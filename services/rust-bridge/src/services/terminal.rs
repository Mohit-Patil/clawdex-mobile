use std::{
    collections::HashSet,
    path::PathBuf,
    process::Stdio,
    time::{Duration, Instant},
};

use tokio::{io::AsyncReadExt, process::Command, time::timeout};

use crate::{
    contains_disallowed_control_chars, normalize_path, BridgeError, TerminalExecRequest,
    TerminalExecResponse,
};

#[derive(Clone)]
pub(crate) struct TerminalService {
    root: PathBuf,
    allowed_commands: HashSet<String>,
    disabled: bool,
    allow_outside_root: bool,
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

#[cfg(test)]
mod tests {
    use super::resolve_exec_cwd;
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
}
