use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    runtime::Handle,
    sync::{RwLock, Semaphore},
    time::timeout,
};

use crate::{
    contains_disallowed_control_chars, normalize_path, BridgeError, ClientHub, TerminalExecRequest,
    TerminalExecResponse, TerminalSessionCloseRequest, TerminalSessionCreateRequest,
    TerminalSessionInputRequest, TerminalSessionInputResponse, TerminalSessionReadRequest,
    TerminalSessionResizeRequest, TerminalSessionSnapshot,
};

const DEFAULT_TERMINAL_MAX_CONCURRENT: usize = 4;
const DEFAULT_TERMINAL_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const DEFAULT_TERMINAL_SESSION_COLS: u16 = 80;
const DEFAULT_TERMINAL_SESSION_ROWS: u16 = 24;
const DEFAULT_TERMINAL_SESSION_PIXEL_WIDTH: u16 = 0;
const DEFAULT_TERMINAL_SESSION_PIXEL_HEIGHT: u16 = 0;
const MAX_TERMINAL_SESSION_BUFFER_BYTES: usize = 512 * 1024;
const MAX_TERMINAL_SESSION_INPUT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_SESSION_COUNT: usize = 16;
const OUTPUT_READ_CHUNK_SIZE: usize = 8 * 1024;

#[derive(Clone)]
pub(crate) struct TerminalService {
    root: PathBuf,
    allowed_commands: HashSet<String>,
    disabled: bool,
    allow_outside_root: bool,
    concurrency_limiter: Arc<Semaphore>,
    hub: Arc<ClientHub>,
    session_counter: Arc<AtomicU64>,
    sessions: Arc<RwLock<HashMap<String, Arc<TerminalSession>>>>,
}

struct TerminalSession {
    state: Arc<Mutex<TerminalSessionState>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

struct TerminalSessionState {
    id: String,
    cwd: String,
    shell: String,
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
    pid: Option<u32>,
    started_at: String,
    started_at_unix_ms: i64,
    active: bool,
    exited_at: Option<String>,
    exit_code: Option<i32>,
    exit_signal: Option<String>,
    last_error: Option<String>,
    output: VecDeque<u8>,
    output_len: usize,
    output_truncated: bool,
}

impl TerminalSession {
    fn snapshot(&self, include_output: bool) -> TerminalSessionSnapshot {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.to_snapshot(include_output)
    }

    fn is_active(&self) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active
    }

    fn started_at_unix_ms(&self) -> i64 {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.started_at_unix_ms
    }
}

impl TerminalSessionState {
    fn to_snapshot(&self, include_output: bool) -> TerminalSessionSnapshot {
        let output_base64 = if include_output && !self.output.is_empty() {
            Some(BASE64_STANDARD.encode(self.output.iter().copied().collect::<Vec<_>>()))
        } else {
            None
        };

        TerminalSessionSnapshot {
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            shell: self.shell.clone(),
            cols: self.cols,
            rows: self.rows,
            pixel_width: self.pixel_width,
            pixel_height: self.pixel_height,
            pid: self.pid,
            started_at: self.started_at.clone(),
            active: self.active,
            exited_at: self.exited_at.clone(),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal.clone(),
            last_error: self.last_error.clone(),
            output_base64,
            output_truncated: self.output_truncated,
        }
    }

    fn append_output(&mut self, data: &[u8]) {
        for byte in data {
            if self.output_len == MAX_TERMINAL_SESSION_BUFFER_BYTES {
                if self.output.pop_front().is_some() {
                    self.output_len -= 1;
                    self.output_truncated = true;
                }
            }
            self.output.push_back(*byte);
            self.output_len += 1;
        }
    }

    fn update_size(&mut self, cols: u16, rows: u16, pixel_width: u16, pixel_height: u16) {
        self.cols = cols;
        self.rows = rows;
        self.pixel_width = pixel_width;
        self.pixel_height = pixel_height;
    }

    fn mark_error(&mut self, error: String) {
        self.last_error = Some(error);
    }

    fn mark_exited(
        &mut self,
        exit_code: Option<i32>,
        exit_signal: Option<String>,
        error: Option<String>,
    ) {
        self.active = false;
        self.exited_at = Some(Utc::now().to_rfc3339());
        self.exit_code = exit_code;
        self.exit_signal = exit_signal;
        if let Some(error) = error {
            self.last_error = Some(error);
        }
    }
}

