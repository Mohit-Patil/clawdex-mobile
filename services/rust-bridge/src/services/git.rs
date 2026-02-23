use std::{path::PathBuf, sync::Arc};

use crate::{
    normalize_path, BridgeError, GitCommitResponse, GitDiffResponse, GitPushResponse,
    GitStatusResponse,
};

use super::TerminalService;

#[derive(Clone)]
pub(crate) struct GitService {
    terminal: Arc<TerminalService>,
    root: PathBuf,
    allow_outside_root: bool,
}

impl GitService {
    pub(crate) fn new(
        terminal: Arc<TerminalService>,
        root: PathBuf,
        allow_outside_root: bool,
    ) -> Self {
        Self {
            terminal,
            root,
            allow_outside_root,
        }
    }

    fn resolve_repo_path(&self, raw_cwd: Option<&str>) -> Result<PathBuf, BridgeError> {
        resolve_git_cwd(raw_cwd, &self.root, self.allow_outside_root)
    }

    pub(crate) async fn get_status(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitStatusResponse, BridgeError> {
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

    pub(crate) async fn get_diff(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitDiffResponse, BridgeError> {
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

    pub(crate) async fn commit(
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

    pub(crate) async fn push(&self, raw_cwd: Option<&str>) -> Result<GitPushResponse, BridgeError> {
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

fn resolve_git_cwd(
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
    use super::resolve_git_cwd;
    use std::path::PathBuf;

    #[test]
    fn resolves_relative_cwd_against_root() {
        let root = PathBuf::from("/bridge/root");
        let resolved =
            resolve_git_cwd(Some("workspace/repo"), &root, false).expect("resolve relative cwd");
        assert_eq!(resolved, PathBuf::from("/bridge/root/workspace/repo"));
    }

    #[test]
    fn rejects_absolute_cwd_outside_root_by_default() {
        let root = PathBuf::from("/bridge/root");
        let error = resolve_git_cwd(Some("/external/repo"), &root, false)
            .expect_err("reject outside-root cwd");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn rejects_relative_cwd_that_escapes_root() {
        let root = PathBuf::from("/bridge/root");
        let error =
            resolve_git_cwd(Some("../outside"), &root, false).expect_err("reject escaped cwd");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn allows_absolute_cwd_outside_root_when_enabled() {
        let root = PathBuf::from("/bridge/root");
        let resolved =
            resolve_git_cwd(Some("/external/repo"), &root, true).expect("allow outside root");
        assert_eq!(resolved, PathBuf::from("/external/repo"));
    }

    #[test]
    fn falls_back_to_root_when_cwd_missing() {
        let root = PathBuf::from("/bridge/root");
        let resolved = resolve_git_cwd(None, &root, false).expect("fallback to root");
        assert_eq!(resolved, root);
    }
}
