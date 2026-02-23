use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use services::{GitService, TerminalService};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot, Mutex, RwLock},
    time::timeout,
};

mod services;

const APPROVAL_COMMAND_METHOD: &str = "item/commandExecution/requestApproval";
const APPROVAL_FILE_METHOD: &str = "item/fileChange/requestApproval";
const REQUEST_USER_INPUT_METHOD: &str = "item/tool/requestUserInput";
const REQUEST_USER_INPUT_METHOD_ALT: &str = "tool/requestUserInput";
const MOBILE_ATTACHMENTS_DIR: &str = ".clawdex-mobile-attachments";
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const NOTIFICATION_REPLAY_BUFFER_SIZE: usize = 2_000;
const NOTIFICATION_REPLAY_MAX_LIMIT: usize = 1_000;
const WS_CLIENT_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
struct BridgeConfig {
    host: String,
    port: u16,
    workdir: PathBuf,
    cli_bin: String,
    auth_token: Option<String>,
    auth_enabled: bool,
    allow_insecure_no_auth: bool,
    allow_query_token_auth: bool,
    allow_outside_root_cwd: bool,
    disable_terminal_exec: bool,
    terminal_allowed_commands: HashSet<String>,
}

impl BridgeConfig {
    fn from_env() -> Result<Self, String> {
        let host = env::var("BRIDGE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("BRIDGE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8787);

        let configured_workdir = env::var("BRIDGE_WORKDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let workdir = resolve_bridge_workdir(configured_workdir)?;

        let cli_bin = env::var("CODEX_CLI_BIN").unwrap_or_else(|_| "codex".to_string());
        let auth_token = env::var("BRIDGE_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let allow_insecure_no_auth = parse_bool_env("BRIDGE_ALLOW_INSECURE_NO_AUTH");
        if auth_token.is_none() && !allow_insecure_no_auth {
            return Err(
                "BRIDGE_AUTH_TOKEN is required. Set BRIDGE_ALLOW_INSECURE_NO_AUTH=true only for local development."
                    .to_string(),
            );
        }

        let auth_enabled = auth_token.is_some();
        let allow_query_token_auth = parse_bool_env("BRIDGE_ALLOW_QUERY_TOKEN_AUTH");
        let allow_outside_root_cwd =
            parse_bool_env_with_default("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", true);
        let disable_terminal_exec = parse_bool_env("BRIDGE_DISABLE_TERMINAL_EXEC");

        let terminal_allowed_commands = parse_csv_env(
            "BRIDGE_TERMINAL_ALLOWED_COMMANDS",
            &["pwd", "ls", "cat", "git"],
        );

        Ok(Self {
            host,
            port,
            workdir,
            cli_bin,
            auth_token,
            auth_enabled,
            allow_insecure_no_auth,
            allow_query_token_auth,
            allow_outside_root_cwd,
            disable_terminal_exec,
            terminal_allowed_commands,
        })
    }

    fn is_authorized(&self, headers: &HeaderMap, query_token: Option<&str>) -> bool {
        if !self.auth_enabled {
            return true;
        }

        let expected = match &self.auth_token {
            Some(token) => token,
            None => return false,
        };

        if let Some(value) = headers.get("authorization") {
            if let Ok(raw) = value.to_str() {
                let mut parts = raw.trim().split_whitespace();
                let scheme = parts.next();
                let token = parts.next();
                if let (Some(scheme), Some(token)) = (scheme, token) {
                    if scheme.eq_ignore_ascii_case("bearer")
                        && parts.next().is_none()
                        && constant_time_eq(token, expected)
                    {
                        return true;
                    }
                }
            }
        }

        if self.allow_query_token_auth {
            if let Some(token) = query_token.map(str::trim).filter(|token| !token.is_empty()) {
                if constant_time_eq(token, expected) {
                    return true;
                }
            }
        }

        false
    }
}

#[derive(Clone)]
struct AppState {
    config: Arc<BridgeConfig>,
    started_at: Instant,
    hub: Arc<ClientHub>,
    app_server: Arc<AppServerBridge>,
    terminal: Arc<TerminalService>,
    git: Arc<GitService>,
}

struct ClientHub {
    next_client_id: AtomicU64,
    next_event_id: AtomicU64,
    replay_capacity: usize,
    clients: RwLock<HashMap<u64, mpsc::Sender<Message>>>,
    notification_replay: RwLock<VecDeque<ReplayableNotification>>,
}

#[derive(Clone)]
struct ReplayableNotification {
    event_id: u64,
    payload: Value,
}

impl ClientHub {
    fn new() -> Self {
        Self::with_replay_capacity(NOTIFICATION_REPLAY_BUFFER_SIZE)
    }

    fn with_replay_capacity(replay_capacity: usize) -> Self {
        Self {
            next_client_id: AtomicU64::new(1),
            next_event_id: AtomicU64::new(1),
            replay_capacity,
            clients: RwLock::new(HashMap::new()),
            notification_replay: RwLock::new(VecDeque::new()),
        }
    }

    async fn add_client(&self, tx: mpsc::Sender<Message>) -> u64 {
        let id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        self.clients.write().await.insert(id, tx);
        id
    }

    async fn remove_client(&self, client_id: u64) {
        self.clients.write().await.remove(&client_id);
    }

    async fn send_json(&self, client_id: u64, value: Value) {
        let text = match serde_json::to_string(&value) {
            Ok(v) => v,
            Err(error) => {
                eprintln!("failed to serialize websocket payload: {error}");
                return;
            }
        };

        let tx = {
            let clients = self.clients.read().await;
            clients.get(&client_id).cloned()
        };
        let Some(tx) = tx else {
            return;
        };

        let message = Message::Text(text.into());
        let should_remove = match tx.try_send(message) {
            Ok(()) => false,
            Err(mpsc::error::TrySendError::Closed(_)) => true,
            Err(mpsc::error::TrySendError::Full(message)) => {
                match timeout(Duration::from_millis(250), tx.send(message)).await {
                    Ok(Ok(())) => false,
                    Ok(Err(_)) | Err(_) => true,
                }
            }
        };

        if should_remove {
            self.remove_client(client_id).await;
        }
    }

    async fn broadcast_json(&self, value: Value) {
        let text = match serde_json::to_string(&value) {
            Ok(v) => v,
            Err(error) => {
                eprintln!("failed to serialize broadcast payload: {error}");
                return;
            }
        };

        let mut stale_clients = Vec::new();
        {
            let clients = self.clients.read().await;
            for (client_id, tx) in clients.iter() {
                match tx.try_send(Message::Text(text.clone().into())) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        stale_clients.push(*client_id);
                    }
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        // Keep the client and rely on replay to catch up dropped notifications.
                    }
                }
            }
        }

        if !stale_clients.is_empty() {
            let mut clients = self.clients.write().await;
            for client_id in stale_clients {
                clients.remove(&client_id);
            }
        }
    }

    async fn broadcast_notification(&self, method: &str, params: Value) {
        let event_id = self.next_event_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "method": method,
            "eventId": event_id,
            "params": params
        });

        self.push_replay(event_id, payload.clone()).await;
        self.broadcast_json(payload).await;
    }

    async fn push_replay(&self, event_id: u64, payload: Value) {
        if self.replay_capacity == 0 {
            return;
        }

        let mut replay = self.notification_replay.write().await;
        replay.push_back(ReplayableNotification { event_id, payload });
        while replay.len() > self.replay_capacity {
            replay.pop_front();
        }
    }

    async fn replay_since(&self, after_event_id: Option<u64>, limit: usize) -> (Vec<Value>, bool) {
        let after = after_event_id.unwrap_or(0);
        let replay = self.notification_replay.read().await;
        let mut events = Vec::new();
        let mut has_more = false;

        for entry in replay.iter() {
            if entry.event_id <= after {
                continue;
            }

            if events.len() >= limit {
                has_more = true;
                break;
            }

            events.push(entry.payload.clone());
        }

        (events, has_more)
    }

    async fn earliest_event_id(&self) -> Option<u64> {
        self.notification_replay
            .read()
            .await
            .front()
            .map(|entry| entry.event_id)
    }

    fn latest_event_id(&self) -> u64 {
        self.next_event_id.load(Ordering::Relaxed).saturating_sub(1)
    }
}