impl TerminalService {
    pub(crate) fn new(
        root: PathBuf,
        allowed_commands: HashSet<String>,
        disabled: bool,
        allow_outside_root: bool,
        hub: Arc<ClientHub>,
    ) -> Self {
        Self {
            root,
            allowed_commands,
            disabled,
            allow_outside_root,
            concurrency_limiter: Arc::new(Semaphore::new(DEFAULT_TERMINAL_MAX_CONCURRENT)),
            hub,
            session_counter: Arc::new(AtomicU64::new(1)),
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn execute_shell(
        &self,
        request: TerminalExecRequest,
    ) -> Result<TerminalExecResponse, BridgeError> {
        self.ensure_terminal_enabled()?;

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
        let cwd = resolve_exec_cwd(request.cwd.as_deref(), &self.root, self.allow_outside_root)?;

        self.execute_binary_internal(
            binary.as_str(),
            &args,
            command.to_string(),
            cwd,
            request.timeout_ms,
        )
        .await
    }

    pub(crate) async fn create_session(
        &self,
        request: TerminalSessionCreateRequest,
    ) -> Result<TerminalSessionSnapshot, BridgeError> {
        self.ensure_terminal_enabled()?;

        let cwd = resolve_exec_cwd(request.cwd.as_deref(), &self.root, self.allow_outside_root)?;
        let (cols, rows, pixel_width, pixel_height) = normalize_requested_session_size(
            request.cols,
            request.rows,
            request.pixel_width,
            request.pixel_height,
        )?;
        let (mut command, shell_display) = build_session_command(request.shell.as_deref(), &cwd)?;

        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.cwd(cwd.as_os_str());

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width,
                pixel_height,
            })
            .map_err(|error| BridgeError::server(&format!("failed to open pty: {error}")))?;

        let child = pair.slave.spawn_command(command).map_err(|error| {
            BridgeError::server(&format!("failed to spawn terminal session: {error}"))
        })?;
        drop(pair.slave);

        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(|error| {
            BridgeError::server(&format!("failed to clone pty reader: {error}"))
        })?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| BridgeError::server(&format!("failed to take pty writer: {error}")))?;
        let killer = child.clone_killer();

        let session_id = format!(
            "terminal-session-{}",
            self.session_counter.fetch_add(1, Ordering::Relaxed)
        );
        let started_at = Utc::now();
        let cwd_display = cwd.to_string_lossy().to_string();

        let state = Arc::new(Mutex::new(TerminalSessionState {
            id: session_id.clone(),
            cwd: cwd_display,
            shell: shell_display,
            cols,
            rows,
            pixel_width,
            pixel_height,
            pid,
            started_at: started_at.to_rfc3339(),
            started_at_unix_ms: started_at.timestamp_millis(),
            active: true,
            exited_at: None,
            exit_code: None,
            exit_signal: None,
            last_error: None,
            output: VecDeque::new(),
            output_len: 0,
            output_truncated: false,
        }));

