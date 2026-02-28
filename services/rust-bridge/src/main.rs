use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    hash::{Hash, Hasher},
    io::SeekFrom,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
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
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot, Mutex, RwLock},
    time::timeout,
};

mod services;

const APPROVAL_COMMAND_METHOD: &str = "item/commandExecution/requestApproval";
const APPROVAL_FILE_METHOD: &str = "item/fileChange/requestApproval";
const LEGACY_APPROVAL_PATCH_METHOD: &str = "applyPatchApproval";
const LEGACY_APPROVAL_COMMAND_METHOD: &str = "execCommandApproval";
const REQUEST_USER_INPUT_METHOD: &str = "item/tool/requestUserInput";
const REQUEST_USER_INPUT_METHOD_ALT: &str = "tool/requestUserInput";
const DYNAMIC_TOOL_CALL_METHOD: &str = "item/tool/call";
const ACCOUNT_CHATGPT_TOKENS_REFRESH_METHOD: &str = "account/chatgptAuthTokens/refresh";
const MOBILE_ATTACHMENTS_DIR: &str = ".clawdex-mobile-attachments";
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const DEFAULT_MAX_VOICE_TRANSCRIPTION_BYTES: usize = 100 * 1024 * 1024;
const NOTIFICATION_REPLAY_BUFFER_SIZE: usize = 2_000;
const NOTIFICATION_REPLAY_MAX_LIMIT: usize = 1_000;
const WS_CLIENT_QUEUE_CAPACITY: usize = 256;
const ROLLOUT_LIVE_SYNC_POLL_INTERVAL_MS: u64 = 900;
const ROLLOUT_LIVE_SYNC_DISCOVERY_INTERVAL_TICKS: u64 = 1;
const ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES: usize = 64;
const ROLLOUT_LIVE_SYNC_MAX_FILE_AGE: Duration = Duration::from_secs(60 * 60 * 24 * 2);
const ROLLOUT_LIVE_SYNC_INITIAL_TAIL_BYTES: u64 = 64 * 1024;
const ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY: usize = 8_192;

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

#[derive(Clone, Copy)]
enum ApprovalResponseFormat {
    Modern,
    Legacy,
}

#[derive(Clone)]
struct PendingApprovalEntry {
    app_server_request_id: Value,
    response_format: ApprovalResponseFormat,
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

        let Some(mapped_decision) =
            approval_decision_to_response_value(decision, pending.response_format)
        else {
            self.pending_approvals
                .lock()
                .await
                .insert(approval_id.to_string(), pending.clone());
            return Err("invalid approval decision payload".to_string());
        };

