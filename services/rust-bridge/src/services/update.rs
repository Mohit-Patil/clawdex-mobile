use std::{
    env,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BridgeInstallKind {
    PublishedCli,
    SourceCheckout,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeUpdaterStatus {
    pub(crate) state: String,
    pub(crate) job_id: String,
    pub(crate) target_version: String,
    pub(crate) message: String,
    pub(crate) updated_at: String,
    pub(crate) started_at: Option<String>,
    pub(crate) completed_at: Option<String>,
    pub(crate) log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeRuntimeInfo {
    pub(crate) version: String,
    pub(crate) install_kind: BridgeInstallKind,
    pub(crate) self_update_supported: bool,
    pub(crate) updater_status: Option<BridgeUpdaterStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeUpdateStartResponse {
    pub(crate) ok: bool,
    pub(crate) job_id: String,
    pub(crate) target_version: String,
    pub(crate) message: String,
    pub(crate) log_path: Option<String>,
}

#[derive(Clone)]
pub(crate) struct UpdateService {
    package_root: Option<PathBuf>,
    install_kind: BridgeInstallKind,
    status_path: Option<PathBuf>,
    log_path: Option<PathBuf>,
    script_path: Option<PathBuf>,
}

impl UpdateService {
    pub(crate) fn discover() -> Self {
        let package_root = find_package_root();
        let install_kind = package_root
            .as_ref()
            .map(|root| detect_install_kind(root))
            .unwrap_or(BridgeInstallKind::Unknown);
        let status_path = package_root
            .as_ref()
            .map(|root| root.join(".bridge-update-status.json"));
        let log_path = package_root
            .as_ref()
            .map(|root| root.join(".bridge-updater.log"));
        let script_path = package_root
            .as_ref()
            .map(|root| root.join("scripts").join("bridge-self-update.js"));

        Self {
            package_root,
            install_kind,
            status_path,
            log_path,
            script_path,
        }
    }

    pub(crate) fn is_self_update_supported(&self) -> bool {
        self.install_kind == BridgeInstallKind::PublishedCli
            && self.package_root.is_some()
            && self.script_path.as_ref().is_some_and(|path| path.exists())
    }

    pub(crate) fn runtime_info(&self) -> BridgeRuntimeInfo {
        BridgeRuntimeInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            install_kind: self.install_kind,
            self_update_supported: self.is_self_update_supported(),
            updater_status: self.read_status(),
        }
    }

    pub(crate) fn start_update(
        &self,
        version: &str,
        bridge_pid: u32,
        now_iso: &str,
    ) -> Result<BridgeUpdateStartResponse, String> {
        if !self.is_self_update_supported() {
            return Err(
                "Bridge self-update is only supported for published clawdex-mobile CLI installs."
                    .to_string(),
            );
        }

        let package_root = self
            .package_root
            .as_ref()
            .ok_or_else(|| "unable to resolve bridge package root".to_string())?;
        let script_path = self
            .script_path
            .as_ref()
            .ok_or_else(|| "bridge updater script is missing".to_string())?;
        let status_path = self
            .status_path
            .as_ref()
            .ok_or_else(|| "bridge updater status path is missing".to_string())?;
        let log_path = self
            .log_path
            .as_ref()
            .ok_or_else(|| "bridge updater log path is missing".to_string())?;

        let target_version = normalize_target_version(version)?;
        let job_id = create_job_id();

        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|error| format!("failed to open updater log: {error}"))?;
        let log_file_err = log_file
            .try_clone()
            .map_err(|error| format!("failed to clone updater log handle: {error}"))?;

        let mut command = std::process::Command::new(node_command());
        command
            .arg(script_path)
            .arg("--job-id")
            .arg(&job_id)
            .arg("--bridge-pid")
            .arg(bridge_pid.to_string())
            .arg("--version")
            .arg(&target_version)
            .arg("--status-path")
            .arg(status_path)
            .arg("--log-path")
            .arg(log_path)
            .arg("--started-at")
            .arg(now_iso)
            .current_dir(package_root)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_file_err));

        configure_detached_command(&mut command);

        let child = command
            .spawn()
            .map_err(|error| format!("failed to spawn updater: {error}"))?;
        let _ = child.id();

        Ok(BridgeUpdateStartResponse {
            ok: true,
            job_id,
            target_version: target_version.clone(),
            message: format!(
                "Bridge update scheduled for {target_version}. The bridge will disconnect briefly and should restart automatically."
            ),
            log_path: Some(log_path.to_string_lossy().to_string()),
        })
    }

    fn read_status(&self) -> Option<BridgeUpdaterStatus> {
        let status_path = self.status_path.as_ref()?;
        let raw = fs::read_to_string(status_path).ok()?;
        serde_json::from_str::<BridgeUpdaterStatus>(&raw).ok()
    }
}

fn find_package_root() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok()?;
    for ancestor in current_exe.ancestors() {
        if looks_like_package_root(ancestor) {
            return Some(ancestor.to_path_buf());
        }
    }

    None
}

fn looks_like_package_root(path: &Path) -> bool {
    path.join("package.json").is_file()
        && path
            .join("scripts")
            .join("start-bridge-secure.js")
            .is_file()
}

fn detect_install_kind(path: &Path) -> BridgeInstallKind {
    if path
        .join("services")
        .join("rust-bridge")
        .join("src")
        .is_dir()
        && path.join("apps").join("mobile").is_dir()
    {
        return BridgeInstallKind::SourceCheckout;
    }

    if path.join("bin").join("clawdex.js").is_file()
        && path.join("scripts").join("bridge-self-update.js").is_file()
    {
        return BridgeInstallKind::PublishedCli;
    }

    BridgeInstallKind::Unknown
}

fn normalize_target_version(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok("latest".to_string());
    }

    if trimmed == "latest"
        || trimmed
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '-' | '_'))
    {
        return Ok(trimmed.to_string());
    }

    Err("version must be 'latest' or a simple npm package version".to_string())
}

fn create_job_id() -> String {
    format!(
        "bridge-update-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        std::process::id()
    )
}

fn node_command() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

#[cfg(unix)]
fn configure_detached_command(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(windows)]
fn configure_detached_command(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn configure_detached_command(_command: &mut std::process::Command) {}

#[allow(dead_code)]
fn _ensure_send_sync(_: &UpdateService) {}