        let session = Arc::new(TerminalSession {
            state: state.clone(),
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            killer: Arc::new(Mutex::new(killer)),
        });

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session.clone());
        }
        self.prune_inactive_sessions().await;

        let runtime = Handle::current();
        spawn_session_reader(
            runtime.clone(),
            self.hub.clone(),
            session_id.clone(),
            state.clone(),
            reader,
        );
        spawn_session_waiter(runtime, self.hub.clone(), session_id, state, child);

        Ok(session.snapshot(false))
    }

    pub(crate) async fn read_session(
        &self,
        request: TerminalSessionReadRequest,
    ) -> Result<TerminalSessionSnapshot, BridgeError> {
        let session = self.get_session(request.session_id.as_str()).await?;
        Ok(session.snapshot(true))
    }

    pub(crate) async fn write_session_input(
        &self,
        request: TerminalSessionInputRequest,
    ) -> Result<TerminalSessionInputResponse, BridgeError> {
        let session = self.get_session(request.session_id.as_str()).await?;
        let data = decode_session_input(request.data_base64.as_str())?;

        let mut writer = session
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        writer
            .write_all(&data)
            .map_err(|error| BridgeError::server(&format!("failed to write to pty: {error}")))?;
        writer
            .flush()
            .map_err(|error| BridgeError::server(&format!("failed to flush pty input: {error}")))?;

        Ok(TerminalSessionInputResponse { ok: true })
    }

    pub(crate) async fn resize_session(
        &self,
        request: TerminalSessionResizeRequest,
    ) -> Result<TerminalSessionSnapshot, BridgeError> {
        let session = self.get_session(request.session_id.as_str()).await?;
        let (cols, rows, pixel_width, pixel_height) = normalize_requested_session_size(
            Some(request.cols),
            Some(request.rows),
            request.pixel_width,
            request.pixel_height,
        )?;

        {
            let master = session
                .master
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width,
                    pixel_height,
                })
                .map_err(|error| BridgeError::server(&format!("failed to resize pty: {error}")))?;
        }

        {
            let mut state = session
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.update_size(cols, rows, pixel_width, pixel_height);
        }

        Ok(session.snapshot(false))
    }

    pub(crate) async fn close_session(
        &self,
        request: TerminalSessionCloseRequest,
    ) -> Result<TerminalSessionSnapshot, BridgeError> {
        let session = self.get_session(request.session_id.as_str()).await?;
        if session.is_active() {
            let result = session
                .killer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .kill();
            if let Err(error) = result {
                #[cfg(unix)]
                if error.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(session.snapshot(false));
                }
                return Err(BridgeError::server(&format!(
                    "failed to terminate terminal session: {error}"
                )));
            }
        }

        Ok(session.snapshot(false))
    }

    pub(crate) async fn execute_binary(
        &self,
        binary: &str,
        args: &[String],
        cwd: PathBuf,
        timeout_ms: Option<u64>,
    ) -> Result<TerminalExecResponse, BridgeError> {
        let cwd = normalize_path(&cwd);
        if !self.allow_outside_root {
            let normalized_root = normalize_path(&self.root);
            if !cwd.starts_with(&normalized_root) {
                return Err(BridgeError::invalid_params(
                    "cwd must stay within BRIDGE_WORKDIR",
                ));
            }
        }

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
        let _permit = self
            .concurrency_limiter
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| BridgeError::server("terminal concurrency limiter is closed"))?;
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

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture stderr"))?;

        let stdout_task = tokio::spawn(async move {
            read_stream_limited(stdout, DEFAULT_TERMINAL_MAX_OUTPUT_BYTES).await
        });

        let stderr_task = tokio::spawn(async move {
            read_stream_limited(stderr, DEFAULT_TERMINAL_MAX_OUTPUT_BYTES).await
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

        let (stdout_bytes, stdout_truncated) = stdout_task.await.unwrap_or_default();
        let (stderr_bytes, stderr_truncated) = stderr_task.await.unwrap_or_default();

        let stdout_text = finalize_output(stdout_bytes, stdout_truncated);
        let mut stderr_text = finalize_output(stderr_bytes, stderr_truncated);
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

    fn ensure_terminal_enabled(&self) -> Result<(), BridgeError> {
        if self.disabled {
            return Err(BridgeError::forbidden(
                "terminal_exec_disabled",
                "Terminal execution is disabled on this bridge.",
            ));
        }
        Ok(())
    }

    async fn get_session(&self, session_id: &str) -> Result<Arc<TerminalSession>, BridgeError> {
        let normalized = session_id.trim();
        if normalized.is_empty() {
            return Err(BridgeError::invalid_params("sessionId must not be empty"));
        }

        let sessions = self.sessions.read().await;
        sessions
            .get(normalized)
            .cloned()
            .ok_or_else(|| BridgeError::invalid_params("terminal session not found"))
    }

    async fn prune_inactive_sessions(&self) {
        let removable_ids = {
            let sessions = self.sessions.read().await;
            if sessions.len() <= MAX_TERMINAL_SESSION_COUNT {
                return;
            }

            let mut inactive = sessions
                .iter()
                .filter_map(|(session_id, session)| {
                    if session.is_active() {
                        return None;
                    }
                    Some((session.started_at_unix_ms(), session_id.clone()))
                })
                .collect::<Vec<_>>();
            inactive.sort_by_key(|(started_at, _)| *started_at);
            let remove_count = sessions.len().saturating_sub(MAX_TERMINAL_SESSION_COUNT);
            inactive
                .into_iter()
                .take(remove_count)
                .map(|(_, session_id)| session_id)
                .collect::<Vec<_>>()
        };

        if removable_ids.is_empty() {
            return;
        }

        let mut sessions = self.sessions.write().await;
        for session_id in removable_ids {
            sessions.remove(&session_id);
        }
    }
}

fn spawn_session_reader(
    runtime: Handle,
    hub: Arc<ClientHub>,
    session_id: String,
    state: Arc<Mutex<TerminalSessionState>>,
    mut reader: Box<dyn Read + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; OUTPUT_READ_CHUNK_SIZE];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = &buffer[..read];
                    {
                        let mut locked = state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        locked.append_output(chunk);
                    }
                    let encoded = BASE64_STANDARD.encode(chunk);
                    runtime.block_on(hub.broadcast_ephemeral_notification(
                        "bridge/terminal/session/data",
                        json!({
                            "sessionId": session_id,
                            "dataBase64": encoded,
                        }),
                    ));
                }
                Err(error) => {
                    let message = format!("pty read failed: {error}");
                    {
                        let mut locked = state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        locked.mark_error(message.clone());
                    }
                    runtime.block_on(hub.broadcast_ephemeral_notification(
                        "bridge/terminal/session/error",
                        json!({
                            "sessionId": session_id,
                            "message": message,
                        }),
                    ));
                    break;
                }
            }
        }
    });
}

