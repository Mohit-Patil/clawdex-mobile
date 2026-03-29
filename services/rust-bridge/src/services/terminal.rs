use std::{
    collections::HashSet,
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Semaphore,
    time::timeout,
};

use crate::{
    contains_disallowed_control_chars, normalize_path, BridgeError, TerminalExecRequest,
    TerminalExecResponse,
};

const DEFAULT_TERMINAL_MAX_CONCURRENT: usize = 4;
const DEFAULT_TERMINAL_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const OUTPUT_READ_CHUNK_SIZE: usize = 8 * 1024;

#[derive(Clone)]
pub(crate) struct TerminalService {
    root: PathBuf,
    allowed_commands: HashSet<String>,
    disabled: bool,
    allow_outside_root: bool,
    concurrency_limiter: Arc<Semaphore>,
}

impl TerminalService {
    pub(crate) fn new(
        root: PathBuf,
        allowed_commands: HashSet<String>,
        disabled: bool,
        allow_outside_root: bool,
    ) -> Self {
        Self {
            root,
            allowed_commands,
            disabled,
            allow_outside_root,
            concurrency_limiter: Arc::new(Semaphore::new(DEFAULT_TERMINAL_MAX_CONCURRENT)),
        }
    }

    pub(crate) async fn execute_shell(
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
    use super::{finalize_output, resolve_exec_cwd};
    use std::path::PathBuf;

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
}
