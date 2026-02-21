use std::{
    collections::{HashMap, HashSet},
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
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot, Mutex, RwLock},
    time::timeout,
};

const APPROVAL_COMMAND_METHOD: &str = "item/commandExecution/requestApproval";
const APPROVAL_FILE_METHOD: &str = "item/fileChange/requestApproval";

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

        let workdir = env::var("BRIDGE_WORKDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let workdir = normalize_path(&workdir);

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
                if let Some(token) = raw.strip_prefix("Bearer ") {
                    if token.trim() == expected {
                        return true;
                    }
                }
            }
        }

        if self.allow_query_token_auth {
            if let Some(token) = query_token {
                if token == expected {
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
    clients: RwLock<HashMap<u64, mpsc::UnboundedSender<Message>>>,
}

impl ClientHub {
    fn new() -> Self {
        Self {
            next_client_id: AtomicU64::new(1),
            clients: RwLock::new(HashMap::new()),
        }
    }

    async fn add_client(&self, tx: mpsc::UnboundedSender<Message>) -> u64 {
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

        let clients = self.clients.read().await;
        if let Some(tx) = clients.get(&client_id) {
            let _ = tx.send(Message::Text(text.into()));
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

        let clients = self.clients.read().await;
        for tx in clients.values() {
            let _ = tx.send(Message::Text(text.clone().into()));
        }
    }

    async fn broadcast_notification(&self, method: &str, params: Value) {
        self.broadcast_json(json!({
            "method": method,
            "params": params
        }))
        .await;
    }
}

struct AppServerBridge {
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    pending_requests: Mutex<HashMap<u64, PendingRequest>>,
    internal_waiters: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    pending_approvals: Mutex<HashMap<String, PendingApprovalEntry>>,
    next_request_id: AtomicU64,
    approval_counter: AtomicU64,
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
            next_request_id: AtomicU64::new(1),
            approval_counter: AtomicU64::new(1),
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
                    "name": "codex-mobile-rust-bridge",
                    "title": "Codex Mobile Rust Bridge",
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
        decision: &str,
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
        let mut payload = json!({
            "method": method,
        });
        if let Some(params) = params {
            payload["params"] = params;
        }

        self.hub.broadcast_json(payload).await;
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

#[derive(Clone)]
struct TerminalService {
    root: PathBuf,
    allowed_commands: HashSet<String>,
    disabled: bool,
}

impl TerminalService {
    fn new(root: PathBuf, allowed_commands: HashSet<String>, disabled: bool) -> Self {
        Self {
            root,
            allowed_commands,
            disabled,
        }
    }

    async fn execute_shell(
        &self,
        request: TerminalExecRequest,
    ) -> Result<TerminalExecResponse, BridgeError> {
        if self.disabled {
            return Err(BridgeError::forbidden(
                "terminal_exec_disabled",
                "Terminal execution is disabled on this bridge.",
            ));
        }

        let command = request.command.trim();
        if command.is_empty() {
            return Err(BridgeError::invalid_params("command must not be empty"));
        }

        if contains_disallowed_control_chars(command) {
            return Err(BridgeError::invalid_params(
                "command contains disallowed control characters",
            ));
        }

        let tokens = shlex::split(command)
            .ok_or_else(|| BridgeError::invalid_params("invalid command quoting"))?;
        if tokens.is_empty() {
            return Err(BridgeError::invalid_params("command must not be empty"));
        }

        let binary = tokens[0].clone();
        if !self.allowed_commands.is_empty() && !self.allowed_commands.contains(&binary) {
            let mut allowed = self.allowed_commands.iter().cloned().collect::<Vec<_>>();
            allowed.sort();
            return Err(BridgeError::invalid_params(&format!(
                "Command \"{binary}\" is not allowed. Allowed commands: {}",
                allowed.join(", ")
            )));
        }

        let args = tokens[1..].to_vec();
        let cwd = resolve_cwd_within_root(request.cwd.as_deref(), &self.root)
            .ok_or_else(|| BridgeError::invalid_params("cwd must stay within BRIDGE_WORKDIR"))?;

        self.execute_binary_internal(
            binary.as_str(),
            &args,
            command.to_string(),
            cwd,
            request.timeout_ms,
        )
        .await
    }

    async fn execute_binary(
        &self,
        binary: &str,
        args: &[String],
        cwd: PathBuf,
        timeout_ms: Option<u64>,
    ) -> Result<TerminalExecResponse, BridgeError> {
        let display = std::iter::once(binary.to_string())
            .chain(args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");

        self.execute_binary_internal(binary, args, display, cwd, timeout_ms)
            .await
    }

    async fn execute_binary_internal(
        &self,
        binary: &str,
        args: &[String],
        display_command: String,
        cwd: PathBuf,
        timeout_ms: Option<u64>,
    ) -> Result<TerminalExecResponse, BridgeError> {
        let timeout_ms = timeout_ms.unwrap_or(30_000).clamp(100, 120_000);
        let started_at = Instant::now();

        let mut child = Command::new(binary)
            .args(args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| BridgeError::server(&format!("failed to spawn command: {error}")))?;

        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture stdout"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture stderr"))?;

        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes).await;
            bytes
        });

        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes).await;
            bytes
        });

        let mut timed_out = false;
        let mut exit_code = None;
        let mut wait_error: Option<String> = None;

        match timeout(Duration::from_millis(timeout_ms), child.wait()).await {
            Ok(Ok(status)) => {
                exit_code = status.code();
            }
            Ok(Err(error)) => {
                wait_error = Some(error.to_string());
                exit_code = Some(-1);
            }
            Err(_) => {
                timed_out = true;
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let stdout_bytes = stdout_task.await.unwrap_or_default();
        let stderr_bytes = stderr_task.await.unwrap_or_default();

        let stdout_text = String::from_utf8_lossy(&stdout_bytes)
            .trim_end()
            .to_string();
        let mut stderr_text = String::from_utf8_lossy(&stderr_bytes)
            .trim_end()
            .to_string();
        if let Some(wait_error) = wait_error {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str(&wait_error);
        }

        Ok(TerminalExecResponse {
            command: display_command,
            cwd: cwd.to_string_lossy().to_string(),
            code: exit_code,
            stdout: stdout_text,
            stderr: stderr_text,
            timed_out,
            duration_ms: started_at.elapsed().as_millis() as u64,
        })
    }
}