struct AppServerBridge {
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    pending_requests: Mutex<HashMap<u64, PendingRequest>>,
    internal_waiters: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    pending_approvals: Mutex<HashMap<String, PendingApprovalEntry>>,
    pending_user_inputs: Mutex<HashMap<String, PendingUserInputEntry>>,
    next_request_id: AtomicU64,
    approval_counter: AtomicU64,
    user_input_counter: AtomicU64,
    hub: Arc<ClientHub>,
}

struct PendingRequest {
    client_id: u64,
    client_request_id: Value,
}

#[derive(Clone)]
struct PendingApprovalEntry {
    app_server_request_id: Value,
    approval: PendingApproval,
}

#[derive(Clone)]
struct PendingUserInputEntry {
    app_server_request_id: Value,
    request: PendingUserInputRequest,
}

impl AppServerBridge {
    async fn start(cli_bin: &str, hub: Arc<ClientHub>) -> Result<Arc<Self>, String> {
        let mut child = Command::new(cli_bin)
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to start app-server: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "app-server stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "app-server stderr unavailable".to_string())?;

        let bridge = Arc::new(Self {
            child: Mutex::new(child),
            writer: Mutex::new(stdin),
            pending_requests: Mutex::new(HashMap::new()),
            internal_waiters: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_user_inputs: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            approval_counter: AtomicU64::new(1),
            user_input_counter: AtomicU64::new(1),
            hub,
        });

        bridge.spawn_stdout_loop(stdout);
        bridge.spawn_stderr_loop(stderr);
        bridge.spawn_wait_loop();

        bridge.initialize().await?;

        Ok(bridge)
    }

    async fn initialize(&self) -> Result<(), String> {
        let init_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        self.internal_waiters.lock().await.insert(init_id, tx);

        let initialize_request = json!({
            "id": init_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "clawdex-mobile-rust-bridge",
                    "title": "Clawdex Mobile Rust Bridge",
                    "version": "0.1.0"
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }
        });

        self.write_json(initialize_request)
            .await
            .map_err(|error| format!("initialize write failed: {error}"))?;

        let init_result = timeout(Duration::from_secs(15), rx)
            .await
            .map_err(|_| "app-server initialize timed out".to_string())?;

        match init_result {
            Ok(Ok(_)) => {}
            Ok(Err(message)) => return Err(format!("app-server initialize failed: {message}")),
            Err(_) => return Err("app-server initialize waiter dropped".to_string()),
        }

        self.write_json(json!({
            "method": "initialized",
            "params": {}
        }))
        .await
        .map_err(|error| format!("initialized write failed: {error}"))?;