fn spawn_session_waiter(
    runtime: Handle,
    hub: Arc<ClientHub>,
    session_id: String,
    state: Arc<Mutex<TerminalSessionState>>,
    mut child: Box<dyn Child + Send + Sync>,
) {
    thread::spawn(move || {
        let (exit_code, exit_signal, last_error) = match child.wait() {
            Ok(status) => {
                let signal = status.signal().map(|value| value.to_string());
                let code = i32::try_from(status.exit_code()).ok();
                (code, signal, None)
            }
            Err(error) => (
                Some(-1),
                None,
                Some(format!("terminal session wait failed: {error}")),
            ),
        };

        let exited_at = {
            let mut locked = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locked.mark_exited(exit_code, exit_signal.clone(), last_error.clone());
            locked.exited_at.clone()
        };

        runtime.block_on(hub.broadcast_ephemeral_notification(
            "bridge/terminal/session/exit",
            json!({
                "sessionId": session_id,
                "exitCode": exit_code,
                "exitSignal": exit_signal,
                "exitedAt": exited_at,
                "lastError": last_error,
            }),
        ));
    });
}

fn build_session_command(
    raw_shell: Option<&str>,
    cwd: &PathBuf,
) -> Result<(CommandBuilder, String), BridgeError> {
    let tokens = match raw_shell {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(BridgeError::invalid_params("shell must not be empty"));
            }
            if contains_disallowed_control_chars(trimmed) {
                return Err(BridgeError::invalid_params(
                    "shell contains disallowed control characters",
                ));
            }
            shlex::split(trimmed)
                .ok_or_else(|| BridgeError::invalid_params("invalid shell quoting"))?
        }
        None => vec![default_shell_program()],
    };

    if tokens.is_empty() {
        return Err(BridgeError::invalid_params("shell must not be empty"));
    }

    let mut command = CommandBuilder::new(tokens[0].as_str());
    if tokens.len() > 1 {
        command.args(tokens[1..].iter().map(|token| token.as_str()));
    }
    command.cwd(cwd.as_os_str());

    Ok((command, tokens.join(" ")))
}

fn default_shell_program() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "cmd.exe".to_string())
    }

    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

fn normalize_requested_session_size(
    cols: Option<u16>,
    rows: Option<u16>,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
) -> Result<(u16, u16, u16, u16), BridgeError> {
    let cols = cols.unwrap_or(DEFAULT_TERMINAL_SESSION_COLS);
    let rows = rows.unwrap_or(DEFAULT_TERMINAL_SESSION_ROWS);
    let pixel_width = pixel_width.unwrap_or(DEFAULT_TERMINAL_SESSION_PIXEL_WIDTH);
    let pixel_height = pixel_height.unwrap_or(DEFAULT_TERMINAL_SESSION_PIXEL_HEIGHT);

    if cols == 0 {
        return Err(BridgeError::invalid_params(
            "cols must be greater than zero",
        ));
    }
    if rows == 0 {
        return Err(BridgeError::invalid_params(
            "rows must be greater than zero",
        ));
    }

    Ok((cols, rows, pixel_width, pixel_height))
}

fn decode_session_input(encoded: &str) -> Result<Vec<u8>, BridgeError> {
    let trimmed = encoded.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("dataBase64 must not be empty"));
    }

    let bytes = BASE64_STANDARD
        .decode(trimmed)
        .map_err(|_| BridgeError::invalid_params("dataBase64 must be valid base64"))?;
    if bytes.is_empty() {
        return Err(BridgeError::invalid_params(
            "decoded terminal input is empty",
        ));
    }
    if bytes.len() > MAX_TERMINAL_SESSION_INPUT_BYTES {
        return Err(BridgeError::invalid_params(
            "decoded terminal input is too large",
        ));
    }

    Ok(bytes)
}

