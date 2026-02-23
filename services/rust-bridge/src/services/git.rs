use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::{
    normalize_path, BridgeError, GitCommitResponse, GitDiffResponse, GitPushResponse,
    GitStageAllResponse, GitStageResponse, GitStatusEntry, GitStatusResponse,
    GitUnstageAllResponse, GitUnstageResponse,
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
            "-uall".to_string(),
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

        let porcelain_entries = self.get_porcelain_status_entries(&repo_path).await?;

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

        let clean = porcelain_entries.is_empty();

        Ok(GitStatusResponse {
            branch,
            clean,
            raw: result.stdout,
            files: porcelain_entries,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn get_diff(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitDiffResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let entries = self.get_porcelain_status_entries(&repo_path).await?;
        let mut sections = Vec::new();

        for entry in entries {
            if entry.untracked {
                let untracked_patch = self
                    .run_git_diff_command(
                        &repo_path,
                        &[
                            "diff",
                            "--no-color",
                            "--no-index",
                            "--",
                            "/dev/null",
                            entry.path.as_str(),
                        ],
                        true,
                        "git diff for untracked file failed",
                    )
                    .await?;
                if !untracked_patch.trim().is_empty() {
                    sections.push(untracked_patch);
                }
                continue;
            }

            let tracked_patch = self
                .run_git_diff_command(
                    &repo_path,
                    &[
                        "diff",
                        "--no-color",
                        "--patch",
                        "HEAD",
                        "--",
                        entry.path.as_str(),
                    ],
                    false,
                    "git diff HEAD for file failed",
                )
                .await;
            match tracked_patch {
                Ok(output) => {
                    if !output.trim().is_empty() {
                        sections.push(output);
                    }
                }
                Err(_) => {
                    // Repositories without HEAD (e.g. first commit) need per-file fallback.
                    let staged_patch = self
                        .run_git_diff_command(
                            &repo_path,
                            &[
                                "diff",
                                "--no-color",
                                "--patch",
                                "--cached",
                                "--",
                                entry.path.as_str(),
                            ],
                            false,
                            "git diff --cached for file failed",
                        )
                        .await?;
                    if !staged_patch.trim().is_empty() {
                        sections.push(staged_patch);
                    }

                    let unstaged_patch = self
                        .run_git_diff_command(
                            &repo_path,
                            &["diff", "--no-color", "--patch", "--", entry.path.as_str()],
                            false,
                            "git diff for file failed",
                        )
                        .await?;
                    if !unstaged_patch.trim().is_empty() {
                        sections.push(unstaged_patch);
                    }
                }
            }
        }

        let diff_output = sections
            .into_iter()
            .filter(|section| !section.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        Ok(GitDiffResponse {
            diff: diff_output,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn stage_file(
        &self,
        path: &str,
        raw_cwd: Option<&str>,
    ) -> Result<GitStageResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let relative_path = resolve_repo_relative_path(path, &repo_path)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "add".to_string(),
            "--".to_string(),
            relative_path.clone(),
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        Ok(GitStageResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            staged: result.code == Some(0),
            path: relative_path,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn stage_all(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitStageAllResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "add".to_string(),
            "-A".to_string(),
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        Ok(GitStageAllResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            staged: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn unstage_file(
        &self,
        path: &str,
        raw_cwd: Option<&str>,
    ) -> Result<GitUnstageResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let relative_path = resolve_repo_relative_path(path, &repo_path)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "reset".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            relative_path.clone(),
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        Ok(GitUnstageResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            unstaged: result.code == Some(0),
            path: relative_path,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn unstage_all(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitUnstageAllResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "reset".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            ".".to_string(),
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.clone(), None)
            .await?;

        Ok(GitUnstageAllResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            unstaged: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn commit(
        &self,
        message: String,
        raw_cwd: Option<&str>,
    ) -> Result<GitCommitResponse, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
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

    async fn get_porcelain_status_entries(
        &self,
        repo_path: &Path,
    ) -> Result<Vec<GitStatusEntry>, BridgeError> {
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "--branch".to_string(),
            "-uall".to_string(),
            "-z".to_string(),
        ];

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.to_path_buf(), None)
            .await?;

        if result.code != Some(0) {
            return Err(BridgeError::server(
                &(if !result.stderr.is_empty() {
                    result.stderr
                } else if !result.stdout.is_empty() {
                    result.stdout
                } else {
                    "git status --porcelain failed".to_string()
                }),
            ));
        }

        parse_porcelain_status_entries(&result.stdout)
    }

    async fn run_git_diff_command(
        &self,
        repo_path: &Path,
        command: &[&str],
        allow_exit_code_one: bool,
        fallback_message: &str,
    ) -> Result<String, BridgeError> {
        let mut args = vec!["-C".to_string(), repo_path.to_string_lossy().to_string()];
        args.extend(command.iter().map(|segment| (*segment).to_string()));

        let result = self
            .terminal
            .execute_binary("git", &args, repo_path.to_path_buf(), None)
            .await?;

        let code = result.code.unwrap_or(-1);
        let is_allowed = code == 0 || (allow_exit_code_one && code == 1);
        if !is_allowed {
            return Err(BridgeError::server(
                &(if !result.stderr.is_empty() {
                    result.stderr
                } else if !result.stdout.is_empty() {
                    result.stdout
                } else {
                    fallback_message.to_string()
                }),
            ));
        }

        Ok(result.stdout)
    }
}

fn parse_porcelain_status_entries(raw: &str) -> Result<Vec<GitStatusEntry>, BridgeError> {
    let tokens = raw
        .split('\0')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let mut index = 0usize;
    let mut entries = Vec::new();

    while index < tokens.len() {
        let token = tokens[index];
        index += 1;

        if token.starts_with("## ") {
            continue;
        }

        let mut chars = token.chars();
        let index_status = chars.next().unwrap_or(' ');
        let worktree_status = chars.next().unwrap_or(' ');
        let path = token.chars().skip(3).collect::<String>();
        if path.is_empty() {
            continue;
        }

        let mut original_path = None;
        if matches!(index_status, 'R' | 'C') && index < tokens.len() {
            let original = tokens[index].to_string();
            index += 1;
            if !original.is_empty() {
                original_path = Some(original);
            }
        }

        let untracked = index_status == '?' && worktree_status == '?';
        let staged = !matches!(index_status, ' ' | '?');
        let unstaged = untracked || worktree_status != ' ';

        entries.push(GitStatusEntry {
            path,
            original_path,
            index_status: index_status.to_string(),
            worktree_status: worktree_status.to_string(),
            staged,
            unstaged,
            untracked,
        });
    }

    Ok(entries)
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

fn resolve_repo_relative_path(raw_path: &str, repo_path: &Path) -> Result<String, BridgeError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("path must not be empty"));
    }

    let requested = PathBuf::from(trimmed);
    if requested.is_absolute() {
        return Err(BridgeError::invalid_params(
            "path must be relative to repository",
        ));
    }

    let normalized_repo = normalize_path(repo_path);
    let normalized_target = normalize_path(&repo_path.join(&requested));
    if !normalized_target.starts_with(&normalized_repo) {
        return Err(BridgeError::invalid_params(
            "path must stay within repository root",
        ));
    }

    let relative = normalized_target
        .strip_prefix(&normalized_repo)
        .map_err(|_| BridgeError::invalid_params("path must stay within repository root"))?;
    if relative.as_os_str().is_empty() {
        return Err(BridgeError::invalid_params("path must point to a file"));
    }

    Ok(relative.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_porcelain_status_entries, resolve_git_cwd, resolve_repo_relative_path};
    use std::path::{Path, PathBuf};

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

    #[test]
    fn resolves_repo_relative_path_and_rejects_escape() {
        let repo = Path::new("/bridge/root/repo");
        let normalized = resolve_repo_relative_path("src/../src/main.rs", repo)
            .expect("resolve normalized relative path");
        assert_eq!(normalized, "src/main.rs");

        let error =
            resolve_repo_relative_path("../outside.txt", repo).expect_err("reject escape path");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn parses_porcelain_entries_for_rename_and_untracked() {
        let raw = "## main...origin/main\0R  new/path.ts\0old/path.ts\0?? fresh/file.ts\0";
        let entries = parse_porcelain_status_entries(raw).expect("parse status entries");
        assert_eq!(entries.len(), 2);

        let renamed = &entries[0];
        assert_eq!(renamed.path, "new/path.ts");
        assert_eq!(renamed.original_path.as_deref(), Some("old/path.ts"));
        assert_eq!(renamed.index_status, "R");
        assert_eq!(renamed.worktree_status, " ");
        assert!(renamed.staged);
        assert!(!renamed.unstaged);
        assert!(!renamed.untracked);

        let untracked = &entries[1];
        assert_eq!(untracked.path, "fresh/file.ts");
        assert_eq!(untracked.index_status, "?");
        assert_eq!(untracked.worktree_status, "?");
        assert!(!untracked.staged);
        assert!(untracked.unstaged);
        assert!(untracked.untracked);
    }
}