        Ok(())
    }

    fn spawn_stdout_loop(self: &Arc<Self>, stdout: ChildStdout) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();

            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }

                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => this.handle_incoming(value).await,
                            Err(error) => {
                                eprintln!("invalid app-server json: {error} | line={trimmed}");
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("app-server stdout read error: {error}");
                        break;
                    }
                }
            }
        });
    }

    fn spawn_stderr_loop(self: &Arc<Self>, stderr: tokio::process::ChildStderr) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => eprintln!("[app-server] {line}"),
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("app-server stderr read error: {error}");
                        break;
                    }
                }
            }
        });
    }

    fn spawn_wait_loop(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let status_result = {
                let mut child = this.child.lock().await;
                child.wait().await
            };

            match status_result {
                Ok(status) => {
                    eprintln!("app-server exited with status: {status}");
                }
                Err(error) => {
                    eprintln!("failed waiting for app-server exit: {error}");
                }
            }

            this.fail_all_pending("app-server closed").await;
            this.pending_approvals.lock().await.clear();
            this.pending_user_inputs.lock().await.clear();
        });
    }

    async fn fail_all_pending(&self, message: &str) {
        let pending_entries = {
            let mut pending = self.pending_requests.lock().await;
            pending.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };

        for pending in pending_entries {
            self.hub
                .send_json(
                    pending.client_id,
                    json!({
                        "id": pending.client_request_id,
                        "error": {
                            "code": -32000,
                            "message": message
                        }
                    }),
                )
                .await;
        }
    }

    async fn forward_request(
        &self,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        let internal_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);

        {
            let mut pending = self.pending_requests.lock().await;
            pending.insert(
                internal_id,
                PendingRequest {
                    client_id,
                    client_request_id,
                },
            );
        }

        let mut payload = json!({
            "id": internal_id,
            "method": method,
        });
        if let Some(params) = params {
            payload["params"] = params;
        }

        if let Err(error) = self.write_json(payload).await {
            self.pending_requests.lock().await.remove(&internal_id);
            return Err(format!("failed forwarding request to app-server: {error}"));
        }

        Ok(())
    }

    async fn list_pending_approvals(&self) -> Vec<PendingApproval> {
        let mut approvals = self
            .pending_approvals
            .lock()
            .await
            .values()
            .map(|entry| entry.approval.clone())
            .collect::<Vec<_>>();

        approvals.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        approvals
    }

    async fn resolve_approval(
        &self,
        approval_id: &str,
        decision: &Value,
    ) -> Result<Option<PendingApproval>, String> {
        let pending = self.pending_approvals.lock().await.remove(approval_id);
        let Some(pending) = pending else {
            return Ok(None);
        };

        let response = json!({
            "id": pending.app_server_request_id,
            "result": {
                "decision": decision
            }
        });

        if let Err(error) = self.write_json(response).await {
            self.pending_approvals
                .lock()
                .await
                .insert(approval_id.to_string(), pending.clone());
            return Err(format!("failed to send approval response: {error}"));
        }

        self.hub
            .broadcast_notification(
                "bridge/approval.resolved",
                json!({
                    "id": pending.approval.id,
                    "threadId": pending.approval.thread_id,
                    "decision": decision,
                    "resolvedAt": now_iso(),
                }),
            )
            .await;

        Ok(Some(pending.approval))
    }

    async fn resolve_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, UserInputAnswerPayload>,
    ) -> Result<Option<PendingUserInputRequest>, String> {
        let pending = self.pending_user_inputs.lock().await.remove(request_id);
        let Some(pending) = pending else {
            return Ok(None);
        };

        let response = json!({
            "id": pending.app_server_request_id,
            "result": {
                "answers": answers
            }
        });

        if let Err(error) = self.write_json(response).await {
            self.pending_user_inputs
                .lock()
                .await
                .insert(request_id.to_string(), pending.clone());
            return Err(format!("failed to send requestUserInput response: {error}"));
        }

        self.hub
            .broadcast_notification(
                "bridge/userInput.resolved",
                json!({
                    "id": pending.request.id,
                    "threadId": pending.request.thread_id,
                    "turnId": pending.request.turn_id,
                    "resolvedAt": now_iso(),
                }),
            )
            .await;

        Ok(Some(pending.request))
    }

    async fn handle_incoming(&self, value: Value) {
        let Some(object) = value.as_object() else {
            return;
        };

        let method = object
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let id = object.get("id").cloned();

        match (method, id) {
            (Some(method), Some(id)) => {
                self.handle_server_request(&method, id, object.get("params").cloned())
                    .await;
            }
            (Some(method), None) => {
                self.handle_notification(&method, object.get("params").cloned())
                    .await;
            }
            (None, Some(_)) => {
                self.handle_response(value).await;
            }
            (None, None) => {}
        }
    }

    async fn handle_server_request(&self, method: &str, id: Value, params: Option<Value>) {
        if method == APPROVAL_COMMAND_METHOD || method == APPROVAL_FILE_METHOD {
            let params_obj = params.as_ref().and_then(Value::as_object);
            let approval_id = format!(
                "{}-{}",
                Utc::now().timestamp_millis(),
                self.approval_counter.fetch_add(1, Ordering::Relaxed)
            );

            let approval = PendingApproval {
                id: approval_id.clone(),
                kind: if method == APPROVAL_COMMAND_METHOD {
                    "commandExecution".to_string()
                } else {
                    "fileChange".to_string()
                },
                thread_id: read_string(params_obj.and_then(|p| p.get("threadId")))
                    .unwrap_or_else(|| "unknown-thread".to_string()),
                turn_id: read_string(params_obj.and_then(|p| p.get("turnId")))
                    .unwrap_or_else(|| "unknown-turn".to_string()),
                item_id: read_string(params_obj.and_then(|p| p.get("itemId")))
                    .unwrap_or_else(|| "unknown-item".to_string()),
                requested_at: now_iso(),
                reason: read_string(params_obj.and_then(|p| p.get("reason"))),
                command: read_string(params_obj.and_then(|p| p.get("command"))),
                cwd: read_string(params_obj.and_then(|p| p.get("cwd"))),
                grant_root: read_string(params_obj.and_then(|p| p.get("grantRoot"))),
                proposed_execpolicy_amendment: parse_execpolicy_amendment(
                    params_obj.and_then(|p| p.get("proposedExecpolicyAmendment")),
                ),
            };

            self.pending_approvals.lock().await.insert(
                approval_id,
                PendingApprovalEntry {
                    app_server_request_id: id,
                    approval: approval.clone(),
                },
            );

            self.hub
                .broadcast_notification(
                    "bridge/approval.requested",
                    serde_json::to_value(approval).unwrap_or(Value::Null),
                )
                .await;
            return;
        }

        if method == REQUEST_USER_INPUT_METHOD || method == REQUEST_USER_INPUT_METHOD_ALT {
            let params_obj = params.as_ref().and_then(Value::as_object);
            let request_id = format!(
                "request-user-input-{}-{}",
                Utc::now().timestamp_millis(),
                self.user_input_counter.fetch_add(1, Ordering::Relaxed)
            );

            let request = PendingUserInputRequest {
                id: request_id.clone(),
                thread_id: read_string(params_obj.and_then(|p| p.get("threadId")))
                    .unwrap_or_else(|| "unknown-thread".to_string()),
                turn_id: read_string(params_obj.and_then(|p| p.get("turnId")))
                    .unwrap_or_else(|| "unknown-turn".to_string()),
                item_id: read_string(params_obj.and_then(|p| p.get("itemId")))
                    .unwrap_or_else(|| "unknown-item".to_string()),
                requested_at: now_iso(),
                questions: parse_user_input_questions(params_obj.and_then(|p| p.get("questions"))),
            };

            self.pending_user_inputs.lock().await.insert(
                request_id,
                PendingUserInputEntry {
                    app_server_request_id: id,
                    request: request.clone(),
                },
            );

            self.hub
                .broadcast_notification(
                    "bridge/userInput.requested",
                    serde_json::to_value(request).unwrap_or(Value::Null),
                )
                .await;
            return;
        }

        let _ = self
            .write_json(json!({
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Unsupported server request method: {method}")
                }
            }))
            .await;
    }

    async fn handle_notification(&self, method: &str, params: Option<Value>) {
        self.hub
            .broadcast_notification(method, params.unwrap_or(Value::Null))
            .await;
    }

    async fn handle_response(&self, response: Value) {
        let Some(object) = response.as_object() else {
            return;
        };

        let Some(internal_id) = parse_internal_id(object.get("id")) else {
            return;
        };

        let pending = self.pending_requests.lock().await.remove(&internal_id);
        if pending.is_none() {
            let waiter = self.internal_waiters.lock().await.remove(&internal_id);
            if let Some(waiter) = waiter {
                if let Some(error) = object.get("error") {
                    let message = error
                        .as_object()
                        .and_then(|entry| entry.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown initialize error")
                        .to_string();
                    let _ = waiter.send(Err(message));
                } else {
                    let _ = waiter.send(Ok(object.get("result").cloned().unwrap_or(Value::Null)));
                }
                return;
            }
        }
        let Some(pending) = pending else {
            return;
        };

        let client_payload = if let Some(error) = object.get("error") {
            json!({
                "id": pending.client_request_id,
                "error": error,
            })
        } else {
            json!({
                "id": pending.client_request_id,
                "result": object.get("result").cloned().unwrap_or(Value::Null),
            })
        };

        self.hub.send_json(pending.client_id, client_payload).await;
    }

    async fn write_json(&self, payload: Value) -> Result<(), std::io::Error> {
        let line = serde_json::to_string(&payload).map_err(std::io::Error::other)?;
        let mut writer = self.writer.lock().await;
        writer.write_all(line.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await
    }
}

#[derive(Debug)]
struct BridgeError {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl BridgeError {
    fn method_not_found(message: &str) -> Self {
        Self {
            code: -32601,
            message: message.to_string(),
            data: None,
        }
    }

    fn invalid_params(message: &str) -> Self {
        Self {
            code: -32602,
            message: message.to_string(),
            data: None,
        }
    }

    fn server(message: &str) -> Self {
        Self {
            code: -32000,
            message: message.to_string(),
            data: None,
        }
    }

    fn forbidden(error: &str, message: &str) -> Self {
        Self {
            code: -32003,
            message: message.to_string(),
            data: Some(json!({ "error": error })),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExecRequest {
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExecResponse {
    command: String,
    cwd: String,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitStatusResponse {
    branch: String,
    clean: bool,
    raw: String,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitDiffResponse {
    diff: String,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitCommitResponse {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    committed: bool,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitPushResponse {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    pushed: bool,
    cwd: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitQueryRequest {
    cwd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventReplayRequest {
    after_event_id: Option<u64>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitRequest {
    message: String,
    cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadRequest {
    data_base64: String,
    file_name: Option<String>,
    mime_type: Option<String>,
    thread_id: Option<String>,
    kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadResponse {
    path: String,
    file_name: String,
    mime_type: Option<String>,
    size_bytes: usize,
    kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingApproval {
    id: String,
    kind: String,
    thread_id: String,
    turn_id: String,
    item_id: String,
    requested_at: String,
    reason: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    grant_root: Option<String>,
    proposed_execpolicy_amendment: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveApprovalRequest {
    id: String,
    decision: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserInputAnswerPayload {
    answers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveUserInputRequest {
    id: String,
    answers: HashMap<String, UserInputAnswerPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUserInputRequest {
    id: String,
    thread_id: String,
    turn_id: String,
    item_id: String,
    requested_at: String,
    questions: Vec<PendingUserInputQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUserInputQuestion {
    id: String,
    header: String,
    question: String,
    is_other: bool,
    is_secret: bool,
    options: Option<Vec<PendingUserInputQuestionOption>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUserInputQuestionOption {
    label: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct RpcQuery {
    token: Option<String>,
}

#[tokio::main]
async fn main() {
    let config = match BridgeConfig::from_env() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    if !config.auth_enabled && config.allow_insecure_no_auth {
        eprintln!(
            "bridge auth is disabled by BRIDGE_ALLOW_INSECURE_NO_AUTH=true (local development only)"
        );
    }
    if config.allow_query_token_auth {
        eprintln!(
            "query-token auth is enabled (BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true); prefer Authorization headers instead"
        );
    }

    let hub = Arc::new(ClientHub::new());
    let app_server = match AppServerBridge::start(&config.cli_bin, hub.clone()).await {
        Ok(client) => client,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    let terminal = Arc::new(TerminalService::new(
        config.workdir.clone(),
        config.terminal_allowed_commands.clone(),
        config.disable_terminal_exec,
        config.allow_outside_root_cwd,
    ));
    let git = Arc::new(GitService::new(
        terminal.clone(),
        config.workdir.clone(),
        config.allow_outside_root_cwd,
    ));

    let state = Arc::new(AppState {
        config: config.clone(),
        started_at: Instant::now(),
        hub,
        app_server,
        terminal,
        git,
    });

    let app = Router::new()
        .route("/rpc", get(ws_handler))
        .route("/health", get(health_handler))
        .with_state(state);

    let bind_addr = format!("{}:{}", config.host, config.port);
    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind {bind_addr}: {error}");
            std::process::exit(1);
        }
    };

    println!("rust-bridge listening on {bind_addr}");

    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("server error: {error}");
        std::process::exit(1);
    }
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "at": now_iso(),
        "uptimeSec": state.started_at.elapsed().as_secs(),
    }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<RpcQuery>,
) -> Response {
    if !state.config.is_authorized(&headers, query.token.as_deref()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "unauthorized",
                "message": "Missing or invalid bridge token"
            })),
        )
            .into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(WS_CLIENT_QUEUE_CAPACITY);
    let client_id = state.hub.add_client(tx).await;

    let mut writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if socket_tx.send(message).await.is_err() {
                break;
            }
        }
    });

    state
        .hub
        .send_json(
            client_id,
            json!({
                "method": "bridge/connection/state",
                "params": {
                    "status": "connected",
                    "at": now_iso(),
                }
            }),
        )
        .await;

    loop {
        tokio::select! {
            writer_result = &mut writer_task => {
                if let Err(error) = writer_result {
                    eprintln!("websocket writer task error: {error}");
                }
                break;
            }
            maybe_message = socket_rx.next() => {
                let Some(message) = maybe_message else {
                    break;
                };

                match message {
                    Ok(Message::Text(text)) => {
                        handle_client_message(client_id, text.to_string(), &state).await;
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Binary(_)) => {
                        state
                            .hub
                            .send_json(
                                client_id,
                                json!({
                                    "id": Value::Null,
                                    "error": {
                                        "code": -32600,
                                        "message": "Binary websocket messages are not supported"
                                    }
                                }),
                            )
                            .await;
                    }
                    Ok(Message::Ping(payload)) => {
                        state
                            .hub
                            .send_json(
                                client_id,
                                json!({
                                    "method": "bridge/ping",
                                    "params": {
                                        "size": payload.len()
                                    }
                                }),
                            )
                            .await;
                    }
                    Ok(Message::Pong(_)) => {}
                    Err(error) => {
                        eprintln!("websocket error: {error}");
                        break;
                    }
                }
            }
        }
    }

    state.hub.remove_client(client_id).await;
    if !writer_task.is_finished() {
        writer_task.abort();
    }
}

async fn handle_client_message(client_id: u64, text: String, state: &Arc<AppState>) {
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(error) => {
            send_rpc_error(
                state,
                client_id,
                Value::Null,
                -32700,
                &format!("Parse error: {error}"),
                None,
            )
            .await;
            return;
        }
    };

    let Some(object) = parsed.as_object() else {
        send_rpc_error(
            state,
            client_id,
            Value::Null,
            -32600,
            "Invalid request payload",
            None,
        )
        .await;
        return;
    };

    let Some(method) = object.get("method").and_then(Value::as_str) else {
        send_rpc_error(
            state,
            client_id,
            object.get("id").cloned().unwrap_or(Value::Null),
            -32600,
            "Missing method",
            None,
        )
        .await;
        return;
    };

    let Some(id) = object.get("id").cloned() else {
        // Ignore client-side notifications for now.
        return;
    };

    let params = object.get("params").cloned();

    if method.starts_with("bridge/") {
        match handle_bridge_method(method, params, state).await {
            Ok(result) => {
                state
                    .hub
                    .send_json(client_id, json!({ "id": id, "result": result }))
                    .await;
            }
            Err(error) => {
                send_rpc_error(state, client_id, id, error.code, &error.message, error.data).await;
            }
        }
        return;
    }

    if !is_forwarded_method(method) {
        send_rpc_error(
            state,
            client_id,
            id,
            -32601,
            &format!("Method not allowed: {method}"),
            None,
        )
        .await;
        return;
    }

    if let Err(error) = state
        .app_server
        .forward_request(client_id, id.clone(), method, params)
        .await
    {
        send_rpc_error(state, client_id, id, -32000, &error, None).await;
    }
}

async fn handle_bridge_method(
    method: &str,
    params: Option<Value>,
    state: &Arc<AppState>,
) -> Result<Value, BridgeError> {
    match method {
        "bridge/health/read" => Ok(json!({
            "status": "ok",
            "at": now_iso(),
            "uptimeSec": state.started_at.elapsed().as_secs(),
        })),
        "bridge/events/replay" => {
            let request: EventReplayRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let limit = request
                .limit
                .unwrap_or(200)
                .clamp(1, NOTIFICATION_REPLAY_MAX_LIMIT);
            let (events, has_more) = state.hub.replay_since(request.after_event_id, limit).await;

            Ok(json!({
                "events": events,
                "hasMore": has_more,
                "earliestEventId": state.hub.earliest_event_id().await,
                "latestEventId": state.hub.latest_event_id(),
            }))
        }
        "bridge/terminal/exec" => {
            let request: TerminalExecRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let result = state.terminal.execute_shell(request).await?;
            let result_value = serde_json::to_value(&result)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            state
                .hub
                .broadcast_notification("bridge/terminal/completed", result_value.clone())
                .await;

            Ok(result_value)
        }
        "bridge/attachments/upload" => {
            let request: AttachmentUploadRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let uploaded = save_uploaded_attachment(request, state).await?;
            serde_json::to_value(uploaded).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/status" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let status = state.git.get_status(request.cwd.as_deref()).await?;
            serde_json::to_value(status).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/diff" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let diff = state.git.get_diff(request.cwd.as_deref()).await?;
            serde_json::to_value(diff).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/commit" => {
            let request: GitCommitRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitCommitRequest { message, cwd } = request;

            if message.trim().is_empty() {
                return Err(BridgeError::invalid_params("message must not be empty"));
            }

            let commit = state.git.commit(message, cwd.as_deref()).await?;
            let commit_value = serde_json::to_value(&commit)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if commit.committed {
                if let Ok(status) = state.git.get_status(cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(commit_value)
        }
        "bridge/git/push" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let push = state.git.push(request.cwd.as_deref()).await?;
            let push_value = serde_json::to_value(&push)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if push.pushed {
                if let Ok(status) = state.git.get_status(request.cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(push_value)
        }
        "bridge/approvals/list" => {
            let list = state.app_server.list_pending_approvals().await;
            serde_json::to_value(list).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/approvals/resolve" => {
            let request: ResolveApprovalRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            if !is_valid_approval_decision(&request.decision) {
                return Err(BridgeError::invalid_params(
                    "decision must be one of: accept, acceptForSession, decline, cancel, or acceptWithExecpolicyAmendment",
                ));
            }

            let resolved = state
                .app_server
                .resolve_approval(&request.id, &request.decision)
                .await
                .map_err(|error| BridgeError::server(&error))?;

            let Some(approval) = resolved else {
                return Err(BridgeError {
                    code: -32004,
                    message: "approval_not_found".to_string(),
                    data: Some(json!({ "error": "approval_not_found" })),
                });
            };

            Ok(json!({
                "ok": true,
                "approval": approval,
                "decision": request.decision,
            }))
        }
        "bridge/userInput/resolve" => {
            let request: ResolveUserInputRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            if request.answers.is_empty() {
                return Err(BridgeError::invalid_params(
                    "answers must contain at least one question response",
                ));
            }

            if !is_valid_user_input_answers(&request.answers) {
                return Err(BridgeError::invalid_params(
                    "answers must map question ids to non-empty answers arrays",
                ));
            }

            let resolved = state
                .app_server
                .resolve_user_input(&request.id, &request.answers)
                .await
                .map_err(|error| BridgeError::server(&error))?;

            let Some(user_input_request) = resolved else {
                return Err(BridgeError {
                    code: -32004,
                    message: "user_input_not_found".to_string(),
                    data: Some(json!({ "error": "user_input_not_found" })),
                });
            };

            Ok(json!({
                "ok": true,
                "request": user_input_request,
            }))
        }
        _ => Err(BridgeError::method_not_found(&format!(
            "Unknown bridge method: {method}"
        ))),
    }
}

async fn send_rpc_error(
    state: &Arc<AppState>,
    client_id: u64,
    id: Value,
    code: i64,
    message: &str,
    data: Option<Value>,
) {
    let mut payload = json!({
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    });

    if let Some(data) = data {
        payload["error"]["data"] = data;
    }

    state.hub.send_json(client_id, payload).await;
}

fn resolve_bridge_workdir(raw_workdir: PathBuf) -> Result<PathBuf, String> {
    if !raw_workdir.is_absolute() {
        return Err(format!(
            "BRIDGE_WORKDIR must be an absolute path (got: {})",
            raw_workdir.to_string_lossy()
        ));
    }

    let canonical = std::fs::canonicalize(&raw_workdir).map_err(|error| {
        format!(
            "BRIDGE_WORKDIR is invalid or inaccessible ({}): {error}",
            raw_workdir.to_string_lossy()
        )
    })?;

    Ok(normalize_path(&canonical))
}

fn parse_bool_env(name: &str) -> bool {
    env::var(name)
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn parse_bool_env_with_default(name: &str, default: bool) -> bool {
    env::var(name)
        .map(|raw| {
            let value = raw.trim();
            if value.eq_ignore_ascii_case("true") {
                true
            } else if value.eq_ignore_ascii_case("false") {
                false
            } else {
                default
            }
        })
        .unwrap_or(default)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let max_len = left_bytes.len().max(right_bytes.len());

    let mut diff = left_bytes.len() ^ right_bytes.len();
    for index in 0..max_len {
        let left_byte = *left_bytes.get(index).unwrap_or(&0);
        let right_byte = *right_bytes.get(index).unwrap_or(&0);
        diff |= (left_byte ^ right_byte) as usize;
    }

    diff == 0
}

fn parse_csv_env(name: &str, fallback: &[&str]) -> HashSet<String> {
    match env::var(name) {
        Ok(raw) => raw
            .split(',')
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect(),
        Err(_) => fallback.iter().map(|entry| entry.to_string()).collect(),
    }
}

fn is_forwarded_method(method: &str) -> bool {
    matches!(
        method,
        "thread/start"
            | "thread/resume"
            | "thread/read"
            | "thread/list"
            | "thread/name/set"
            | "thread/fork"
            | "thread/archive"
            | "thread/unarchive"
            | "thread/rollback"
            | "thread/compact/start"
            | "turn/start"
            | "turn/steer"
            | "turn/interrupt"
            | "model/list"
            | "review/start"
            | "skills/list"
            | "app/list"
            | "command/exec"
            | "thread/loaded/list"
    )
}

fn is_valid_approval_decision(value: &Value) -> bool {
    if let Some(raw) = value.as_str() {
        return matches!(raw, "accept" | "acceptForSession" | "decline" | "cancel");
    }

    let Some(object) = value.as_object() else {
        return false;
    };

    let Some(amendment) = object.get("acceptWithExecpolicyAmendment") else {
        return false;
    };

    let Some(amendment_object) = amendment.as_object() else {
        return false;
    };

    let Some(execpolicy_amendment) = amendment_object.get("execpolicy_amendment") else {
        return false;
    };

    let Some(tokens) = execpolicy_amendment.as_array() else {
        return false;
    };

    if tokens.is_empty() {
        return false;
    }

    tokens.iter().all(|token| token.as_str().is_some())
}

fn parse_internal_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;

    if let Some(number) = value.as_u64() {
        return Some(number);
    }

    if let Some(number) = value.as_i64() {
        if number >= 0 {
            return Some(number as u64);
        }
    }

    if let Some(raw) = value.as_str() {
        return raw.parse::<u64>().ok();
    }

    None
}

fn read_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn read_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn parse_execpolicy_amendment(value: Option<&Value>) -> Option<Vec<String>> {
    let array = if let Some(array) = value.and_then(Value::as_array) {
        array
    } else if let Some(object) = value.and_then(Value::as_object) {
        object.get("execpolicy_amendment")?.as_array()?
    } else {
        return None;
    };

    let tokens = array
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();

    if tokens.is_empty() {
        None
    } else {
        Some(tokens)
    }
}

fn parse_user_input_questions(value: Option<&Value>) -> Vec<PendingUserInputQuestion> {
    let Some(array) = value.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut questions = Vec::new();
    for raw_question in array {
        let Some(question_object) = raw_question.as_object() else {
            continue;
        };

        let Some(id) = read_string(question_object.get("id")) else {
            continue;
        };
        let Some(header) = read_string(question_object.get("header")) else {
            continue;
        };
        let Some(question) = read_string(question_object.get("question")) else {
            continue;
        };

        let options = question_object
            .get("options")
            .and_then(Value::as_array)
            .map(|option_array| {
                option_array
                    .iter()
                    .filter_map(Value::as_object)
                    .filter_map(|option_object| {
                        let label = read_string(option_object.get("label"))?;
                        let description =
                            read_string(option_object.get("description")).unwrap_or_default();
                        Some(PendingUserInputQuestionOption { label, description })
                    })
                    .collect::<Vec<_>>()
            });

        questions.push(PendingUserInputQuestion {
            id,
            header,
            question,
            is_other: read_bool(question_object.get("isOther")).unwrap_or(false),
            is_secret: read_bool(question_object.get("isSecret")).unwrap_or(false),
            options,
        });
    }

    questions
}

fn is_valid_user_input_answers(answers: &HashMap<String, UserInputAnswerPayload>) -> bool {
    answers.iter().all(|(question_id, answer_payload)| {
        if question_id.trim().is_empty() {
            return false;
        }

        if answer_payload.answers.is_empty() {
            return false;
        }

        answer_payload
            .answers
            .iter()
            .all(|answer| !answer.trim().is_empty())
    })
}

async fn save_uploaded_attachment(
    request: AttachmentUploadRequest,
    state: &Arc<AppState>,
) -> Result<AttachmentUploadResponse, BridgeError> {
    let encoded = request.data_base64.trim();
    if encoded.is_empty() {
        return Err(BridgeError::invalid_params("dataBase64 must not be empty"));
    }

    let estimated_size = estimate_base64_decoded_size(encoded)?;
    if estimated_size > MAX_ATTACHMENT_BYTES {
        return Err(BridgeError::invalid_params(&format!(
            "attachment exceeds max size of {MAX_ATTACHMENT_BYTES} bytes"
        )));
    }

    let bytes = decode_base64_payload(encoded)?;
    if bytes.is_empty() {
        return Err(BridgeError::invalid_params("attachment payload is empty"));
    }

    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(BridgeError::invalid_params(&format!(
            "attachment exceeds max size of {MAX_ATTACHMENT_BYTES} bytes"
        )));
    }

    let normalized_kind =
        normalize_attachment_kind(request.kind.as_deref(), request.mime_type.as_deref());
    let file_name = build_attachment_file_name(
        request.file_name.as_deref(),
        request.mime_type.as_deref(),
        normalized_kind,
    );

    let mut attachment_dir = state.config.workdir.join(MOBILE_ATTACHMENTS_DIR);
    if let Some(thread_id) = request.thread_id.as_deref() {
        let normalized_thread = sanitize_path_segment(thread_id);
        if !normalized_thread.is_empty() {
            attachment_dir = attachment_dir.join(normalized_thread);
        }
    }

    fs::create_dir_all(&attachment_dir).await.map_err(|error| {
        BridgeError::server(&format!("failed to create attachment directory: {error}"))
    })?;

    let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let unique_name = format!("{timestamp}-{}-{file_name}", std::process::id());
    let target_path = attachment_dir.join(unique_name);
    let normalized_target = normalize_path(&target_path);
    if !normalized_target.starts_with(&state.config.workdir) {
        return Err(BridgeError::invalid_params(
            "attachment path must stay within BRIDGE_WORKDIR",
        ));
    }

    fs::write(&normalized_target, &bytes)
        .await
        .map_err(|error| BridgeError::server(&format!("failed to persist attachment: {error}")))?;

    Ok(AttachmentUploadResponse {
        path: normalized_target.to_string_lossy().to_string(),
        file_name,
        mime_type: request
            .mime_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        size_bytes: bytes.len(),
        kind: normalized_kind.to_string(),
    })
}

fn extract_base64_payload(raw: &str) -> Result<&str, BridgeError> {
    let payload = raw
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(raw)
        .trim();
    if payload.is_empty() {
        return Err(BridgeError::invalid_params(
            "dataBase64 must contain base64 payload",
        ));
    }

    Ok(payload)
}

fn estimate_base64_decoded_size(raw: &str) -> Result<usize, BridgeError> {
    let payload = extract_base64_payload(raw)?;
    let encoded_len = payload.len();
    let padding = payload
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);

    let block_count = (encoded_len + 3) / 4;
    Ok(block_count.saturating_mul(3).saturating_sub(padding))
}

fn decode_base64_payload(raw: &str) -> Result<Vec<u8>, BridgeError> {
    let payload = extract_base64_payload(raw)?;

    general_purpose::STANDARD
        .decode(payload)
        .or_else(|_| general_purpose::URL_SAFE.decode(payload))
        .map_err(|error| {
            BridgeError::invalid_params(&format!("invalid base64 attachment payload: {error}"))
        })
}

fn normalize_attachment_kind(kind: Option<&str>, mime_type: Option<&str>) -> &'static str {
    let normalized = kind
        .map(str::trim)
        .map(str::to_lowercase)
        .unwrap_or_default();
    if normalized == "image" {
        return "image";
    }
    if normalized == "file" {
        return "file";
    }

    if let Some(mime) = mime_type {
        if mime.trim().to_ascii_lowercase().starts_with("image/") {
            return "image";
        }
    }

    "file"
}

fn build_attachment_file_name(
    raw_name: Option<&str>,
    raw_mime_type: Option<&str>,
    kind: &str,
) -> String {
    let requested_name = raw_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if kind == "image" {
                "image".to_string()
            } else {
                "attachment".to_string()
            }
        });

    let mut sanitized = sanitize_filename(&requested_name);
    if !sanitized.contains('.') {
        if let Some(extension) = infer_extension_from_mime(raw_mime_type) {
            sanitized.push('.');
            sanitized.push_str(extension);
        }
    }

    sanitized
}

fn sanitize_filename(value: &str) -> String {
    let basename = value
        .split(['/', '\\'])
        .filter(|segment| !segment.trim().is_empty())
        .next_back()
        .unwrap_or("attachment");

    let mut cleaned = basename
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '.' | '-' | '_') {
                char
            } else {
                '_'
            }
        })
        .collect::<String>();

    cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        return "attachment".to_string();
    }

    if cleaned.len() > 96 {
        cleaned.truncate(96);
    }

    cleaned
}

fn sanitize_path_segment(value: &str) -> String {
    let mut cleaned = value
        .trim()
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '-' | '_') {
                char
            } else {
                '_'
            }
        })
        .collect::<String>();

    cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.len() > 64 {
        cleaned.truncate(64);
    }

    cleaned
}

fn infer_extension_from_mime(raw_mime_type: Option<&str>) -> Option<&'static str> {
    let mime = raw_mime_type?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "text/plain" => Some("txt"),
        "application/json" => Some("json"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

fn contains_disallowed_control_chars(value: &str) -> bool {
    value
        .chars()
        .any(|char| matches!(char, ';' | '|' | '&' | '<' | '>' | '`'))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }

    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn build_test_bridge(hub: Arc<ClientHub>) -> Arc<AppServerBridge> {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cat process");
        let writer = child.stdin.take().expect("child stdin available");

        Arc::new(AppServerBridge {
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            pending_requests: Mutex::new(HashMap::new()),
            internal_waiters: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_user_inputs: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            approval_counter: AtomicU64::new(1),
            user_input_counter: AtomicU64::new(1),
            hub,
        })
    }

    async fn shutdown_test_bridge(bridge: &Arc<AppServerBridge>) {
        let mut child = bridge.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    async fn build_test_state() -> Arc<AppState> {
        let workdir = normalize_path(&env::temp_dir());
        let config = Arc::new(BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            workdir: workdir.clone(),
            cli_bin: "cat".to_string(),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            allow_outside_root_cwd: false,
            disable_terminal_exec: true,
            terminal_allowed_commands: HashSet::new(),
        });

        let hub = Arc::new(ClientHub::new());
        let app_server = build_test_bridge(hub.clone()).await;
        let terminal = Arc::new(TerminalService::new(
            config.workdir.clone(),
            config.terminal_allowed_commands.clone(),
            config.disable_terminal_exec,
            config.allow_outside_root_cwd,
        ));
        let git = Arc::new(GitService::new(
            terminal.clone(),
            config.workdir.clone(),
            config.allow_outside_root_cwd,
        ));

        Arc::new(AppState {
            config,
            started_at: Instant::now(),
            hub,
            app_server,
            terminal,
            git,
        })
    }

    async fn add_test_client(hub: &Arc<ClientHub>) -> (u64, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel(8);
        let client_id = hub.add_client(tx).await;
        (client_id, rx)
    }

    async fn recv_client_json(rx: &mut mpsc::Receiver<Message>) -> Value {
        let message = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("timed out waiting for message")
            .expect("client channel closed");
        let Message::Text(text) = message else {
            panic!("expected text websocket frame");
        };

        serde_json::from_str(&text).expect("valid json message")
    }

    #[tokio::test]
    async fn replay_since_returns_notifications_after_cursor() {
        let hub = ClientHub::with_replay_capacity(16);
        hub.broadcast_notification("turn/started", json!({ "threadId": "thr_1" }))
            .await;
        hub.broadcast_notification("turn/completed", json!({ "threadId": "thr_1" }))
            .await;

        let (events, has_more) = hub.replay_since(Some(1), 10).await;
        assert_eq!(events.len(), 1);
        assert!(!has_more);
        assert_eq!(events[0]["method"], "turn/completed");
        assert_eq!(events[0]["eventId"], 2);
        assert_eq!(hub.latest_event_id(), 2);
    }

    #[tokio::test]
    async fn replay_since_respects_limit() {
        let hub = ClientHub::with_replay_capacity(16);
        hub.broadcast_notification("event/1", json!({})).await;
        hub.broadcast_notification("event/2", json!({})).await;
        hub.broadcast_notification("event/3", json!({})).await;

        let (events, has_more) = hub.replay_since(Some(0), 2).await;
        assert_eq!(events.len(), 2);
        assert!(has_more);
        assert_eq!(events[0]["eventId"], 1);
        assert_eq!(events[1]["eventId"], 2);
    }

    #[tokio::test]
    async fn replay_buffer_evicts_oldest_entries() {
        let hub = ClientHub::with_replay_capacity(2);
        hub.broadcast_notification("event/1", json!({})).await;
        hub.broadcast_notification("event/2", json!({})).await;
        hub.broadcast_notification("event/3", json!({})).await;

        let (events, has_more) = hub.replay_since(Some(0), 10).await;
        assert_eq!(events.len(), 2);
        assert!(!has_more);
        assert_eq!(hub.earliest_event_id().await, Some(2));
        assert_eq!(events[0]["eventId"], 2);
        assert_eq!(events[1]["eventId"], 3);
    }

    #[tokio::test]
    async fn send_json_evicts_closed_clients() {
        let hub = ClientHub::with_replay_capacity(4);
        let (tx, rx) = mpsc::channel(1);
        let client_id = hub.add_client(tx).await;
        drop(rx);

        hub.send_json(client_id, json!({ "ok": true })).await;
        assert!(!hub.clients.read().await.contains_key(&client_id));
    }

    #[tokio::test]
    async fn send_json_evicts_slow_clients_when_queue_fills() {
        let hub = ClientHub::with_replay_capacity(4);
        let (tx, mut rx) = mpsc::channel(1);
        let client_id = hub.add_client(tx).await;

        hub.send_json(client_id, json!({ "seq": 1 })).await;
        hub.send_json(client_id, json!({ "seq": 2 })).await;

        assert!(rx.recv().await.is_some());
        assert!(!hub.clients.read().await.contains_key(&client_id));
    }

    #[tokio::test]
    async fn broadcast_json_keeps_clients_when_queue_is_temporarily_full() {
        let hub = ClientHub::with_replay_capacity(4);
        let (tx, mut rx) = mpsc::channel(1);
        let tx_clone = tx.clone();
        let client_id = hub.add_client(tx).await;

        tx_clone
            .try_send(Message::Text("queued".to_string().into()))
            .expect("seed full queue");

        hub.broadcast_json(json!({ "method": "event/x" })).await;

        assert!(hub.clients.read().await.contains_key(&client_id));
        let message = rx.recv().await.expect("first queued message");
        let Message::Text(text) = message else {
            panic!("expected text frame");
        };
        assert_eq!(text, "queued");
    }

    #[test]
    fn forwarded_method_allowlist_matches_expected() {
        assert!(is_forwarded_method("thread/start"));
        assert!(is_forwarded_method("turn/start"));
        assert!(is_forwarded_method("thread/loaded/list"));
        assert!(!is_forwarded_method("bridge/terminal/exec"));
        assert!(!is_forwarded_method("thread/delete"));
    }

    #[test]
    fn approval_decision_validation_accepts_expected_forms() {
        assert!(is_valid_approval_decision(&json!("accept")));
        assert!(is_valid_approval_decision(&json!("acceptForSession")));
        assert!(is_valid_approval_decision(&json!("decline")));
        assert!(is_valid_approval_decision(&json!("cancel")));
        assert!(is_valid_approval_decision(&json!({
            "acceptWithExecpolicyAmendment": {
                "execpolicy_amendment": ["--allow-network", "git"]
            }
        })));
    }

    #[test]
    fn approval_decision_validation_rejects_invalid_values() {
        assert!(!is_valid_approval_decision(&json!("approve")));
        assert!(!is_valid_approval_decision(&json!({
            "acceptWithExecpolicyAmendment": {
                "execpolicy_amendment": []
            }
        })));
        assert!(!is_valid_approval_decision(&json!({
            "acceptWithExecpolicyAmendment": {
                "execpolicy_amendment": ["ok", 1]
            }
        })));
        assert!(!is_valid_approval_decision(&json!({
            "acceptWithExecpolicyAmendment": {}
        })));
    }

    #[test]
    fn parse_internal_id_supports_numeric_and_string_ids() {
        assert_eq!(parse_internal_id(Some(&json!(42))), Some(42));
        assert_eq!(parse_internal_id(Some(&json!("17"))), Some(17));
        assert_eq!(parse_internal_id(Some(&json!(-1))), None);
        assert_eq!(parse_internal_id(Some(&json!("invalid"))), None);
        assert_eq!(parse_internal_id(None), None);
    }

    #[test]
    fn parse_execpolicy_amendment_supports_array_and_object_forms() {
        assert_eq!(
            parse_execpolicy_amendment(Some(&json!(["--allow-network", "git"]))),
            Some(vec!["--allow-network".to_string(), "git".to_string()])
        );
        assert_eq!(
            parse_execpolicy_amendment(Some(&json!({
                "execpolicy_amendment": ["npm", "test"]
            }))),
            Some(vec!["npm".to_string(), "test".to_string()])
        );
    }

    #[test]
    fn parse_execpolicy_amendment_rejects_invalid_or_empty_values() {
        assert_eq!(parse_execpolicy_amendment(Some(&json!([]))), None);
        assert_eq!(
            parse_execpolicy_amendment(Some(&json!({ "execpolicy_amendment": [1, true] }))),
            None
        );
        assert_eq!(
            parse_execpolicy_amendment(Some(&json!({ "other": ["x"] }))),
            None
        );
        assert_eq!(parse_execpolicy_amendment(Some(&json!(null))), None);
    }

    #[test]
    fn parse_user_input_questions_filters_invalid_entries_and_maps_options() {
        let questions = parse_user_input_questions(Some(&json!([
            {
                "id": "q1",
                "header": "Repo",
                "question": "Pick one",
                "isOther": true,
                "isSecret": false,
                "options": [
                    { "label": "main", "description": "default branch" },
                    { "label": "develop" },
                    { "description": "missing label" }
                ]
            },
            {
                "id": "q2",
                "question": "Missing header"
            },
            "not-an-object"
        ])));

        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].id, "q1");
        assert_eq!(questions[0].header, "Repo");
        assert_eq!(questions[0].question, "Pick one");
        assert!(questions[0].is_other);
        assert!(!questions[0].is_secret);
        let options = questions[0].options.as_ref().expect("options to exist");
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].label, "main");
        assert_eq!(options[0].description, "default branch");
        assert_eq!(options[1].label, "develop");
        assert_eq!(options[1].description, "");
    }

    #[test]
    fn user_input_answer_validation_enforces_non_empty_ids_and_answers() {
        let mut valid = HashMap::new();
        valid.insert(
            "q1".to_string(),
            UserInputAnswerPayload {
                answers: vec!["yes".to_string()],
            },
        );
        assert!(is_valid_user_input_answers(&valid));

        let mut invalid_question_id = HashMap::new();
        invalid_question_id.insert(
            "  ".to_string(),
            UserInputAnswerPayload {
                answers: vec!["yes".to_string()],
            },
        );
        assert!(!is_valid_user_input_answers(&invalid_question_id));

        let mut invalid_empty_answers = HashMap::new();
        invalid_empty_answers.insert(
            "q1".to_string(),
            UserInputAnswerPayload {
                answers: Vec::new(),
            },
        );
        assert!(!is_valid_user_input_answers(&invalid_empty_answers));

        let mut invalid_blank_answer = HashMap::new();
        invalid_blank_answer.insert(
            "q1".to_string(),
            UserInputAnswerPayload {
                answers: vec!["   ".to_string()],
            },
        );
        assert!(!is_valid_user_input_answers(&invalid_blank_answer));
    }

    #[test]
    fn decode_base64_payload_supports_standard_urlsafe_and_data_uri_inputs() {
        assert_eq!(
            decode_base64_payload("aGVsbG8=").expect("decode standard base64"),
            b"hello".to_vec()
        );
        assert_eq!(
            decode_base64_payload("data:text/plain;base64,aGVsbG8=")
                .expect("decode data-uri base64"),
            b"hello".to_vec()
        );
        assert_eq!(
            decode_base64_payload("_w==").expect("decode url-safe base64"),
            vec![255]
        );
    }

    #[test]
    fn decode_base64_payload_rejects_invalid_payloads() {
        assert!(decode_base64_payload("not@@base64").is_err());
        assert!(decode_base64_payload("data:text/plain;base64,").is_err());
    }

    #[test]
    fn estimate_base64_decoded_size_matches_expected_values() {
        assert_eq!(
            estimate_base64_decoded_size("aGVsbG8=").unwrap_or_default(),
            5
        );
        assert_eq!(
            estimate_base64_decoded_size("data:text/plain;base64,aGVsbG8=").unwrap_or_default(),
            5
        );
        assert_eq!(estimate_base64_decoded_size("YQ==").unwrap_or_default(), 1);
    }

    #[test]
    fn resolve_bridge_workdir_requires_absolute_existing_paths() {
        let temp_dir = env::temp_dir();
        let resolved = resolve_bridge_workdir(temp_dir.clone()).expect("resolve temp dir");
        assert!(resolved.is_absolute());

        assert!(resolve_bridge_workdir(PathBuf::from("relative/path")).is_err());

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after unix epoch")
            .as_nanos();
        let missing = env::temp_dir().join(format!("clawdex-missing-{nonce}"));
        assert!(resolve_bridge_workdir(missing).is_err());
    }

    #[test]
    fn attachment_kind_normalization_uses_kind_then_mime_fallback() {
        assert_eq!(normalize_attachment_kind(Some("image"), None), "image");
        assert_eq!(normalize_attachment_kind(Some(" FILE "), None), "file");
        assert_eq!(
            normalize_attachment_kind(Some("unknown"), Some("image/png")),
            "image"
        );
        assert_eq!(
            normalize_attachment_kind(None, Some("application/pdf")),
            "file"
        );
    }

    #[test]
    fn attachment_file_name_building_sanitizes_and_infers_extension() {
        assert_eq!(
            build_attachment_file_name(None, Some("image/png"), "image"),
            "image.png"
        );
        assert_eq!(
            build_attachment_file_name(Some("../weird name?.txt"), None, "file"),
            "weird_name_.txt"
        );
        assert_eq!(
            build_attachment_file_name(Some("notes"), Some("application/json"), "file"),
            "notes.json"
        );
    }

    #[test]
    fn sanitize_filename_drops_path_segments_and_limits_length() {
        assert_eq!(
            sanitize_filename("../unsafe/..\\evil?.txt"),
            "evil_.txt".to_string()
        );
        assert_eq!(sanitize_filename("..."), "attachment".to_string());
        assert_eq!(sanitize_filename(&"a".repeat(120)).len(), 96);
    }

    #[test]
    fn sanitize_path_segment_keeps_safe_characters_only() {
        assert_eq!(
            sanitize_path_segment(" ../Thread 01/.. "),
            "Thread_01".to_string()
        );
        assert_eq!(sanitize_path_segment(&"a".repeat(80)).len(), 64);
    }

    #[test]
    fn infer_extension_from_mime_handles_supported_and_unknown_values() {
        assert_eq!(infer_extension_from_mime(Some("image/JPEG")), Some("jpg"));
        assert_eq!(infer_extension_from_mime(Some("text/plain")), Some("txt"));
        assert_eq!(infer_extension_from_mime(Some("application/zip")), None);
    }

    #[test]
    fn disallowed_control_character_detection_flags_shell_metacharacters() {
        assert!(!contains_disallowed_control_chars("git status"));
        assert!(contains_disallowed_control_chars("echo hi; ls"));
        assert!(contains_disallowed_control_chars("echo `whoami`"));
    }

    #[test]
    fn normalize_path_collapses_current_and_parent_components() {
        assert_eq!(
            normalize_path(Path::new("/tmp/./bridge/../repo/./main.rs")),
            PathBuf::from("/tmp/repo/main.rs")
        );
        assert_eq!(
            normalize_path(Path::new("a/b/../c/./d")),
            PathBuf::from("a/c/d")
        );
    }

    #[test]
    fn constant_time_eq_handles_equal_and_different_strings() {
        assert!(constant_time_eq("secret-token", "secret-token"));
        assert!(!constant_time_eq("secret-token", "secret-tok3n"));
        assert!(!constant_time_eq("secret-token", "secret-token-extra"));
    }

    #[test]
    fn bridge_config_authorization_validates_header_and_query_token_paths() {
        let base = BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            workdir: PathBuf::from("/tmp/workdir"),
            cli_bin: "codex".to_string(),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            allow_outside_root_cwd: false,
            disable_terminal_exec: false,
            terminal_allowed_commands: HashSet::new(),
        };

        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            "bearer secret-token".parse().expect("header value"),
        );
        assert!(base.is_authorized(&headers, None));
        assert!(!base.is_authorized(&HeaderMap::new(), Some("secret-token")));
        assert!(!base.is_authorized(&HeaderMap::new(), Some("secret-tok3n")));

        let mut query_allowed = base.clone();
        query_allowed.allow_query_token_auth = true;
        assert!(query_allowed.is_authorized(&HeaderMap::new(), Some("secret-token")));
        assert!(query_allowed.is_authorized(&HeaderMap::new(), Some("  secret-token  ")));

        let mut auth_disabled = base;
        auth_disabled.auth_enabled = false;
        auth_disabled.auth_token = None;
        assert!(auth_disabled.is_authorized(&HeaderMap::new(), None));
    }

    #[tokio::test]
    async fn app_server_forwarded_response_routes_to_original_client_request_id() {
        let hub = Arc::new(ClientHub::new());
        let bridge = build_test_bridge(hub.clone()).await;
        let (client_id, mut rx) = add_test_client(&hub).await;

        bridge
            .forward_request(
                client_id,
                json!("client-req-1"),
                "thread/start",
                Some(json!({ "foo": "bar" })),
            )
            .await
            .expect("forward request");

        bridge
            .handle_response(json!({ "id": 1, "result": { "ok": true } }))
            .await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], "client-req-1");
        assert_eq!(payload["result"]["ok"], true);
        assert!(bridge.pending_requests.lock().await.is_empty());

        shutdown_test_bridge(&bridge).await;
    }

    #[tokio::test]
    async fn app_server_fail_all_pending_notifies_waiting_clients() {
        let hub = Arc::new(ClientHub::new());
        let bridge = build_test_bridge(hub.clone()).await;
        let (client_a, mut rx_a) = add_test_client(&hub).await;
        let (client_b, mut rx_b) = add_test_client(&hub).await;

        bridge
            .forward_request(client_a, json!("req-a"), "thread/start", None)
            .await
            .expect("forward request a");
        bridge
            .forward_request(client_b, json!("req-b"), "thread/start", None)
            .await
            .expect("forward request b");

        bridge.fail_all_pending("app-server closed").await;

        let payload_a = recv_client_json(&mut rx_a).await;
        let payload_b = recv_client_json(&mut rx_b).await;

        assert_eq!(payload_a["id"], "req-a");
        assert_eq!(payload_a["error"]["code"], -32000);
        assert_eq!(payload_b["id"], "req-b");
        assert_eq!(payload_b["error"]["code"], -32000);

        shutdown_test_bridge(&bridge).await;
    }

    #[tokio::test]
    async fn app_server_response_completes_internal_waiter() {
        let hub = Arc::new(ClientHub::new());
        let bridge = build_test_bridge(hub).await;
        let (tx, rx) = oneshot::channel();
        bridge.internal_waiters.lock().await.insert(7, tx);

        bridge
            .handle_response(json!({ "id": 7, "result": { "initialized": true } }))
            .await;

        let result = rx.await.expect("waiter result").expect("successful result");
        assert_eq!(result["initialized"], true);

        shutdown_test_bridge(&bridge).await;
    }

    #[tokio::test]
    async fn handle_client_message_returns_parse_error_for_invalid_json() {
        let state = build_test_state().await;
        let (client_id, mut rx) = add_test_client(&state.hub).await;

        handle_client_message(client_id, "{invalid-json".to_string(), &state).await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], Value::Null);
        assert_eq!(payload["error"]["code"], -32700);

        shutdown_test_bridge(&state.app_server).await;
    }

    #[tokio::test]
    async fn handle_client_message_rejects_missing_method() {
        let state = build_test_state().await;
        let (client_id, mut rx) = add_test_client(&state.hub).await;

        handle_client_message(client_id, json!({ "id": "abc" }).to_string(), &state).await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], "abc");
        assert_eq!(payload["error"]["code"], -32600);
        assert_eq!(payload["error"]["message"], "Missing method");

        shutdown_test_bridge(&state.app_server).await;
    }

    #[tokio::test]
    async fn handle_client_message_rejects_non_allowlisted_methods() {
        let state = build_test_state().await;
        let (client_id, mut rx) = add_test_client(&state.hub).await;

        handle_client_message(
            client_id,
            json!({
                "id": "abc",
                "method": "thread/delete",
            })
            .to_string(),
            &state,
        )
        .await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], "abc");
        assert_eq!(payload["error"]["code"], -32601);

        shutdown_test_bridge(&state.app_server).await;
    }

    #[tokio::test]
    async fn handle_client_message_forwards_allowlisted_methods_and_relays_result() {
        let state = build_test_state().await;
        let (client_id, mut rx) = add_test_client(&state.hub).await;

        handle_client_message(
            client_id,
            json!({
                "id": "request-1",
                "method": "thread/start",
                "params": { "model": "o3-mini" }
            })
            .to_string(),
            &state,
        )
        .await;

        state
            .app_server
            .handle_response(json!({
                "id": 1,
                "result": { "threadId": "thr_123" }
            }))
            .await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], "request-1");
        assert_eq!(payload["result"]["threadId"], "thr_123");

        shutdown_test_bridge(&state.app_server).await;
    }
}