        let response = json!({
            "id": pending.app_server_request_id,
            "result": {
                "decision": mapped_decision
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
        if matches!(
            method,
            APPROVAL_COMMAND_METHOD
                | APPROVAL_FILE_METHOD
                | LEGACY_APPROVAL_PATCH_METHOD
                | LEGACY_APPROVAL_COMMAND_METHOD
        ) {
            let params_obj = params.as_ref().and_then(Value::as_object);
            let approval_id = format!(
                "{}-{}",
                Utc::now().timestamp_millis(),
                self.approval_counter.fetch_add(1, Ordering::Relaxed)
            );

            let response_format = if matches!(
                method,
                LEGACY_APPROVAL_PATCH_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                ApprovalResponseFormat::Legacy
            } else {
                ApprovalResponseFormat::Modern
            };

            let kind = if matches!(
                method,
                APPROVAL_COMMAND_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                "commandExecution".to_string()
            } else {
                "fileChange".to_string()
            };

            let thread_id = if matches!(
                method,
                LEGACY_APPROVAL_PATCH_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                read_string(params_obj.and_then(|p| p.get("conversationId")))
                    .unwrap_or_else(|| "unknown-thread".to_string())
            } else {
                read_string(params_obj.and_then(|p| p.get("threadId")))
                    .unwrap_or_else(|| "unknown-thread".to_string())
            };

            let legacy_call_id = read_string(params_obj.and_then(|p| p.get("callId")));
            let turn_id = if matches!(
                method,
                LEGACY_APPROVAL_PATCH_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                legacy_call_id
                    .clone()
                    .unwrap_or_else(|| "unknown-turn".to_string())
            } else {
                read_string(params_obj.and_then(|p| p.get("turnId")))
                    .unwrap_or_else(|| "unknown-turn".to_string())
            };

            let item_id = if method == LEGACY_APPROVAL_COMMAND_METHOD {
                read_string(params_obj.and_then(|p| p.get("approvalId")))
                    .or_else(|| legacy_call_id.clone())
                    .unwrap_or_else(|| "unknown-item".to_string())
            } else if method == LEGACY_APPROVAL_PATCH_METHOD {
                legacy_call_id
                    .clone()
                    .unwrap_or_else(|| "unknown-item".to_string())
            } else {
                read_string(params_obj.and_then(|p| p.get("itemId")))
                    .unwrap_or_else(|| "unknown-item".to_string())
            };

            let approval = PendingApproval {
                id: approval_id.clone(),
                kind,
                thread_id,
                turn_id,
                item_id,
                requested_at: now_iso(),
                reason: read_string(params_obj.and_then(|p| p.get("reason"))),
                command: if method == LEGACY_APPROVAL_COMMAND_METHOD {
                    read_shell_command(params_obj.and_then(|p| p.get("command")))
                } else {
                    read_string(params_obj.and_then(|p| p.get("command")))
                },
                cwd: read_string(params_obj.and_then(|p| p.get("cwd"))),
                grant_root: read_string(params_obj.and_then(|p| p.get("grantRoot"))),
                proposed_execpolicy_amendment: parse_execpolicy_amendment(
                    if method == APPROVAL_COMMAND_METHOD {
                        params_obj.and_then(|p| p.get("proposedExecpolicyAmendment"))
                    } else {
                        None
                    },
                ),
            };

            self.pending_approvals.lock().await.insert(
                approval_id,
                PendingApprovalEntry {
                    app_server_request_id: id,
                    response_format,
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

        if method == DYNAMIC_TOOL_CALL_METHOD {
            self.hub
                .broadcast_notification(
                    "bridge/tool.call.unsupported",
                    json!({
                        "requestedAt": now_iso(),
                        "message": "Dynamic tool calls are not supported by clawdex-mobile bridge",
                        "request": params.clone().unwrap_or(Value::Null),
                    }),
                )
                .await;

            let _ = self
                .write_json(json!({
                    "id": id,
                    "result": {
                        "success": false,
                        "contentItems": [
                            {
                                "type": "inputText",
                                "text": "Dynamic tool calls are not supported by clawdex-mobile bridge"
                            }
                        ]
                    }
                }))
                .await;
            return;
        }

        if method == ACCOUNT_CHATGPT_TOKENS_REFRESH_METHOD {
            let access_token = read_non_empty_env("BRIDGE_CHATGPT_ACCESS_TOKEN");
            let account_id = read_non_empty_env("BRIDGE_CHATGPT_ACCOUNT_ID");
            let plan_type = read_non_empty_env("BRIDGE_CHATGPT_PLAN_TYPE");

            if let (Some(access_token), Some(chatgpt_account_id)) = (access_token, account_id) {
                let mut result = json!({
                    "accessToken": access_token,
                    "chatgptAccountId": chatgpt_account_id,
                    "chatgptPlanType": Value::Null,
                });

                if let Some(plan_type) = plan_type {
                    result["chatgptPlanType"] = json!(plan_type);
                }

                let _ = self
                    .write_json(json!({
                        "id": id,
                        "result": result
                    }))
                    .await;
            } else {
                self.hub
                    .broadcast_notification(
                        "bridge/account.chatgptAuthTokens.refresh.required",
                        json!({
                            "requestedAt": now_iso(),
                            "reason": params
                                .as_ref()
                                .and_then(Value::as_object)
                                .and_then(|raw| raw.get("reason"))
                                .and_then(Value::as_str)
                                .unwrap_or("unauthorized"),
                        }),
                    )
                    .await;

                let _ = self
                    .write_json(json!({
                        "id": id,
                        "error": {
                            "code": -32001,
                            "message": "account/chatgptAuthTokens/refresh is not configured (set BRIDGE_CHATGPT_ACCESS_TOKEN and BRIDGE_CHATGPT_ACCOUNT_ID)"
                        }
                    }))
                    .await;
            }
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

#[derive(Default)]
struct RolloutLiveSyncState {
    files: HashMap<PathBuf, RolloutTrackedFile>,
    tick: u64,
}

struct RolloutTrackedFile {
    path: PathBuf,
    offset: u64,
    partial_line: String,
    drop_first_partial_line: bool,
    thread_id: Option<String>,
    originator: Option<String>,
    include_for_live_sync: bool,
    last_seen: Instant,
    recent_line_hashes: VecDeque<u64>,
    recent_line_hash_set: HashSet<u64>,
}

impl RolloutTrackedFile {
    async fn new(path: PathBuf) -> Result<Self, std::io::Error> {
        let metadata = fs::metadata(&path).await?;
        let mut thread_id = None;
        let mut originator = None;
        let mut include_for_live_sync = false;

        if let Some((meta_thread_id, meta_originator)) = read_rollout_session_meta(&path).await? {
            include_for_live_sync = rollout_originator_allowed(meta_originator.as_deref());
            thread_id = Some(meta_thread_id);
            originator = meta_originator;
        }

        let offset = metadata
            .len()
            .saturating_sub(ROLLOUT_LIVE_SYNC_INITIAL_TAIL_BYTES);
        Ok(Self {
            path,
            offset,
            partial_line: String::new(),
            drop_first_partial_line: offset > 0,
            thread_id,
            originator,
            include_for_live_sync,
            last_seen: Instant::now(),
            recent_line_hashes: VecDeque::new(),
            recent_line_hash_set: HashSet::new(),
        })
    }

    async fn poll(&mut self, hub: &Arc<ClientHub>) -> Result<(), std::io::Error> {
        let mut file = match fs::File::open(&self.path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(error);
            }
            Err(error) => return Err(error),
        };

        let metadata = file.metadata().await?;
        let len = metadata.len();

        if len < self.offset {
            self.offset = 0;
            self.partial_line.clear();
            self.drop_first_partial_line = false;
            self.recent_line_hashes.clear();
            self.recent_line_hash_set.clear();
        }

        if len == self.offset {
            return Ok(());
        }

        file.seek(SeekFrom::Start(self.offset)).await?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        self.offset = len;
        self.last_seen = Instant::now();

        if bytes.is_empty() {
            return Ok(());
        }

        let chunk = String::from_utf8_lossy(&bytes);
        let mut combined = String::with_capacity(self.partial_line.len() + chunk.len());
        combined.push_str(&self.partial_line);
        combined.push_str(&chunk);
        self.partial_line.clear();

        if self.drop_first_partial_line {
            if let Some(index) = combined.find('\n') {
                combined = combined[(index + 1)..].to_string();
                self.drop_first_partial_line = false;
            } else {
                self.partial_line = combined;
                return Ok(());
            }
        }

        let has_trailing_newline = combined.ends_with('\n');
        let mut lines = combined.split('\n').map(str::to_string).collect::<Vec<_>>();
        if !has_trailing_newline {
            self.partial_line = lines.pop().unwrap_or_default();
        }

        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let line_hash = hash_rollout_line(trimmed);
            if !self.remember_line_hash(line_hash) {
                continue;
            }

            if let Some((method, params)) = self.to_notification(trimmed) {
                if let Some(status_payload) = build_rollout_thread_status_notification(&method, &params)
                {
                    hub.broadcast_notification("thread/status/changed", status_payload)
                        .await;
                }
                hub.broadcast_notification(&method, params).await;
            }
        }

        Ok(())
    }

    fn remember_line_hash(&mut self, line_hash: u64) -> bool {
        if self.recent_line_hash_set.contains(&line_hash) {
            return false;
        }

        self.recent_line_hash_set.insert(line_hash);
        self.recent_line_hashes.push_back(line_hash);
        while self.recent_line_hashes.len() > ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY {
            if let Some(oldest) = self.recent_line_hashes.pop_front() {
                self.recent_line_hash_set.remove(&oldest);
            }
        }

        true
    }

    fn to_notification(&mut self, line: &str) -> Option<(String, Value)> {
        let parsed = serde_json::from_str::<Value>(line).ok()?;
        let parsed_object = parsed.as_object()?;
        let record_type = read_string(parsed_object.get("type"))?;
        let timestamp = read_string(parsed_object.get("timestamp"));
        let payload = parsed_object.get("payload")?.as_object()?;

        if record_type == "session_meta" {
            self.thread_id =
                extract_rollout_thread_id(payload, true).or_else(|| self.thread_id.clone());
            self.originator =
                read_string(payload.get("originator")).or_else(|| self.originator.clone());
            self.include_for_live_sync = self.thread_id.is_some()
                && rollout_originator_allowed(self.originator.as_deref());
            return None;
        }

        if !self.include_for_live_sync {
            return None;
        }

        if let Some(payload_thread_id) = extract_rollout_thread_id(payload, false) {
            self.thread_id = Some(payload_thread_id);
        }

        let thread_id = self.thread_id.as_deref()?;
        if record_type == "event_msg" {
            return build_rollout_event_msg_notification(payload, thread_id, timestamp.as_deref());
        }

        if record_type == "response_item" {
            return build_rollout_response_item_notification(
                payload,
                thread_id,
                timestamp.as_deref(),
            );
        }

        None
    }
}

fn spawn_rollout_live_sync(hub: Arc<ClientHub>) {
    tokio::spawn(async move {
        let Some(sessions_root) = resolve_codex_sessions_root() else {
            return;
        };

        let mut state = RolloutLiveSyncState::default();
        let mut ticker =
            tokio::time::interval(Duration::from_millis(ROLLOUT_LIVE_SYNC_POLL_INTERVAL_MS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            state.tick = state.tick.wrapping_add(1);

            if should_run_rollout_discovery_tick(
                state.tick,
                ROLLOUT_LIVE_SYNC_DISCOVERY_INTERVAL_TICKS,
            ) {
                if let Err(error) =
                    rollout_live_sync_discover_files(&sessions_root, &mut state).await
                {
                    eprintln!("rollout live sync discovery failed: {error}");
                }
            }

            if let Err(error) = rollout_live_sync_poll_files(&hub, &mut state).await {
                eprintln!("rollout live sync poll failed: {error}");
            }
        }
    });
}

fn resolve_codex_sessions_root() -> Option<PathBuf> {
    if let Some(codex_home) = read_non_empty_env("CODEX_HOME") {
        let root = PathBuf::from(codex_home).join("sessions");
        if root.is_dir() {
            return Some(root);
        }
    }

    let home = read_non_empty_env("HOME")?;
    let root = PathBuf::from(home).join(".codex").join("sessions");
    if root.is_dir() {
        Some(root)
    } else {
        None
    }
}

async fn rollout_live_sync_discover_files(
    sessions_root: &Path,
    state: &mut RolloutLiveSyncState,
) -> Result<(), std::io::Error> {
    let discovered_paths = discover_recent_rollout_files(sessions_root).await?;
    let discovered_set = discovered_paths.iter().cloned().collect::<HashSet<_>>();

    for path in discovered_paths {
        if state.files.contains_key(&path) {
            continue;
        }

        match RolloutTrackedFile::new(path.clone()).await {
            Ok(tracked) => {
                state.files.insert(path, tracked);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }

    state.files.retain(|path, tracked| {
        discovered_set.contains(path)
            || tracked.last_seen.elapsed() < ROLLOUT_LIVE_SYNC_MAX_FILE_AGE
    });

    Ok(())
}

async fn rollout_live_sync_poll_files(
    hub: &Arc<ClientHub>,
    state: &mut RolloutLiveSyncState,
) -> Result<(), std::io::Error> {
    let tracked_paths = state.files.keys().cloned().collect::<Vec<_>>();
    let mut removed_paths = Vec::new();

    for path in tracked_paths {
        let Some(tracked) = state.files.get_mut(&path) else {
            continue;
        };

        match tracked.poll(hub).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                removed_paths.push(path.clone());
            }
            Err(error) => return Err(error),
        }
    }

    for path in removed_paths {
        state.files.remove(&path);
    }

    Ok(())
}

async fn discover_recent_rollout_files(root: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let now = SystemTime::now();
    let mut stack = vec![root.to_path_buf()];
    let mut matches = Vec::<(PathBuf, SystemTime)>::new();

    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let metadata = entry.metadata().await?;

            if metadata.is_dir() {
                stack.push(path);
                continue;
            }

            if !metadata.is_file() || !is_rollout_file_path(&path) {
                continue;
            }

            let modified = metadata.modified().unwrap_or(now);
            if now
                .duration_since(modified)
                .unwrap_or_else(|_| Duration::from_secs(0))
                > ROLLOUT_LIVE_SYNC_MAX_FILE_AGE
            {
                continue;
            }

            matches.push((path, modified));
        }
    }

    matches.sort_by(|left, right| right.1.cmp(&left.1));
    matches.truncate(ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES);

    Ok(matches.into_iter().map(|(path, _)| path).collect())
}

fn is_rollout_file_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

async fn read_rollout_session_meta(
    path: &Path,
) -> Result<Option<(String, Option<String>)>, std::io::Error> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    let mut lines = BufReader::new(file).lines();
    let Some(first_line) = lines.next_line().await? else {
        return Ok(None);
    };

    let parsed = match serde_json::from_str::<Value>(&first_line) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(None),
    };

    let parsed_object = match parsed.as_object() {
        Some(object) => object,
        None => return Ok(None),
    };

    if read_string(parsed_object.get("type")).as_deref() != Some("session_meta") {
        return Ok(None);
    }

    let payload = match parsed_object.get("payload").and_then(Value::as_object) {
        Some(payload) => payload,
        None => return Ok(None),
    };

    let thread_id = match extract_rollout_thread_id(payload, true) {
        Some(id) => id,
        None => return Ok(None),
    };
    let originator = read_string(payload.get("originator"));

    Ok(Some((thread_id, originator)))
}

fn extract_rollout_thread_id(
    payload: &serde_json::Map<String, Value>,
    allow_session_id_fallback: bool,
) -> Option<String> {
    let source = payload.get("source").and_then(Value::as_object);
    let source_subagent = source
        .and_then(|value| value.get("subagent"))
        .and_then(Value::as_object);
    let source_thread_spawn = source_subagent
        .and_then(|value| value.get("thread_spawn"))
        .and_then(Value::as_object);

    read_string(payload.get("thread_id"))
        .or_else(|| read_string(payload.get("threadId")))
        .or_else(|| read_string(payload.get("conversation_id")))
        .or_else(|| read_string(payload.get("conversationId")))
        .or_else(|| source.and_then(|value| read_string(value.get("thread_id"))))
        .or_else(|| source.and_then(|value| read_string(value.get("threadId"))))
        .or_else(|| source.and_then(|value| read_string(value.get("conversation_id"))))
        .or_else(|| source.and_then(|value| read_string(value.get("conversationId"))))
        .or_else(|| source.and_then(|value| read_string(value.get("parent_thread_id"))))
        .or_else(|| source.and_then(|value| read_string(value.get("parentThreadId"))))
        .or_else(|| {
            source_thread_spawn.and_then(|value| read_string(value.get("parent_thread_id")))
        })
        .or_else(|| {
            if allow_session_id_fallback {
                read_string(payload.get("id"))
            } else {
                None
            }
        })
}

fn hash_rollout_line(line: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    line.hash(&mut hasher);
    hasher.finish()
}

fn should_run_rollout_discovery_tick(tick: u64, interval_ticks: u64) -> bool {
    if interval_ticks <= 1 {
        return true;
    }

    tick == 1 || tick % interval_ticks == 0
}

fn rollout_originator_allowed(originator: Option<&str>) -> bool {
    match originator {
        Some(value) => {
            let normalized = value.to_ascii_lowercase();
            normalized.contains("codex") || normalized.contains("clawdex")
        }
        None => true,
    }
}

fn build_rollout_thread_status_notification(method: &str, params: &Value) -> Option<Value> {
    let codex_event_type = method.strip_prefix("codex/event/")?;
    let status = match codex_event_type {
        "task_started" | "taskstarted" => "running",
        "task_complete" | "taskcomplete" => "completed",
        "task_failed" | "taskfailed" | "turn_failed" | "turnfailed" => "failed",
        "task_interrupted" | "taskinterrupted" | "turn_aborted" | "turnaborted" => {
            "interrupted"
        }
        _ => return None,
    };

    let msg = params
        .as_object()
        .and_then(|value| value.get("msg"))
        .and_then(Value::as_object)?;
    let thread_id =
        read_string(msg.get("thread_id")).or_else(|| read_string(msg.get("threadId")))?;

    Some(json!({
        "threadId": thread_id,
        "thread_id": thread_id,
        "status": status,
        "source": "rollout_live_sync",
    }))
}

fn build_rollout_event_msg_notification(
    payload: &serde_json::Map<String, Value>,
    thread_id: &str,
    timestamp: Option<&str>,
) -> Option<(String, Value)> {
    let raw_type = read_string(payload.get("type"))?;
    if matches!(
        raw_type.as_str(),
        "token_count" | "user_message" | "context_compacted"
    ) {
        return None;
    }

    let mut msg = payload.clone();
    msg.entry("thread_id".to_string())
        .or_insert_with(|| json!(thread_id));
    msg.entry("threadId".to_string())
        .or_insert_with(|| json!(thread_id));
    if let Some(timestamp) = timestamp {
        msg.entry("timestamp".to_string())
            .or_insert_with(|| json!(timestamp));
    }

    if raw_type == "agent_reasoning" {
        let delta = read_string(payload.get("text"))?;
        if delta.trim().is_empty() {
            return None;
        }
        msg.insert("type".to_string(), json!("agent_reasoning_delta"));
        msg.insert("delta".to_string(), json!(delta));
        return Some((
            "codex/event/agent_reasoning_delta".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    if raw_type == "agent_message" {
        let delta = read_string(payload.get("message"))?;
        if delta.trim().is_empty() {
            return None;
        }
        msg.insert("type".to_string(), json!("agent_message_delta"));
        msg.insert("delta".to_string(), json!(delta));
        return Some((
            "codex/event/agent_message_delta".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    Some((
        format!("codex/event/{raw_type}"),
        json!({ "msg": Value::Object(msg) }),
    ))
}

fn build_rollout_response_item_notification(
    payload: &serde_json::Map<String, Value>,
    thread_id: &str,
    timestamp: Option<&str>,
) -> Option<(String, Value)> {
    let item_type = read_string(payload.get("type"))?;
    if item_type != "function_call" {
        return None;
    }

    let name = read_string(payload.get("name"))?;
    let arguments = parse_rollout_function_call_arguments(payload.get("arguments"));

    if name == "exec_command" {
        let command = arguments
            .as_object()
            .and_then(|object| read_shell_command(object.get("cmd")));
        let command = command?.trim().to_string();
        if command.is_empty() {
            return None;
        }

        let command_parts = shlex::split(&command).unwrap_or_else(|| vec![command.clone()]);
        let mut msg = serde_json::Map::new();
        msg.insert("type".to_string(), json!("exec_command_begin"));
        msg.insert("thread_id".to_string(), json!(thread_id));
        msg.insert("threadId".to_string(), json!(thread_id));
        msg.insert("command".to_string(), json!(command_parts));
        if let Some(call_id) = read_string(payload.get("call_id")) {
            msg.insert("call_id".to_string(), json!(call_id));
        }
        if let Some(timestamp) = timestamp {
            msg.insert("timestamp".to_string(), json!(timestamp));
        }
        return Some((
            "codex/event/exec_command_begin".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    if let Some((server, tool)) = parse_rollout_mcp_tool_name(&name) {
        let mut msg = serde_json::Map::new();
        msg.insert("type".to_string(), json!("mcp_tool_call_begin"));
        msg.insert("thread_id".to_string(), json!(thread_id));
        msg.insert("threadId".to_string(), json!(thread_id));
        msg.insert("server".to_string(), json!(server));
        msg.insert("tool".to_string(), json!(tool));
        if let Some(timestamp) = timestamp {
            msg.insert("timestamp".to_string(), json!(timestamp));
        }
        return Some((
            "codex/event/mcp_tool_call_begin".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    if name == "search_query" || name == "image_query" {
        let query = extract_rollout_search_query(&arguments)?;
        if query.trim().is_empty() {
            return None;
        }
        let mut msg = serde_json::Map::new();
        msg.insert("type".to_string(), json!("web_search_begin"));
        msg.insert("thread_id".to_string(), json!(thread_id));
        msg.insert("threadId".to_string(), json!(thread_id));
        msg.insert("query".to_string(), json!(query));
        if let Some(timestamp) = timestamp {
            msg.insert("timestamp".to_string(), json!(timestamp));
        }
        return Some((
            "codex/event/web_search_begin".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    None
}

fn parse_rollout_function_call_arguments(raw_arguments: Option<&Value>) -> Value {
    if let Some(text_arguments) = raw_arguments.and_then(Value::as_str) {
        return serde_json::from_str::<Value>(text_arguments).unwrap_or(Value::Null);
    }

    raw_arguments.cloned().unwrap_or(Value::Null)
}

fn parse_rollout_mcp_tool_name(name: &str) -> Option<(String, String)> {
    if !name.starts_with("mcp__") {
        return None;
    }

    let raw = name.trim_start_matches("mcp__");
    let mut segments = raw.split("__");
    let server = segments.next()?.trim();
    if server.is_empty() {
        return None;
    }

    let tool = segments.collect::<Vec<_>>().join("__");
    if tool.trim().is_empty() {
        return None;
    }

    Some((server.to_string(), tool))
}

fn extract_rollout_search_query(arguments: &Value) -> Option<String> {
    let object = arguments.as_object()?;

    let entries = object
        .get("search_query")
        .and_then(Value::as_array)
        .or_else(|| object.get("image_query").and_then(Value::as_array))?;

    for entry in entries {
        let query = read_string(entry.as_object().and_then(|item| item.get("q")));
        if let Some(query) = query.filter(|query| !query.trim().is_empty()) {
            return Some(query);
        }
    }

    None
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
    files: Vec<GitStatusEntry>,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusEntry {
    path: String,
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitDiffResponse {
    diff: String,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStageResponse {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    staged: bool,
    path: String,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStageAllResponse {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    staged: bool,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitUnstageResponse {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    unstaged: bool,
    path: String,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitUnstageAllResponse {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    unstaged: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitFileRequest {
    path: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTranscribeRequest {
    data_base64: String,
    prompt: Option<String>,
    file_name: Option<String>,
    mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTranscribeResponse {
    text: String,
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
    spawn_rollout_live_sync(state.hub.clone());

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
        "bridge/git/stage" => {
            let request: GitFileRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitFileRequest { path, cwd } = request;
            if path.trim().is_empty() {
                return Err(BridgeError::invalid_params("path must not be empty"));
            }

            let staged = state.git.stage_file(&path, cwd.as_deref()).await?;
            let staged_value = serde_json::to_value(&staged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if staged.staged {
                if let Ok(status) = state.git.get_status(cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(staged_value)
        }
        "bridge/git/stageAll" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let staged = state.git.stage_all(request.cwd.as_deref()).await?;
            let staged_value = serde_json::to_value(&staged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if staged.staged {
                if let Ok(status) = state.git.get_status(request.cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(staged_value)
        }
        "bridge/git/unstage" => {
            let request: GitFileRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitFileRequest { path, cwd } = request;
            if path.trim().is_empty() {
                return Err(BridgeError::invalid_params("path must not be empty"));
            }

            let unstaged = state.git.unstage_file(&path, cwd.as_deref()).await?;
            let unstaged_value = serde_json::to_value(&unstaged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if unstaged.unstaged {
                if let Ok(status) = state.git.get_status(cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(unstaged_value)
        }
        "bridge/git/unstageAll" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let unstaged = state.git.unstage_all(request.cwd.as_deref()).await?;
            let unstaged_value = serde_json::to_value(&unstaged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if unstaged.unstaged {
                if let Ok(status) = state.git.get_status(request.cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(unstaged_value)
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
                    "decision must be one of: accept/approved, acceptForSession/approved_for_session, decline/denied, cancel/abort, or an execpolicy amendment object",
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
        "bridge/voice/transcribe" => {
            let request: VoiceTranscribeRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|e| BridgeError::invalid_params(&e.to_string()))?;
            transcribe_voice(request).await
        }
        _ => Err(BridgeError::method_not_found(&format!(
            "Unknown bridge method: {method}"
        ))),
    }
}

async fn transcribe_voice(request: VoiceTranscribeRequest) -> Result<Value, BridgeError> {
    let max_voice_transcription_bytes = resolve_max_voice_transcription_bytes();
    let estimated_size = estimate_base64_decoded_size(&request.data_base64)?;
    if estimated_size > max_voice_transcription_bytes {
        return Err(BridgeError::invalid_params(&format!(
            "audio payload exceeds max size of {max_voice_transcription_bytes} bytes",
        )));
    }

    let audio_bytes = decode_base64_payload(&request.data_base64)?;

    // Minimum ~16KB — roughly 0.5s at 16kHz 16-bit mono.
    if audio_bytes.len() < 16_000 {
        return Err(BridgeError::invalid_params(
            "audio payload too short (minimum ~0.5 seconds required)",
        ));
    }
    if audio_bytes.len() > max_voice_transcription_bytes {
        return Err(BridgeError::invalid_params(&format!(
            "audio payload exceeds max size of {max_voice_transcription_bytes} bytes",
        )));
    }

    // Resolve auth: env vars first, then ~/.codex/auth.json.
    let (endpoint, bearer_token, include_model) = resolve_transcription_auth()?;
    let normalized_mime_type = normalize_transcription_mime_type(request.mime_type.as_deref());
    let normalized_file_name =
        normalize_transcription_file_name(request.file_name.as_deref(), &normalized_mime_type);

    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(normalized_file_name)
        .mime_str(&normalized_mime_type)
        .map_err(|e| BridgeError::server(&e.to_string()))?;

    let mut form = reqwest::multipart::Form::new().part("file", file_part);

    if include_model {
        form = form.text("model", "gpt-4o-transcribe");
    }

    if let Some(prompt) = request.prompt {
        let trimmed = prompt.trim().to_string();
        if !trimmed.is_empty() {
            form = form.text("prompt", trimmed);
        }
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&endpoint)
        .bearer_auth(&bearer_token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| BridgeError::server(&e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable>".to_string());
        return Err(BridgeError {
            code: -32000,
            message: format!("transcription API returned HTTP {status}"),
            data: Some(json!({ "status": status, "body": body })),
        });
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| BridgeError::server(&e.to_string()))?;

    let text = body["text"].as_str().unwrap_or("").to_string();

    Ok(serde_json::to_value(VoiceTranscribeResponse { text })
        .map_err(|e| BridgeError::server(&e.to_string()))?)
}

fn resolve_transcription_auth() -> Result<(String, String, bool), BridgeError> {
    // Path 1: OPENAI_API_KEY env var → OpenAI direct API.
    if let Some(api_key) = read_non_empty_env("OPENAI_API_KEY") {
        return Ok((
            "https://api.openai.com/v1/audio/transcriptions".to_string(),
            api_key,
            true,
        ));
    }

    // Path 2: BRIDGE_CHATGPT_ACCESS_TOKEN env var → ChatGPT backend.
    if let Some(access_token) = read_non_empty_env("BRIDGE_CHATGPT_ACCESS_TOKEN") {
        return Ok((
            "https://chatgpt.com/backend-api/transcribe".to_string(),
            access_token,
            false,
        ));
    }

    // Fall back to ~/.codex/auth.json.
    let auth_path = resolve_codex_auth_json_path();
    if let Some(path) = auth_path {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let Ok(auth) = serde_json::from_str::<Value>(&contents) {
                // Check for OPENAI_API_KEY field.
                if let Some(key) = auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()) {
                    let trimmed = key.trim();
                    if !trimmed.is_empty() {
                        return Ok((
                            "https://api.openai.com/v1/audio/transcriptions".to_string(),
                            trimmed.to_string(),
                            true,
                        ));
                    }
                }

                // Check for chatgpt auth mode with access_token.
                let is_chatgpt_mode = auth
                    .get("auth_mode")
                    .and_then(|v| v.as_str())
                    .map(|m| m == "chatgpt")
                    .unwrap_or(false);

                if is_chatgpt_mode {
                    if let Some(token) = auth
                        .get("tokens")
                        .and_then(|t| t.get("access_token"))
                        .and_then(|v| v.as_str())
                    {
                        let trimmed = token.trim();
                        if !trimmed.is_empty() {
                            return Ok((
                                "https://chatgpt.com/backend-api/transcribe".to_string(),
                                trimmed.to_string(),
                                false,
                            ));
                        }
                    }
                }
            }
        }
    }

    Err(BridgeError {
        code: -32002,
        message:
            "no transcription credentials found: set OPENAI_API_KEY or BRIDGE_CHATGPT_ACCESS_TOKEN"
                .to_string(),
        data: None,
    })
}

fn resolve_codex_auth_json_path() -> Option<PathBuf> {
    if let Some(codex_home) = read_non_empty_env("CODEX_HOME") {
        let path = PathBuf::from(codex_home).join("auth.json");
        if path.is_file() {
            return Some(path);
        }
    }
    let home = read_non_empty_env("HOME")?;
    let path = PathBuf::from(home).join(".codex").join("auth.json");
    if path.is_file() {
        Some(path)
    } else {
        None
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

fn read_non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_max_voice_transcription_bytes() -> usize {
    read_non_empty_env("BRIDGE_MAX_VOICE_TRANSCRIPTION_BYTES")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_VOICE_TRANSCRIPTION_BYTES)
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
        "account/login/cancel"
            | "account/login/start"
            | "account/logout"
            | "account/rateLimits/read"
            | "account/read"
            | "app/list"
            | "collaborationMode/list"
            | "command/exec"
            | "config/batchWrite"
            | "config/mcpServer/reload"
            | "config/read"
            | "config/value/write"
            | "configRequirements/read"
            | "experimentalFeature/list"
            | "feedback/upload"
            | "fuzzyFileSearch/sessionStart"
            | "fuzzyFileSearch/sessionStop"
            | "fuzzyFileSearch/sessionUpdate"
            | "mcpServer/oauth/login"
            | "mcpServerStatus/list"
            | "mock/experimentalMethod"
            | "model/list"
            | "review/start"
            | "skills/config/write"
            | "skills/list"
            | "skills/remote/export"
            | "skills/remote/list"
            | "thread/archive"
            | "thread/backgroundTerminals/clean"
            | "thread/compact/start"
            | "thread/fork"
            | "thread/list"
            | "thread/loaded/list"
            | "thread/name/set"
            | "thread/read"
            | "thread/resume"
            | "thread/rollback"
            | "thread/start"
            | "thread/unarchive"
            | "turn/interrupt"
            | "turn/start"
            | "turn/steer"
    )
}

#[derive(Clone)]
enum ApprovalDecisionCanonical {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
    AcceptWithExecpolicyAmendment(Vec<String>),
}

fn is_valid_approval_decision(value: &Value) -> bool {
    parse_approval_decision(value).is_some()
}

fn parse_approval_decision(value: &Value) -> Option<ApprovalDecisionCanonical> {
    if let Some(raw) = value.as_str() {
        return match raw {
            "accept" | "approved" => Some(ApprovalDecisionCanonical::Accept),
            "acceptForSession" | "approved_for_session" => {
                Some(ApprovalDecisionCanonical::AcceptForSession)
            }
            "decline" | "denied" => Some(ApprovalDecisionCanonical::Decline),
            "cancel" | "abort" => Some(ApprovalDecisionCanonical::Cancel),
            _ => None,
        };
    }

    let object = value.as_object()?;

    if let Some(amendment) = object.get("acceptWithExecpolicyAmendment") {
        let tokens = amendment
            .as_object()
            .and_then(|entry| parse_string_array_strict(entry.get("execpolicy_amendment")))?;
        return Some(ApprovalDecisionCanonical::AcceptWithExecpolicyAmendment(
            tokens,
        ));
    }

    if let Some(amendment) = object.get("approved_execpolicy_amendment") {
        let tokens = amendment.as_object().and_then(|entry| {
            parse_string_array_strict(entry.get("proposed_execpolicy_amendment"))
        })?;
        return Some(ApprovalDecisionCanonical::AcceptWithExecpolicyAmendment(
            tokens,
        ));
    }

    None
}

fn approval_decision_to_response_value(
    decision: &Value,
    response_format: ApprovalResponseFormat,
) -> Option<Value> {
    let parsed = parse_approval_decision(decision)?;
    match response_format {
        ApprovalResponseFormat::Modern => Some(match parsed {
            ApprovalDecisionCanonical::Accept => json!("accept"),
            ApprovalDecisionCanonical::AcceptForSession => json!("acceptForSession"),
            ApprovalDecisionCanonical::Decline => json!("decline"),
            ApprovalDecisionCanonical::Cancel => json!("cancel"),
            ApprovalDecisionCanonical::AcceptWithExecpolicyAmendment(tokens) => {
                json!({
                    "acceptWithExecpolicyAmendment": {
                        "execpolicy_amendment": tokens
                    }
                })
            }
        }),
        ApprovalResponseFormat::Legacy => Some(match parsed {
            ApprovalDecisionCanonical::Accept => json!("approved"),
            ApprovalDecisionCanonical::AcceptForSession => json!("approved_for_session"),
            ApprovalDecisionCanonical::Decline => json!("denied"),
            ApprovalDecisionCanonical::Cancel => json!("abort"),
            ApprovalDecisionCanonical::AcceptWithExecpolicyAmendment(tokens) => {
                json!({
                    "approved_execpolicy_amendment": {
                        "proposed_execpolicy_amendment": tokens
                    }
                })
            }
        }),
    }
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

fn parse_string_array_strict(value: Option<&Value>) -> Option<Vec<String>> {
    let entries = value.and_then(Value::as_array)?;
    if entries.is_empty() {
        return None;
    }

    let mut parsed = Vec::with_capacity(entries.len());
    for entry in entries {
        let text = entry.as_str()?;
        parsed.push(text.to_string());
    }

    Some(parsed)
}

fn read_string_array(value: Option<&Value>) -> Option<Vec<String>> {
    parse_string_array_strict(value)
}

fn read_shell_command(value: Option<&Value>) -> Option<String> {
    if let Some(command) = read_string(value) {
        return Some(command);
    }

    read_string_array(value).map(|parts| parts.join(" "))
}

fn read_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn parse_execpolicy_amendment(value: Option<&Value>) -> Option<Vec<String>> {
    if let Some(array) = parse_string_array_strict(value) {
        return Some(array);
    }

    if let Some(object) = value.and_then(Value::as_object) {
        return parse_string_array_strict(object.get("execpolicy_amendment"));
    }

    None
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

fn normalize_transcription_mime_type(raw_mime_type: Option<&str>) -> String {
    let Some(raw_mime_type) = raw_mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return "audio/wav".to_string();
    };

    let base_mime = raw_mime_type
        .split(';')
        .next()
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase();

    match base_mime.as_str() {
        "audio/wav" | "audio/x-wav" | "audio/wave" => "audio/wav".to_string(),
        "audio/mp4" => "audio/mp4".to_string(),
        "audio/m4a" | "audio/x-m4a" => "audio/m4a".to_string(),
        "audio/aac" => "audio/aac".to_string(),
        "audio/mpeg" | "audio/mp3" | "audio/mpga" => "audio/mpeg".to_string(),
        "audio/webm" => "audio/webm".to_string(),
        "audio/ogg" => "audio/ogg".to_string(),
        "audio/flac" | "audio/x-flac" => "audio/flac".to_string(),
        _ => "audio/wav".to_string(),
    }
}

fn normalize_transcription_file_name(raw_name: Option<&str>, mime_type: &str) -> String {
    let mut file_name = raw_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(sanitize_filename)
        .unwrap_or_else(|| "audio".to_string());

    if !file_name.contains('.') {
        file_name.push('.');
        file_name.push_str(infer_transcription_extension_from_mime(mime_type));
    }

    file_name
}

fn infer_transcription_extension_from_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "audio/wav" => "wav",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/mpeg" => "mp3",
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        _ => "wav",
    }
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
        assert!(is_forwarded_method("account/read"));
        assert!(is_forwarded_method("mcpServer/oauth/login"));
        assert!(is_forwarded_method("thread/backgroundTerminals/clean"));
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
        assert!(is_valid_approval_decision(&json!("approved")));
        assert!(is_valid_approval_decision(&json!("approved_for_session")));
        assert!(is_valid_approval_decision(&json!("denied")));
        assert!(is_valid_approval_decision(&json!("abort")));
        assert!(is_valid_approval_decision(&json!({
            "acceptWithExecpolicyAmendment": {
                "execpolicy_amendment": ["--allow-network", "git"]
            }
        })));
        assert!(is_valid_approval_decision(&json!({
            "approved_execpolicy_amendment": {
                "proposed_execpolicy_amendment": ["npm", "test"]
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
        assert!(!is_valid_approval_decision(&json!({
            "approved_execpolicy_amendment": {
                "proposed_execpolicy_amendment": []
            }
        })));
    }

    #[test]
    fn approval_decision_response_mapping_supports_modern_and_legacy_shapes() {
        assert_eq!(
            approval_decision_to_response_value(&json!("accept"), ApprovalResponseFormat::Modern),
            Some(json!("accept"))
        );
        assert_eq!(
            approval_decision_to_response_value(&json!("accept"), ApprovalResponseFormat::Legacy),
            Some(json!("approved"))
        );
        assert_eq!(
            approval_decision_to_response_value(
                &json!({
                    "acceptWithExecpolicyAmendment": {
                        "execpolicy_amendment": ["git", "status"]
                    }
                }),
                ApprovalResponseFormat::Legacy,
            ),
            Some(json!({
                "approved_execpolicy_amendment": {
                    "proposed_execpolicy_amendment": ["git", "status"]
                }
            }))
        );
        assert_eq!(
            approval_decision_to_response_value(
                &json!({
                    "approved_execpolicy_amendment": {
                        "proposed_execpolicy_amendment": ["npm", "test"]
                    }
                }),
                ApprovalResponseFormat::Modern,
            ),
            Some(json!({
                "acceptWithExecpolicyAmendment": {
                    "execpolicy_amendment": ["npm", "test"]
                }
            }))
        );
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
    fn read_shell_command_supports_string_and_array_forms() {
        assert_eq!(
            read_shell_command(Some(&json!("git status"))),
            Some("git status".to_string())
        );
        assert_eq!(
            read_shell_command(Some(&json!(["npm", "test", "--watch"]))),
            Some("npm test --watch".to_string())
        );
        assert_eq!(read_shell_command(Some(&json!([]))), None);
    }

    #[test]
    fn rollout_event_msg_mapping_converts_reasoning_and_message_to_delta_events() {
        let reasoning = build_rollout_event_msg_notification(
            json!({
                "type": "agent_reasoning",
                "text": "**Inspecting workspace**"
            })
            .as_object()
            .expect("event payload object"),
            "thread-1",
            Some("2026-02-25T00:00:00Z"),
        )
        .expect("reasoning notification");

        assert_eq!(reasoning.0, "codex/event/agent_reasoning_delta");
        assert_eq!(reasoning.1["msg"]["type"], "agent_reasoning_delta");
        assert_eq!(reasoning.1["msg"]["delta"], "**Inspecting workspace**");
        assert_eq!(reasoning.1["msg"]["thread_id"], "thread-1");

        let agent_message = build_rollout_event_msg_notification(
            json!({
                "type": "agent_message",
                "message": "Running checks"
            })
            .as_object()
            .expect("event payload object"),
            "thread-1",
            Some("2026-02-25T00:00:01Z"),
        )
        .expect("agent message notification");

        assert_eq!(agent_message.0, "codex/event/agent_message_delta");
        assert_eq!(agent_message.1["msg"]["type"], "agent_message_delta");
        assert_eq!(agent_message.1["msg"]["delta"], "Running checks");
    }

    #[test]
    fn rollout_event_msg_mapping_ignores_noise_events() {
        assert!(build_rollout_event_msg_notification(
            json!({
                "type": "token_count",
                "info": {}
            })
            .as_object()
            .expect("event payload object"),
            "thread-1",
            None,
        )
        .is_none());
        assert!(build_rollout_event_msg_notification(
            json!({
                "type": "user_message",
                "message": "hello"
            })
            .as_object()
            .expect("event payload object"),
            "thread-1",
            None,
        )
        .is_none());
    }

    #[test]
    fn extract_rollout_thread_id_prefers_parent_thread_id_from_source() {
        let payload = json!({
            "id": "session-123",
            "source": {
                "subagent": {
                    "thread_spawn": {
                        "parent_thread_id": "thread-parent"
                    }
                }
            }
        });
        let payload_object = payload.as_object().expect("payload object");

        assert_eq!(
            extract_rollout_thread_id(payload_object, true),
            Some("thread-parent".to_string())
        );
    }

    #[test]
    fn rollout_thread_status_notification_maps_task_lifecycle_events() {
        let params = json!({
            "msg": {
                "thread_id": "thread-1"
            }
        });

        let running = build_rollout_thread_status_notification("codex/event/task_started", &params)
            .expect("running status");
        assert_eq!(running["threadId"], "thread-1");
        assert_eq!(running["status"], "running");

        let completed =
            build_rollout_thread_status_notification("codex/event/task_complete", &params)
                .expect("complete status");
        assert_eq!(completed["status"], "completed");

        let failed = build_rollout_thread_status_notification("codex/event/task_failed", &params)
            .expect("failed status");
        assert_eq!(failed["status"], "failed");

        let interrupted =
            build_rollout_thread_status_notification("codex/event/task_interrupted", &params)
                .expect("interrupted status");
        assert_eq!(interrupted["status"], "interrupted");

        assert!(
            build_rollout_thread_status_notification("codex/event/agent_message_delta", &params)
                .is_none()
        );
    }

    #[test]
    fn rollout_originator_filter_allows_codex_and_clawdex_origins() {
        assert!(rollout_originator_allowed(Some("codex_cli_rs")));
        assert!(rollout_originator_allowed(Some(
            "clawdex-mobile-rust-bridge"
        )));
        assert!(!rollout_originator_allowed(Some("some_other_originator")));
    }

    #[test]
    fn rollout_response_item_mapping_builds_exec_command_and_mcp_notifications() {
        let exec_command = build_rollout_response_item_notification(
            json!({
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"npm run test\"}",
                "call_id": "call_1"
            })
            .as_object()
            .expect("response item payload object"),
            "thread-1",
            None,
        )
        .expect("exec command notification");

        assert_eq!(exec_command.0, "codex/event/exec_command_begin");
        assert_eq!(exec_command.1["msg"]["type"], "exec_command_begin");
        assert_eq!(exec_command.1["msg"]["thread_id"], "thread-1");
        assert_eq!(
            exec_command.1["msg"]["command"],
            json!(["npm", "run", "test"])
        );

        let mcp_call = build_rollout_response_item_notification(
            json!({
                "type": "function_call",
                "name": "mcp__openaiDeveloperDocs__search_openai_docs",
                "arguments": "{\"query\":\"codex\"}"
            })
            .as_object()
            .expect("response item payload object"),
            "thread-2",
            None,
        )
        .expect("mcp notification");

        assert_eq!(mcp_call.0, "codex/event/mcp_tool_call_begin");
        assert_eq!(mcp_call.1["msg"]["server"], "openaiDeveloperDocs");
        assert_eq!(mcp_call.1["msg"]["tool"], "search_openai_docs");
    }

    #[test]
    fn parse_rollout_mcp_tool_name_handles_expected_shapes() {
        assert_eq!(
            parse_rollout_mcp_tool_name("mcp__server__tool_name"),
            Some(("server".to_string(), "tool_name".to_string()))
        );
        assert_eq!(
            parse_rollout_mcp_tool_name("mcp__server__namespace__tool"),
            Some(("server".to_string(), "namespace__tool".to_string()))
        );
        assert_eq!(parse_rollout_mcp_tool_name("exec_command"), None);
        assert_eq!(parse_rollout_mcp_tool_name("mcp____tool"), None);
    }

    #[test]
    fn extract_rollout_search_query_supports_search_and_image_query_shapes() {
        assert_eq!(
            extract_rollout_search_query(&json!({
                "search_query": [
                    { "q": "codex cli live mode" }
                ]
            })),
            Some("codex cli live mode".to_string())
        );
        assert_eq!(
            extract_rollout_search_query(&json!({
                "image_query": [
                    { "q": "sunset" }
                ]
            })),
            Some("sunset".to_string())
        );
        assert_eq!(extract_rollout_search_query(&json!({})), None);
    }

    #[test]
    fn rollout_discovery_tick_scheduler_handles_one_tick_interval() {
        assert!(should_run_rollout_discovery_tick(1, 1));
        assert!(should_run_rollout_discovery_tick(10, 1));
        assert!(should_run_rollout_discovery_tick(5, 0));
    }

    #[test]
    fn rollout_discovery_tick_scheduler_handles_multi_tick_intervals() {
        assert!(should_run_rollout_discovery_tick(1, 3));
        assert!(!should_run_rollout_discovery_tick(2, 3));
        assert!(should_run_rollout_discovery_tick(3, 3));
        assert!(should_run_rollout_discovery_tick(6, 3));
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
    fn transcription_mime_normalization_accepts_known_values_and_falls_back() {
        assert_eq!(
            normalize_transcription_mime_type(Some(" audio/MP4 ")),
            "audio/mp4".to_string()
        );
        assert_eq!(
            normalize_transcription_mime_type(Some("audio/webm;codecs=opus")),
            "audio/webm".to_string()
        );
        assert_eq!(
            normalize_transcription_mime_type(Some("audio/mpga")),
            "audio/mpeg".to_string()
        );
        assert_eq!(
            normalize_transcription_mime_type(Some("application/octet-stream")),
            "audio/wav".to_string()
        );
        assert_eq!(
            normalize_transcription_mime_type(None),
            "audio/wav".to_string()
        );
    }

    #[test]
    fn voice_transcribe_request_deserializes_legacy_and_extended_shapes() {
        let legacy: VoiceTranscribeRequest = serde_json::from_value(json!({
            "dataBase64": "YQ==",
            "prompt": "hello"
        }))
        .expect("deserialize legacy request shape");
        assert_eq!(legacy.data_base64, "YQ==");
        assert_eq!(legacy.prompt.as_deref(), Some("hello"));
        assert!(legacy.file_name.is_none());
        assert!(legacy.mime_type.is_none());

        let extended: VoiceTranscribeRequest = serde_json::from_value(json!({
            "dataBase64": "YQ==",
            "prompt": "hello",
            "fileName": "audio.m4a",
            "mimeType": "audio/mp4"
        }))
        .expect("deserialize extended request shape");
        assert_eq!(extended.data_base64, "YQ==");
        assert_eq!(extended.prompt.as_deref(), Some("hello"));
        assert_eq!(extended.file_name.as_deref(), Some("audio.m4a"));
        assert_eq!(extended.mime_type.as_deref(), Some("audio/mp4"));
    }

    #[test]
    fn transcription_file_name_normalization_sanitizes_and_sets_extension() {
        assert_eq!(
            normalize_transcription_file_name(Some("../voice note"), "audio/mp4"),
            "voice_note.m4a".to_string()
        );
        assert_eq!(
            normalize_transcription_file_name(None, "audio/wav"),
            "audio.wav".to_string()
        );
        assert_eq!(
            normalize_transcription_file_name(Some("meeting"), "audio/webm"),
            "meeting.webm".to_string()
        );
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
    async fn handle_server_request_item_tool_call_returns_structured_unsupported_result() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after unix epoch")
            .as_nanos();
        let capture_path = env::temp_dir().join(format!("clawdex-tool-call-capture-{nonce}.jsonl"));
        let shell_command = format!("cat > {}", capture_path.to_string_lossy());

        let mut child = Command::new("sh")
            .arg("-c")
            .arg(shell_command)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn capture process");
        let writer = child.stdin.take().expect("capture stdin available");

        let hub = Arc::new(ClientHub::new());
        let bridge = Arc::new(AppServerBridge {
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            pending_requests: Mutex::new(HashMap::new()),
            internal_waiters: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_user_inputs: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            approval_counter: AtomicU64::new(1),
            user_input_counter: AtomicU64::new(1),
            hub: hub.clone(),
        });

        let (_client_id, mut rx) = add_test_client(&hub).await;

        bridge
            .handle_server_request(
                DYNAMIC_TOOL_CALL_METHOD,
                json!("tool-call-1"),
                Some(json!({
                    "callId": "call_demo_1",
                    "threadId": "thr_demo_1",
                    "turnId": "turn_demo_1",
                    "tool": "demo_tool",
                    "arguments": { "hello": "world" }
                })),
            )
            .await;

        let notification = recv_client_json(&mut rx).await;
        assert_eq!(notification["method"], "bridge/tool.call.unsupported");
        assert_eq!(notification["params"]["request"]["tool"], "demo_tool");

        tokio::time::sleep(Duration::from_millis(60)).await;
        shutdown_test_bridge(&bridge).await;

        let captured = std::fs::read_to_string(&capture_path).expect("capture file exists");
        std::fs::remove_file(&capture_path).ok();

        println!("captured_app_server_response={captured}");

        assert!(captured.contains("\"id\":\"tool-call-1\""));
        assert!(captured.contains("\"success\":false"));
        assert!(captured.contains("Dynamic tool calls are not supported by clawdex-mobile bridge"));
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