#[derive(Clone)]
struct GitService {
    terminal: Arc<TerminalService>,
    root: PathBuf,
}

impl GitService {
    fn new(terminal: Arc<TerminalService>, root: PathBuf) -> Self {
        Self { terminal, root }
    }

    fn resolve_repo_path(&self, raw_cwd: Option<&str>) -> Result<PathBuf, BridgeError> {
        resolve_cwd_within_root(raw_cwd, &self.root)
            .ok_or_else(|| BridgeError::invalid_params("cwd must stay within BRIDGE_WORKDIR"))
    }

    async fn get_status(&self, raw_cwd: Option<&str>) -> Result<GitStatusResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "status".to_string(),
            "--short".to_string(),
            "--branch".to_string(),
        ];
        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        if result.code != Some(0) {
            return Err(BridgeError::server(
                &(if !result.stderr.is_empty() {
                    result.stderr.clone()
                } else if !result.stdout.is_empty() {
                    result.stdout.clone()
                } else {
                    "git status failed".to_string()
                }),
            ));
        }

        let lines = result
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>();

        let branch = lines
            .iter()
            .find(|line| line.starts_with("## "))
            .map(|line| {
                line.trim_start_matches("## ")
                    .split("...")
                    .next()
                    .unwrap_or("unknown")
            })
            .unwrap_or("unknown")
            .to_string();

        let clean = lines.iter().filter(|line| !line.starts_with("## ")).count() == 0;

        Ok(GitStatusResponse {
            branch,
            clean,
            raw: result.stdout,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    async fn get_diff(&self, raw_cwd: Option<&str>) -> Result<GitDiffResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "diff".to_string(),
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        if result.code != Some(0) {
            return Err(BridgeError::server(
                &(if !result.stderr.is_empty() {
                    result.stderr.clone()
                } else if !result.stdout.is_empty() {
                    result.stdout.clone()
                } else {
                    "git diff failed".to_string()
                }),
            ));
        }

        Ok(GitDiffResponse {
            diff: result.stdout,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    async fn commit(
        &self,
        message: String,
        raw_cwd: Option<&str>,
    ) -> Result<GitCommitResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let add_args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "add".to_string(),
            "-A".to_string(),
        ];
        let add_result = self
            .terminal
            .execute_binary("git", &add_args, repo_path.clone(), None)
            .await?;
        if add_result.code != Some(0) {
            return Ok(GitCommitResponse {
                code: add_result.code,
                stdout: add_result.stdout,
                stderr: if !add_result.stderr.is_empty() {
                    add_result.stderr
                } else {
                    "git add -A failed".to_string()
                },
                committed: false,
                cwd: repo_path.to_string_lossy().to_string(),
            });
        }

        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "commit".to_string(),
            "-m".to_string(),
            message,
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        Ok(GitCommitResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            committed: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    async fn push(&self, raw_cwd: Option<&str>) -> Result<GitPushResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "push".to_string(),
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        Ok(GitPushResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            pushed: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitRequest {
    message: String,
    cwd: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveApprovalRequest {
    id: String,
    decision: String,
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
    ));
    let git = Arc::new(GitService::new(terminal.clone(), config.workdir.clone()));

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
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let client_id = state.hub.add_client(tx).await;

    let writer_task = tokio::spawn(async move {
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

    while let Some(message) = socket_rx.next().await {
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

    state.hub.remove_client(client_id).await;
    writer_task.abort();
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

            let commit = state
                .git
                .commit(message, cwd.as_deref())
                .await?;
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
                    "decision must be one of: accept, acceptForSession, decline, cancel",
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

fn parse_bool_env(name: &str) -> bool {
    env::var(name)
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
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

fn is_valid_approval_decision(value: &str) -> bool {
    matches!(value, "accept" | "acceptForSession" | "decline" | "cancel")
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

fn contains_disallowed_control_chars(value: &str) -> bool {
    value
        .chars()
        .any(|char| matches!(char, ';' | '|' | '&' | '<' | '>' | '`'))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn resolve_cwd_within_root(raw_cwd: Option<&str>, root: &Path) -> Option<PathBuf> {
    let requested = match raw_cwd {
        Some(raw) if !raw.trim().is_empty() => {
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        }
        _ => root.to_path_buf(),
    };

    let normalized_root = normalize_path(root);
    let normalized_requested = normalize_path(&requested);

    if normalized_requested.starts_with(&normalized_root) {
        Some(normalized_requested)
    } else {
        None
    }
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