fn resolve_exec_cwd(
    raw_cwd: Option<&str>,
    root: &PathBuf,
    allow_outside_root: bool,
) -> Result<PathBuf, BridgeError> {
    let normalized_root = normalize_path(root);
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

    let normalized = normalize_path(&requested);
    if !allow_outside_root && !normalized.starts_with(&normalized_root) {
        return Err(BridgeError::invalid_params(
            "cwd must stay within BRIDGE_WORKDIR",
        ));
    }

    Ok(normalized)
}

async fn read_stream_limited<R>(mut reader: R, max_bytes: usize) -> (Vec<u8>, bool)
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; OUTPUT_READ_CHUNK_SIZE];
    let mut truncated = false;

    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };

        if bytes.len() < max_bytes {
            let remaining = max_bytes - bytes.len();
            let to_take = remaining.min(read);
            bytes.extend_from_slice(&buffer[..to_take]);
            if to_take < read {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }

    (bytes, truncated)
}

fn finalize_output(bytes: Vec<u8>, truncated: bool) -> String {
    let mut output = String::from_utf8_lossy(&bytes).trim_end().to_string();
    if truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("[output truncated]");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{
        build_session_command, decode_session_input, finalize_output,
        normalize_requested_session_size, resolve_exec_cwd, TerminalSessionState,
        MAX_TERMINAL_SESSION_BUFFER_BYTES,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use std::{collections::VecDeque, path::PathBuf};

    #[test]
    fn resolves_relative_exec_cwd_against_root() {
        let root = PathBuf::from("/bridge/root");
        let resolved =
            resolve_exec_cwd(Some("workspace/repo"), &root, false).expect("resolve relative cwd");
        assert_eq!(resolved, PathBuf::from("/bridge/root/workspace/repo"));
    }

    #[test]
    fn rejects_absolute_exec_cwd_outside_root_by_default() {
        let root = PathBuf::from("/bridge/root");
        let error = resolve_exec_cwd(Some("/external/repo"), &root, false)
            .expect_err("reject outside-root cwd");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn rejects_relative_exec_cwd_that_escapes_root() {
        let root = PathBuf::from("/bridge/root");
        let error =
            resolve_exec_cwd(Some("../outside"), &root, false).expect_err("reject escape path");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn allows_absolute_exec_cwd_outside_root_when_enabled() {
        let root = PathBuf::from("/bridge/root");
        let resolved =
            resolve_exec_cwd(Some("/external/repo"), &root, true).expect("allow outside root");
        assert_eq!(resolved, PathBuf::from("/external/repo"));
    }

    #[test]
    fn finalize_output_marks_truncated_streams() {
        assert_eq!(
            finalize_output(b"hello\n".to_vec(), true),
            "hello\n[output truncated]"
        );
    }

    #[test]
    fn normalize_requested_session_size_rejects_zero_rows_or_cols() {
        let error = normalize_requested_session_size(Some(0), Some(24), None, None)
            .expect_err("reject zero cols");
        assert_eq!(error.code, -32602);

        let error = normalize_requested_session_size(Some(80), Some(0), None, None)
            .expect_err("reject zero rows");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn build_session_command_uses_requested_shell_and_cwd() {
        let cwd = PathBuf::from("/tmp/clawdex");
        let (command, display) =
            build_session_command(Some("/bin/zsh -l"), &cwd).expect("build command");
        assert_eq!(display, "/bin/zsh -l");
        assert_eq!(command.get_argv().len(), 2);
        assert_eq!(command.get_cwd(), Some(&cwd.into_os_string()));
    }

    #[test]
    fn decode_session_input_accepts_valid_base64() {
        let decoded =
            decode_session_input(BASE64_STANDARD.encode("ls -la\r").as_str()).expect("decode");
        assert_eq!(decoded, b"ls -la\r");
    }

    #[test]
    fn session_output_buffer_keeps_latest_bytes() {
        let mut state = TerminalSessionState {
            id: "session-1".to_string(),
            cwd: "/tmp".to_string(),
            shell: "/bin/sh".to_string(),
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
            pid: None,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            started_at_unix_ms: 0,
            active: true,
            exited_at: None,
            exit_code: None,
            exit_signal: None,
            last_error: None,
            output: VecDeque::new(),
            output_len: 0,
            output_truncated: false,
        };

        state.append_output(&vec![b'a'; MAX_TERMINAL_SESSION_BUFFER_BYTES + 8]);

        assert_eq!(state.output_len, MAX_TERMINAL_SESSION_BUFFER_BYTES);
        assert!(state.output_truncated);
        let retained = state.output.iter().copied().collect::<Vec<_>>();
        assert_eq!(retained.len(), MAX_TERMINAL_SESSION_BUFFER_BYTES);
        assert!(retained.iter().all(|byte| *byte == b'a'));
    }
}
