#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    hash::{Hash, Hasher},
    io::{SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock, RwLock as StdRwLock,
    },
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        FromRequestParts, Query, Request, State,
    },
    http::{
        header::{
            CACHE_CONTROL, CONNECTION, CONTENT_ENCODING, CONTENT_TYPE, COOKIE, HOST, LOCATION,
            ORIGIN, REFERER, SET_COOKIE, UPGRADE, VARY,
        },
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use futures_util::{stream, SinkExt, StreamExt};
use reqwest::{Client as HttpClient, Method as HttpMethod, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use services::{GitService, TerminalService, UpdateService};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{broadcast, mpsc, oneshot, watch, Mutex, RwLock},
    time::timeout,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as UpstreamWsMessage},
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
const BRIDGE_CHATGPT_AUTH_CACHE_FILE_NAME: &str = ".clawdex-chatgpt-auth.json";
const MOBILE_ATTACHMENTS_DIR: &str = ".clawdex-mobile-attachments";
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const DEFAULT_MAX_VOICE_TRANSCRIPTION_BYTES: usize = 100 * 1024 * 1024;
const NOTIFICATION_REPLAY_BUFFER_SIZE: usize = 2_000;
const NOTIFICATION_REPLAY_MAX_LIMIT: usize = 1_000;
const INTERNAL_NOTIFICATION_CHANNEL_CAPACITY: usize = 1_024;
const WS_CLIENT_QUEUE_CAPACITY: usize = 256;
const ROLLOUT_LIVE_SYNC_POLL_INTERVAL_MS: u64 = 900;
const ROLLOUT_LIVE_SYNC_DISCOVERY_INTERVAL_TICKS: u64 = 1;
const ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES: usize = 64;
const ROLLOUT_LIVE_SYNC_MAX_FILE_AGE: Duration = Duration::from_secs(60 * 60 * 24 * 2);
const ROLLOUT_LIVE_SYNC_INITIAL_TAIL_BYTES: u64 = 64 * 1024;
const ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY: usize = 8_192;
const OPENCODE_HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const OPENCODE_HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(250);
const OPENCODE_EVENT_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const BROWSER_PREVIEW_COOKIE_NAME: &str = "clawdex_preview";
const BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME: &str = "clawdex_preview_vp";
const BROWSER_PREVIEW_PROXY_PREFIX: &str = "/__clawdex_proxy__";
const BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH: &str = "/__clawdex_preview_runtime__.js";
const BROWSER_PREVIEW_SESSION_TTL: Duration = Duration::from_secs(60 * 60 * 12);
const BROWSER_PREVIEW_MAX_SESSIONS: usize = 12;
const BROWSER_PREVIEW_HTTP_BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const BROWSER_PREVIEW_HTML_REWRITE_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const BROWSER_PREVIEW_DISCOVERY_HTTP_TIMEOUT: Duration = Duration::from_millis(500);
const GITHUB_CODESPACES_AUTH_CACHE_TTL: Duration = Duration::from_secs(60 * 5);
const GITHUB_CODESPACES_API_VERSION: &str = "2022-11-28";
const GITHUB_API_URL: &str = "https://api.github.com";
const GITHUB_HOST: &str = "github.com";
const GITHUB_CREDENTIALS_DIR_NAME: &str = ".clawdex";
const GITHUB_CREDENTIALS_FILE_NAME: &str = "github-credentials";
const GITHUB_GIT_CONFIG_FILE_NAME: &str = "github-git-auth.gitconfig";

#[derive(Debug, Clone)]
struct GitHubCodespacesAuthConfig {
    api_url: String,
    codespace_name: String,
}

#[derive(Clone)]
struct BridgeConfig {
    host: String,
    port: u16,
    preview_port: u16,
    connect_url: Option<String>,
    preview_connect_url: Option<String>,
    workdir: PathBuf,
    cli_bin: String,
    opencode_cli_bin: String,
    active_engine: BridgeRuntimeEngine,
    enabled_engines: Vec<BridgeRuntimeEngine>,
    opencode_host: String,
    opencode_port: u16,
    opencode_server_username: String,
    opencode_server_password: Option<String>,
    auth_token: Option<String>,
    auth_enabled: bool,
    allow_insecure_no_auth: bool,
    allow_query_token_auth: bool,
    github_codespaces_auth: Option<GitHubCodespacesAuthConfig>,
    allow_outside_root_cwd: bool,
    disable_terminal_exec: bool,
    terminal_allowed_commands: HashSet<String>,
    show_pairing_qr: bool,
}

impl BridgeConfig {
    fn from_env() -> Result<Self, String> {
        let host = env::var("BRIDGE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("BRIDGE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8787);
        let preview_port = env::var("BRIDGE_PREVIEW_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or_else(|| port.checked_add(1).unwrap_or(8788));
        if preview_port == port {
            return Err("BRIDGE_PREVIEW_PORT must differ from BRIDGE_PORT".to_string());
        }
        let connect_url = parse_connect_url_env("BRIDGE_CONNECT_URL")?;
        let preview_connect_url = parse_connect_url_env("BRIDGE_PREVIEW_CONNECT_URL")?;

        let configured_workdir = env::var("BRIDGE_WORKDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let workdir = resolve_bridge_workdir(configured_workdir)?;

        let cli_bin = env::var("CODEX_CLI_BIN").unwrap_or_else(|_| "codex".to_string());
        let opencode_cli_bin =
            env::var("OPENCODE_CLI_BIN").unwrap_or_else(|_| "opencode".to_string());
        let requested_active_engine = match env::var("BRIDGE_ACTIVE_ENGINE") {
            Ok(raw) => parse_bridge_runtime_engine(raw.trim())
                .ok_or_else(|| format!("unsupported BRIDGE_ACTIVE_ENGINE value: {raw}"))?,
            Err(_) => BridgeRuntimeEngine::Codex,
        };
        let enabled_engines = parse_enabled_bridge_engines_env()?
            .unwrap_or_else(|| legacy_default_enabled_engines(requested_active_engine));
        let active_engine = if enabled_engines.contains(&requested_active_engine) {
            requested_active_engine
        } else {
            enabled_engines[0]
        };
        let opencode_host =
            env::var("BRIDGE_OPENCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let opencode_port = env::var("BRIDGE_OPENCODE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(4090);
        let auth_token = env::var("BRIDGE_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let github_codespaces_auth = parse_github_codespaces_auth_config()?;
        let opencode_server_username = env::var("BRIDGE_OPENCODE_SERVER_USERNAME")
            .or_else(|_| env::var("OPENCODE_SERVER_USERNAME"))
            .unwrap_or_else(|_| "opencode".to_string())
            .trim()
            .to_string();
        let opencode_server_password = env::var("BRIDGE_OPENCODE_SERVER_PASSWORD")
            .or_else(|_| env::var("OPENCODE_SERVER_PASSWORD"))
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| auth_token.clone());

        let allow_insecure_no_auth = parse_bool_env("BRIDGE_ALLOW_INSECURE_NO_AUTH");
        if auth_token.is_none() && github_codespaces_auth.is_none() && !allow_insecure_no_auth {
            return Err(
                "BRIDGE_AUTH_TOKEN is required unless GitHub Codespaces auth is enabled. Set BRIDGE_ALLOW_INSECURE_NO_AUTH=true only for local development."
                    .to_string(),
            );
        }

        let auth_enabled = auth_token.is_some() || github_codespaces_auth.is_some();
        let allow_query_token_auth = parse_bool_env("BRIDGE_ALLOW_QUERY_TOKEN_AUTH");
        let allow_outside_root_cwd =
            parse_bool_env_with_default("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", true);
        let disable_terminal_exec = parse_bool_env("BRIDGE_DISABLE_TERMINAL_EXEC");
        let show_pairing_qr = parse_bool_env_with_default("BRIDGE_SHOW_PAIRING_QR", true);

        let terminal_allowed_commands = parse_csv_env(
            "BRIDGE_TERMINAL_ALLOWED_COMMANDS",
            &["pwd", "ls", "cat", "git"],
        );

        Ok(Self {
            host,
            port,
            preview_port,
            connect_url,
            preview_connect_url,
            workdir,
            cli_bin,
            opencode_cli_bin,
            active_engine,
            enabled_engines,
            opencode_host,
            opencode_port,
            opencode_server_username,
            opencode_server_password,
            auth_token,
            auth_enabled,
            allow_insecure_no_auth,
            allow_query_token_auth,
            github_codespaces_auth,
            allow_outside_root_cwd,
            disable_terminal_exec,
            terminal_allowed_commands,
            show_pairing_qr,
        })
    }

    fn is_authorized_with_bridge_token(
        &self,
        headers: &HeaderMap,
        query_token: Option<&str>,
    ) -> bool {
        let expected = match &self.auth_token {
            Some(token) => token,
            None => return false,
        };

        if let Some(token) = extract_bearer_token(headers) {
            if constant_time_eq(token, expected) {
                return true;
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

fn parse_github_codespaces_auth_config() -> Result<Option<GitHubCodespacesAuthConfig>, String> {
    if !parse_bool_env("BRIDGE_GITHUB_CODESPACES_AUTH") {
        return Ok(None);
    }

    let codespace_name = env::var("BRIDGE_GITHUB_CODESPACE_NAME")
        .or_else(|_| env::var("CODESPACE_NAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "BRIDGE_GITHUB_CODESPACES_AUTH=true requires BRIDGE_GITHUB_CODESPACE_NAME or CODESPACE_NAME."
                .to_string()
        })?;
    let api_url = env::var("BRIDGE_GITHUB_API_URL")
        .unwrap_or_else(|_| "https://api.github.com".to_string())
        .trim()
        .trim_end_matches('/')
        .to_string();
    if api_url.is_empty() {
        return Err("BRIDGE_GITHUB_API_URL must not be empty.".to_string());
    }

    Ok(Some(GitHubCodespacesAuthConfig {
        api_url,
        codespace_name,
    }))
}

fn extract_bearer_token<'a>(headers: &'a HeaderMap) -> Option<&'a str> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    let mut parts = raw.trim().split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    if !scheme.eq_ignore_ascii_case("bearer") || parts.next().is_some() {
        return None;
    }
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

fn hash_token_for_cache(token: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut hasher);
    hasher.finish()
}

fn prune_expired_auth_cache_entries(cache: &mut HashMap<u64, Instant>) {
    let now = Instant::now();
    cache.retain(|_, expires_at| *expires_at > now);
}

struct GitHubCodespacesAuthService {
    config: GitHubCodespacesAuthConfig,
    http: HttpClient,
    cache: Mutex<HashMap<u64, Instant>>,
}

impl GitHubCodespacesAuthService {
    fn new(config: GitHubCodespacesAuthConfig) -> Result<Self, String> {
        let http = HttpClient::builder()
            .user_agent("clawdex-rust-bridge")
            .build()
            .map_err(|error| format!("failed to build GitHub auth client: {error}"))?;

        Ok(Self {
            config,
            http,
            cache: Mutex::new(HashMap::new()),
        })
    }

    async fn is_authorized(&self, token: &str) -> bool {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return false;
        }

        let cache_key = hash_token_for_cache(trimmed);
        {
            let mut cache = self.cache.lock().await;
            prune_expired_auth_cache_entries(&mut cache);
            if let Some(expires_at) = cache.get(&cache_key) {
                if *expires_at > Instant::now() {
                    return true;
                }
            }
        }

        let url = format!(
            "{}/user/codespaces/{}",
            self.config.api_url, self.config.codespace_name
        );
        let response = match self
            .http
            .get(url)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", GITHUB_CODESPACES_API_VERSION)
            .bearer_auth(trimmed)
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return false,
        };

        if !response.status().is_success() {
            return false;
        }

        let mut cache = self.cache.lock().await;
        prune_expired_auth_cache_entries(&mut cache);
        cache.insert(cache_key, Instant::now() + GITHUB_CODESPACES_AUTH_CACHE_TTL);
        true
    }
}

#[derive(Debug, Clone)]
struct GitHubViewer {
    login: String,
    scopes: Vec<String>,
}

async fn install_github_git_auth(
    state: &Arc<AppState>,
    access_token: &str,
    repositories: &[String],
) -> Result<GitHubAuthInstallResponse, BridgeError> {
    let viewer = fetch_github_viewer(state, access_token).await?;
    if !github_token_can_be_used_for_git_auth(&viewer.scopes) {
        return Err(BridgeError::forbidden(
            "github_repo_scope_required",
            "GitHub repository access is required. Sign in again from the app and approve the required repository access.",
        ));
    }

    let normalized_repositories = normalize_github_auth_repositories(repositories);
    let credentials_file = resolve_github_credentials_file_path()?;
    let git_config_file = resolve_github_git_config_file_path()?;
    ensure_private_parent_dir(&credentials_file).await?;
    write_github_credentials_file(&credentials_file, access_token, &normalized_repositories)
        .await?;
    write_github_git_config_file(
        &git_config_file,
        &credentials_file,
        &normalized_repositories,
    )
    .await?;
    configure_git_credential_store(state, &credentials_file, &git_config_file).await?;

    Ok(GitHubAuthInstallResponse {
        installed: true,
        host: GITHUB_HOST.to_string(),
        login: viewer.login,
        scopes: viewer.scopes,
        credential_file: credentials_file.to_string_lossy().to_string(),
    })
}

async fn fetch_github_viewer(
    state: &Arc<AppState>,
    access_token: &str,
) -> Result<GitHubViewer, BridgeError> {
    let trimmed = access_token.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("accessToken must not be empty"));
    }

    let api_url = state
        .config
        .github_codespaces_auth
        .as_ref()
        .map(|config| config.api_url.as_str())
        .unwrap_or(GITHUB_API_URL);
    let http = HttpClient::builder()
        .user_agent("clawdex-rust-bridge")
        .build()
        .map_err(|error| {
            BridgeError::server(&format!("failed to build GitHub auth client: {error}"))
        })?;
    let response = http
        .get(format!("{api_url}/user"))
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", GITHUB_CODESPACES_API_VERSION)
        .bearer_auth(trimmed)
        .send()
        .await
        .map_err(|error| BridgeError::server(&format!("GitHub auth check failed: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let message = if let Ok(value) = serde_json::from_str::<Value>(&body) {
            read_string(value.get("message"))
                .unwrap_or_else(|| format!("GitHub auth check failed ({status})"))
        } else {
            format!("GitHub auth check failed ({status})")
        };
        return Err(BridgeError::server(&message));
    }

    let scopes = parse_github_oauth_scopes(
        response
            .headers()
            .get("x-oauth-scopes")
            .and_then(|value| value.to_str().ok()),
    );
    let payload = response.json::<Value>().await.map_err(|error| {
        BridgeError::server(&format!("failed to parse GitHub user response: {error}"))
    })?;
    let login = read_string(payload.get("login"))
        .ok_or_else(|| BridgeError::server("GitHub auth check returned an invalid user payload"))?;

    Ok(GitHubViewer { login, scopes })
}

fn parse_github_oauth_scopes(header: Option<&str>) -> Vec<String> {
    header
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn github_scopes_allow_repo_access(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| scope == "repo" || scope == "public_repo")
}

fn github_token_can_be_used_for_git_auth(scopes: &[String]) -> bool {
    scopes.is_empty() || github_scopes_allow_repo_access(scopes)
}

fn normalize_github_auth_repositories(repositories: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for repository in repositories {
        let trimmed = repository.trim().trim_matches('/');
        let Some((owner, name)) = trimmed.split_once('/') else {
            continue;
        };
        if owner.is_empty() || name.is_empty() || name.contains('/') {
            continue;
        }

        let key = format!(
            "{}/{}",
            owner.to_ascii_lowercase(),
            name.to_ascii_lowercase()
        );
        if seen.insert(key) {
            normalized.push(format!("{owner}/{name}"));
        }
    }

    normalized.sort_unstable_by_key(|repository| repository.to_ascii_lowercase());
    normalized
}

fn resolve_github_credentials_dir_path() -> Result<PathBuf, BridgeError> {
    let home = read_non_empty_env("HOME")
        .ok_or_else(|| BridgeError::server("HOME is not set; cannot install GitHub auth"))?;
    Ok(PathBuf::from(home).join(GITHUB_CREDENTIALS_DIR_NAME))
}

fn resolve_github_credentials_file_path() -> Result<PathBuf, BridgeError> {
    Ok(resolve_github_credentials_dir_path()?.join(GITHUB_CREDENTIALS_FILE_NAME))
}

fn resolve_github_git_config_file_path() -> Result<PathBuf, BridgeError> {
    Ok(resolve_github_credentials_dir_path()?.join(GITHUB_GIT_CONFIG_FILE_NAME))
}

async fn ensure_private_parent_dir(path: &Path) -> Result<(), BridgeError> {
    let Some(parent) = path.parent() else {
        return Err(BridgeError::server(
            "failed to resolve GitHub credential directory",
        ));
    };
    fs::create_dir_all(parent).await.map_err(|error| {
        BridgeError::server(&format!("failed to create GitHub auth directory: {error}"))
    })?;
    #[cfg(unix)]
    {
        fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|error| {
                BridgeError::server(&format!(
                    "failed to secure GitHub auth directory permissions: {error}"
                ))
            })?;
    }
    Ok(())
}

async fn write_github_credentials_file(
    credentials_file: &Path,
    access_token: &str,
    repositories: &[String],
) -> Result<(), BridgeError> {
    let mut content = String::new();
    let trimmed_access_token = access_token.trim();
    for repository in repositories {
        content.push_str(&format!(
            "https://x-access-token:{trimmed_access_token}@{GITHUB_HOST}/{repository}\n"
        ));
        content.push_str(&format!(
            "https://x-access-token:{trimmed_access_token}@{GITHUB_HOST}/{repository}.git\n"
        ));
    }

    fs::write(credentials_file, content)
        .await
        .map_err(|error| {
            BridgeError::server(&format!("failed to write GitHub credentials: {error}"))
        })?;
    #[cfg(unix)]
    {
        fs::set_permissions(credentials_file, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| {
                BridgeError::server(&format!(
                    "failed to secure GitHub credential permissions: {error}"
                ))
            })?;
    }
    Ok(())
}

async fn write_github_git_config_file(
    git_config_file: &Path,
    credentials_file: &Path,
    repositories: &[String],
) -> Result<(), BridgeError> {
    let helper_value = format!("store --file {}", credentials_file.to_string_lossy());
    let mut content = String::from(
        "[credential \"https://github.com\"]\n\tuseHttpPath = true\n[url \"https://github.com/\"]\n\tinsteadOf = git@github.com:\n\tinsteadOf = ssh://git@github.com/\n",
    );

    for repository in repositories {
        for context in [
            format!("https://{GITHUB_HOST}/{repository}"),
            format!("https://{GITHUB_HOST}/{repository}.git"),
        ] {
            content.push_str(&format!(
                "[credential \"{context}\"]\n\thelper =\n\thelper = {helper_value}\n\tusername = x-access-token\n"
            ));
        }
    }

    fs::write(git_config_file, content).await.map_err(|error| {
        BridgeError::server(&format!("failed to write GitHub git config: {error}"))
    })?;
    #[cfg(unix)]
    {
        fs::set_permissions(git_config_file, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| {
                BridgeError::server(&format!(
                    "failed to secure GitHub git config permissions: {error}"
                ))
            })?;
    }
    Ok(())
}

async fn configure_git_credential_store(
    state: &Arc<AppState>,
    credentials_file: &Path,
    git_config_file: &Path,
) -> Result<(), BridgeError> {
    let helper_value = format!("store --file {}", credentials_file.to_string_lossy());
    let include_path = git_config_file.to_string_lossy().to_string();
    let commands = vec![
        (
            vec![
                "config".to_string(),
                "--global".to_string(),
                "--fixed-value".to_string(),
                "--unset-all".to_string(),
                "credential.helper".to_string(),
                helper_value.clone(),
            ],
            true,
        ),
        (
            vec![
                "config".to_string(),
                "--global".to_string(),
                "--fixed-value".to_string(),
                "--unset-all".to_string(),
                "credential.https://github.com.helper".to_string(),
                helper_value.clone(),
            ],
            true,
        ),
        (
            vec![
                "config".to_string(),
                "--global".to_string(),
                "--fixed-value".to_string(),
                "--unset-all".to_string(),
                "credential.https://github.com.username".to_string(),
                "x-access-token".to_string(),
            ],
            true,
        ),
        (
            vec![
                "config".to_string(),
                "--global".to_string(),
                "--fixed-value".to_string(),
                "--unset-all".to_string(),
                "include.path".to_string(),
                include_path.clone(),
            ],
            true,
        ),
        (
            vec![
                "config".to_string(),
                "--global".to_string(),
                "--add".to_string(),
                "include.path".to_string(),
                include_path,
            ],
            false,
        ),
    ];

    for (args, allow_missing) in commands {
        let result = state
            .terminal
            .execute_binary("git", &args, state.config.workdir.clone(), None)
            .await?;

        let code = result.code.unwrap_or(-1);
        if code != 0 && !(allow_missing && code == 5) {
            return Err(BridgeError::server(
                &(if !result.stderr.is_empty() {
                    result.stderr
                } else if !result.stdout.is_empty() {
                    result.stdout
                } else {
                    "failed to configure git credentials".to_string()
                }),
            ));
        }
    }

    Ok(())
}

#[derive(Clone)]
struct AppState {
    config: Arc<BridgeConfig>,
    started_at: Instant,
    hub: Arc<ClientHub>,
    backend: Arc<RuntimeBackend>,
    queue: Arc<BridgeQueueService>,
    terminal: Arc<TerminalService>,
    git: Arc<GitService>,
    updater: Arc<UpdateService>,
    preview: Arc<BrowserPreviewService>,
    github_codespaces_auth: Option<Arc<GitHubCodespacesAuthService>>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
enum BridgeRuntimeEngine {
    Codex,
    Opencode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeCapabilities {
    active_engine: BridgeRuntimeEngine,
    available_engines: Vec<BridgeRuntimeEngine>,
    unified_chat_list: bool,
    supports: BridgeCapabilitySupport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeCapabilitySupport {
    review_start: bool,
    turn_steer: bool,
    command_output_delta: bool,
    self_update: bool,
    browser_preview: bool,
}

impl AppState {
    fn bridge_capabilities(&self) -> BridgeCapabilities {
        let mut capabilities = self.backend.capabilities();
        capabilities.supports.self_update = self.updater.is_self_update_supported();
        capabilities.supports.browser_preview = self.preview.is_available();
        capabilities
    }

    async fn is_authorized(&self, headers: &HeaderMap, query_token: Option<&str>) -> bool {
        if !self.config.auth_enabled {
            return true;
        }

        if self
            .config
            .is_authorized_with_bridge_token(headers, query_token)
        {
            return true;
        }

        let Some(service) = &self.github_codespaces_auth else {
            return false;
        };
        let Some(token) = extract_bearer_token(headers) else {
            return false;
        };

        service.is_authorized(token).await
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewSessionResponse {
    session_id: String,
    target_url: String,
    preview_port: u16,
    preview_base_url: Option<String>,
    bootstrap_path: String,
    created_at: String,
    last_accessed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewDiscoverySuggestion {
    target_url: String,
    port: u16,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewDiscoveryResponse {
    scanned_at: String,
    suggestions: Vec<BrowserPreviewDiscoverySuggestion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewCreateRequest {
    target_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewCloseRequest {
    session_id: String,
}

#[derive(Debug, Clone)]
struct BrowserPreviewSessionEntry {
    id: String,
    target_url: Url,
    bootstrap_token: String,
    created_at: String,
    last_accessed_at: String,
}

#[derive(Debug, Clone)]
struct BrowserPreviewResolvedSession {
    target_url: Url,
}

struct BrowserPreviewService {
    bridge_port: u16,
    preview_port: u16,
    preview_base_url: Option<String>,
    available: AtomicBool,
    next_session_counter: AtomicU64,
    http: HttpClient,
    sessions: RwLock<HashMap<String, BrowserPreviewSessionEntry>>,
}

impl BrowserPreviewService {
    fn new(bridge_port: u16, preview_port: u16, preview_base_url: Option<String>) -> Self {
        Self {
            bridge_port,
            preview_port,
            preview_base_url,
            available: AtomicBool::new(false),
            next_session_counter: AtomicU64::new(1),
            http: HttpClient::builder()
                .danger_accept_invalid_certs(true)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("build browser preview client"),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    fn set_available(&self, available: bool) {
        self.available.store(available, Ordering::Relaxed);
    }

    async fn create_session(
        &self,
        target_url: &str,
    ) -> Result<BrowserPreviewSessionResponse, BridgeError> {
        if !self.is_available() {
            return Err(BridgeError::server("browser preview server is unavailable"));
        }

        let target_url = normalize_browser_preview_target_url(target_url)?;
        let created_at = now_iso();
        let session_id = self.next_id("preview-session");
        let bootstrap_token = self.next_id("preview-token");
        let entry = BrowserPreviewSessionEntry {
            id: session_id.clone(),
            target_url,
            bootstrap_token,
            created_at: created_at.clone(),
            last_accessed_at: created_at,
        };

        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        evict_excess_preview_sessions(&mut sessions);
        sessions.insert(session_id, entry.clone());
        Ok(self.to_session_response(&entry))
    }

    async fn list_sessions(&self) -> Vec<BrowserPreviewSessionResponse> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);

        let mut entries = sessions.values().cloned().collect::<Vec<_>>();
        entries.sort_by(|left, right| right.last_accessed_at.cmp(&left.last_accessed_at));
        entries
            .iter()
            .map(|entry| self.to_session_response(entry))
            .collect()
    }

    async fn close_session(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id).is_some()
    }

    async fn resolve_bootstrap(
        &self,
        session_id: &str,
        bootstrap_token: &str,
    ) -> Option<BrowserPreviewResolvedSession> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let entry = sessions.get_mut(session_id)?;
        if !constant_time_eq(&entry.bootstrap_token, bootstrap_token) {
            return None;
        }

        entry.last_accessed_at = now_iso();
        Some(BrowserPreviewResolvedSession {
            target_url: entry.target_url.clone(),
        })
    }

    async fn resolve_cookie(&self, bootstrap_token: &str) -> Option<BrowserPreviewResolvedSession> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let now = now_iso();

        for entry in sessions.values_mut() {
            if constant_time_eq(&entry.bootstrap_token, bootstrap_token) {
                entry.last_accessed_at = now.clone();
                return Some(BrowserPreviewResolvedSession {
                    target_url: entry.target_url.clone(),
                });
            }
        }

        None
    }

    async fn discover_targets(&self) -> BrowserPreviewDiscoveryResponse {
        let candidate_ports =
            discover_loopback_listening_ports(&[self.bridge_port, self.preview_port]).await;
        let http = self.http.clone();
        let mut suggestions = stream::iter(candidate_ports.into_iter())
            .map(|port| {
                let http = http.clone();
                async move {
                    if is_loopback_http_port_reachable(&http, port).await {
                        Some(BrowserPreviewDiscoverySuggestion {
                            target_url: format!("http://127.0.0.1:{port}"),
                            port,
                            label: browser_preview_label_for_port(port),
                        })
                    } else {
                        None
                    }
                }
            })
            .buffer_unordered(24)
            .filter_map(async move |suggestion| suggestion)
            .collect::<Vec<_>>()
            .await;

        suggestions.sort_by_key(|suggestion| suggestion.port);

        BrowserPreviewDiscoveryResponse {
            scanned_at: now_iso(),
            suggestions,
        }
    }

    fn to_session_response(
        &self,
        entry: &BrowserPreviewSessionEntry,
    ) -> BrowserPreviewSessionResponse {
        BrowserPreviewSessionResponse {
            session_id: entry.id.clone(),
            target_url: entry.target_url.to_string(),
            preview_port: self.preview_port,
            preview_base_url: self.preview_base_url.clone(),
            bootstrap_path: build_preview_bootstrap_path(
                &entry.target_url,
                &entry.id,
                &entry.bootstrap_token,
            ),
            created_at: entry.created_at.clone(),
            last_accessed_at: entry.last_accessed_at.clone(),
        }
    }

    fn next_id(&self, prefix: &str) -> String {
        let nonce = self.next_session_counter.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let raw = format!("{prefix}:{stamp:x}:{nonce:x}");
        general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes())
    }
}

#[derive(Clone)]
struct RuntimeBackend {
    preferred_engine: BridgeRuntimeEngine,
    codex: Option<Arc<AppServerBridge>>,
    opencode: Option<Arc<OpencodeBackend>>,
}

impl RuntimeBackend {
    async fn start(config: &Arc<BridgeConfig>, hub: Arc<ClientHub>) -> Result<Arc<Self>, String> {
        let preferred_engine = config.active_engine;
        let codex_enabled = config.enabled_engines.contains(&BridgeRuntimeEngine::Codex);
        let opencode_enabled = config
            .enabled_engines
            .contains(&BridgeRuntimeEngine::Opencode);
        let mut codex = None;
        let mut opencode = None;

        match preferred_engine {
            BridgeRuntimeEngine::Codex => {
                if codex_enabled {
                    let app_server = AppServerBridge::start(
                        &config.cli_bin,
                        BridgeRuntimeEngine::Codex,
                        hub.clone(),
                    )
                    .await?;
                    spawn_rollout_live_sync(hub.clone());
                    codex = Some(app_server);
                }

                if opencode_enabled {
                    match OpencodeBackend::start(config, hub).await {
                        Ok(backend) => opencode = Some(backend),
                        Err(error) => eprintln!(
                            "opencode backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }
            }
            BridgeRuntimeEngine::Opencode => {
                if opencode_enabled {
                    let backend = OpencodeBackend::start(config, hub.clone()).await?;
                    opencode = Some(backend);
                }

                if codex_enabled {
                    match AppServerBridge::start(
                        &config.cli_bin,
                        BridgeRuntimeEngine::Codex,
                        hub.clone(),
                    )
                    .await
                    {
                        Ok(app_server) => {
                            spawn_rollout_live_sync(hub);
                            codex = Some(app_server);
                        }
                        Err(error) => eprintln!(
                            "codex backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }
            }
        }

        Ok(Arc::new(Self {
            preferred_engine,
            codex,
            opencode,
        }))
    }

    async fn shutdown(&self) {
        if let Some(codex) = &self.codex {
            codex.request_shutdown().await;
        }
        if let Some(opencode) = &self.opencode {
            opencode.request_shutdown().await;
        }
    }

    fn engine(&self) -> BridgeRuntimeEngine {
        self.preferred_engine
    }

    fn available_engines(&self) -> Vec<BridgeRuntimeEngine> {
        let mut engines = Vec::new();
        if self.codex.is_some() {
            engines.push(BridgeRuntimeEngine::Codex);
        }
        if self.opencode.is_some() {
            engines.push(BridgeRuntimeEngine::Opencode);
        }
        engines
    }

    fn capabilities(&self) -> BridgeCapabilities {
        let active_engine = self.engine();
        let supports = match active_engine {
            BridgeRuntimeEngine::Codex => BridgeCapabilitySupport {
                review_start: true,
                turn_steer: true,
                command_output_delta: true,
                self_update: false,
                browser_preview: false,
            },
            BridgeRuntimeEngine::Opencode => BridgeCapabilitySupport {
                review_start: false,
                turn_steer: false,
                command_output_delta: false,
                self_update: false,
                browser_preview: false,
            },
        };
        let available_engines = self.available_engines();

        BridgeCapabilities {
            active_engine,
            unified_chat_list: available_engines.len() > 1,
            available_engines,
            supports,
        }
    }

    fn backend_for_engine(
        &self,
        engine: BridgeRuntimeEngine,
    ) -> Result<RuntimeBackendRef<'_>, String> {
        match engine {
            BridgeRuntimeEngine::Codex => self
                .codex
                .as_ref()
                .map(RuntimeBackendRef::Codex)
                .ok_or_else(|| "codex backend is unavailable".to_string()),
            BridgeRuntimeEngine::Opencode => self
                .opencode
                .as_ref()
                .map(RuntimeBackendRef::Opencode)
                .ok_or_else(|| "opencode backend is unavailable".to_string()),
        }
    }

    fn route_engine_for_method(
        &self,
        method: &str,
        raw_params: Option<&Value>,
    ) -> BridgeRuntimeEngine {
        if is_dual_engine_aggregate_method(method) {
            return self.preferred_engine;
        }

        route_engine_from_params(raw_params).unwrap_or(self.preferred_engine)
    }

    async fn forward_request(
        &self,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        raw_params: Option<Value>,
    ) -> Result<(), String> {
        if is_dual_engine_aggregate_method(method) {
            let result = self.request_internal(method, raw_params).await?;
            self.send_client_result(client_id, client_request_id, result)
                .await;
            return Ok(());
        }

        let target_engine = self.route_engine_for_method(method, raw_params.as_ref());
        let normalized_params = raw_params.map(normalize_forwarded_params);
        match self.backend_for_engine(target_engine)? {
            RuntimeBackendRef::Codex(bridge) => {
                bridge
                    .forward_request(client_id, client_request_id, method, normalized_params)
                    .await
            }
            RuntimeBackendRef::Opencode(backend) => {
                backend
                    .forward_request(client_id, client_request_id, method, normalized_params)
                    .await
            }
        }
    }

    async fn request_internal(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        if method == "thread/list" {
            return self.aggregate_thread_list(params).await;
        }
        if method == "thread/loaded/list" {
            return self.aggregate_loaded_thread_ids().await;
        }
        if method == "model/list" {
            let target_engine =
                route_engine_from_params(params.as_ref()).unwrap_or(self.preferred_engine);
            let normalized_params = params.map(normalize_forwarded_params);
            return match self.backend_for_engine(target_engine)? {
                RuntimeBackendRef::Codex(bridge) => {
                    bridge.request_internal(method, normalized_params).await
                }
                RuntimeBackendRef::Opencode(backend) => {
                    backend.request_internal(method, normalized_params).await
                }
            };
        }

        let target_engine = self.route_engine_for_method(method, params.as_ref());
        let normalized_params = params.map(normalize_forwarded_params);
        match self.backend_for_engine(target_engine)? {
            RuntimeBackendRef::Codex(bridge) => {
                bridge.request_internal(method, normalized_params).await
            }
            RuntimeBackendRef::Opencode(backend) => {
                backend.request_internal(method, normalized_params).await
            }
        }
    }

    async fn aggregate_thread_list(&self, params: Option<Value>) -> Result<Value, String> {
        let mut results = Vec::new();

        if let Some(codex) = &self.codex {
            results.push((
                BridgeRuntimeEngine::Codex,
                codex
                    .request_internal("thread/list", params.clone())
                    .await?,
            ));
        }

        if let Some(opencode) = &self.opencode {
            results.push((
                BridgeRuntimeEngine::Opencode,
                opencode.request_internal("thread/list", params).await?,
            ));
        }

        Ok(merge_thread_list_results(results))
    }

    async fn aggregate_loaded_thread_ids(&self) -> Result<Value, String> {
        let mut results = Vec::new();

        if let Some(codex) = &self.codex {
            results.push((
                BridgeRuntimeEngine::Codex,
                codex.request_internal("thread/loaded/list", None).await?,
            ));
        }

        if let Some(opencode) = &self.opencode {
            results.push((
                BridgeRuntimeEngine::Opencode,
                opencode
                    .request_internal("thread/loaded/list", None)
                    .await?,
            ));
        }

        Ok(merge_loaded_thread_ids_results(results))
    }

    async fn list_pending_approvals(&self) -> Vec<PendingApproval> {
        let mut approvals = Vec::new();
        if let Some(codex) = &self.codex {
            approvals.extend(codex.list_pending_approvals().await);
        }
        if let Some(opencode) = &self.opencode {
            approvals.extend(opencode.list_pending_approvals().await);
        }
        approvals.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        approvals
    }

    async fn list_pending_user_inputs(&self) -> Vec<PendingUserInputRequest> {
        let mut requests = Vec::new();
        if let Some(codex) = &self.codex {
            requests.extend(codex.list_pending_user_inputs().await);
        }
        if let Some(opencode) = &self.opencode {
            requests.extend(opencode.list_pending_user_inputs().await);
        }
        requests.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        requests
    }

    async fn resolve_approval(
        &self,
        approval_id: &str,
        decision: &Value,
    ) -> Result<Option<PendingApproval>, String> {
        if let Some(codex) = &self.codex {
            if let Some(approval) = codex.resolve_approval(approval_id, decision).await? {
                return Ok(Some(approval));
            }
        }

        if let Some(opencode) = &self.opencode {
            if let Some(approval) = opencode.resolve_approval(approval_id, decision).await? {
                return Ok(Some(approval));
            }
        }

        Ok(None)
    }

    async fn resolve_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, UserInputAnswerPayload>,
    ) -> Result<Option<PendingUserInputRequest>, String> {
        if let Some(codex) = &self.codex {
            if let Some(request) = codex.resolve_user_input(request_id, answers).await? {
                return Ok(Some(request));
            }
        }

        if let Some(opencode) = &self.opencode {
            if let Some(request) = opencode.resolve_user_input(request_id, answers).await? {
                return Ok(Some(request));
            }
        }

        Ok(None)
    }

    async fn send_client_result(&self, client_id: u64, client_request_id: Value, result: Value) {
        self.send_client_result_error(client_id, client_request_id, Ok(result))
            .await;
    }

    async fn send_client_result_error(
        &self,
        client_id: u64,
        client_request_id: Value,
        result: Result<Value, String>,
    ) {
        let payload = match result {
            Ok(result) => json!({
                "id": client_request_id,
                "result": result,
            }),
            Err(error) => json!({
                "id": client_request_id,
                "error": {
                    "code": -32000,
                    "message": error,
                }
            }),
        };
        if let Some(codex) = &self.codex {
            codex.hub.send_json(client_id, payload).await;
        } else if let Some(opencode) = &self.opencode {
            opencode.hub.send_json(client_id, payload).await;
        }
    }
}

fn configure_managed_child_command(command: &mut Command) {
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
}

async fn terminate_managed_child(pid: u32, label: &str) {
    #[cfg(unix)]
    {
        terminate_process_group_unix(pid, label).await;
        return;
    }

    #[cfg(windows)]
    {
        terminate_process_tree_windows(pid, label).await;
        return;
    }

    #[allow(unreachable_code)]
    let _ = (pid, label);
}

#[cfg(unix)]
async fn wait_for_shutdown_signal() -> &'static str {
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .expect("failed to install SIGINT handler");
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("failed to install SIGTERM handler");

    tokio::select! {
        _ = sigint.recv() => "SIGINT",
        _ = sigterm.recv() => "SIGTERM",
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() -> &'static str {
    let _ = tokio::signal::ctrl_c().await;
    "Ctrl+C"
}

#[cfg(unix)]
async fn terminate_process_group_unix(pid: u32, label: &str) {
    let process_group = pid as i32;
    if process_group <= 0 {
        return;
    }

    let terminate_result = unsafe { libc::killpg(process_group, libc::SIGTERM) };
    if terminate_result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            eprintln!("failed to terminate {label} process group {process_group}: {error}");
        }
        return;
    }

    tokio::time::sleep(Duration::from_millis(400)).await;

    let kill_result = unsafe { libc::killpg(process_group, 0) };
    if kill_result == 0 {
        let force_result = unsafe { libc::killpg(process_group, libc::SIGKILL) };
        if force_result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                eprintln!("failed to force-kill {label} process group {process_group}: {error}");
            }
        }
    }
}

#[cfg(windows)]
async fn terminate_process_tree_windows(pid: u32, label: &str) {
    let status = Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .status()
        .await;

    match status {
        Ok(result) if result.success() => {}
        Ok(result) => eprintln!("failed to terminate {label} process tree {pid}: {result}"),
        Err(error) => eprintln!("failed to terminate {label} process tree {pid}: {error}"),
    }
}

enum RuntimeBackendRef<'a> {
    Codex(&'a Arc<AppServerBridge>),
    Opencode(&'a Arc<OpencodeBackend>),
}

struct ClientHub {
    next_client_id: AtomicU64,
    next_event_id: AtomicU64,
    replay_capacity: usize,
    clients: RwLock<HashMap<u64, mpsc::Sender<Message>>>,
    notification_replay: RwLock<VecDeque<ReplayableNotification>>,
    notification_tx: broadcast::Sender<HubNotification>,
}

#[derive(Clone)]
struct ReplayableNotification {
    event_id: u64,
    payload: Value,
}

#[derive(Clone)]
struct HubNotification {
    event_id: u64,
    method: String,
    params: Value,
}

impl ClientHub {
    fn new() -> Self {
        Self::with_replay_capacity(NOTIFICATION_REPLAY_BUFFER_SIZE)
    }

    fn with_replay_capacity(replay_capacity: usize) -> Self {
        let (notification_tx, _) =
            broadcast::channel::<HubNotification>(INTERNAL_NOTIFICATION_CHANNEL_CAPACITY);
        Self {
            next_client_id: AtomicU64::new(1),
            next_event_id: AtomicU64::new(1),
            replay_capacity,
            clients: RwLock::new(HashMap::new()),
            notification_replay: RwLock::new(VecDeque::new()),
            notification_tx,
        }
    }

    fn subscribe_notifications(&self) -> broadcast::Receiver<HubNotification> {
        self.notification_tx.subscribe()
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
        let params = payload.get("params").cloned().unwrap_or(Value::Null);

        self.push_replay(event_id, payload.clone()).await;
        let _ = self.notification_tx.send(HubNotification {
            event_id,
            method: method.to_string(),
            params,
        });
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

impl BridgeQueuedMessageEntry {
    fn to_public(&self) -> BridgeQueuedMessage {
        BridgeQueuedMessage {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            content: self.content.clone(),
        }
    }
}

impl BridgeQueueService {
    fn new(backend: Arc<RuntimeBackend>, hub: Arc<ClientHub>) -> Arc<Self> {
        let service = Arc::new(Self {
            backend,
            hub,
            threads: Arc::new(RwLock::new(HashMap::new())),
            next_queue_item_id: AtomicU64::new(1),
        });
        service.spawn_notification_loop();
        service
    }

    fn next_queued_message_id(&self) -> String {
        format!(
            "queue-{}",
            self.next_queue_item_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn spawn_notification_loop(self: &Arc<Self>) {
        let this = Arc::clone(self);
        let mut receiver = this.hub.subscribe_notifications();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(notification) => this.handle_notification(notification).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    async fn read_queue(&self, thread_id: &str) -> BridgeThreadQueueState {
        let normalized_thread_id = thread_id.trim();
        if normalized_thread_id.is_empty() {
            return BridgeThreadQueueState {
                thread_id: String::new(),
                items: Vec::new(),
                last_error: None,
            };
        }

        let threads = self.threads.read().await;
        let runtime = threads.get(normalized_thread_id);
        Self::snapshot_for_thread(normalized_thread_id, runtime)
    }

    async fn send_message(
        &self,
        request: BridgeThreadQueueSendRequest,
    ) -> Result<BridgeThreadQueueSendResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let content = request.content.trim().to_string();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }
        if content.is_empty() {
            return Err("content must not be empty".to_string());
        }

        self.ensure_thread_runtime(&normalized_thread_id).await?;

        let queued_item = BridgeQueuedMessageEntry {
            id: self.next_queued_message_id(),
            created_at: now_iso(),
            content,
            turn_start: request.turn_start,
        };

        let should_queue = {
            let threads = self.threads.read().await;
            let runtime = threads.get(&normalized_thread_id);
            runtime.is_some_and(Self::runtime_is_blocked_or_occupied)
        };

        if should_queue {
            let snapshot = {
                let mut threads = self.threads.write().await;
                let runtime = threads
                    .entry(normalized_thread_id.clone())
                    .or_insert_with(BridgeThreadQueueRuntime::default);
                runtime.items.push_back(queued_item);
                runtime.last_error = None;
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
            };
            self.broadcast_snapshot(&snapshot).await;
            return Ok(BridgeThreadQueueSendResponse {
                disposition: BridgeThreadQueueDisposition::Queued,
                queue: snapshot,
                turn_id: None,
            });
        }

        {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .entry(normalized_thread_id.clone())
                .or_insert_with(BridgeThreadQueueRuntime::default);
            runtime.turn_start_in_flight = true;
            runtime.last_error = None;
        }

        match self
            .dispatch_turn_start(&normalized_thread_id, &queued_item.turn_start)
            .await
        {
            Ok(turn_id) => {
                let snapshot = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads
                        .entry(normalized_thread_id.clone())
                        .or_insert_with(BridgeThreadQueueRuntime::default);
                    runtime.turn_start_in_flight = false;
                    runtime.thread_running = true;
                    runtime.active_turn_id = Some(turn_id.clone());
                    runtime.last_error = None;
                    Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
                };
                Ok(BridgeThreadQueueSendResponse {
                    disposition: BridgeThreadQueueDisposition::Sent,
                    queue: snapshot,
                    turn_id: Some(turn_id),
                })
            }
            Err(error) => {
                let mut threads = self.threads.write().await;
                if let Some(runtime) = threads.get_mut(&normalized_thread_id) {
                    runtime.turn_start_in_flight = false;
                }
                Err(error)
            }
        }
    }

    async fn steer_message(
        &self,
        request: BridgeThreadQueueSteerRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }
        if normalized_item_id.is_empty() {
            return Err("itemId must not be empty".to_string());
        }

        self.ensure_thread_runtime(&normalized_thread_id).await?;

        let (turn_id, removed_item, removed_index, snapshot) = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;

            if runtime.turn_start_in_flight || runtime.action_in_flight_item_id.is_some() {
                return Err("queue is busy processing another action".to_string());
            }
            if !runtime.pending_approval_ids.is_empty() {
                return Err("cannot steer while an approval is pending".to_string());
            }
            if !runtime.pending_user_input_ids.is_empty() {
                return Err("cannot steer while user input is pending".to_string());
            }

            let active_turn_id = runtime
                .active_turn_id
                .clone()
                .ok_or_else(|| "no active turn available to steer".to_string())?;
            let item_index = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
                .ok_or_else(|| "queued message not found".to_string())?;
            let removed_item = runtime
                .items
                .remove(item_index)
                .ok_or_else(|| "queued message not found".to_string())?;
            runtime.action_in_flight_item_id = Some(normalized_item_id.clone());
            runtime.last_error = None;
            let snapshot = Self::snapshot_for_thread(&normalized_thread_id, Some(runtime));
            (active_turn_id, removed_item, item_index, snapshot)
        };

        self.broadcast_snapshot(&snapshot).await;

        match self
            .dispatch_turn_steer(&normalized_thread_id, &turn_id, &removed_item.turn_start)
            .await
        {
            Ok(()) => {
                let snapshot = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads
                        .entry(normalized_thread_id.clone())
                        .or_insert_with(BridgeThreadQueueRuntime::default);
                    if runtime.action_in_flight_item_id.as_deref()
                        == Some(normalized_item_id.as_str())
                    {
                        runtime.action_in_flight_item_id = None;
                    }
                    runtime.last_error = None;
                    Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
                };
                Ok(BridgeThreadQueueActionResponse {
                    ok: true,
                    queue: snapshot,
                })
            }
            Err(error) => {
                let snapshot = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads
                        .entry(normalized_thread_id.clone())
                        .or_insert_with(BridgeThreadQueueRuntime::default);
                    if runtime.action_in_flight_item_id.as_deref()
                        == Some(normalized_item_id.as_str())
                    {
                        runtime.action_in_flight_item_id = None;
                    }
                    let insert_index = removed_index.min(runtime.items.len());
                    runtime.items.insert(insert_index, removed_item);
                    runtime.last_error = Some(BridgeThreadQueueError {
                        message: error.clone(),
                        operation: "steer".to_string(),
                        at: now_iso(),
                        item_id: Some(normalized_item_id.clone()),
                    });
                    Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
                };
                self.broadcast_snapshot(&snapshot).await;
                Err(error)
            }
        }
    }

    async fn cancel_message(
        &self,
        request: BridgeThreadQueueCancelRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }
        if normalized_item_id.is_empty() {
            return Err("itemId must not be empty".to_string());
        }

        let snapshot = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .entry(normalized_thread_id.clone())
                .or_insert_with(BridgeThreadQueueRuntime::default);
            if runtime.action_in_flight_item_id.as_deref() == Some(normalized_item_id.as_str()) {
                return Err(
                    "cannot cancel a queued message while it is being processed".to_string()
                );
            }
            let Some(item_index) = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
            else {
                return Err("queued message not found".to_string());
            };
            runtime.items.remove(item_index);
            runtime.last_error = None;
            Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
        };

        self.broadcast_snapshot(&snapshot).await;

        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
    }

    async fn ensure_thread_runtime(&self, thread_id: &str) -> Result<(), String> {
        let normalized_thread_id = thread_id.trim();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }

        {
            let threads = self.threads.read().await;
            if threads.contains_key(normalized_thread_id) {
                return Ok(());
            }
        }

        let hydrated = self.hydrate_thread_runtime(normalized_thread_id).await?;
        let mut threads = self.threads.write().await;
        threads
            .entry(normalized_thread_id.to_string())
            .or_insert(hydrated);
        Ok(())
    }

    async fn hydrate_thread_runtime(
        &self,
        thread_id: &str,
    ) -> Result<BridgeThreadQueueRuntime, String> {
        let thread_result = self
            .backend
            .request_internal("thread/read", Some(json!({ "threadId": thread_id })))
            .await?;
        let thread = thread_result
            .get("thread")
            .ok_or_else(|| "thread/read did not return thread".to_string())?;

        let approvals = self.backend.list_pending_approvals().await;
        let user_inputs = self.backend.list_pending_user_inputs().await;

        let mut runtime = BridgeThreadQueueRuntime::default();
        runtime.active_turn_id = read_active_turn_id_from_thread(thread);
        runtime.thread_running = thread_has_running_turn(thread);
        runtime.pending_approval_ids = approvals
            .into_iter()
            .filter(|entry| entry.thread_id == thread_id)
            .map(|entry| entry.id)
            .collect();
        runtime.pending_user_input_ids = user_inputs
            .into_iter()
            .filter(|entry| entry.thread_id == thread_id)
            .map(|entry| entry.id)
            .collect();
        Ok(runtime)
    }

    async fn dispatch_turn_start(
        &self,
        thread_id: &str,
        turn_start: &Value,
    ) -> Result<String, String> {
        Self::dispatch_turn_start_with_backend(&self.backend, thread_id, turn_start).await
    }

    async fn dispatch_turn_start_with_backend(
        backend: &Arc<RuntimeBackend>,
        thread_id: &str,
        turn_start: &Value,
    ) -> Result<String, String> {
        let mut params = turn_start.clone();
        let params_object = params
            .as_object_mut()
            .ok_or_else(|| "turnStart payload must be an object".to_string())?;
        params_object.insert("threadId".to_string(), Value::String(thread_id.to_string()));

        let response = backend
            .request_internal("turn/start", Some(Value::Object(params_object.clone())))
            .await?;
        read_string(
            response
                .as_object()
                .and_then(|object| object.get("turn"))
                .and_then(Value::as_object)
                .and_then(|turn| turn.get("id")),
        )
        .ok_or_else(|| "turn/start did not return turn id".to_string())
    }

    async fn dispatch_turn_steer(
        &self,
        thread_id: &str,
        turn_id: &str,
        turn_start: &Value,
    ) -> Result<(), String> {
        let input = turn_start
            .as_object()
            .and_then(|object| object.get("input"))
            .cloned()
            .ok_or_else(|| "turnStart payload missing input".to_string())?;

        self.backend
            .request_internal(
                "turn/steer",
                Some(json!({
                    "threadId": thread_id,
                    "expectedTurnId": turn_id,
                    "input": input,
                })),
            )
            .await?;
        Ok(())
    }

    async fn broadcast_snapshot(&self, snapshot: &BridgeThreadQueueState) {
        if let Ok(value) = serde_json::to_value(snapshot) {
            self.hub
                .broadcast_notification("bridge/thread/queue/updated", value)
                .await;
        }
    }

    fn snapshot_for_thread(
        thread_id: &str,
        runtime: Option<&BridgeThreadQueueRuntime>,
    ) -> BridgeThreadQueueState {
        let (items, last_error) = runtime.map_or((Vec::new(), None), |runtime| {
            (
                runtime
                    .items
                    .iter()
                    .map(BridgeQueuedMessageEntry::to_public)
                    .collect::<Vec<_>>(),
                runtime.last_error.clone(),
            )
        });

        BridgeThreadQueueState {
            thread_id: thread_id.to_string(),
            items,
            last_error,
        }
    }

    fn runtime_has_blockers(runtime: &BridgeThreadQueueRuntime) -> bool {
        runtime.thread_running
            || runtime.turn_start_in_flight
            || runtime.action_in_flight_item_id.is_some()
            || !runtime.pending_approval_ids.is_empty()
            || !runtime.pending_user_input_ids.is_empty()
    }

    fn runtime_is_blocked_or_occupied(runtime: &BridgeThreadQueueRuntime) -> bool {
        Self::runtime_has_blockers(runtime) || !runtime.items.is_empty()
    }

    async fn handle_notification(&self, notification: HubNotification) {
        let _ = notification.event_id;
        match notification.method.as_str() {
            "turn/started" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let turn_id = read_string(notification.params.get("turnId"));
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.thread_running = true;
                runtime.turn_start_in_flight = false;
                if let Some(turn_id) = turn_id {
                    runtime.active_turn_id = Some(turn_id);
                }
                runtime.last_error = None;
            }
            "turn/completed" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let should_dispatch = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.thread_running = false;
                    runtime.turn_start_in_flight = false;
                    runtime.active_turn_id = None;
                    runtime.pending_approval_ids.clear();
                    runtime.pending_user_input_ids.clear();
                    runtime.action_in_flight_item_id = None;
                    !runtime.items.is_empty()
                };
                if should_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                }
            }
            "thread/status/changed" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(status) = read_string(notification.params.get("status"))
                    .map(|value| value.trim().to_lowercase())
                else {
                    return;
                };
                let should_dispatch = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    if matches!(status.as_str(), "running" | "pending" | "queued") {
                        runtime.thread_running = true;
                        false
                    } else {
                        runtime.thread_running = false;
                        runtime.turn_start_in_flight = false;
                        runtime.active_turn_id = None;
                        !runtime.items.is_empty()
                    }
                };
                if should_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                }
            }
            "bridge/approval.requested" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(approval_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.pending_approval_ids.insert(approval_id);
            }
            "bridge/approval.resolved" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(approval_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let should_dispatch = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.pending_approval_ids.remove(&approval_id);
                    !Self::runtime_has_blockers(runtime) && !runtime.items.is_empty()
                };
                if should_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                }
            }
            "bridge/userInput.requested" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(request_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.pending_user_input_ids.insert(request_id);
            }
            "bridge/userInput.resolved" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(request_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let should_dispatch = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.pending_user_input_ids.remove(&request_id);
                    !Self::runtime_has_blockers(runtime) && !runtime.items.is_empty()
                };
                if should_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                }
            }
            _ => {}
        }
    }

    fn spawn_auto_dispatch(&self, thread_id: String) {
        let backend = Arc::clone(&self.backend);
        let hub = Arc::clone(&self.hub);
        let threads = Arc::clone(&self.threads);
        tokio::spawn(async move {
            BridgeQueueService::drain_thread_queue(backend, hub, threads, thread_id).await;
        });
    }

    async fn drain_thread_queue(
        backend: Arc<RuntimeBackend>,
        hub: Arc<ClientHub>,
        threads: Arc<RwLock<HashMap<String, BridgeThreadQueueRuntime>>>,
        thread_id: String,
    ) {
        let (queued_item, snapshot) = {
            let mut threads = threads.write().await;
            let Some(runtime) = threads.get_mut(&thread_id) else {
                return;
            };
            if runtime.thread_running
                || runtime.turn_start_in_flight
                || runtime.action_in_flight_item_id.is_some()
                || !runtime.pending_approval_ids.is_empty()
                || !runtime.pending_user_input_ids.is_empty()
            {
                return;
            }
            let Some(queued_item) = runtime.items.pop_front() else {
                return;
            };
            runtime.turn_start_in_flight = true;
            runtime.last_error = None;
            let snapshot = BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime));
            (queued_item, snapshot)
        };

        if let Ok(value) = serde_json::to_value(&snapshot) {
            hub.broadcast_notification("bridge/thread/queue/updated", value)
                .await;
        }

        match BridgeQueueService::dispatch_turn_start_with_backend(
            &backend,
            &thread_id,
            &queued_item.turn_start,
        )
        .await
        {
            Ok(turn_id) => {
                let mut threads = threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.turn_start_in_flight = false;
                runtime.thread_running = true;
                runtime.active_turn_id = Some(turn_id);
                runtime.last_error = None;
            }
            Err(error) => {
                let snapshot = {
                    let mut threads = threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.turn_start_in_flight = false;
                    runtime.items.push_front(queued_item);
                    runtime.last_error = Some(BridgeThreadQueueError {
                        message: error.clone(),
                        operation: "dispatch".to_string(),
                        at: now_iso(),
                        item_id: runtime.items.front().map(|item| item.id.clone()),
                    });
                    BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime))
                };
                if let Ok(value) = serde_json::to_value(&snapshot) {
                    hub.broadcast_notification("bridge/thread/queue/updated", value)
                        .await;
                }
            }
        }
    }
}

struct AppServerBridge {
    engine: BridgeRuntimeEngine,
    child: Mutex<Child>,
    child_pid: u32,
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
    method: String,
    cached_chatgpt_auth: Option<BridgeChatGptAuthBundle>,
    clear_cached_chatgpt_auth_on_success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct BridgeChatGptAuthBundle {
    access_token: String,
    account_id: String,
    plan_type: Option<String>,
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
    async fn start(
        cli_bin: &str,
        engine: BridgeRuntimeEngine,
        hub: Arc<ClientHub>,
    ) -> Result<Arc<Self>, String> {
        let mut command = Command::new(cli_bin);
        command
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_managed_child_command(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start app-server: {error}"))?;
        let child_pid = child
            .id()
            .ok_or_else(|| "app-server pid unavailable".to_string())?;

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
            engine,
            child: Mutex::new(child),
            child_pid,
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

    async fn request_shutdown(&self) {
        terminate_managed_child(self.child_pid, "app-server").await;
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
        let cached_chatgpt_auth =
            extract_chatgpt_auth_tokens_from_account_login_start(params.as_ref());
        let clear_cached_chatgpt_auth_on_success = method == "account/logout";

        {
            let mut pending = self.pending_requests.lock().await;
            pending.insert(
                internal_id,
                PendingRequest {
                    client_id,
                    client_request_id,
                    method: method.to_string(),
                    cached_chatgpt_auth,
                    clear_cached_chatgpt_auth_on_success,
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

    async fn request_internal(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let internal_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        self.internal_waiters.lock().await.insert(internal_id, tx);

        let mut payload = json!({
            "id": internal_id,
            "method": method,
        });
        if let Some(params) = params {
            payload["params"] = params;
        }

        if let Err(error) = self.write_json(payload).await {
            self.internal_waiters.lock().await.remove(&internal_id);
            return Err(format!(
                "failed forwarding internal request to app-server: {error}"
            ));
        }

        match timeout(Duration::from_secs(20), rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(message),
            Ok(Err(_)) => Err("internal app-server waiter dropped".to_string()),
            Err(_) => {
                self.internal_waiters.lock().await.remove(&internal_id);
                Err(format!("internal app-server request timed out: {method}"))
            }
        }
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

    async fn list_pending_user_inputs(&self) -> Vec<PendingUserInputRequest> {
        let mut requests = self
            .pending_user_inputs
            .lock()
            .await
            .values()
            .map(|entry| entry.request.clone())
            .collect::<Vec<_>>();
        requests.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        requests
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
                thread_id: encode_engine_qualified_id(self.engine, &thread_id),
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
                thread_id: encode_engine_qualified_id(
                    self.engine,
                    &read_string(params_obj.and_then(|p| p.get("threadId")))
                        .unwrap_or_else(|| "unknown-thread".to_string()),
                ),
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
            if let Some(auth) = resolve_bridge_chatgpt_auth_bundle_for_refresh() {
                let mut result = json!({
                    "accessToken": auth.access_token,
                    "chatgptAccountId": auth.account_id,
                    "chatgptPlanType": Value::Null,
                });

                if let Some(plan_type) = auth.plan_type {
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
                            "message": "account/chatgptAuthTokens/refresh is not configured (set BRIDGE_CHATGPT_ACCESS_TOKEN and BRIDGE_CHATGPT_ACCOUNT_ID, or complete ChatGPT login from the mobile app)"
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
        let normalized_params =
            normalize_forwarded_notification(method, params.unwrap_or(Value::Null), self.engine);
        self.hub
            .broadcast_notification(method, normalized_params)
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

        if object.get("error").is_none() {
            if pending.clear_cached_chatgpt_auth_on_success {
                clear_cached_bridge_chatgpt_auth();
            }
            if let Some(auth) = pending.cached_chatgpt_auth.clone() {
                cache_bridge_chatgpt_auth(auth);
            }
        }

        let client_payload = if let Some(error) = object.get("error") {
            json!({
                "id": pending.client_request_id,
                "error": error,
            })
        } else {
            let normalized_result = normalize_forwarded_result(
                &pending.method,
                object.get("result").cloned().unwrap_or(Value::Null),
                self.engine,
            );
            json!({
                "id": pending.client_request_id,
                "result": normalized_result,
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
struct OpencodePendingApprovalEntry {
    approval: PendingApproval,
    directory: String,
}

#[derive(Clone)]
struct OpencodePendingUserInputEntry {
    request: PendingUserInputRequest,
    directory: String,
}

struct OpencodeBackend {
    child: Mutex<Child>,
    child_pid: u32,
    hub: Arc<ClientHub>,
    http: HttpClient,
    base_url: Url,
    username: String,
    password: Option<String>,
    fallback_directory: String,
    session_directories: RwLock<HashMap<String, String>>,
    session_statuses: RwLock<HashMap<String, String>>,
    active_turns: RwLock<HashMap<String, String>>,
    part_kinds: RwLock<HashMap<String, String>>,
    interrupted_sessions: RwLock<HashSet<String>>,
    pending_approvals: Mutex<HashMap<String, OpencodePendingApprovalEntry>>,
    pending_user_inputs: Mutex<HashMap<String, OpencodePendingUserInputEntry>>,
}

impl OpencodeBackend {
    async fn start(config: &Arc<BridgeConfig>, hub: Arc<ClientHub>) -> Result<Arc<Self>, String> {
        let mut command = Command::new(&config.opencode_cli_bin);
        command
            .arg("serve")
            .arg("--hostname")
            .arg(&config.opencode_host)
            .arg("--port")
            .arg(config.opencode_port.to_string())
            .current_dir(&config.workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_managed_child_command(&mut command);

        if let Some(password) = config.opencode_server_password.as_deref() {
            command.env("OPENCODE_SERVER_PASSWORD", password);
            command.env("OPENCODE_SERVER_USERNAME", &config.opencode_server_username);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start opencode serve: {error}"))?;
        let child_pid = child
            .id()
            .ok_or_else(|| "opencode pid unavailable".to_string())?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "opencode stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "opencode stderr unavailable".to_string())?;

        let base_url = Url::parse(&format!(
            "http://{}:{}/",
            config.opencode_host, config.opencode_port
        ))
        .map_err(|error| format!("invalid opencode base url: {error}"))?;

        let backend = Arc::new(Self {
            child: Mutex::new(child),
            child_pid,
            hub,
            http: HttpClient::builder()
                .build()
                .map_err(|error| format!("failed to build opencode http client: {error}"))?,
            base_url,
            username: config.opencode_server_username.clone(),
            password: config.opencode_server_password.clone(),
            fallback_directory: config.workdir.to_string_lossy().to_string(),
            session_directories: RwLock::new(HashMap::new()),
            session_statuses: RwLock::new(HashMap::new()),
            active_turns: RwLock::new(HashMap::new()),
            part_kinds: RwLock::new(HashMap::new()),
            interrupted_sessions: RwLock::new(HashSet::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_user_inputs: Mutex::new(HashMap::new()),
        });

        backend.spawn_stdout_loop(stdout);
        backend.spawn_stderr_loop(stderr);
        backend.spawn_wait_loop();
        backend.wait_until_healthy().await?;
        backend.spawn_global_event_loop();

        Ok(backend)
    }

    async fn request_shutdown(&self) {
        terminate_managed_child(self.child_pid, "opencode").await;
    }

    fn spawn_stdout_loop(self: &Arc<Self>, stdout: ChildStdout) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => eprintln!("[opencode] {line}"),
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("opencode stdout read error: {error}");
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
                    Ok(Some(line)) => eprintln!("[opencode] {line}"),
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("opencode stderr read error: {error}");
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
                Ok(status) => eprintln!("opencode exited with status: {status}"),
                Err(error) => eprintln!("failed waiting for opencode exit: {error}"),
            }

            this.pending_approvals.lock().await.clear();
            this.pending_user_inputs.lock().await.clear();
            this.session_statuses.write().await.clear();
            this.active_turns.write().await.clear();
            this.part_kinds.write().await.clear();
            this.interrupted_sessions.write().await.clear();
        });
    }

    async fn wait_until_healthy(&self) -> Result<(), String> {
        let mut last_error = "opencode health probe did not run".to_string();
        let deadline = Instant::now() + OPENCODE_HEALTH_TIMEOUT;
        while Instant::now() < deadline {
            match self
                .request_json(HttpMethod::GET, "global/health", None, None, None)
                .await
            {
                Ok(health) if health.get("healthy").and_then(Value::as_bool) == Some(true) => {
                    return Ok(());
                }
                Ok(_) => {
                    last_error = "opencode health probe returned unhealthy response".to_string();
                }
                Err(error) => {
                    last_error = error;
                }
            }

            tokio::time::sleep(OPENCODE_HEALTH_POLL_INTERVAL).await;
        }

        Err(format!("opencode failed health check: {last_error}"))
    }

    fn spawn_global_event_loop(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                if let Err(error) = this.consume_global_events().await {
                    eprintln!("opencode global event stream failed: {error}");
                }
                if this.child_has_exited().await {
                    break;
                }
                tokio::time::sleep(OPENCODE_EVENT_RECONNECT_DELAY).await;
            }
        });
    }

    async fn child_has_exited(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                eprintln!("failed to poll opencode child status: {error}");
                true
            }
        }
    }

    async fn consume_global_events(&self) -> Result<(), String> {
        let url = self
            .base_url
            .join("global/event")
            .map_err(|error| format!("invalid opencode global event url: {error}"))?;

        let mut request = self.http.request(HttpMethod::GET, url);
        if let Some(password) = self.password.as_deref() {
            request = request.basic_auth(&self.username, Some(password));
        }

        let mut response = request
            .send()
            .await
            .map_err(|error| format!("failed to open opencode global event stream: {error}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "opencode global event stream returned {}: {}",
                status.as_u16(),
                body.trim()
            ));
        }

        let mut buffer = String::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("failed reading opencode event stream: {error}"))?
        {
            if chunk.is_empty() {
                continue;
            }

            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text.replace("\r\n", "\n"));

            while let Some(index) = buffer.find("\n\n") {
                let frame = buffer[..index].to_string();
                buffer.drain(..index + 2);
                self.handle_sse_frame(&frame).await;
            }
        }

        Err("opencode global event stream closed".to_string())
    }

    async fn handle_sse_frame(&self, frame: &str) {
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.trim().is_empty() {
            return;
        }

        let Ok(payload) = serde_json::from_str::<Value>(&data) else {
            return;
        };
        self.handle_global_event(payload).await;
    }

    async fn handle_global_event(&self, envelope: Value) {
        let Some(envelope_object) = envelope.as_object() else {
            return;
        };
        let directory = read_string(envelope_object.get("directory"));
        let Some(payload) = envelope_object.get("payload").and_then(Value::as_object) else {
            return;
        };
        let Some(event_type) = read_string(payload.get("type")) else {
            return;
        };
        let properties = payload.get("properties").cloned().unwrap_or(Value::Null);

        match event_type.as_str() {
            "server.connected" | "server.heartbeat" => {}
            "session.created" => {
                if let Some(info) = properties.get("info") {
                    self.cache_session_info(info).await;
                    if let Some(session_id) = read_string(info.get("id")) {
                        self.broadcast_json_notification(
                            "thread/started",
                            json!({
                                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                            }),
                        )
                        .await;
                    }
                }
            }
            "session.updated" => {
                if let Some(info) = properties.get("info") {
                    self.cache_session_info(info).await;
                    if let Some(session_id) = read_string(info.get("id")) {
                        self.broadcast_json_notification(
                            "thread/name/updated",
                            json!({
                                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                                "threadName": read_string(info.get("title")),
                            }),
                        )
                        .await;
                    }
                }
            }
            "session.status" => {
                self.handle_session_status_event(properties).await;
            }
            "session.error" => {
                self.handle_session_error_event(properties).await;
            }
            "message.part.updated" => {
                self.cache_message_part_kind(properties).await;
            }
            "message.part.delta" => {
                self.handle_message_part_delta(properties).await;
            }
            "message.part.removed" => {
                let session_id = read_string(properties.get("sessionID"));
                let part_id = read_string(properties.get("partID"));
                if let (Some(session_id), Some(part_id)) = (session_id, part_id) {
                    self.part_kinds
                        .write()
                        .await
                        .remove(&opencode_part_key(&session_id, &part_id));
                }
            }
            "permission.asked" => {
                self.handle_permission_asked(properties, directory).await;
            }
            "permission.replied" => {
                self.handle_permission_replied(properties).await;
            }
            "question.asked" => {
                self.handle_question_asked(properties, directory).await;
            }
            "question.replied" | "question.rejected" => {
                self.handle_question_resolved(properties).await;
            }
            _ => {}
        }
    }

    async fn handle_session_status_event(&self, properties: Value) {
        let Some(session_id) = read_string(properties.get("sessionID")) else {
            return;
        };
        let status_type = properties
            .get("status")
            .and_then(Value::as_object)
            .and_then(|status| read_string(status.get("type")));
        let Some(status_type) = status_type else {
            return;
        };

        let previous_status = self
            .session_statuses
            .write()
            .await
            .insert(session_id.clone(), status_type.clone());
        let was_active = opencode_status_is_active(previous_status.as_deref());
        let is_active = opencode_status_is_active(Some(status_type.as_str()));
        let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id);
        let interrupted = if !is_active && was_active {
            self.interrupted_sessions.write().await.remove(&session_id)
        } else {
            false
        };

        self.broadcast_json_notification(
            "thread/status/changed",
            json!({
                "threadId": thread_id,
                "status": if is_active {
                    "running"
                } else if was_active && interrupted {
                    "interrupted"
                } else if was_active {
                    "completed"
                } else {
                    "idle"
                },
            }),
        )
        .await;

        if is_active && !was_active {
            let turn_id = self.active_turns.read().await.get(&session_id).cloned();
            self.broadcast_json_notification(
                "turn/started",
                json!({
                    "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                    "turnId": turn_id,
                }),
            )
            .await;
            return;
        }

        if !is_active && was_active {
            let turn_id = self.active_turns.write().await.remove(&session_id);
            self.broadcast_json_notification(
                "turn/completed",
                json!({
                    "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                    "turnId": turn_id,
                    "status": if interrupted { "interrupted" } else { "completed" },
                }),
            )
            .await;
        }
    }

    async fn handle_session_error_event(&self, properties: Value) {
        let Some(session_id) = read_string(properties.get("sessionID")) else {
            return;
        };
        let error_message = properties
            .get("error")
            .and_then(Value::as_object)
            .and_then(|error| read_string(error.get("message")));
        self.session_statuses
            .write()
            .await
            .insert(session_id.clone(), "idle".to_string());
        let turn_id = self.active_turns.write().await.remove(&session_id);
        self.interrupted_sessions.write().await.remove(&session_id);

        self.broadcast_json_notification(
            "thread/status/changed",
            json!({
                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                "status": "failed",
                "error": {
                    "message": error_message,
                },
            }),
        )
        .await;
        self.broadcast_json_notification(
            "turn/completed",
            json!({
                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                "turnId": turn_id,
                "status": "failed",
                "error": {
                    "message": error_message,
                },
            }),
        )
        .await;
    }

    async fn cache_message_part_kind(&self, properties: Value) {
        let Some(part) = properties.get("part").and_then(Value::as_object) else {
            return;
        };
        let Some(session_id) = read_string(part.get("sessionID")) else {
            return;
        };
        let Some(part_id) = read_string(part.get("id")) else {
            return;
        };
        let Some(kind) = read_string(part.get("type")) else {
            return;
        };
        let storage_kind = if kind == "tool" {
            let status = part
                .get("state")
                .and_then(Value::as_object)
                .and_then(|state| read_string(state.get("status")))
                .unwrap_or_else(|| "pending".to_string());
            format!("tool:{status}")
        } else {
            kind.clone()
        };
        let part_key = opencode_part_key(&session_id, &part_id);
        let previous = self
            .part_kinds
            .write()
            .await
            .insert(part_key, storage_kind.clone());

        let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id);
        if kind == "reasoning" && previous.is_none() {
            self.broadcast_json_notification(
                "item/started",
                json!({
                    "threadId": thread_id,
                    "item": {
                        "id": part_id,
                        "type": "reasoning",
                    }
                }),
            )
            .await;
            return;
        }

        if kind == "tool" {
            if let Some((event_method, item)) = opencode_tool_part_bridge_event(part) {
                let should_emit = previous.as_deref() != Some(storage_kind.as_str());
                if should_emit {
                    self.broadcast_json_notification(
                        event_method,
                        json!({
                            "threadId": thread_id,
                            "item": item,
                        }),
                    )
                    .await;
                }
            }
        }
    }

    async fn handle_message_part_delta(&self, properties: Value) {
        let Some(session_id) = read_string(properties.get("sessionID")) else {
            return;
        };
        let Some(part_id) = read_string(properties.get("partID")) else {
            return;
        };
        let Some(field) = read_string(properties.get("field")) else {
            return;
        };
        let Some(delta) = read_string(properties.get("delta")) else {
            return;
        };
        if field != "text" || delta.is_empty() {
            return;
        }

        let part_key = opencode_part_key(&session_id, &part_id);
        let part_kind = self.part_kinds.read().await.get(&part_key).cloned();
        let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id);
        match part_kind.as_deref() {
            Some("reasoning") => {
                self.broadcast_json_notification(
                    "item/reasoning/textDelta",
                    json!({
                        "threadId": thread_id,
                        "itemId": part_id,
                        "delta": delta,
                    }),
                )
                .await;
            }
            Some("text") => {
                self.broadcast_json_notification(
                    "item/agentMessage/delta",
                    json!({
                        "threadId": thread_id,
                        "itemId": part_id,
                        "delta": delta,
                    }),
                )
                .await;
            }
            _ => {}
        }
    }

    async fn handle_permission_asked(&self, properties: Value, directory: Option<String>) {
        let Some(request) = properties.as_object() else {
            return;
        };
        let Some(id) = read_string(request.get("id")) else {
            return;
        };
        let Some(session_id) = read_string(request.get("sessionID")) else {
            return;
        };
        let directory = match directory {
            Some(directory) => Some(directory),
            None => self
                .session_directories
                .read()
                .await
                .get(&session_id)
                .cloned(),
        };
        let Some(directory) = directory else {
            return;
        };

        let tool = request.get("tool").and_then(Value::as_object);
        let approval = PendingApproval {
            id: id.clone(),
            kind: opencode_permission_kind(read_string(request.get("permission")).as_deref())
                .to_string(),
            thread_id: encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
            turn_id: read_string(tool.and_then(|tool| tool.get("messageID")))
                .unwrap_or_else(|| session_id.clone()),
            item_id: read_string(tool.and_then(|tool| tool.get("callID")))
                .unwrap_or_else(|| id.clone()),
            requested_at: now_iso(),
            reason: read_string(request.get("permission")),
            command: request
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| {
                    read_shell_command(metadata.get("command"))
                        .or_else(|| read_string(metadata.get("command")))
                }),
            cwd: Some(directory.clone()),
            grant_root: None,
            proposed_execpolicy_amendment: None,
        };

        self.pending_approvals.lock().await.insert(
            id.clone(),
            OpencodePendingApprovalEntry {
                approval: approval.clone(),
                directory,
            },
        );

        self.broadcast_json_notification(
            "bridge/approval.requested",
            serde_json::to_value(approval).unwrap_or(Value::Null),
        )
        .await;
    }

    async fn handle_permission_replied(&self, properties: Value) {
        let Some(request_id) = read_string(properties.get("requestID")) else {
            return;
        };
        let Some(pending) = self.pending_approvals.lock().await.remove(&request_id) else {
            return;
        };
        let decision = match read_string(properties.get("reply")).as_deref() {
            Some("always") => "acceptForSession",
            Some("reject") => "decline",
            _ => "accept",
        };

        self.broadcast_json_notification(
            "bridge/approval.resolved",
            json!({
                "id": pending.approval.id,
                "threadId": pending.approval.thread_id,
                "decision": decision,
                "resolvedAt": now_iso(),
            }),
        )
        .await;
    }

    async fn handle_question_asked(&self, properties: Value, directory: Option<String>) {
        let Some(request) = properties.as_object() else {
            return;
        };
        let Some(id) = read_string(request.get("id")) else {
            return;
        };
        let Some(session_id) = read_string(request.get("sessionID")) else {
            return;
        };
        let directory = match directory {
            Some(directory) => Some(directory),
            None => self
                .session_directories
                .read()
                .await
                .get(&session_id)
                .cloned(),
        };
        let Some(directory) = directory else {
            return;
        };

        let tool = request.get("tool").and_then(Value::as_object);
        let raw_questions = request
            .get("questions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut questions = Vec::new();
        for (index, raw_question) in raw_questions.iter().enumerate() {
            let Some(question) = raw_question.as_object() else {
                continue;
            };
            let Some(header) = read_string(question.get("header")) else {
                continue;
            };
            let Some(question_text) = read_string(question.get("question")) else {
                continue;
            };
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(Value::as_object)
                        .filter_map(|option| {
                            let label = read_string(option.get("label"))?;
                            let description =
                                read_string(option.get("description")).unwrap_or_default();
                            Some(PendingUserInputQuestionOption { label, description })
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|options| !options.is_empty());

            questions.push(PendingUserInputQuestion {
                id: format!("{id}:{index}"),
                header,
                question: question_text,
                is_other: read_bool(question.get("custom")).unwrap_or(true),
                is_secret: false,
                options,
            });
        }

        if questions.is_empty() {
            return;
        }

        let request_payload = PendingUserInputRequest {
            id: id.clone(),
            thread_id: encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
            turn_id: read_string(tool.and_then(|tool| tool.get("messageID")))
                .unwrap_or_else(|| session_id.clone()),
            item_id: read_string(tool.and_then(|tool| tool.get("callID")))
                .unwrap_or_else(|| id.clone()),
            requested_at: now_iso(),
            questions,
        };

        self.pending_user_inputs.lock().await.insert(
            id.clone(),
            OpencodePendingUserInputEntry {
                request: request_payload.clone(),
                directory,
            },
        );

        self.broadcast_json_notification(
            "bridge/userInput.requested",
            serde_json::to_value(request_payload).unwrap_or(Value::Null),
        )
        .await;
    }

    async fn handle_question_resolved(&self, properties: Value) {
        let Some(request_id) = read_string(properties.get("requestID")) else {
            return;
        };
        let Some(pending) = self.pending_user_inputs.lock().await.remove(&request_id) else {
            return;
        };

        self.broadcast_json_notification(
            "bridge/userInput.resolved",
            json!({
                "id": pending.request.id,
                "threadId": pending.request.thread_id,
                "turnId": pending.request.turn_id,
                "resolvedAt": now_iso(),
            }),
        )
        .await;
    }

    async fn cache_session_info(&self, info: &Value) {
        let Some(session_id) = read_string(info.get("id")) else {
            return;
        };
        let Some(directory) = read_string(info.get("directory")) else {
            return;
        };
        self.session_directories
            .write()
            .await
            .insert(session_id, directory);
    }

    async fn current_directory_for_session(&self, session_id: &str) -> String {
        self.session_directories
            .read()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| self.fallback_directory.clone())
    }

    async fn current_status_for_session(&self, session_id: &str) -> Option<String> {
        self.session_statuses.read().await.get(session_id).cloned()
    }

    async fn forward_request(
        &self,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        match self.dispatch_request(method, params).await {
            Ok(result) => {
                let normalized =
                    normalize_forwarded_result(method, result, BridgeRuntimeEngine::Opencode);
                self.hub
                    .send_json(
                        client_id,
                        json!({ "id": client_request_id, "result": normalized }),
                    )
                    .await;
                Ok(())
            }
            Err(error) => {
                let code = if error.starts_with("unsupported opencode backend method:") {
                    -32601
                } else {
                    -32000
                };
                self.hub
                    .send_json(
                        client_id,
                        json!({
                            "id": client_request_id,
                            "error": {
                                "code": code,
                                "message": error,
                            }
                        }),
                    )
                    .await;
                Ok(())
            }
        }
    }

    async fn request_internal(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        self.dispatch_request(method, params).await
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

    async fn list_pending_user_inputs(&self) -> Vec<PendingUserInputRequest> {
        let mut requests = self
            .pending_user_inputs
            .lock()
            .await
            .values()
            .map(|entry| entry.request.clone())
            .collect::<Vec<_>>();
        requests.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        requests
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

        let reply = match parse_approval_decision(decision) {
            Some(ApprovalDecisionCanonical::AcceptForSession) => "always",
            Some(ApprovalDecisionCanonical::Accept)
            | Some(ApprovalDecisionCanonical::AcceptWithExecpolicyAmendment(_)) => "once",
            Some(ApprovalDecisionCanonical::Decline) | Some(ApprovalDecisionCanonical::Cancel) => {
                "reject"
            }
            None => {
                self.pending_approvals
                    .lock()
                    .await
                    .insert(approval_id.to_string(), pending.clone());
                return Err("invalid approval decision payload".to_string());
            }
        };

        let body = json!({ "reply": reply });
        if let Err(error) = self
            .request_json(
                HttpMethod::POST,
                &format!("permission/{approval_id}/reply"),
                Some(&pending.directory),
                None,
                Some(body),
            )
            .await
        {
            self.pending_approvals
                .lock()
                .await
                .insert(approval_id.to_string(), pending.clone());
            return Err(error);
        }

        self.broadcast_json_notification(
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

        let ordered_answers = pending
            .request
            .questions
            .iter()
            .map(|question| {
                answers
                    .get(&question.id)
                    .map(|answer| answer.answers.clone())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();

        let body = json!({ "answers": ordered_answers });
        if let Err(error) = self
            .request_json(
                HttpMethod::POST,
                &format!("question/{request_id}/reply"),
                Some(&pending.directory),
                None,
                Some(body),
            )
            .await
        {
            self.pending_user_inputs
                .lock()
                .await
                .insert(request_id.to_string(), pending.clone());
            return Err(error);
        }

        self.broadcast_json_notification(
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

    async fn dispatch_request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        match method {
            "account/logout" => Ok(json!({})),
            "account/rateLimits/read" => Ok(json!({})),
            "account/read" => Ok(json!({
                "account": Value::Null,
                "requiresOpenaiAuth": false,
            })),
            "config/read" => Ok(json!({ "config": {} })),
            "thread/list" => self.list_threads(params).await,
            "thread/loaded/list" => self.list_loaded_threads().await,
            "thread/read" => self.read_thread(params).await,
            "thread/start" => self.start_thread(params).await,
            "thread/name/set" => self.set_thread_name(params).await,
            "thread/fork" => self.fork_thread(params).await,
            "thread/resume" => Ok(json!({
                "model": Value::Null,
                "effort": Value::Null,
            })),
            "review/start" => Err("review/start is not supported for opencode threads".to_string()),
            "turn/start" => self.start_turn(params).await,
            "turn/interrupt" => self.interrupt_turn(params).await,
            "model/list" => self.list_models(params).await,
            _ => Err(format!("unsupported opencode backend method: {method}")),
        }
    }

    async fn list_threads(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params.as_ref().and_then(Value::as_object);
        let limit = params_object
            .and_then(|params| params.get("limit"))
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .clamp(1, 1000);
        let cwd = read_string(params_object.and_then(|params| params.get("cwd")));
        let archived = params_object
            .and_then(|params| params.get("archived"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut query = vec![("limit", limit.to_string())];
        if let Some(cwd) = cwd.as_deref() {
            query.push(("directory", cwd.to_string()));
        }
        if archived {
            query.push(("archived", "true".to_string()));
        }
        let sessions = match self
            .request_json(
                HttpMethod::GET,
                "experimental/session",
                None,
                Some(query.clone()),
                None,
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                eprintln!(
                    "opencode experimental session list unavailable; falling back to directory-scoped session list: {error}"
                );
                self.request_json(HttpMethod::GET, "session", None, Some(query), None)
                    .await?
            }
        };
        let statuses = self
            .request_json(
                HttpMethod::GET,
                "session/status",
                cwd.as_deref(),
                None,
                None,
            )
            .await
            .ok();
        let session_entries = sessions.as_array().cloned().unwrap_or_default();
        let status_map = statuses.as_ref().and_then(Value::as_object);

        let mut data = Vec::new();
        for session in session_entries {
            if !archived
                && session
                    .get("time")
                    .and_then(Value::as_object)
                    .and_then(|time| time.get("archived"))
                    .is_some()
            {
                continue;
            }

            self.cache_session_info(&session).await;
            let session_id = read_string(session.get("id")).unwrap_or_default();
            let status = status_map
                .and_then(|statuses| statuses.get(&session_id))
                .and_then(Value::as_object)
                .and_then(|status| read_string(status.get("type")));
            let thread = self
                .project_session_to_thread(&session, status.as_deref(), None)
                .await;
            data.push(thread);
        }

        data.sort_by(|a, b| {
            let left = a.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
            let right = b.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
            right.cmp(&left)
        });

        Ok(json!({ "data": data }))
    }

    async fn list_loaded_threads(&self) -> Result<Value, String> {
        let statuses = self
            .request_json(HttpMethod::GET, "session/status", None, None, None)
            .await?;
        let ids = statuses
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(session_id, status)| {
                let status_type = status
                    .as_object()
                    .and_then(|status| read_string(status.get("type")));
                if opencode_status_is_active(status_type.as_deref()) {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        Ok(json!({ "data": ids }))
    }

    async fn read_thread(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "thread/read requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "thread/read requires threadId".to_string())?;
        let include_turns = params_object
            .get("includeTurns")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let directory = self.current_directory_for_session(&session_id).await;
        let session = self
            .request_json(
                HttpMethod::GET,
                &format!("session/{session_id}"),
                Some(&directory),
                None,
                None,
            )
            .await?;
        self.cache_session_info(&session).await;

        let messages = if include_turns {
            Some(
                self.request_json(
                    HttpMethod::GET,
                    &format!("session/{session_id}/message"),
                    Some(&directory),
                    None,
                    None,
                )
                .await?,
            )
        } else {
            None
        };

        let fetched_status = self
            .request_json(
                HttpMethod::GET,
                "session/status",
                Some(&directory),
                None,
                None,
            )
            .await
            .ok()
            .and_then(|statuses| {
                statuses
                    .as_object()
                    .and_then(|statuses| statuses.get(&session_id).cloned())
            })
            .and_then(|status| {
                status
                    .as_object()
                    .and_then(|status| read_string(status.get("type")))
            });
        let status = match fetched_status {
            Some(status) => Some(status),
            None => self.current_status_for_session(&session_id).await,
        };
        let thread = self
            .project_session_to_thread(&session, status.as_deref(), messages.as_ref())
            .await;
        Ok(json!({ "thread": thread }))
    }

    async fn start_thread(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params.as_ref().and_then(Value::as_object);
        let directory = read_string(params_object.and_then(|params| params.get("cwd")))
            .unwrap_or_else(|| self.fallback_directory.clone());
        let title = read_string(params_object.and_then(|params| params.get("threadName")))
            .or_else(|| read_string(params_object.and_then(|params| params.get("name"))));
        let body = title
            .map(|title| json!({ "title": title }))
            .unwrap_or_else(|| json!({}));
        let session = self
            .request_json(
                HttpMethod::POST,
                "session",
                Some(&directory),
                None,
                Some(body),
            )
            .await?;
        self.cache_session_info(&session).await;
        let thread = self.project_session_to_thread(&session, None, None).await;
        Ok(json!({ "thread": thread }))
    }

    async fn list_models(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params.as_ref().and_then(Value::as_object);
        let requested_directory = read_string(params_object.and_then(|params| params.get("cwd")));
        let thread_id = read_string(params_object.and_then(|params| params.get("threadId")));
        let directory = match (
            requested_directory.filter(|value| !value.is_empty()),
            thread_id.filter(|value| !value.is_empty()),
        ) {
            (Some(directory), _) => directory,
            (None, Some(session_id)) => self.current_directory_for_session(&session_id).await,
            (None, None) => self.fallback_directory.clone(),
        };

        let configured_providers = self
            .request_json(
                HttpMethod::GET,
                "config/providers",
                Some(&directory),
                None,
                None,
            )
            .await?;
        let provider_catalog = self
            .request_json(HttpMethod::GET, "provider", Some(&directory), None, None)
            .await
            .ok();
        let config = self
            .request_json(HttpMethod::GET, "config", Some(&directory), None, None)
            .await
            .ok();

        Ok(json!({
            "data": opencode_flatten_model_options(
                &configured_providers,
                provider_catalog.as_ref(),
                config.as_ref(),
            )
        }))
    }

    async fn set_thread_name(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "thread/name/set requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "thread/name/set requires threadId".to_string())?;
        let thread_name = read_string(params_object.get("threadName"))
            .or_else(|| read_string(params_object.get("name")))
            .ok_or_else(|| "thread/name/set requires threadName".to_string())?;
        let directory = self.current_directory_for_session(&session_id).await;

        let session = self
            .request_json(
                HttpMethod::PATCH,
                &format!("session/{session_id}"),
                Some(&directory),
                None,
                Some(json!({ "title": thread_name })),
            )
            .await?;
        self.cache_session_info(&session).await;
        Ok(json!({}))
    }

    async fn fork_thread(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "thread/fork requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "thread/fork requires threadId".to_string())?;
        let directory = read_string(params_object.get("cwd"))
            .unwrap_or_else(|| self.fallback_directory.clone());
        let directory = if directory == self.fallback_directory {
            self.current_directory_for_session(&session_id).await
        } else {
            directory
        };

        let session = self
            .request_json(
                HttpMethod::POST,
                &format!("session/{session_id}/fork"),
                Some(&directory),
                None,
                Some(json!({})),
            )
            .await?;
        self.cache_session_info(&session).await;
        let thread = self.project_session_to_thread(&session, None, None).await;
        Ok(json!({ "thread": thread }))
    }

    async fn start_turn(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "turn/start requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "turn/start requires threadId".to_string())?;
        let directory = match read_string(params_object.get("cwd")) {
            Some(directory) => directory,
            None => self.current_directory_for_session(&session_id).await,
        };
        let input = params_object
            .get("input")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let parts = opencode_prompt_parts_from_turn_input(&input);
        if parts.is_empty() {
            return Err("turn/start requires non-empty input".to_string());
        }

        let mut body = json!({
            "parts": parts,
        });
        let requested_effort = read_string(params_object.get("effort"));
        let mut configured_providers: Option<Value> = None;
        let config = if requested_effort.is_some() {
            Some(
                self.request_json(HttpMethod::GET, "config", Some(&directory), None, None)
                    .await
                    .ok(),
            )
            .flatten()
        } else {
            None
        };
        let mut resolved_model = params_object
            .get("model")
            .and_then(Value::as_str)
            .and_then(parse_opencode_model_selector);

        if requested_effort.is_some() || resolved_model.is_none() {
            configured_providers = Some(
                self.request_json(
                    HttpMethod::GET,
                    "config/providers",
                    Some(&directory),
                    None,
                    None,
                )
                .await?,
            );
        }

        if resolved_model.is_none() {
            resolved_model = configured_providers.as_ref().and_then(|providers| {
                opencode_default_model_selector(providers, None, config.as_ref())
            });
        }

        if let Some((provider_id, model_id)) = resolved_model.as_ref() {
            body["model"] = json!({
                "providerID": provider_id,
                "modelID": model_id,
            });
            if let (Some(requested_effort), Some(configured_providers)) =
                (requested_effort.as_deref(), configured_providers.as_ref())
            {
                if let Some(variant) = opencode_variant_for_effort(
                    configured_providers,
                    provider_id,
                    model_id,
                    requested_effort,
                ) {
                    body["variant"] = Value::String(variant);
                }
            }
        }

        let before_message_id = self
            .latest_user_message_id(&session_id, &directory)
            .await
            .ok()
            .flatten();
        self.request_json(
            HttpMethod::POST,
            &format!("session/{session_id}/prompt_async"),
            Some(&directory),
            None,
            Some(body),
        )
        .await?;

        let turn_id = self
            .wait_for_new_user_message_id(&session_id, &directory, before_message_id.as_deref())
            .await?
            .unwrap_or_else(|| format!("turn-{}", Utc::now().timestamp_millis()));
        self.active_turns
            .write()
            .await
            .insert(session_id.clone(), turn_id.clone());

        Ok(json!({
            "turn": {
                "id": turn_id,
            }
        }))
    }

    async fn interrupt_turn(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "turn/interrupt requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "turn/interrupt requires threadId".to_string())?;
        let directory = self.current_directory_for_session(&session_id).await;
        self.request_json(
            HttpMethod::POST,
            &format!("session/{session_id}/abort"),
            Some(&directory),
            None,
            None,
        )
        .await?;
        self.interrupted_sessions.write().await.insert(session_id);
        Ok(json!({}))
    }

    async fn latest_user_message_id(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Option<String>, String> {
        let messages = self
            .request_json(
                HttpMethod::GET,
                &format!("session/{session_id}/message"),
                Some(directory),
                None,
                None,
            )
            .await?;
        Ok(opencode_latest_user_message_id(&messages))
    }

    async fn wait_for_new_user_message_id(
        &self,
        session_id: &str,
        directory: &str,
        previous_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        for _ in 0..20 {
            let latest = self.latest_user_message_id(session_id, directory).await?;
            if let Some(latest) = latest {
                if previous_id != Some(latest.as_str()) {
                    return Ok(Some(latest));
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Ok(None)
    }

    async fn project_session_to_thread(
        &self,
        session: &Value,
        status: Option<&str>,
        messages: Option<&Value>,
    ) -> Value {
        let session_object = session.as_object().cloned().unwrap_or_default();
        let session_id = read_string(session_object.get("id")).unwrap_or_default();
        let created_at_ms = session_object
            .get("time")
            .and_then(Value::as_object)
            .and_then(|time| time.get("created"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let updated_at_ms = session_object
            .get("time")
            .and_then(Value::as_object)
            .and_then(|time| time.get("updated"))
            .and_then(Value::as_u64)
            .unwrap_or(created_at_ms);
        let active_turn_id = self.active_turns.read().await.get(&session_id).cloned();
        let turns = messages.map(|messages| {
            opencode_messages_to_turns(&session_id, messages, status, active_turn_id.as_deref())
        });

        let preview = messages
            .and_then(opencode_thread_preview_from_messages)
            .unwrap_or_default();
        let source = read_string(session_object.get("parentID"))
            .map(|parent_id| {
                json!({
                    "kind": "subAgentThreadSpawn",
                    "parentThreadId": parent_id,
                })
            })
            .unwrap_or_else(|| json!("appServer"));

        let mut thread = json!({
            "id": session_id,
            "name": read_string(session_object.get("title")),
            "title": read_string(session_object.get("title")),
            "preview": preview,
            "createdAt": created_at_ms / 1000,
            "updatedAt": updated_at_ms / 1000,
            "status": {
                "type": if opencode_status_is_active(status) { "running" } else { "idle" }
            },
            "cwd": read_string(session_object.get("directory")),
            "source": source,
        });

        if let Some(turns) = turns {
            thread["turns"] = Value::Array(turns);
        }

        thread
    }

    async fn request_json(
        &self,
        method: HttpMethod,
        path: &str,
        directory: Option<&str>,
        query: Option<Vec<(&str, String)>>,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut url = self
            .base_url
            .join(path)
            .map_err(|error| format!("invalid opencode path {path}: {error}"))?;
        if let Some(query) = query {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, &value);
            }
        }

        let mut request = self.http.request(method, url);
        if let Some(password) = self.password.as_deref() {
            request = request.basic_auth(&self.username, Some(password));
        }
        if let Some(directory) = directory
            .map(str::trim)
            .filter(|directory| !directory.is_empty())
        {
            request = request.header("x-opencode-directory", directory);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("opencode request {path} failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "opencode request {path} failed with {}: {}",
                status.as_u16(),
                body.trim()
            ));
        }
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }

        response
            .json::<Value>()
            .await
            .map_err(|error| format!("failed decoding opencode response for {path}: {error}"))
    }

    async fn broadcast_json_notification(&self, method: &str, params: Value) {
        self.hub.broadcast_notification(method, params).await;
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
                if let Some(status_payload) =
                    build_rollout_thread_status_notification(&method, &params)
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
            self.include_for_live_sync =
                self.thread_id.is_some() && rollout_originator_allowed(self.originator.as_deref());
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
        "task_interrupted" | "taskinterrupted" | "turn_aborted" | "turnaborted" => "interrupted",
        _ => return None,
    };

    let msg = params
        .as_object()
        .and_then(|value| value.get("msg"))
        .and_then(Value::as_object)?;
    let thread_id = encode_engine_qualified_id(
        BridgeRuntimeEngine::Codex,
        &read_string(msg.get("thread_id")).or_else(|| read_string(msg.get("threadId")))?,
    );

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
    let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Codex, thread_id);
    let raw_type = read_string(payload.get("type"))?;
    if matches!(raw_type.as_str(), "user_message" | "context_compacted") {
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
    let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Codex, thread_id);
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
#[serde(rename_all = "camelCase")]
struct BridgeUpdateStartRequest {
    version: Option<String>,
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
struct GitHistoryCommit {
    hash: String,
    short_hash: String,
    subject: String,
    author_name: String,
    authored_at: String,
    ref_names: Vec<String>,
    is_head: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitHistoryResponse {
    commits: Vec<GitHistoryCommit>,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCloneResponse {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    cloned: bool,
    cwd: String,
    url: String,
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
struct GitHubAuthInstallRequest {
    access_token: String,
    repositories: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubAuthInstallResponse {
    installed: bool,
    host: String,
    login: String,
    scopes: Vec<String>,
    credential_file: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHistoryRequest {
    cwd: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCloneRequest {
    url: String,
    parent_path: Option<String>,
    directory_name: String,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceListRequest {
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSummary {
    path: String,
    chat_count: usize,
    updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceListResponse {
    bridge_root: String,
    allow_outside_root_cwd: bool,
    workspaces: Vec<WorkspaceSummary>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSystemListRequest {
    path: Option<String>,
    include_hidden: Option<bool>,
    directories_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSystemEntry {
    name: String,
    path: String,
    kind: String,
    hidden: bool,
    selectable: bool,
    is_git_repo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSystemListResponse {
    bridge_root: String,
    path: String,
    parent_path: Option<String>,
    entries: Vec<FileSystemEntry>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueReadRequest {
    thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueSendRequest {
    thread_id: String,
    content: String,
    turn_start: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueSteerRequest {
    thread_id: String,
    item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueCancelRequest {
    thread_id: String,
    item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeQueuedMessage {
    id: String,
    created_at: String,
    content: String,
}

#[derive(Debug, Clone)]
struct BridgeQueuedMessageEntry {
    id: String,
    created_at: String,
    content: String,
    turn_start: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueError {
    message: String,
    operation: String,
    at: String,
    item_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueState {
    thread_id: String,
    items: Vec<BridgeQueuedMessage>,
    last_error: Option<BridgeThreadQueueError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BridgeThreadQueueDisposition {
    Queued,
    Sent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueSendResponse {
    disposition: BridgeThreadQueueDisposition,
    queue: BridgeThreadQueueState,
    turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeThreadQueueActionResponse {
    ok: bool,
    queue: BridgeThreadQueueState,
}

#[derive(Debug, Default)]
struct BridgeThreadQueueRuntime {
    items: VecDeque<BridgeQueuedMessageEntry>,
    active_turn_id: Option<String>,
    thread_running: bool,
    turn_start_in_flight: bool,
    action_in_flight_item_id: Option<String>,
    pending_approval_ids: HashSet<String>,
    pending_user_input_ids: HashSet<String>,
    last_error: Option<BridgeThreadQueueError>,
}

struct BridgeQueueService {
    backend: Arc<RuntimeBackend>,
    hub: Arc<ClientHub>,
    threads: Arc<RwLock<HashMap<String, BridgeThreadQueueRuntime>>>,
    next_queue_item_id: AtomicU64,
}

#[derive(Debug, Deserialize)]
struct RpcQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LocalImageQuery {
    path: String,
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
    if let Some(github_auth) = &config.github_codespaces_auth {
        eprintln!(
            "GitHub Codespaces auth is enabled for '{}'; bearer tokens with Codespaces access are accepted",
            github_auth.codespace_name
        );
    }

    let hub = Arc::new(ClientHub::new());
    let backend = match RuntimeBackend::start(&config, hub.clone()).await {
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
    let updater = Arc::new(UpdateService::discover());
    let preview = Arc::new(BrowserPreviewService::new(
        config.port,
        config.preview_port,
        config.preview_connect_url.clone(),
    ));
    let queue = BridgeQueueService::new(backend.clone(), hub.clone());
    let github_codespaces_auth = match config.github_codespaces_auth.clone() {
        Some(github_auth) => Some(Arc::new(
            GitHubCodespacesAuthService::new(github_auth).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(1);
            }),
        )),
        None => None,
    };

    let state = Arc::new(AppState {
        config: config.clone(),
        started_at: Instant::now(),
        hub,
        backend,
        queue,
        terminal,
        git,
        updater,
        preview,
        github_codespaces_auth,
    });

    let app = Router::new()
        .route("/rpc", get(ws_handler))
        .route("/health", get(health_handler))
        .route("/local-image", get(local_image_handler))
        .with_state(state.clone());
    let preview_app = Router::new()
        .route("/", any(preview_entry_handler))
        .route("/{*path}", any(preview_entry_handler))
        .with_state(state.clone());

    let bind_addr = format!("{}:{}", config.host, config.port);
    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind {bind_addr}: {error}");
            std::process::exit(1);
        }
    };

    let preview_bind_addr = format!("{}:{}", config.host, config.preview_port);
    let preview_listener = match tokio::net::TcpListener::bind(&preview_bind_addr).await {
        Ok(listener) => {
            state.preview.set_available(true);
            Some(listener)
        }
        Err(error) => {
            eprintln!("browser preview disabled: failed to bind {preview_bind_addr}: {error}");
            None
        }
    };

    println!("rust-bridge listening on {bind_addr}");
    if preview_listener.is_some() {
        println!("browser preview listening on {preview_bind_addr}");
    }
    if let Some(connect_url) = bridge_access_url(&config) {
        let bind_url = format!(
            "http://{}:{}",
            format_host_for_url(&config.host),
            config.port
        );
        if connect_url != bind_url {
            println!("bridge connect URL: {connect_url}");
        }
    }
    maybe_print_pairing_qr(&config);

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let preview_task = preview_listener.map(|listener| {
        let mut preview_shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let serve_result = axum::serve(listener, preview_app)
                .with_graceful_shutdown(async move {
                    wait_for_shutdown_trigger(&mut preview_shutdown_rx).await;
                })
                .await;
            if let Err(error) = serve_result {
                eprintln!("browser preview server error: {error}");
            }
        })
    });
    let shutdown_backend = state.backend.clone();
    let shutdown_signal_tx = shutdown_tx.clone();
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let signal = wait_for_shutdown_signal().await;
            eprintln!("shutdown signal received ({signal}), terminating managed backends");
            let _ = shutdown_signal_tx.send(true);
            shutdown_backend.shutdown().await;
        })
        .await;

    let _ = shutdown_tx.send(true);
    state.backend.shutdown().await;
    if let Some(task) = preview_task {
        let _ = task.await;
    }

    if let Err(error) = serve_result {
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

async fn local_image_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<LocalImageQuery>,
) -> Response {
    if !state.is_authorized(&headers, query.token.as_deref()).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "unauthorized",
                "message": "Missing or invalid bridge credentials"
            })),
        )
            .into_response();
    }

    let path = match resolve_local_image_path(&query.path) {
        Ok(path) => path,
        Err(message) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "invalid_path",
                    "message": message,
                })),
            )
                .into_response();
        }
    };

    let canonical = match fs::canonicalize(&path).await {
        Ok(path) => normalize_path(&path),
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": "not_found",
                    "message": "Image file not found"
                })),
            )
                .into_response();
        }
    };

    let metadata = match fs::metadata(&canonical).await {
        Ok(metadata) => metadata,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": "not_found",
                    "message": "Image file not found"
                })),
            )
                .into_response();
        }
    };

    if !metadata.is_file() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_path",
                "message": "Image path must reference a file"
            })),
        )
            .into_response();
    }

    let content_type = match infer_image_content_type_from_path(&canonical) {
        Some(content_type) => content_type,
        None => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({
                    "error": "unsupported_media_type",
                    "message": "Only image files can be served through /local-image"
                })),
            )
                .into_response();
        }
    };

    let bytes = match fs::read(&canonical).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "read_failed",
                    "message": format!("Failed to read image file: {error}")
                })),
            )
                .into_response();
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "response_failed",
                    "message": format!("Failed to build image response: {error}")
                })),
            )
                .into_response()
        })
}

async fn preview_entry_handler(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();

    if parts.uri.path() == BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH {
        return preview_runtime_script_response();
    }

    if is_websocket_upgrade_request(&parts.method, &parts.headers) {
        return handle_preview_websocket_request(state, &mut parts).await;
    }

    handle_preview_http_request(state, parts, body).await
}

fn preview_runtime_script_response() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(build_preview_runtime_script()))
        .unwrap_or_else(|_| Response::new(Body::from(String::new())))
}

async fn handle_preview_http_request(
    state: Arc<AppState>,
    parts: axum::http::request::Parts,
    body: Body,
) -> Response {
    let resolved_request = match resolve_preview_session_from_request(
        &state.preview,
        &parts.headers,
        &parts.uri,
    )
    .await
    {
        Ok(result) => result,
        Err(response) => return response,
    };
    let session = resolved_request.session;
    let bootstrap_session_id = resolved_request.bootstrap_session_id;
    let bootstrap_token = resolved_request.bootstrap_token;
    let requested_viewport = resolved_request.requested_viewport;
    let requested_shell_mode = resolved_request.requested_shell_mode;
    let raw_frame = resolved_request.raw_frame;
    let sanitized_path_and_query = resolved_request.sanitized_path_and_query;

    if let (Some(session_id), Some(token), Some(shell_mode)) = (
        bootstrap_session_id.as_deref(),
        bootstrap_token.as_deref(),
        requested_shell_mode,
    ) {
        if !raw_frame {
            let viewport = requested_viewport.unwrap_or(PreviewViewportConfig {
                preset: PreviewViewportPreset::Desktop,
                width: Some(DEFAULT_PREVIEW_DESKTOP_WIDTH),
                height: Some(DEFAULT_PREVIEW_DESKTOP_HEIGHT),
            });
            let mut response = match shell_mode {
                PreviewShellMode::Desktop => preview_desktop_shell_response(
                    &sanitized_path_and_query,
                    viewport,
                    Some(session_id),
                    Some(token),
                ),
                PreviewShellMode::Overview => preview_overview_shell_response(
                    &sanitized_path_and_query,
                    viewport,
                    Some(session_id),
                    Some(token),
                ),
            };
            append_preview_bootstrap_headers(&mut response, Some(token), requested_viewport);
            return response;
        }
    }

    if let Some(token) = bootstrap_token.as_deref() {
        if !raw_frame {
            return preview_bootstrap_redirect_response(
                &sanitized_path_and_query,
                token,
                requested_viewport,
            );
        }
    }

    let request_target =
        match resolve_preview_request_target(&session.target_url, &sanitized_path_and_query) {
            Ok(target) => target,
            Err(error) => {
                return preview_error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("invalid preview request path: {error}"),
                );
            }
        };
    let upstream_url = match build_preview_upstream_url(
        &request_target.target_url,
        &request_target.path_and_query,
        false,
    ) {
        Ok(url) => url,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid preview request path: {error}"),
            );
        }
    };

    let body_bytes = match to_bytes(body, BROWSER_PREVIEW_HTTP_BODY_LIMIT_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return preview_error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("preview request body exceeds limit: {error}"),
            );
        }
    };

    let mut upstream_request = state
        .preview
        .http
        .request(to_reqwest_method(&parts.method), upstream_url.clone())
        .body(body_bytes);
    for (name, value) in parts.headers.iter() {
        let header_name = name.as_str();
        if should_skip_preview_request_header(header_name) {
            continue;
        }

        if header_name.eq_ignore_ascii_case(COOKIE.as_str()) {
            if let Some(filtered_cookie) = filter_preview_cookie_header(value) {
                upstream_request = upstream_request.header(name, filtered_cookie);
            }
            continue;
        }

        if let Some(rewritten) =
            rewrite_preview_request_header(header_name, value, &request_target.target_url)
        {
            upstream_request = upstream_request.header(name, rewritten);
        }
    }

    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_GATEWAY,
                &format!("failed to reach preview target: {error}"),
            );
        }
    };

    let request_host = parts
        .headers
        .get(HOST.as_str())
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let effective_viewport =
        requested_viewport.or_else(|| read_preview_viewport_preset(&parts.headers));
    let effective_shell_mode = requested_shell_mode;

    if let Some(shell_mode) = effective_shell_mode {
        if !raw_frame {
            let viewport = effective_viewport.unwrap_or(PreviewViewportConfig {
                preset: PreviewViewportPreset::Desktop,
                width: Some(DEFAULT_PREVIEW_DESKTOP_WIDTH),
                height: Some(DEFAULT_PREVIEW_DESKTOP_HEIGHT),
            });
            return match shell_mode {
                PreviewShellMode::Desktop => {
                    preview_desktop_shell_response(&sanitized_path_and_query, viewport, None, None)
                }
                PreviewShellMode::Overview => {
                    preview_overview_shell_response(&sanitized_path_and_query, viewport, None, None)
                }
            };
        }
    }
    let status = StatusCode::from_u16(upstream_response.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream_response.headers().clone();
    let rewrite_html = should_rewrite_preview_html_response(&upstream_headers);

    let mut response = if rewrite_html {
        let upstream_body = match upstream_response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                return preview_error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("failed to read preview document: {error}"),
                );
            }
        };
        let rewritten_body = rewrite_preview_html_document(&upstream_body, effective_viewport)
            .unwrap_or_else(|| upstream_body.to_vec());
        let mut response = Response::new(Body::from(rewritten_body));
        *response.status_mut() = status;
        response
    } else {
        let mut response = Response::new(Body::from_stream(upstream_response.bytes_stream()));
        *response.status_mut() = status;
        response
    };

    for (name, value) in upstream_headers.iter() {
        if should_skip_preview_response_header(name.as_str()) {
            continue;
        }

        if rewrite_html
            && (name.as_str().eq_ignore_ascii_case("etag")
                || name.as_str().eq_ignore_ascii_case("last-modified"))
        {
            continue;
        }

        if name.as_str().eq_ignore_ascii_case(LOCATION.as_str()) {
            if let Some(rewritten) = rewrite_preview_location_header(
                value,
                &upstream_url,
                request_host.as_deref(),
                request_target.proxy_path_prefix.as_deref(),
            ) {
                response.headers_mut().append(LOCATION, rewritten);
            }
            continue;
        }

        if name.as_str().eq_ignore_ascii_case(SET_COOKIE.as_str()) {
            if let Some(rewritten) = rewrite_preview_set_cookie_header(
                value,
                request_target.proxy_path_prefix.as_deref(),
            ) {
                response.headers_mut().append(SET_COOKIE, rewritten);
            }
            continue;
        }

        response.headers_mut().append(name.clone(), value.clone());
    }

    if rewrite_html {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store, private"));
        append_vary_header_value(response.headers_mut(), "Cookie");
    }

    append_preview_bootstrap_headers(
        &mut response,
        bootstrap_token.as_deref(),
        requested_viewport,
    );

    response
}

async fn handle_preview_websocket_request(
    state: Arc<AppState>,
    parts: &mut axum::http::request::Parts,
) -> Response {
    let resolved_request = match resolve_preview_session_from_request(
        &state.preview,
        &parts.headers,
        &parts.uri,
    )
    .await
    {
        Ok(result) => result,
        Err(response) => return response,
    };
    let session = resolved_request.session;
    let sanitized_path_and_query = resolved_request.sanitized_path_and_query;

    let request_target =
        match resolve_preview_request_target(&session.target_url, &sanitized_path_and_query) {
            Ok(target) => target,
            Err(error) => {
                return preview_error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("invalid websocket preview path: {error}"),
                );
            }
        };
    let upstream_url = match build_preview_upstream_url(
        &request_target.target_url,
        &request_target.path_and_query,
        true,
    ) {
        Ok(url) => url,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid websocket preview path: {error}"),
            );
        }
    };

    let original_headers = parts.headers.clone();
    let mut upstream_request = match upstream_url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_GATEWAY,
                &format!("failed to create websocket request: {error}"),
            );
        }
    };
    for (name, value) in original_headers.iter() {
        let header_name = name.as_str();
        if should_skip_preview_websocket_request_header(header_name) {
            continue;
        }

        if header_name.eq_ignore_ascii_case(COOKIE.as_str()) {
            if let Some(filtered_cookie) = filter_preview_cookie_header(value) {
                upstream_request.headers_mut().append(name, filtered_cookie);
            }
            continue;
        }

        if let Some(rewritten) =
            rewrite_preview_request_header(header_name, value, &request_target.target_url)
        {
            upstream_request.headers_mut().append(name, rewritten);
        }
    }

    let (upstream_socket, upstream_response) = match connect_async(upstream_request).await {
        Ok(result) => result,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_GATEWAY,
                &format!("failed to connect websocket preview target: {error}"),
            );
        }
    };

    let websocket_upgrade = match WebSocketUpgrade::from_request_parts(parts, &state).await {
        Ok(upgrade) => upgrade,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid websocket upgrade request: {error}"),
            );
        }
    };

    let accepted_protocol = upstream_response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let websocket_upgrade = if let Some(protocol) = accepted_protocol {
        websocket_upgrade.protocols([protocol])
    } else {
        websocket_upgrade
    };

    websocket_upgrade
        .on_upgrade(move |socket| async move {
            proxy_preview_websocket(socket, upstream_socket).await;
        })
        .into_response()
}

async fn proxy_preview_websocket(
    socket: WebSocket,
    upstream_socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let (mut client_tx, mut client_rx) = socket.split();
    let (mut upstream_tx, mut upstream_rx) = upstream_socket.split();

    let mut client_to_upstream = tokio::spawn(async move {
        while let Some(message) = client_rx.next().await {
            let Ok(message) = message else {
                break;
            };

            let upstream_message = match message {
                Message::Text(text) => UpstreamWsMessage::Text(text.to_string().into()),
                Message::Binary(data) => UpstreamWsMessage::Binary(data),
                Message::Ping(data) => UpstreamWsMessage::Ping(data),
                Message::Pong(data) => UpstreamWsMessage::Pong(data),
                Message::Close(_) => UpstreamWsMessage::Close(None),
            };

            if upstream_tx.send(upstream_message).await.is_err() {
                break;
            }
        }
    });

    let mut upstream_to_client = tokio::spawn(async move {
        while let Some(message) = upstream_rx.next().await {
            let Ok(message) = message else {
                break;
            };

            let client_message = match message {
                UpstreamWsMessage::Text(text) => Message::Text(text.to_string().into()),
                UpstreamWsMessage::Binary(data) => Message::Binary(data),
                UpstreamWsMessage::Ping(data) => Message::Ping(data),
                UpstreamWsMessage::Pong(data) => Message::Pong(data),
                UpstreamWsMessage::Close(_) => Message::Close(None),
                UpstreamWsMessage::Frame(_) => continue,
            };

            if client_tx.send(client_message).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = &mut client_to_upstream => upstream_to_client.abort(),
        _ = &mut upstream_to_client => client_to_upstream.abort(),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<RpcQuery>,
) -> Response {
    if !state.is_authorized(&headers, query.token.as_deref()).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "unauthorized",
                "message": "Missing or invalid bridge credentials"
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
        .backend
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
        "bridge/capabilities/read" => serde_json::to_value(state.bridge_capabilities())
            .map_err(|error| BridgeError::server(&error.to_string())),
        "bridge/runtime/read" => serde_json::to_value(state.updater.runtime_info().await)
            .map_err(|error| BridgeError::server(&error.to_string())),
        "bridge/browser/session/create" => {
            let request: BrowserPreviewCreateRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let session = state.preview.create_session(&request.target_url).await?;
            serde_json::to_value(session).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/browser/sessions/list" => {
            let sessions = state.preview.list_sessions().await;
            serde_json::to_value(json!({ "sessions": sessions }))
                .map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/browser/session/close" => {
            let request: BrowserPreviewCloseRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let session_id = request.session_id.trim();
            if session_id.is_empty() {
                return Err(BridgeError::invalid_params("sessionId must not be empty"));
            }
            Ok(json!({
                "closed": state.preview.close_session(session_id).await,
            }))
        }
        "bridge/browser/targets/discover" => {
            let result = state.preview.discover_targets().await;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/update/start" => {
            let request: BridgeUpdateStartRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let target_version = request.version.as_deref().unwrap_or("latest");
            let result = state
                .updater
                .start_update(target_version, std::process::id(), &now_iso())
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/restart/start" => {
            let result = state
                .updater
                .start_restart(std::process::id(), &now_iso())
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
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
        "bridge/thread/queue/read" => {
            let request: BridgeThreadQueueReadRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            serde_json::to_value(state.queue.read_queue(&request.thread_id).await)
                .map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/thread/queue/send" => {
            let request: BridgeThreadQueueSendRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = state
                .queue
                .send_message(request)
                .await
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/thread/queue/steer" => {
            let request: BridgeThreadQueueSteerRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = state
                .queue
                .steer_message(request)
                .await
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/thread/queue/cancel" => {
            let request: BridgeThreadQueueCancelRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = state
                .queue
                .cancel_message(request)
                .await
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/workspaces/list" => {
            let request: WorkspaceListRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = list_workspace_roots(state, request).await?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/fs/list" => {
            let request: FileSystemListRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = list_filesystem_entries(state, request).await?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
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
        "bridge/github/auth/install" => {
            let request: GitHubAuthInstallRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = install_github_git_auth(
                state,
                &request.access_token,
                request.repositories.as_deref().unwrap_or(&[]),
            )
            .await?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
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
        "bridge/git/history" => {
            let request: GitHistoryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let history = state
                .git
                .get_history(request.cwd.as_deref(), request.limit)
                .await?;
            serde_json::to_value(history).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/clone" => {
            let request: GitCloneRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitCloneRequest {
                url,
                parent_path,
                directory_name,
            } = request;

            if url.trim().is_empty() {
                return Err(BridgeError::invalid_params("url must not be empty"));
            }
            if directory_name.trim().is_empty() {
                return Err(BridgeError::invalid_params(
                    "directoryName must not be empty",
                ));
            }

            let cloned = state
                .git
                .clone_repo(&url, parent_path.as_deref(), &directory_name)
                .await?;
            serde_json::to_value(cloned).map_err(|error| BridgeError::server(&error.to_string()))
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
            let list = state.backend.list_pending_approvals().await;
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
                .backend
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
                .backend
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

async fn list_workspace_roots(
    state: &Arc<AppState>,
    request: WorkspaceListRequest,
) -> Result<WorkspaceListResponse, BridgeError> {
    let limit = request.limit.unwrap_or(200).clamp(1, 1000);
    let result = state
        .backend
        .request_internal(
            "thread/list",
            Some(json!({
                "cursor": Value::Null,
                "limit": limit,
                "sortKey": Value::Null,
                "modelProviders": Value::Null,
                "sourceKinds": ["cli", "vscode", "exec", "appServer", "unknown"],
                "archived": false,
                "cwd": Value::Null,
            })),
        )
        .await
        .map_err(|error| BridgeError::server(&error))?;

    let entries = result
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut workspaces_by_path: HashMap<String, (usize, u64)> = HashMap::new();

    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };

        let Some(raw_cwd) = read_string(object.get("cwd")) else {
            continue;
        };

        let Some(canonical_path) =
            normalize_existing_directory(&state.config.workdir, raw_cwd.as_str()).await
        else {
            continue;
        };

        let workspace_path = path_to_string(&canonical_path);
        let updated_at = parse_internal_id(object.get("updatedAt")).unwrap_or(0);
        let workspace_entry = workspaces_by_path
            .entry(workspace_path)
            .or_insert((0, updated_at));
        workspace_entry.0 += 1;
        workspace_entry.1 = workspace_entry.1.max(updated_at);
    }

    let mut workspaces = workspaces_by_path
        .into_iter()
        .map(|(path, (chat_count, updated_at))| {
            (
                WorkspaceSummary {
                    path,
                    chat_count,
                    updated_at: (updated_at > 0).then_some(updated_at),
                },
                updated_at,
            )
        })
        .collect::<Vec<_>>();

    workspaces.sort_by(|(left, left_updated_at), (right, right_updated_at)| {
        right_updated_at
            .cmp(left_updated_at)
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(WorkspaceListResponse {
        bridge_root: path_to_string(&state.config.workdir),
        allow_outside_root_cwd: state.config.allow_outside_root_cwd,
        workspaces: workspaces
            .into_iter()
            .map(|(workspace, _)| workspace)
            .collect(),
    })
}

async fn list_filesystem_entries(
    state: &Arc<AppState>,
    request: FileSystemListRequest,
) -> Result<FileSystemListResponse, BridgeError> {
    let include_hidden = request.include_hidden.unwrap_or(false);
    let directories_only = request.directories_only.unwrap_or(true);
    let current_path =
        resolve_browsable_directory(&state.config.workdir, request.path.as_deref()).await?;

    let mut read_dir = fs::read_dir(&current_path)
        .await
        .map_err(|error| BridgeError::server(&format!("failed to read directory: {error}")))?;
    let mut entries = Vec::new();

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|error| BridgeError::server(&format!("failed to read directory entry: {error}")))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }

        let hidden = name.starts_with('.');
        if hidden && !include_hidden {
            continue;
        }

        let entry_path = normalize_path(&entry.path());
        let metadata = match fs::metadata(&entry_path).await {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        let is_directory = metadata.is_dir();
        if directories_only && !is_directory {
            continue;
        }

        let kind = if is_directory { "directory" } else { "file" }.to_string();
        let is_git_repo = if is_directory {
            fs::metadata(entry_path.join(".git")).await.is_ok()
        } else {
            false
        };

        entries.push(FileSystemEntry {
            name,
            path: path_to_string(&entry_path),
            kind,
            hidden,
            selectable: is_directory,
            is_git_repo,
        });
    }

    entries.sort_by(|left, right| {
        right.selectable.cmp(&left.selectable).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.name.cmp(&right.name))
        })
    });

    let parent_path = current_path.parent().map(path_to_string);

    Ok(FileSystemListResponse {
        bridge_root: path_to_string(&state.config.workdir),
        path: path_to_string(&current_path),
        parent_path,
        entries,
    })
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

fn bridge_chatgpt_auth_cache() -> &'static StdRwLock<Option<BridgeChatGptAuthBundle>> {
    static CACHE: OnceLock<StdRwLock<Option<BridgeChatGptAuthBundle>>> = OnceLock::new();
    CACHE.get_or_init(|| StdRwLock::new(None))
}

#[cfg(test)]
fn bridge_chatgpt_auth_cache_path_override() -> &'static StdRwLock<Option<PathBuf>> {
    static OVERRIDE: OnceLock<StdRwLock<Option<PathBuf>>> = OnceLock::new();
    OVERRIDE.get_or_init(|| StdRwLock::new(None))
}

#[cfg(test)]
fn set_bridge_chatgpt_auth_cache_path_override(path: Option<PathBuf>) {
    if let Ok(mut guard) = bridge_chatgpt_auth_cache_path_override().write() {
        *guard = path;
    }
}

fn resolve_bridge_chatgpt_auth_cache_path() -> Option<PathBuf> {
    #[cfg(test)]
    if let Ok(guard) = bridge_chatgpt_auth_cache_path_override().read() {
        if let Some(path) = guard.clone() {
            return Some(path);
        }
    }

    let workdir = read_non_empty_env("BRIDGE_WORKDIR").map(PathBuf::from)?;
    Some(workdir.join(BRIDGE_CHATGPT_AUTH_CACHE_FILE_NAME))
}

fn load_persisted_bridge_chatgpt_auth() -> Option<BridgeChatGptAuthBundle> {
    let path = resolve_bridge_chatgpt_auth_cache_path()?;
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<BridgeChatGptAuthBundle>(&contents).ok()
}

fn read_cached_bridge_chatgpt_auth() -> Option<BridgeChatGptAuthBundle> {
    if let Ok(guard) = bridge_chatgpt_auth_cache().read() {
        if let Some(auth) = guard.clone() {
            return Some(auth);
        }
    }

    let persisted = load_persisted_bridge_chatgpt_auth()?;
    if let Ok(mut guard) = bridge_chatgpt_auth_cache().write() {
        *guard = Some(persisted.clone());
    }
    Some(persisted)
}

fn cache_bridge_chatgpt_auth(auth: BridgeChatGptAuthBundle) {
    if let Ok(mut guard) = bridge_chatgpt_auth_cache().write() {
        *guard = Some(auth.clone());
    }

    if let Some(path) = resolve_bridge_chatgpt_auth_cache_path() {
        if let Ok(payload) = serde_json::to_vec_pretty(&auth) {
            let _ = std::fs::write(path, payload);
        }
    }
}

fn clear_cached_bridge_chatgpt_auth() {
    if let Ok(mut guard) = bridge_chatgpt_auth_cache().write() {
        *guard = None;
    }

    if let Some(path) = resolve_bridge_chatgpt_auth_cache_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn resolve_bridge_chatgpt_auth_bundle_for_refresh() -> Option<BridgeChatGptAuthBundle> {
    let access_token = read_non_empty_env("BRIDGE_CHATGPT_ACCESS_TOKEN");
    let account_id = read_non_empty_env("BRIDGE_CHATGPT_ACCOUNT_ID");
    if let (Some(access_token), Some(account_id)) = (access_token, account_id) {
        return Some(BridgeChatGptAuthBundle {
            access_token,
            account_id,
            plan_type: read_non_empty_env("BRIDGE_CHATGPT_PLAN_TYPE"),
        });
    }

    read_cached_bridge_chatgpt_auth()
}

fn resolve_bridge_chatgpt_access_token_for_transcription() -> Option<String> {
    read_non_empty_env("BRIDGE_CHATGPT_ACCESS_TOKEN")
        .or_else(|| read_cached_bridge_chatgpt_auth().map(|auth| auth.access_token))
}

fn extract_chatgpt_auth_tokens_from_account_login_start(
    params: Option<&Value>,
) -> Option<BridgeChatGptAuthBundle> {
    let params = params?.as_object()?;
    let login_type = params.get("type")?.as_str()?.trim();
    if login_type != "chatgptAuthTokens" {
        return None;
    }

    let access_token = params.get("accessToken")?.as_str()?.trim();
    let account_id = params.get("chatgptAccountId")?.as_str()?.trim();
    if access_token.is_empty() || account_id.is_empty() {
        return None;
    }

    let plan_type = params
        .get("chatgptPlanType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Some(BridgeChatGptAuthBundle {
        access_token: access_token.to_string(),
        account_id: account_id.to_string(),
        plan_type,
    })
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

    // Path 2: bridge ChatGPT auth (env, cached mobile login, or persisted bridge cache)
    // → ChatGPT backend.
    if let Some(access_token) = resolve_bridge_chatgpt_access_token_for_transcription() {
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
            "no transcription credentials found: set OPENAI_API_KEY or BRIDGE_CHATGPT_ACCESS_TOKEN, or finish ChatGPT login for Codex in the mobile app"
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

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

async fn normalize_existing_directory(base: &Path, raw_path: &str) -> Option<PathBuf> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = PathBuf::from(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    };

    let canonical = fs::canonicalize(&resolved).await.ok()?;
    let metadata = fs::metadata(&canonical).await.ok()?;
    if !metadata.is_dir() {
        return None;
    }

    Some(normalize_path(&canonical))
}

async fn resolve_browsable_directory(
    base: &Path,
    raw_path: Option<&str>,
) -> Result<PathBuf, BridgeError> {
    let trimmed = raw_path.map(str::trim).unwrap_or("");
    let candidate = if trimmed.is_empty() {
        base.to_path_buf()
    } else {
        let requested = PathBuf::from(trimmed);
        if requested.is_absolute() {
            requested
        } else {
            base.join(requested)
        }
    };

    let canonical = fs::canonicalize(&candidate).await.map_err(|error| {
        BridgeError::invalid_params(&format!(
            "workspace directory is invalid or inaccessible ({}): {error}",
            candidate.to_string_lossy()
        ))
    })?;

    let metadata = fs::metadata(&canonical).await.map_err(|error| {
        BridgeError::server(&format!(
            "failed to inspect workspace directory ({}): {error}",
            canonical.to_string_lossy()
        ))
    })?;

    if !metadata.is_dir() {
        return Err(BridgeError::invalid_params(
            "workspace directory must point to a folder",
        ));
    }

    Ok(normalize_path(&canonical))
}

fn is_unspecified_bind_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "0.0.0.0" | "::" | "[::]"
    )
}

fn format_host_for_url(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.contains(':') && !trimmed.starts_with('[') && !trimmed.ends_with(']') {
        return format!("[{}]", trimmed);
    }
    trimmed.to_string()
}

fn bridge_access_url(config: &BridgeConfig) -> Option<String> {
    if let Some(url) = config.connect_url.clone() {
        return Some(url);
    }

    if is_unspecified_bind_host(&config.host) {
        return None;
    }

    Some(format!(
        "http://{}:{}",
        format_host_for_url(&config.host),
        config.port
    ))
}

fn build_pairing_payload(config: &BridgeConfig) -> Option<String> {
    let bridge_token = config.auth_token.clone()?;
    let bridge_url = bridge_access_url(config)?;

    Some(
        json!({
            "type": "clawdex-bridge-pair",
            "bridgeUrl": bridge_url,
            "bridgeToken": bridge_token,
        })
        .to_string(),
    )
}

fn build_token_only_pairing_payload(config: &BridgeConfig) -> Option<String> {
    let bridge_token = config.auth_token.clone()?;

    Some(
        json!({
            "type": "clawdex-bridge-token",
            "bridgeToken": bridge_token,
        })
        .to_string(),
    )
}

fn flush_pairing_output() {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
}

fn maybe_print_pairing_qr(config: &BridgeConfig) {
    if !config.show_pairing_qr {
        return;
    }

    if let Some(payload) = build_pairing_payload(config) {
        println!();
        println!("Bridge pairing QR (scan from mobile onboarding):");
        if let Err(error) = qr2term::print_qr(payload.as_bytes()) {
            eprintln!("failed to render pairing QR: {error}");
            flush_pairing_output();
            return;
        }
        println!("QR contains bridge URL + token for one-tap onboarding.");
        println!();
        flush_pairing_output();
        return;
    }

    let Some(payload) = build_token_only_pairing_payload(config) else {
        eprintln!("bridge token QR skipped because BRIDGE_AUTH_TOKEN is not set");
        flush_pairing_output();
        return;
    };

    println!();
    println!("Bridge token QR fallback (scan from mobile onboarding):");
    if let Err(error) = qr2term::print_qr(payload.as_bytes()) {
        eprintln!("failed to render pairing QR: {error}");
        flush_pairing_output();
        return;
    }
    println!(
        "Full pairing QR unavailable because no phone-connectable bridge URL was resolved. Enter URL manually in onboarding."
    );
    println!();
    flush_pairing_output();
}

async fn wait_for_shutdown_trigger(shutdown_rx: &mut watch::Receiver<bool>) {
    if *shutdown_rx.borrow() {
        return;
    }

    while shutdown_rx.changed().await.is_ok() {
        if *shutdown_rx.borrow() {
            break;
        }
    }
}

#[derive(Debug)]
struct PreviewBootstrapParams {
    session_id: Option<String>,
    bootstrap_token: Option<String>,
    viewport: Option<PreviewViewportConfig>,
    shell_mode: Option<PreviewShellMode>,
    raw_frame: bool,
    sanitized_path_and_query: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewShellMode {
    Desktop,
    Overview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewViewportPreset {
    Mobile,
    Desktop,
}

const DEFAULT_PREVIEW_DESKTOP_WIDTH: u32 = 1920;
const DEFAULT_PREVIEW_DESKTOP_HEIGHT: u32 = 1080;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PreviewViewportConfig {
    preset: PreviewViewportPreset,
    width: Option<u32>,
    height: Option<u32>,
}

impl PreviewViewportConfig {
    fn as_cookie_value(self) -> String {
        match self.preset {
            PreviewViewportPreset::Mobile => "mobile".to_string(),
            PreviewViewportPreset::Desktop => match (self.width, self.height) {
                (Some(width), Some(height)) => format!("desktop:{width}:{height}"),
                (Some(width), None) => format!("desktop:{width}"),
                _ => "desktop".to_string(),
            },
        }
    }

    fn viewport_meta_content(self) -> Option<String> {
        match self.preset {
            PreviewViewportPreset::Mobile => None,
            PreviewViewportPreset::Desktop => {
                let width = self.width.unwrap_or(DEFAULT_PREVIEW_DESKTOP_WIDTH);
                let height = self.height.or_else(|| {
                    if self.width.is_none() {
                        Some(DEFAULT_PREVIEW_DESKTOP_HEIGHT)
                    } else {
                        None
                    }
                });
                let mut parts = vec![format!("width={width}")];
                if let Some(height) = height {
                    parts.push(format!("height={height}"));
                }
                parts.push("initial-scale=1".to_string());
                parts.push("minimum-scale=0.1".to_string());
                parts.push("maximum-scale=5".to_string());
                parts.push("user-scalable=yes".to_string());
                Some(parts.join(", "))
            }
        }
    }
}

fn parse_preview_viewport_preset(raw: &str) -> Option<PreviewViewportPreset> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "mobile" => Some(PreviewViewportPreset::Mobile),
        "desktop" => Some(PreviewViewportPreset::Desktop),
        _ => None,
    }
}

fn parse_preview_shell_mode(raw: &str) -> Option<PreviewShellMode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "desktop" => Some(PreviewShellMode::Desktop),
        "overview" => Some(PreviewShellMode::Overview),
        _ => None,
    }
}

fn normalize_preview_viewport_dimension(raw: Option<&str>) -> Option<u32> {
    let value = raw?.trim().parse::<u32>().ok()?;
    if !(320..=4096).contains(&value) {
        return None;
    }
    Some(value)
}

fn build_preview_viewport_config(
    preset: Option<PreviewViewportPreset>,
    width: Option<u32>,
    height: Option<u32>,
) -> Option<PreviewViewportConfig> {
    match preset? {
        PreviewViewportPreset::Mobile => Some(PreviewViewportConfig {
            preset: PreviewViewportPreset::Mobile,
            width: None,
            height: None,
        }),
        PreviewViewportPreset::Desktop => Some(PreviewViewportConfig {
            preset: PreviewViewportPreset::Desktop,
            width,
            height,
        }),
    }
}

#[derive(Debug)]
struct ResolvedPreviewRequest {
    session: BrowserPreviewResolvedSession,
    bootstrap_session_id: Option<String>,
    bootstrap_token: Option<String>,
    requested_viewport: Option<PreviewViewportConfig>,
    requested_shell_mode: Option<PreviewShellMode>,
    raw_frame: bool,
    sanitized_path_and_query: String,
}

async fn resolve_preview_session_from_request(
    preview: &BrowserPreviewService,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<ResolvedPreviewRequest, Response> {
    let params = parse_preview_bootstrap_params(uri);
    if let (Some(session_id), Some(bootstrap_token)) = (
        params.session_id.as_deref(),
        params.bootstrap_token.as_deref(),
    ) {
        let Some(session) = preview.resolve_bootstrap(session_id, bootstrap_token).await else {
            return Err(preview_error_response(
                StatusCode::UNAUTHORIZED,
                "preview session is invalid or expired; reopen it from Clawdex",
            ));
        };

        return Ok(ResolvedPreviewRequest {
            session,
            bootstrap_session_id: Some(session_id.to_string()),
            bootstrap_token: Some(bootstrap_token.to_string()),
            requested_viewport: params.viewport,
            requested_shell_mode: params.shell_mode,
            raw_frame: params.raw_frame,
            sanitized_path_and_query: params.sanitized_path_and_query,
        });
    }

    let Some(cookie_token) = read_cookie_value(headers, BROWSER_PREVIEW_COOKIE_NAME) else {
        return Err(preview_error_response(
            StatusCode::UNAUTHORIZED,
            "preview session is missing; reopen it from Clawdex",
        ));
    };
    let Some(session) = preview.resolve_cookie(&cookie_token).await else {
        return Err(preview_error_response(
            StatusCode::UNAUTHORIZED,
            "preview session expired; reopen it from Clawdex",
        ));
    };

    Ok(ResolvedPreviewRequest {
        session,
        bootstrap_session_id: None,
        bootstrap_token: None,
        requested_viewport: params.viewport,
        requested_shell_mode: params.shell_mode,
        raw_frame: params.raw_frame,
        sanitized_path_and_query: params.sanitized_path_and_query,
    })
}

fn parse_preview_bootstrap_params(uri: &Uri) -> PreviewBootstrapParams {
    let Ok(mut parsed) = Url::parse(&format!("http://preview{}", uri)) else {
        return PreviewBootstrapParams {
            session_id: None,
            bootstrap_token: None,
            viewport: None,
            shell_mode: None,
            raw_frame: false,
            sanitized_path_and_query: uri
                .path_and_query()
                .map(|value| value.as_str().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "/".to_string()),
        };
    };

    let mut session_id = None;
    let mut bootstrap_token = None;
    let mut viewport_preset = None;
    let mut viewport_width = None;
    let mut viewport_height = None;
    let mut shell_mode = None;
    let mut raw_frame = false;
    let mut retained_pairs = Vec::new();
    for (key, value) in parsed.query_pairs() {
        if key == "sid" {
            session_id = Some(value.to_string());
            continue;
        }
        if key == "st" {
            bootstrap_token = Some(value.to_string());
            continue;
        }
        if key == "vp" {
            viewport_preset = parse_preview_viewport_preset(&value);
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "vw" {
            viewport_width = normalize_preview_viewport_dimension(Some(value.as_ref()));
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "vh" {
            viewport_height = normalize_preview_viewport_dimension(Some(value.as_ref()));
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "shell" {
            shell_mode = parse_preview_shell_mode(&value);
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "frame" {
            raw_frame = value == "1";
            continue;
        }
        retained_pairs.push((key.to_string(), value.to_string()));
    }

    parsed.set_query(None);
    if !retained_pairs.is_empty() {
        let mut query_pairs = parsed.query_pairs_mut();
        for (key, value) in &retained_pairs {
            query_pairs.append_pair(key, value);
        }
    }

    let sanitized_path_and_query = format!(
        "{}{}",
        parsed.path(),
        parsed
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default()
    );

    PreviewBootstrapParams {
        session_id,
        bootstrap_token,
        viewport: build_preview_viewport_config(viewport_preset, viewport_width, viewport_height),
        shell_mode,
        raw_frame,
        sanitized_path_and_query,
    }
}

fn preview_bootstrap_redirect_response(
    sanitized_path_and_query: &str,
    bootstrap_token: &str,
    viewport: Option<PreviewViewportConfig>,
) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::TEMPORARY_REDIRECT;
    response.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(sanitized_path_and_query)
            .unwrap_or_else(|_| HeaderValue::from_static("/")),
    );
    if let Ok(cookie) = build_preview_cookie_header(bootstrap_token) {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
    if let Some(viewport) = viewport {
        if let Ok(cookie) = build_preview_viewport_cookie_header(viewport) {
            response.headers_mut().append(SET_COOKIE, cookie);
        }
    }
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store, private"));
    response
}

fn append_preview_bootstrap_headers(
    response: &mut Response,
    bootstrap_token: Option<&str>,
    viewport: Option<PreviewViewportConfig>,
) {
    if let Some(token) = bootstrap_token {
        if let Ok(cookie) = build_preview_cookie_header(token) {
            response.headers_mut().append(SET_COOKIE, cookie);
        }
    }

    if let Some(viewport) = viewport {
        if let Ok(cookie) = build_preview_viewport_cookie_header(viewport) {
            response.headers_mut().append(SET_COOKIE, cookie);
        }
    }
}

fn build_preview_shell_frame_src(
    sanitized_path_and_query: &str,
    bootstrap_session_id: Option<&str>,
    bootstrap_token: Option<&str>,
) -> String {
    let Ok(mut parsed) = Url::parse(&format!("http://preview{sanitized_path_and_query}")) else {
        return if sanitized_path_and_query.contains('?') {
            format!("{sanitized_path_and_query}&frame=1")
        } else {
            format!("{sanitized_path_and_query}?frame=1")
        };
    };

    let mut kept_pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter_map(|(key, value)| {
            let should_drop = matches!(key.as_ref(), "shell" | "frame")
                || (bootstrap_session_id.is_some() && key == "sid")
                || (bootstrap_token.is_some() && key == "st");
            if should_drop {
                None
            } else {
                Some((key.into_owned(), value.into_owned()))
            }
        })
        .collect();

    {
        let mut query_pairs = parsed.query_pairs_mut();
        query_pairs.clear();
        for (key, value) in kept_pairs.drain(..) {
            query_pairs.append_pair(&key, &value);
        }
        query_pairs.append_pair("frame", "1");
        if let Some(session_id) = bootstrap_session_id {
            query_pairs.append_pair("sid", session_id);
        }
        if let Some(token) = bootstrap_token {
            query_pairs.append_pair("st", token);
        }
    }

    format!(
        "{}{}",
        parsed.path(),
        parsed
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default()
    )
}

fn build_preview_shell_request_key(
    bootstrap_session_id: Option<&str>,
    bootstrap_token: Option<&str>,
) -> Option<String> {
    Some(format!("{}:{}", bootstrap_session_id?, bootstrap_token?))
}

fn preview_error_response(status: StatusCode, message: &str) -> Response {
    let body = format!(
        "<!doctype html><html><body style=\"font-family:-apple-system,system-ui,sans-serif;padding:24px;background:#111;color:#f5f5f5\"><h1 style=\"font-size:18px;margin:0 0 12px\">Preview unavailable</h1><p style=\"margin:0;color:#d4d4d4\">{}</p></body></html>",
        html_escape(message)
    );
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from(message.to_string())))
}

fn build_preview_cookie_header(bootstrap_token: &str) -> Result<HeaderValue, String> {
    HeaderValue::from_str(&format!(
        "{BROWSER_PREVIEW_COOKIE_NAME}={bootstrap_token}; HttpOnly; Path=/; SameSite=Lax; Max-Age={}",
        BROWSER_PREVIEW_SESSION_TTL.as_secs()
    ))
    .map_err(|error| error.to_string())
}

fn build_preview_viewport_cookie_header(
    viewport: PreviewViewportConfig,
) -> Result<HeaderValue, String> {
    HeaderValue::from_str(&format!(
        "{BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME}={}; Path=/; SameSite=Lax; Max-Age={}",
        viewport.as_cookie_value(),
        BROWSER_PREVIEW_SESSION_TTL.as_secs()
    ))
    .map_err(|error| error.to_string())
}

fn read_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw_cookie = headers.get(COOKIE)?.to_str().ok()?;
    for segment in raw_cookie.split(';') {
        let trimmed = segment.trim();
        let Some((cookie_name, cookie_value)) = trimmed.split_once('=') else {
            continue;
        };
        if cookie_name.trim() == name {
            let value = cookie_value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn parse_preview_viewport_cookie(raw: &str) -> Option<PreviewViewportConfig> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parts = trimmed.split(':');
    let preset = parse_preview_viewport_preset(parts.next()?)?;
    let width = normalize_preview_viewport_dimension(parts.next());
    let height = normalize_preview_viewport_dimension(parts.next());
    build_preview_viewport_config(Some(preset), width, height)
}

fn read_preview_viewport_preset(headers: &HeaderMap) -> Option<PreviewViewportConfig> {
    read_cookie_value(headers, BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME)
        .as_deref()
        .and_then(parse_preview_viewport_cookie)
}

fn preview_desktop_shell_response(
    sanitized_path_and_query: &str,
    viewport: PreviewViewportConfig,
    bootstrap_session_id: Option<&str>,
    bootstrap_token: Option<&str>,
) -> Response {
    let desktop_width = viewport.width.unwrap_or(DEFAULT_PREVIEW_DESKTOP_WIDTH);
    let desktop_height = viewport.height.unwrap_or(DEFAULT_PREVIEW_DESKTOP_HEIGHT);
    let frame_src = build_preview_shell_frame_src(
        sanitized_path_and_query,
        bootstrap_session_id,
        bootstrap_token,
    );
    let frame_src_json = serde_json::to_string(&frame_src).unwrap_or_else(|_| "\"/\"".to_string());
    let shell_request_key_json = serde_json::to_string(&build_preview_shell_request_key(
        bootstrap_session_id,
        bootstrap_token,
    ))
    .unwrap_or_else(|_| "null".to_string());
    let body = format!(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta id="viewport-meta" name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes">
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        min-height: 100%;
        background: #fff;
      }}
      body {{
        overflow-x: auto;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }}
      #shell {{
        width: {desktop_width}px;
        min-height: {desktop_height}px;
      }}
      #frame {{
        display: block;
        width: {desktop_width}px;
        min-height: {desktop_height}px;
        border: 0;
        background: #fff;
      }}
    </style>
  </head>
  <body>
    <div id="shell">
      <iframe id="frame" title="Desktop preview"></iframe>
    </div>
    <script>
      (function() {{
        var frame = document.getElementById('frame');
        var shell = document.getElementById('shell');
        var viewportMeta = document.getElementById('viewport-meta');
        var desktopWidth = {desktop_width};
        var minimumDesktopHeight = {desktop_height};
        var frameSrc = {frame_src_json};
        var lastMeasuredHeight = 0;
        var lastPostedStateJson = '';
        var knownHistory = [];
        var knownHistoryIndex = -1;
        var frameResizeObserver = null;
        var frameMutationObserver = null;
        var frameCleanupCallbacks = [];
        var measureFrameQueued = false;
        var initialFitApplied = false;

        function currentFrameWindow() {{
          try {{
            return frame.contentWindow || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function currentFrameDocument() {{
          try {{
            return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function cleanupFrameObservers() {{
          if (frameResizeObserver) {{
            frameResizeObserver.disconnect();
            frameResizeObserver = null;
          }}
          if (frameMutationObserver) {{
            frameMutationObserver.disconnect();
            frameMutationObserver = null;
          }}
          while (frameCleanupCallbacks.length > 0) {{
            var callback = frameCleanupCallbacks.pop();
            try {{
              callback();
            }} catch (_error) {{}}
          }}
        }}

        function syncHistory(rawUrl) {{
          if (!rawUrl) {{
            return;
          }}
          if (knownHistoryIndex >= 0 && knownHistory[knownHistoryIndex] === rawUrl) {{
            return;
          }}
          if (knownHistoryIndex > 0 && knownHistory[knownHistoryIndex - 1] === rawUrl) {{
            knownHistoryIndex -= 1;
            return;
          }}
          if (
            knownHistoryIndex + 1 < knownHistory.length &&
            knownHistory[knownHistoryIndex + 1] === rawUrl
          ) {{
            knownHistoryIndex += 1;
            return;
          }}
          knownHistory = knownHistory.slice(0, knownHistoryIndex + 1);
          knownHistory.push(rawUrl);
          knownHistoryIndex = knownHistory.length - 1;
        }}

        function postState() {{
          if (
            !window.ReactNativeWebView ||
            typeof window.ReactNativeWebView.postMessage !== 'function'
          ) {{
            return;
          }}

          var rawUrl = '';
          var title = '';
          try {{
            var win = currentFrameWindow();
            rawUrl = win && win.location ? String(win.location.href) : '';
          }} catch (_error) {{}}
          try {{
            var doc = currentFrameDocument();
            title = doc ? String(doc.title || '') : '';
          }} catch (_error) {{}}
          syncHistory(rawUrl);
          var nextStateJson = JSON.stringify({{
            type: 'clawdexDesktopFrameState',
            shellRequestKey: {shell_request_key_json},
            rawUrl: rawUrl,
            title: title,
            canGoBack: knownHistoryIndex > 0,
            canGoForward: knownHistoryIndex >= 0 && knownHistoryIndex < knownHistory.length - 1,
          }});
          if (nextStateJson === lastPostedStateJson) {{
            return;
          }}
          lastPostedStateJson = nextStateJson;
          window.ReactNativeWebView.postMessage(nextStateJson);
        }}

        function applyInitialFit() {{
          if (initialFitApplied || !viewportMeta) {{
            return;
          }}
          var viewportWidth = Math.max(
            window.innerWidth || document.documentElement.clientWidth || 0,
            1
          );
          var scale = Math.min(1, viewportWidth / desktopWidth);
          viewportMeta.setAttribute(
            'content',
            'width=' +
              desktopWidth +
              ', initial-scale=' +
              scale +
              ', minimum-scale=' +
              Math.min(scale, 1) +
              ', maximum-scale=5, user-scalable=yes'
          );
          initialFitApplied = true;
        }}

        function measureFrameHeight() {{
          measureFrameQueued = false;
          if (minimumDesktopHeight !== lastMeasuredHeight) {{
            lastMeasuredHeight = minimumDesktopHeight;
            frame.style.height = minimumDesktopHeight + 'px';
            shell.style.height = minimumDesktopHeight + 'px';
          }}
          applyInitialFit();
          postState();
        }}

        function queueMeasureFrameHeight() {{
          if (measureFrameQueued) {{
            return;
          }}
          measureFrameQueued = true;
          window.requestAnimationFrame(function() {{
            measureFrameHeight();
          }});
        }}

        function installFrameObservers() {{
          cleanupFrameObservers();
          var win = currentFrameWindow();
          var doc = currentFrameDocument();
          if (!win || !doc) {{
            return;
          }}

          function addFrameListener(target, eventName, handler, options) {{
            if (!target || typeof target.addEventListener !== 'function') {{
              return;
            }}
            target.addEventListener(eventName, handler, options);
            frameCleanupCallbacks.push(function() {{
              try {{
                target.removeEventListener(eventName, handler, options);
              }} catch (_error) {{}}
            }});
          }}

          if (typeof ResizeObserver === 'function') {{
            frameResizeObserver = new ResizeObserver(function() {{
              queueMeasureFrameHeight();
            }});
            if (doc.documentElement) {{
              frameResizeObserver.observe(doc.documentElement);
            }}
            if (doc.body) {{
              frameResizeObserver.observe(doc.body);
            }}
          }}

          if (typeof MutationObserver === 'function' && doc.head) {{
            frameMutationObserver = new MutationObserver(function() {{
              postState();
            }});
            frameMutationObserver.observe(doc.head, {{
              childList: true,
              subtree: true,
              characterData: true,
            }});
          }}

          addFrameListener(win, 'load', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'pageshow', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'hashchange', postState, {{ passive: true }});
          addFrameListener(win, 'popstate', postState, {{ passive: true }});

          if (doc.fonts && typeof doc.fonts.ready === 'object' && typeof doc.fonts.ready.then === 'function') {{
            doc.fonts.ready.then(queueMeasureFrameHeight).catch(function() {{}});
          }}

          if (!win.__clawdexDesktopFramePatched && win.history) {{
            win.__clawdexDesktopFramePatched = true;
            var originalPushState = typeof win.history.pushState === 'function' ? win.history.pushState.bind(win.history) : null;
            var originalReplaceState = typeof win.history.replaceState === 'function' ? win.history.replaceState.bind(win.history) : null;
            if (originalPushState) {{
              win.history.pushState = function() {{
                var result = originalPushState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
            if (originalReplaceState) {{
              win.history.replaceState = function() {{
                var result = originalReplaceState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
          }}
        }}

        frame.addEventListener('load', function() {{
          installFrameObservers();
          queueMeasureFrameHeight();
          setTimeout(queueMeasureFrameHeight, 120);
          setTimeout(queueMeasureFrameHeight, 400);
        }});
        window.addEventListener('resize', queueMeasureFrameHeight, {{ passive: true }});

        window.__clawdexDesktopFrame = {{
          goBack: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.back();
            }}
          }},
          goForward: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.forward();
            }}
          }},
          reload: function() {{
            lastPostedStateJson = '';
            var win = currentFrameWindow();
            if (win) {{
              win.location.reload();
            }} else {{
              frame.src = frame.src;
            }}
          }},
        }};

        shell.style.height = minimumDesktopHeight + 'px';
        frame.style.height = minimumDesktopHeight + 'px';
        applyInitialFit();
        frame.src = frameSrc;
      }})();
    </script>
  </body>
</html>"#
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CACHE_CONTROL, "no-store, private")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from(String::new())))
}

fn preview_overview_shell_response(
    sanitized_path_and_query: &str,
    viewport: PreviewViewportConfig,
    bootstrap_session_id: Option<&str>,
    bootstrap_token: Option<&str>,
) -> Response {
    let desktop_width = viewport.width.unwrap_or(DEFAULT_PREVIEW_DESKTOP_WIDTH);
    let desktop_height = viewport.height.unwrap_or(DEFAULT_PREVIEW_DESKTOP_HEIGHT);
    let frame_src = build_preview_shell_frame_src(
        sanitized_path_and_query,
        bootstrap_session_id,
        bootstrap_token,
    );
    let frame_src_json = serde_json::to_string(&frame_src).unwrap_or_else(|_| "\"/\"".to_string());
    let shell_request_key_json = serde_json::to_string(&build_preview_shell_request_key(
        bootstrap_session_id,
        bootstrap_token,
    ))
    .unwrap_or_else(|_| "null".to_string());
    let body = format!(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta id="viewport-meta" name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes">
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        min-height: 100%;
        background: #000;
      }}
      body {{
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }}
      #shell {{
        width: {desktop_width}px;
        min-height: {desktop_height}px;
        overflow: visible;
      }}
      #frame {{
        display: block;
        width: {desktop_width}px;
        min-height: {desktop_height}px;
        border: 0;
        background: #fff;
      }}
    </style>
  </head>
  <body>
    <div id="shell">
      <iframe id="frame" title="Overview preview"></iframe>
    </div>
    <script>
      (function() {{
        var frame = document.getElementById('frame');
        var shell = document.getElementById('shell');
        var viewportMeta = document.getElementById('viewport-meta');
        var desktopWidth = {desktop_width};
        var minimumDesktopHeight = {desktop_height};
        var frameSrc = {frame_src_json};
        var lastMeasuredHeight = minimumDesktopHeight;
        var lastPostedStateJson = '';
        var knownHistory = [];
        var knownHistoryIndex = -1;
        var frameResizeObserver = null;
        var frameMutationObserver = null;
        var frameCleanupCallbacks = [];
        var measureFrameQueued = false;
        var initialFitApplied = false;

        function currentFrameWindow() {{
          try {{
            return frame.contentWindow || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function currentFrameDocument() {{
          try {{
            return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function cleanupFrameObservers() {{
          if (frameResizeObserver) {{
            frameResizeObserver.disconnect();
            frameResizeObserver = null;
          }}
          if (frameMutationObserver) {{
            frameMutationObserver.disconnect();
            frameMutationObserver = null;
          }}
          while (frameCleanupCallbacks.length > 0) {{
            var callback = frameCleanupCallbacks.pop();
            try {{
              callback();
            }} catch (_error) {{}}
          }}
        }}

        function syncHistory(rawUrl) {{
          if (!rawUrl) {{
            return;
          }}
          if (knownHistoryIndex >= 0 && knownHistory[knownHistoryIndex] === rawUrl) {{
            return;
          }}
          if (knownHistoryIndex > 0 && knownHistory[knownHistoryIndex - 1] === rawUrl) {{
            knownHistoryIndex -= 1;
            return;
          }}
          if (
            knownHistoryIndex + 1 < knownHistory.length &&
            knownHistory[knownHistoryIndex + 1] === rawUrl
          ) {{
            knownHistoryIndex += 1;
            return;
          }}
          knownHistory = knownHistory.slice(0, knownHistoryIndex + 1);
          knownHistory.push(rawUrl);
          knownHistoryIndex = knownHistory.length - 1;
        }}

        function postState() {{
          if (
            !window.ReactNativeWebView ||
            typeof window.ReactNativeWebView.postMessage !== 'function'
          ) {{
            return;
          }}

          var rawUrl = '';
          var title = '';
          try {{
            var win = currentFrameWindow();
            rawUrl = win && win.location ? String(win.location.href) : '';
          }} catch (_error) {{}}
          try {{
            var doc = currentFrameDocument();
            title = doc ? String(doc.title || '') : '';
          }} catch (_error) {{}}
          syncHistory(rawUrl);
          var nextStateJson = JSON.stringify({{
            type: 'clawdexDesktopFrameState',
            shellRequestKey: {shell_request_key_json},
            rawUrl: rawUrl,
            title: title,
            canGoBack: knownHistoryIndex > 0,
            canGoForward: knownHistoryIndex >= 0 && knownHistoryIndex < knownHistory.length - 1,
          }});
          if (nextStateJson === lastPostedStateJson) {{
            return;
          }}
          lastPostedStateJson = nextStateJson;
          window.ReactNativeWebView.postMessage(nextStateJson);
        }}

        function applyInitialFit(contentHeight) {{
          if (initialFitApplied || !viewportMeta) {{
            return;
          }}
          var viewportWidth = Math.max(
            (window.visualViewport && window.visualViewport.width) || window.innerWidth || 0,
            1
          );
          var viewportHeight = Math.max(
            (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0,
            1
          );
          var scale = Math.min(1, viewportWidth / desktopWidth, viewportHeight / contentHeight);
          viewportMeta.setAttribute(
            'content',
            'width=' +
              desktopWidth +
              ', initial-scale=' +
              scale +
              ', minimum-scale=' +
              scale +
              ', maximum-scale=5, user-scalable=yes'
          );
          initialFitApplied = true;
        }}

        function applyLayout(contentHeight) {{
          shell.style.width = desktopWidth + 'px';
          shell.style.height = contentHeight + 'px';
          frame.style.width = desktopWidth + 'px';
          frame.style.height = contentHeight + 'px';
        }}

        function measureFrameHeight() {{
          measureFrameQueued = false;
          var doc = currentFrameDocument();
          var height = minimumDesktopHeight;
          if (doc && doc.documentElement) {{
            var html = doc.documentElement;
            var body = doc.body;
            html.style.overflow = 'hidden';
            if (body) {{
              body.style.overflow = 'hidden';
            }}
            height = Math.max(
              minimumDesktopHeight,
              html.scrollHeight || 0,
              html.offsetHeight || 0,
              body ? body.scrollHeight || 0 : 0,
              body ? body.offsetHeight || 0 : 0
            );
          }}

          if (height !== lastMeasuredHeight) {{
            lastMeasuredHeight = height;
          }}
          applyLayout(height);
          applyInitialFit(height);
          postState();
        }}

        function queueMeasureFrameHeight() {{
          if (measureFrameQueued) {{
            return;
          }}
          measureFrameQueued = true;
          window.requestAnimationFrame(function() {{
            measureFrameHeight();
          }});
        }}

        function installFrameObservers() {{
          cleanupFrameObservers();
          var win = currentFrameWindow();
          var doc = currentFrameDocument();
          if (!win || !doc) {{
            return;
          }}

          function addFrameListener(target, eventName, handler, options) {{
            if (!target || typeof target.addEventListener !== 'function') {{
              return;
            }}
            target.addEventListener(eventName, handler, options);
            frameCleanupCallbacks.push(function() {{
              try {{
                target.removeEventListener(eventName, handler, options);
              }} catch (_error) {{}}
            }});
          }}

          if (typeof ResizeObserver === 'function') {{
            frameResizeObserver = new ResizeObserver(function() {{
              queueMeasureFrameHeight();
            }});
            if (doc.documentElement) {{
              frameResizeObserver.observe(doc.documentElement);
            }}
            if (doc.body) {{
              frameResizeObserver.observe(doc.body);
            }}
          }}

          if (typeof MutationObserver === 'function' && doc.head) {{
            frameMutationObserver = new MutationObserver(function() {{
              postState();
            }});
            frameMutationObserver.observe(doc.head, {{
              childList: true,
              subtree: true,
              characterData: true,
            }});
          }}

          addFrameListener(win, 'load', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'pageshow', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'hashchange', postState, {{ passive: true }});
          addFrameListener(win, 'popstate', postState, {{ passive: true }});

          if (doc.fonts && typeof doc.fonts.ready === 'object' && typeof doc.fonts.ready.then === 'function') {{
            doc.fonts.ready.then(queueMeasureFrameHeight).catch(function() {{}});
          }}

          if (!win.__clawdexDesktopFramePatched && win.history) {{
            win.__clawdexDesktopFramePatched = true;
            var originalPushState = typeof win.history.pushState === 'function' ? win.history.pushState.bind(win.history) : null;
            var originalReplaceState = typeof win.history.replaceState === 'function' ? win.history.replaceState.bind(win.history) : null;
            if (originalPushState) {{
              win.history.pushState = function() {{
                var result = originalPushState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
            if (originalReplaceState) {{
              win.history.replaceState = function() {{
                var result = originalReplaceState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
          }}
        }}

        frame.addEventListener('load', function() {{
          installFrameObservers();
          queueMeasureFrameHeight();
          setTimeout(queueMeasureFrameHeight, 120);
          setTimeout(queueMeasureFrameHeight, 400);
        }});

        window.__clawdexDesktopFrame = {{
          goBack: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.back();
            }}
          }},
          goForward: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.forward();
            }}
          }},
          reload: function() {{
            lastPostedStateJson = '';
            var win = currentFrameWindow();
            if (win) {{
              win.location.reload();
            }} else {{
              frame.src = frame.src;
            }}
          }},
        }};

        applyLayout(minimumDesktopHeight);
        frame.src = frameSrc;
      }})();
    </script>
  </body>
</html>"#
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CACHE_CONTROL, "no-store, private")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from(String::new())))
}

fn should_rewrite_preview_html_response(headers: &HeaderMap) -> bool {
    let Some(content_type) = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let normalized = content_type.to_ascii_lowercase();
    if !normalized.contains("text/html") && !normalized.contains("application/xhtml+xml") {
        return false;
    }

    match headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
    {
        Some(value) if !value.is_empty() && value != "identity" => false,
        _ => true,
    }
}

fn rewrite_preview_html_document(
    body: &[u8],
    viewport: Option<PreviewViewportConfig>,
) -> Option<Vec<u8>> {
    if body.len() > BROWSER_PREVIEW_HTML_REWRITE_LIMIT_BYTES {
        return None;
    }

    let document = std::str::from_utf8(body).ok()?;
    let document =
        if let Some(content) = viewport.and_then(PreviewViewportConfig::viewport_meta_content) {
            inject_preview_viewport_meta(document, &content)
        } else {
            document.to_string()
        };
    let rewritten = inject_preview_runtime_script(&document);
    Some(rewritten.into_bytes())
}

fn inject_preview_viewport_meta(document: &str, content: &str) -> String {
    let replacement = format!(r#"<meta name="viewport" content="{content}">"#);
    let lower = document.to_ascii_lowercase();

    let mut search_start = 0usize;
    while let Some(meta_start_relative) = lower[search_start..].find("<meta") {
        let meta_start = search_start + meta_start_relative;
        let Some(meta_end_relative) = lower[meta_start..].find('>') else {
            break;
        };
        let meta_end = meta_start + meta_end_relative + 1;
        let normalized_meta_tag = lower[meta_start..meta_end]
            .split_whitespace()
            .collect::<String>();
        if normalized_meta_tag.contains("name=\"viewport\"")
            || normalized_meta_tag.contains("name='viewport'")
            || normalized_meta_tag.contains("name=viewport")
        {
            let mut rewritten = String::with_capacity(document.len() + replacement.len());
            rewritten.push_str(&document[..meta_start]);
            rewritten.push_str(&replacement);
            rewritten.push_str(&document[meta_end..]);
            return rewritten;
        }
        search_start = meta_end;
    }

    inject_preview_head_markup(document, &replacement)
}

fn inject_preview_runtime_script(document: &str) -> String {
    if document.contains(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH) {
        return document.to_string();
    }

    let script_tag = format!(r#"<script src="{BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH}"></script>"#);
    inject_preview_head_markup(document, &script_tag)
}

fn inject_preview_head_markup(document: &str, markup: &str) -> String {
    let lower = document.to_ascii_lowercase();

    if let Some(head_start) = lower.find("<head") {
        if let Some(head_tag_end_relative) = lower[head_start..].find('>') {
            let insert_at = head_start + head_tag_end_relative + 1;
            let mut rewritten = String::with_capacity(document.len() + markup.len());
            rewritten.push_str(&document[..insert_at]);
            rewritten.push_str(markup);
            rewritten.push_str(&document[insert_at..]);
            return rewritten;
        }
    }

    if let Some(head_end) = lower.find("</head>") {
        let mut rewritten = String::with_capacity(document.len() + markup.len());
        rewritten.push_str(&document[..head_end]);
        rewritten.push_str(markup);
        rewritten.push_str(&document[head_end..]);
        return rewritten;
    }

    format!("{markup}{document}")
}

fn build_preview_runtime_script() -> String {
    format!(
        r#"(function() {{
  if (globalThis.__clawdexPreviewRuntimeInstalled) {{
    return;
  }}
  globalThis.__clawdexPreviewRuntimeInstalled = true;

  var LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  var PROXY_PREFIX = "{proxy_prefix}";
  var currentOrigin = globalThis.location ? globalThis.location.origin : "";
  var currentHref = globalThis.location ? globalThis.location.href : currentOrigin;
  var wsOrigin = currentOrigin.replace(/^http/, "ws");

  function isLoopbackHost(hostname, host) {{
    return LOOPBACK_HOSTS.has((hostname || "").toLowerCase()) || LOOPBACK_HOSTS.has((host || "").toLowerCase());
  }}

  function encodeToken(value) {{
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }}

  function toProxyUrl(input) {{
    try {{
      var resolved = input instanceof URL ? new URL(input.toString()) : new URL(String(input), currentHref);
      if (!/^https?:$/.test(resolved.protocol) || !isLoopbackHost(resolved.hostname, resolved.host)) {{
        return null;
      }}
      var token = encodeToken(resolved.origin);
      return currentOrigin + PROXY_PREFIX + "/" + token + resolved.pathname + resolved.search + resolved.hash;
    }} catch (_error) {{
      return null;
    }}
  }}

  function toProxyWebSocketUrl(input) {{
    try {{
      var resolved = input instanceof URL ? new URL(input.toString()) : new URL(String(input), currentHref);
      if (!/^wss?:$/.test(resolved.protocol) || !isLoopbackHost(resolved.hostname, resolved.host)) {{
        return null;
      }}
      var httpOrigin = resolved.origin.replace(/^ws/, "http");
      var token = encodeToken(httpOrigin);
      return wsOrigin + PROXY_PREFIX + "/" + token + resolved.pathname + resolved.search + resolved.hash;
    }} catch (_error) {{
      return null;
    }}
  }}

  if (typeof globalThis.fetch === "function") {{
    var originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function(input, init) {{
      var sourceUrl = input && typeof input === "object" && "url" in input ? input.url : input;
      var rewritten = toProxyUrl(sourceUrl);
      if (!rewritten) {{
        return originalFetch(input, init);
      }}
      if (typeof Request === "function" && input instanceof Request) {{
        return originalFetch(new Request(rewritten, input), init);
      }}
      return originalFetch(rewritten, init);
    }};
  }}

  if (typeof XMLHttpRequest === "function") {{
    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {{
      var rewritten = toProxyUrl(url);
      arguments[1] = rewritten || url;
      return originalOpen.apply(this, arguments);
    }};
  }}

  if (typeof EventSource === "function") {{
    var OriginalEventSource = EventSource;
    globalThis.EventSource = new Proxy(OriginalEventSource, {{
      construct(target, args, newTarget) {{
        var url = args[0];
        var config = args[1];
        var rewritten = toProxyUrl(url) || url;
        return config === undefined
          ? Reflect.construct(target, [rewritten], newTarget)
          : Reflect.construct(target, [rewritten, config], newTarget);
      }},
    }});
  }}

  if (typeof WebSocket === "function") {{
    var OriginalWebSocket = WebSocket;
    globalThis.WebSocket = new Proxy(OriginalWebSocket, {{
      construct(target, args, newTarget) {{
        var url = args[0];
        var protocols = args[1];
        var rewritten = toProxyWebSocketUrl(url) || url;
        return protocols === undefined
          ? Reflect.construct(target, [rewritten], newTarget)
          : Reflect.construct(target, [rewritten, protocols], newTarget);
      }},
    }});
  }}

  if (globalThis.navigator && typeof globalThis.navigator.sendBeacon === "function") {{
    var originalSendBeacon = globalThis.navigator.sendBeacon.bind(globalThis.navigator);
    globalThis.navigator.sendBeacon = function(url, data) {{
      return originalSendBeacon(toProxyUrl(url) || url, data);
    }};
  }}

  if (globalThis.document && typeof globalThis.document.addEventListener === "function") {{
    globalThis.document.addEventListener("submit", function(event) {{
      var form = event && event.target;
      if (!form || typeof form.getAttribute !== "function") {{
        return;
      }}
      var action = form.getAttribute("action");
      if (!action) {{
        return;
      }}
      var rewritten = toProxyUrl(action);
      if (rewritten) {{
        form.setAttribute("action", rewritten);
      }}
    }}, true);
  }}
}})();"#,
        proxy_prefix = BROWSER_PREVIEW_PROXY_PREFIX
    )
}

fn normalize_browser_preview_target_url(raw: &str) -> Result<Url, BridgeError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("targetUrl must not be empty"));
    }

    let mut parsed = Url::parse(trimmed)
        .map_err(|error| BridgeError::invalid_params(&format!("invalid targetUrl: {error}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(BridgeError::invalid_params(
            "targetUrl must use http:// or https://",
        ));
    }
    if parsed.username().trim().len() > 0 || parsed.password().is_some() {
        return Err(BridgeError::invalid_params(
            "targetUrl must not include username or password",
        ));
    }

    let Some(host) = parsed.host_str() else {
        return Err(BridgeError::invalid_params("targetUrl host is required"));
    };
    if !is_loopback_preview_host(host) {
        return Err(BridgeError::invalid_params(
            "browser preview only supports localhost, 127.0.0.1, or ::1 targets",
        ));
    }

    parsed.set_fragment(None);
    if parsed.path().trim().is_empty() {
        parsed.set_path("/");
    }

    Ok(parsed)
}

fn is_loopback_preview_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

fn build_preview_bootstrap_path(
    target_url: &Url,
    session_id: &str,
    bootstrap_token: &str,
) -> String {
    let mut bootstrap_url = target_url.clone();
    bootstrap_url.set_fragment(None);

    let mut query_pairs = bootstrap_url
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect::<Vec<_>>();
    query_pairs.push(("sid".to_string(), session_id.to_string()));
    query_pairs.push(("st".to_string(), bootstrap_token.to_string()));
    bootstrap_url.set_query(None);
    if !query_pairs.is_empty() {
        let mut serializer = bootstrap_url.query_pairs_mut();
        for (key, value) in &query_pairs {
            serializer.append_pair(key, value);
        }
    }

    format!(
        "{}{}",
        bootstrap_url.path(),
        bootstrap_url
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default()
    )
}

#[derive(Debug, Clone)]
struct PreviewRequestTarget {
    target_url: Url,
    path_and_query: String,
    proxy_path_prefix: Option<String>,
}

fn resolve_preview_request_target(
    session_target_url: &Url,
    sanitized_path_and_query: &str,
) -> Result<PreviewRequestTarget, String> {
    let parsed = Url::parse(&format!("http://preview{}", sanitized_path_and_query))
        .map_err(|error| error.to_string())?;
    let path = parsed.path();
    let proxy_prefix_with_slash = format!("{BROWSER_PREVIEW_PROXY_PREFIX}/");

    if let Some(proxy_tail) = path.strip_prefix(&proxy_prefix_with_slash) {
        let mut segments = proxy_tail.splitn(2, '/');
        let target_token = segments.next().unwrap_or_default().trim();
        if target_token.is_empty() {
            return Err("missing proxied preview target".to_string());
        }

        let target_url = decode_preview_proxy_origin_token(target_token)?;
        let remainder = segments.next().unwrap_or_default();
        let proxied_path = if remainder.is_empty() {
            "/".to_string()
        } else {
            format!("/{remainder}")
        };
        let path_and_query = format!(
            "{}{}",
            proxied_path,
            parsed
                .query()
                .map(|value| format!("?{value}"))
                .unwrap_or_default()
        );

        return Ok(PreviewRequestTarget {
            target_url,
            path_and_query,
            proxy_path_prefix: Some(format!("{BROWSER_PREVIEW_PROXY_PREFIX}/{target_token}")),
        });
    }

    Ok(PreviewRequestTarget {
        target_url: session_target_url.clone(),
        path_and_query: sanitized_path_and_query.to_string(),
        proxy_path_prefix: None,
    })
}

#[cfg(test)]
fn encode_preview_proxy_origin_token(target_origin: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(target_origin.as_bytes())
}

fn decode_preview_proxy_origin_token(token: &str) -> Result<Url, String> {
    let decoded = general_purpose::URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|error| format!("invalid proxied preview target: {error}"))?;
    let origin = String::from_utf8(decoded)
        .map_err(|_| "invalid proxied preview target encoding".to_string())?;
    let mut url = normalize_browser_preview_target_url(&origin).map_err(|error| error.message)?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn build_preview_upstream_url(
    target_url: &Url,
    sanitized_path_and_query: &str,
    websocket: bool,
) -> Result<Url, String> {
    let parsed_path = Url::parse(&format!("http://preview{}", sanitized_path_and_query))
        .map_err(|error| error.to_string())?;
    let mut upstream_url = target_url.clone();
    if websocket {
        let scheme = if target_url.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        upstream_url
            .set_scheme(scheme)
            .map_err(|_| "failed to rewrite websocket scheme".to_string())?;
    }
    upstream_url.set_path(parsed_path.path());
    upstream_url.set_query(parsed_path.query());
    Ok(upstream_url)
}

fn is_websocket_upgrade_request(method: &Method, headers: &HeaderMap) -> bool {
    method == Method::GET
        && headers
            .get(CONNECTION)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_ascii_lowercase().contains("upgrade"))
            .unwrap_or(false)
        && headers
            .get(UPGRADE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
}

fn to_reqwest_method(method: &Method) -> HttpMethod {
    HttpMethod::from_bytes(method.as_str().as_bytes()).unwrap_or(HttpMethod::GET)
}

fn should_skip_preview_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "upgrade"
            | "content-length"
            | "accept-encoding"
            | "transfer-encoding"
            | "proxy-connection"
    )
}

fn should_skip_preview_websocket_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "upgrade"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-extensions"
            | "content-length"
            | "transfer-encoding"
            | "proxy-connection"
    )
}

fn should_skip_preview_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "content-length"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn filter_preview_cookie_header(value: &HeaderValue) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let filtered = raw
        .split(';')
        .filter_map(|segment| {
            let trimmed = segment.trim();
            let (cookie_name, _) = trimmed.split_once('=')?;
            if cookie_name.trim() == BROWSER_PREVIEW_COOKIE_NAME
                || cookie_name.trim() == BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME
            {
                return None;
            }
            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>()
        .join("; ");

    if filtered.is_empty() {
        return None;
    }

    HeaderValue::from_str(&filtered).ok()
}

fn rewrite_preview_request_header(
    name: &str,
    value: &HeaderValue,
    target_url: &Url,
) -> Option<HeaderValue> {
    if name.eq_ignore_ascii_case(ORIGIN.as_str()) {
        return HeaderValue::from_str(&target_origin_string(target_url)).ok();
    }

    if name.eq_ignore_ascii_case(REFERER.as_str()) {
        let raw = value.to_str().ok()?;
        let Ok(mut referer) = Url::parse(raw) else {
            return Some(value.clone());
        };
        let _ = referer.set_scheme(target_url.scheme());
        let _ = referer.set_host(target_url.host_str());
        let _ = referer.set_port(target_url.port());
        return HeaderValue::from_str(referer.as_str()).ok();
    }

    Some(value.clone())
}

fn rewrite_preview_location_header(
    value: &HeaderValue,
    current_upstream_url: &Url,
    request_host: Option<&str>,
    proxy_path_prefix: Option<&str>,
) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let location_url = match Url::parse(raw) {
        Ok(url) => url,
        Err(_) => match current_upstream_url.join(raw) {
            Ok(url) => url,
            Err(_) => return Some(value.clone()),
        },
    };
    if location_url.scheme() != current_upstream_url.scheme()
        || location_url.host_str() != current_upstream_url.host_str()
        || location_url.port_or_known_default() != current_upstream_url.port_or_known_default()
    {
        return Some(value.clone());
    }

    let request_host = request_host?.trim();
    let path_prefix = proxy_path_prefix.unwrap_or_default();
    let rewritten = format!(
        "http://{}{}{}{}{}",
        request_host,
        path_prefix,
        location_url.path(),
        location_url
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default(),
        location_url
            .fragment()
            .map(|fragment| format!("#{fragment}"))
            .unwrap_or_default()
    );
    HeaderValue::from_str(&rewritten).ok()
}

fn rewrite_preview_set_cookie_header(
    value: &HeaderValue,
    proxy_path_prefix: Option<&str>,
) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let mut segments = raw.split(';');
    let cookie_pair = segments.next()?.trim();
    if cookie_pair.is_empty() {
        return None;
    }

    let mut rewritten_segments = vec![cookie_pair.to_string()];
    let mut saw_path = false;

    for segment in segments {
        let trimmed = segment.trim();
        if trimmed.is_empty() {
            continue;
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("domain=") {
            continue;
        }

        if lower.starts_with("path=") {
            saw_path = true;
            let raw_path = trimmed[5..].trim();
            if let Some(path_prefix) = proxy_path_prefix {
                let normalized_path = if raw_path.starts_with('/') {
                    format!("{path_prefix}{raw_path}")
                } else {
                    format!("{path_prefix}/{raw_path}")
                };
                rewritten_segments.push(format!("Path={normalized_path}"));
            } else {
                rewritten_segments.push(trimmed.to_string());
            }
            continue;
        }

        rewritten_segments.push(trimmed.to_string());
    }

    if !saw_path {
        if let Some(path_prefix) = proxy_path_prefix {
            rewritten_segments.push(format!("Path={path_prefix}/"));
        }
    }

    HeaderValue::from_str(&rewritten_segments.join("; ")).ok()
}

fn append_vary_header_value(headers: &mut HeaderMap, token: &str) {
    let normalized_token = token.trim();
    if normalized_token.is_empty() {
        return;
    }

    let existing = headers
        .get(VARY)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let has_token = existing
        .split(',')
        .any(|segment| segment.trim().eq_ignore_ascii_case(normalized_token));
    if has_token {
        return;
    }

    let merged = if existing.trim().is_empty() {
        normalized_token.to_string()
    } else {
        format!("{existing}, {normalized_token}")
    };
    if let Ok(value) = HeaderValue::from_str(&merged) {
        headers.insert(VARY, value);
    }
}

fn target_origin_string(target_url: &Url) -> String {
    let default_port = target_url.port_or_known_default();
    let explicit_port = target_url.port();
    if explicit_port.is_some() && explicit_port != default_port {
        format!(
            "{}://{}:{}",
            target_url.scheme(),
            target_url.host_str().unwrap_or("127.0.0.1"),
            explicit_port.unwrap_or_default()
        )
    } else {
        format!(
            "{}://{}",
            target_url.scheme(),
            target_url.host_str().unwrap_or("127.0.0.1")
        )
    }
}

async fn discover_loopback_listening_ports(excluded_ports: &[u16]) -> Vec<u16> {
    let mut ports = HashSet::new();
    let excluded: HashSet<u16> = excluded_ports.iter().copied().collect();

    if let Some(output) = read_command_stdout("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).await {
        collect_ports_from_lsof(&output, &mut ports);
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(contents) = fs::read_to_string("/proc/net/tcp").await {
            collect_ports_from_linux_proc_net(&contents, false, &mut ports);
        }
        if let Ok(contents) = fs::read_to_string("/proc/net/tcp6").await {
            collect_ports_from_linux_proc_net(&contents, true, &mut ports);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(output) = read_command_stdout("netstat", &["-ano", "-p", "tcp"]).await {
            collect_ports_from_netstat(&output, &mut ports);
        }
    }

    let mut result = ports
        .into_iter()
        .filter(|port| !excluded.contains(port))
        .collect::<Vec<_>>();
    result.sort_unstable();
    result.dedup();
    result
}

async fn read_command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn collect_ports_from_lsof(output: &str, ports: &mut HashSet<u16>) {
    for line in output.lines() {
        if !line.contains("(LISTEN)") {
            continue;
        }
        let Some(address) = line
            .split(" TCP ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
        else {
            continue;
        };
        if let Some(port) = parse_listening_socket_port(address) {
            ports.insert(port);
        }
    }
}

#[cfg(target_os = "linux")]
fn collect_ports_from_linux_proc_net(output: &str, is_ipv6: bool, ports: &mut HashSet<u16>) {
    for line in output.lines().skip(1) {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 4 || columns[3] != "0A" {
            continue;
        }
        let Some((address_hex, port_hex)) = columns[1].split_once(':') else {
            continue;
        };
        if !linux_proc_address_is_loopback_or_any(address_hex, is_ipv6) {
            continue;
        }
        if let Ok(port) = u16::from_str_radix(port_hex, 16) {
            ports.insert(port);
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_proc_address_is_loopback_or_any(value: &str, is_ipv6: bool) -> bool {
    if !is_ipv6 {
        return matches!(value, "00000000" | "0100007F");
    }

    matches!(
        value,
        "00000000000000000000000000000000"
            | "00000000000000000000000000000001"
            | "00000000000000000000000001000000"
    )
}

#[cfg(target_os = "windows")]
fn collect_ports_from_netstat(output: &str, ports: &mut HashSet<u16>) {
    for line in output.lines() {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 4 {
            continue;
        }
        if columns[0] != "TCP" || columns[3] != "LISTENING" {
            continue;
        }
        if let Some(port) = parse_listening_socket_port(columns[1]) {
            ports.insert(port);
        }
    }
}

fn parse_listening_socket_port(value: &str) -> Option<u16> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    if let Some(rest) = value.strip_prefix('[') {
        let (host, remainder) = rest.split_once(']')?;
        let port = remainder.strip_prefix(':')?;
        if !is_loopback_listen_host(host) {
            return None;
        }
        return port.parse::<u16>().ok();
    }

    let (host, port) = value.rsplit_once(':')?;
    if !is_loopback_listen_host(host) {
        return None;
    }
    port.parse::<u16>().ok()
}

fn is_loopback_listen_host(host: &str) -> bool {
    matches!(
        host,
        "*" | "127.0.0.1" | "0.0.0.0" | "::1" | "::" | "localhost"
    )
}

async fn is_loopback_http_port_reachable(http: &HttpClient, port: u16) -> bool {
    let request = http
        .get(format!("http://127.0.0.1:{port}/"))
        .header("accept", "text/html,application/json,*/*");
    timeout(BROWSER_PREVIEW_DISCOVERY_HTTP_TIMEOUT, request.send())
        .await
        .map(|result| result.is_ok())
        .unwrap_or(false)
}

fn browser_preview_label_for_port(port: u16) -> String {
    match port {
        3000 => "Local dev server on :3000".to_string(),
        3001 => "Local dev server on :3001".to_string(),
        3002 => "Local dev server on :3002".to_string(),
        3003 => "Local dev server on :3003".to_string(),
        3004 => "Local dev server on :3004".to_string(),
        3005 => "Local dev server on :3005".to_string(),
        4173 => "Vite preview on :4173".to_string(),
        4200 => "Angular dev server on :4200".to_string(),
        4321 => "Metro / Expo web on :4321".to_string(),
        5000 => "Local dev server on :5000".to_string(),
        5173 => "Vite dev server on :5173".to_string(),
        5500 => "Live Server on :5500".to_string(),
        8000 => "Local dev server on :8000".to_string(),
        8080 => "Local dev server on :8080".to_string(),
        8081 => "Metro bundler on :8081".to_string(),
        _ => format!("Local dev server on :{port}"),
    }
}

fn prune_expired_preview_sessions(sessions: &mut HashMap<String, BrowserPreviewSessionEntry>) {
    let cutoff = SystemTime::now()
        .checked_sub(BROWSER_PREVIEW_SESSION_TTL)
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    let Some(cutoff_secs) = cutoff else {
        return;
    };

    sessions.retain(|_, entry| {
        chrono::DateTime::parse_from_rfc3339(&entry.last_accessed_at)
            .map(|value| value.timestamp() >= cutoff_secs)
            .unwrap_or(true)
    });
}

fn evict_excess_preview_sessions(sessions: &mut HashMap<String, BrowserPreviewSessionEntry>) {
    while sessions.len() + 1 > BROWSER_PREVIEW_MAX_SESSIONS {
        let Some(oldest_id) = sessions
            .values()
            .min_by(|left, right| left.last_accessed_at.cmp(&right.last_accessed_at))
            .map(|entry| entry.id.clone())
        else {
            break;
        };
        sessions.remove(&oldest_id);
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
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

fn normalize_connect_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parsed = Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }

    let normalized_path = parsed.path().trim_end_matches('/').to_string();
    let final_path = if normalized_path.is_empty() {
        ""
    } else {
        normalized_path.as_str()
    };
    parsed.set_path(final_path);
    parsed.set_query(None);
    parsed.set_fragment(None);

    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn parse_connect_url_env(name: &str) -> Result<Option<String>, String> {
    let Some(raw) = read_non_empty_env(name) else {
        return Ok(None);
    };

    normalize_connect_url(&raw)
        .ok_or_else(|| format!("{name} must be a valid http:// or https:// base URL"))
        .map(Some)
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

fn parse_enabled_bridge_engines_csv(raw: &str) -> Result<Vec<BridgeRuntimeEngine>, String> {
    let mut parsed = Vec::new();
    let mut seen = HashSet::new();
    for entry in raw.split(',') {
        let normalized = entry.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        let Some(engine) = parse_bridge_runtime_engine(&normalized) else {
            continue;
        };
        if seen.insert(engine) {
            parsed.push(engine);
        }
    }

    if parsed.is_empty() {
        return Err(
            "BRIDGE_ENABLED_ENGINES must include one or more of: codex, opencode".to_string(),
        );
    }

    Ok(parsed)
}

fn parse_enabled_bridge_engines_env() -> Result<Option<Vec<BridgeRuntimeEngine>>, String> {
    let raw = match env::var("BRIDGE_ENABLED_ENGINES") {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };

    Ok(Some(parse_enabled_bridge_engines_csv(&raw)?))
}

fn legacy_default_enabled_engines(
    requested_active_engine: BridgeRuntimeEngine,
) -> Vec<BridgeRuntimeEngine> {
    match requested_active_engine {
        BridgeRuntimeEngine::Codex => {
            vec![BridgeRuntimeEngine::Codex, BridgeRuntimeEngine::Opencode]
        }
        BridgeRuntimeEngine::Opencode => {
            vec![BridgeRuntimeEngine::Opencode, BridgeRuntimeEngine::Codex]
        }
    }
}

impl BridgeRuntimeEngine {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

fn parse_bridge_runtime_engine(value: &str) -> Option<BridgeRuntimeEngine> {
    match value.trim().to_ascii_lowercase().as_str() {
        "codex" => Some(BridgeRuntimeEngine::Codex),
        "opencode" => Some(BridgeRuntimeEngine::Opencode),
        _ => None,
    }
}

fn is_known_engine(value: &str) -> bool {
    matches!(value, "codex" | "opencode")
}

fn decode_engine_qualified_id(value: &str) -> String {
    let trimmed = value.trim();
    match trimmed.split_once(':') {
        Some(("codex", raw)) | Some(("opencode", raw)) if !raw.trim().is_empty() => {
            raw.trim().to_string()
        }
        _ => trimmed.to_string(),
    }
}

fn encode_engine_qualified_id(engine: BridgeRuntimeEngine, value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    match trimmed.split_once(':') {
        Some((prefix, raw)) if is_known_engine(prefix) && !raw.trim().is_empty() => {
            format!("{prefix}:{}", raw.trim())
        }
        _ => format!("{}:{trimmed}", engine.as_str()),
    }
}

fn normalize_forwarded_ids(value: Value) -> Value {
    normalize_forwarded_ids_for_key(None, value)
}

fn normalize_forwarded_params(value: Value) -> Value {
    strip_bridge_routing_fields(normalize_forwarded_ids(value))
}

fn normalize_forwarded_ids_for_key(key: Option<&str>, value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let normalized = object
                .into_iter()
                .map(|(child_key, child_value)| {
                    let normalized_value =
                        normalize_forwarded_ids_for_key(Some(child_key.as_str()), child_value);
                    (child_key, normalized_value)
                })
                .collect();
            Value::Object(normalized)
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|item| normalize_forwarded_ids_for_key(key, item))
                .collect(),
        ),
        Value::String(raw) if key.is_some_and(is_engine_id_field) => {
            Value::String(decode_engine_qualified_id(&raw))
        }
        other => other,
    }
}

fn strip_bridge_routing_fields(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            object.remove("engine");
            Value::Object(object)
        }
        other => other,
    }
}

fn is_engine_id_field(key: &str) -> bool {
    matches!(
        key,
        "threadId"
            | "thread_id"
            | "conversationId"
            | "conversation_id"
            | "parentThreadId"
            | "parent_thread_id"
    )
}

fn normalize_forwarded_notification(
    method: &str,
    params: Value,
    engine: BridgeRuntimeEngine,
) -> Value {
    let normalized = qualify_engine_ids(params, engine);
    if method.starts_with("thread/") {
        return normalize_thread_payload_container(normalized, engine);
    }

    normalized
}

fn normalize_forwarded_result(method: &str, result: Value, engine: BridgeRuntimeEngine) -> Value {
    let normalized = qualify_engine_ids(result, engine);
    match method {
        "thread/list" => normalize_thread_list_result(normalized, engine),
        "thread/loaded/list" => normalize_loaded_thread_ids_result(normalized, engine),
        "thread/read" | "thread/start" | "thread/fork" => {
            normalize_thread_payload_container(normalized, engine)
        }
        _ => normalized,
    }
}

fn qualify_engine_ids(value: Value, engine: BridgeRuntimeEngine) -> Value {
    qualify_engine_ids_for_key(None, value, engine)
}

fn qualify_engine_ids_for_key(
    key: Option<&str>,
    value: Value,
    engine: BridgeRuntimeEngine,
) -> Value {
    match value {
        Value::Object(object) => {
            let normalized = object
                .into_iter()
                .map(|(child_key, child_value)| {
                    let normalized_value =
                        qualify_engine_ids_for_key(Some(child_key.as_str()), child_value, engine);
                    (child_key, normalized_value)
                })
                .collect();
            Value::Object(normalized)
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|item| qualify_engine_ids_for_key(key, item, engine))
                .collect(),
        ),
        Value::String(raw) if key.is_some_and(is_engine_id_field) => {
            Value::String(encode_engine_qualified_id(engine, &raw))
        }
        other => other,
    }
}

fn normalize_thread_list_result(value: Value, engine: BridgeRuntimeEngine) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };

    if let Some(Value::Array(entries)) = object.get_mut("data") {
        for entry in entries.iter_mut() {
            let next_value = match entry {
                Value::String(raw_id) => json!(encode_engine_qualified_id(engine, raw_id)),
                _ => normalize_thread_record(entry.take(), engine),
            };
            *entry = next_value;
        }
    }

    Value::Object(object)
}

fn normalize_loaded_thread_ids_result(value: Value, engine: BridgeRuntimeEngine) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };

    if let Some(Value::Array(entries)) = object.get_mut("data") {
        for entry in entries.iter_mut() {
            if let Some(id) = entry.as_str() {
                *entry = json!(encode_engine_qualified_id(engine, id));
            }
        }
    }

    Value::Object(object)
}

fn is_dual_engine_aggregate_method(method: &str) -> bool {
    matches!(method, "thread/list" | "thread/loaded/list")
}

fn route_engine_from_params(params: Option<&Value>) -> Option<BridgeRuntimeEngine> {
    let params = params?.as_object()?;
    let thread_id = read_string(
        params
            .get("threadId")
            .or_else(|| params.get("thread_id"))
            .or_else(|| params.get("conversationId"))
            .or_else(|| params.get("conversation_id"))
            .or_else(|| params.get("parentThreadId"))
            .or_else(|| params.get("parent_thread_id")),
    );
    if let Some(thread_id) = thread_id {
        if let Some((engine, _)) = parse_engine_qualified_id(&thread_id) {
            return Some(engine);
        }
    }

    params
        .get("engine")
        .and_then(Value::as_str)
        .and_then(parse_bridge_runtime_engine)
}

fn parse_engine_qualified_id(value: &str) -> Option<(BridgeRuntimeEngine, String)> {
    let trimmed = value.trim();
    let (prefix, raw) = trimmed.split_once(':')?;
    let engine = parse_bridge_runtime_engine(prefix)?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    Some((engine, raw.to_string()))
}

fn extract_thread_list_entries(result: &Value) -> Vec<Value> {
    result
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn extract_loaded_thread_ids(result: &Value) -> Vec<String> {
    result
        .get("data")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn merge_thread_list_results(results: Vec<(BridgeRuntimeEngine, Value)>) -> Value {
    let mut entries = Vec::new();

    for (engine, result) in results {
        let normalized = normalize_forwarded_result("thread/list", result, engine);
        entries.extend(extract_thread_list_entries(&normalized));
    }

    entries.sort_by(|left, right| {
        let left_updated = parse_internal_id(left.get("updatedAt")).unwrap_or(0);
        let right_updated = parse_internal_id(right.get("updatedAt")).unwrap_or(0);
        right_updated.cmp(&left_updated).then_with(|| {
            read_string(left.get("id"))
                .unwrap_or_default()
                .cmp(&read_string(right.get("id")).unwrap_or_default())
        })
    });

    json!({ "data": entries })
}

fn merge_loaded_thread_ids_results(results: Vec<(BridgeRuntimeEngine, Value)>) -> Value {
    let mut ids = Vec::new();

    for (engine, result) in results {
        let normalized = normalize_forwarded_result("thread/loaded/list", result, engine);
        ids.extend(extract_loaded_thread_ids(&normalized));
    }

    ids.sort();
    ids.dedup();
    json!({ "data": ids })
}

fn normalize_thread_payload_container(value: Value, engine: BridgeRuntimeEngine) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };

    if let Some(thread_value) = object.remove("thread") {
        object.insert(
            "thread".to_string(),
            normalize_thread_record(thread_value, engine),
        );
        return Value::Object(object);
    }

    if looks_like_thread_record(&object) {
        return normalize_thread_record(Value::Object(object), engine);
    }

    Value::Object(object)
}

fn normalize_thread_record(value: Value, engine: BridgeRuntimeEngine) -> Value {
    let value = qualify_engine_ids(value, engine);
    let Value::Object(mut object) = value else {
        return value;
    };

    if engine == BridgeRuntimeEngine::Codex {
        enrich_thread_record_with_rollout_mcp_media(&mut object);
    }

    if let Some(id) = object.get("id").and_then(Value::as_str) {
        object.insert(
            "id".to_string(),
            json!(encode_engine_qualified_id(engine, id)),
        );
    }
    object.insert("engine".to_string(), json!(engine.as_str()));
    Value::Object(object)
}

fn enrich_thread_record_with_rollout_mcp_media(thread: &mut serde_json::Map<String, Value>) {
    let Some(path) = read_string(thread.get("path")).filter(|value| !value.is_empty()) else {
        return;
    };

    let candidate_ids = collect_thread_mcp_tool_media_candidates(thread);
    if candidate_ids.is_empty() {
        return;
    }

    let enrichments =
        read_rollout_mcp_tool_result_parts_by_call_id(Path::new(&path), &candidate_ids);
    if enrichments.is_empty() {
        return;
    }

    apply_rollout_mcp_tool_result_part_enrichments(thread, &enrichments);
}

fn collect_thread_mcp_tool_media_candidates(
    thread: &serde_json::Map<String, Value>,
) -> HashSet<String> {
    let mut candidates = HashSet::new();
    let Some(turns) = thread.get("turns").and_then(Value::as_array) else {
        return candidates;
    };

    for turn in turns {
        let Some(items) = turn.get("items").and_then(Value::as_array) else {
            continue;
        };

        for item in items {
            let Some(item_object) = item.as_object() else {
                continue;
            };
            if item_object.get("type").and_then(Value::as_str) != Some("mcpToolCall") {
                continue;
            }
            let Some(item_id) =
                read_string(item_object.get("id")).filter(|value| !value.is_empty())
            else {
                continue;
            };
            if thread_mcp_tool_result_has_image(item_object.get("result")) {
                continue;
            }
            candidates.insert(item_id);
        }
    }

    candidates
}

fn thread_mcp_tool_result_has_image(result: Option<&Value>) -> bool {
    rollout_value_contains_image(result, 0)
}

fn rollout_value_contains_image(value: Option<&Value>, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    let Some(value) = value else {
        return false;
    };

    match value {
        Value::Array(entries) => entries
            .iter()
            .any(|entry| rollout_value_contains_image(Some(entry), depth + 1)),
        Value::Object(object) => {
            let entry_type = object
                .get("type")
                .and_then(Value::as_str)
                .map(normalize_rollout_content_type)
                .unwrap_or_default();
            if matches!(entry_type.as_str(), "image" | "inputimage" | "localimage")
                && (object
                    .get("image_url")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .is_some()
                    || object
                        .get("imageUrl")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .is_some()
                    || object
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .is_some()
                    || object
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .is_some()
                    || rollout_image_data_url(object).is_some())
            {
                return true;
            }

            let candidate_keys = [
                "content",
                "contents",
                "items",
                "item",
                "result",
                "results",
                "output",
                "data",
                "structuredContent",
                "structured_content",
                "_meta",
                "meta",
            ];
            candidate_keys.iter().any(|key| {
                object
                    .get(*key)
                    .map(|child| rollout_value_contains_image(Some(child), depth + 1))
                    .unwrap_or(false)
            })
        }
        _ => false,
    }
}

fn read_rollout_mcp_tool_result_parts_by_call_id(
    path: &Path,
    candidate_ids: &HashSet<String>,
) -> HashMap<String, Vec<Value>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return HashMap::new(),
    };
    let reader = std::io::BufReader::new(file);
    let mut enrichments = HashMap::new();
    use std::io::BufRead as _;

    for line in reader.lines() {
        if enrichments.len() >= candidate_ids.len() {
            break;
        }

        let Ok(line) = line else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(record_object) = record.as_object() else {
            continue;
        };
        if read_string(record_object.get("type")).as_deref() != Some("event_msg") {
            continue;
        }

        let Some(payload) = record_object.get("payload").and_then(Value::as_object) else {
            continue;
        };
        if read_string(payload.get("type")).as_deref() != Some("mcp_tool_call_end") {
            continue;
        }

        let Some(call_id) = read_string(payload.get("call_id")).filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !candidate_ids.contains(&call_id) {
            continue;
        }

        let result_parts = payload
            .get("result")
            .and_then(Value::as_object)
            .and_then(|result| result.get("Ok"))
            .and_then(rollout_mcp_tool_result_parts);
        let Some(result_parts) = result_parts.filter(|parts| !parts.is_empty()) else {
            continue;
        };
        enrichments.insert(call_id, result_parts);
    }

    enrichments
}

fn rollout_mcp_tool_result_parts(result: &Value) -> Option<Vec<Value>> {
    let content = result.get("content").and_then(Value::as_array)?;
    let mut parts = Vec::new();

    for entry in content {
        let Some(entry_object) = entry.as_object() else {
            continue;
        };
        match normalize_rollout_content_type(
            entry_object
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .as_str()
        {
            "text" => {
                if let Some(text) =
                    read_string(entry_object.get("text")).filter(|value| !value.is_empty())
                {
                    parts.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            }
            "image" | "inputimage" => {
                if let Some(image_url) = rollout_image_data_url(entry_object) {
                    parts.push(json!({
                        "type": "input_image",
                        "image_url": image_url,
                    }));
                }
            }
            "localimage" => {
                if let Some(path) =
                    read_string(entry_object.get("path")).filter(|value| !value.is_empty())
                {
                    parts.push(json!({
                        "type": "localImage",
                        "path": path,
                    }));
                }
            }
            _ => {}
        }
    }

    Some(parts)
}

fn rollout_image_data_url(entry: &serde_json::Map<String, Value>) -> Option<String> {
    let data = read_string(entry.get("data")).filter(|value| !value.is_empty())?;
    let mime_type = read_string(entry.get("mimeType"))
        .or_else(|| read_string(entry.get("mime_type")))
        .filter(|value| !value.is_empty())?;
    Some(format!("data:{mime_type};base64,{data}"))
}

fn normalize_rollout_content_type(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn apply_rollout_mcp_tool_result_part_enrichments(
    thread: &mut serde_json::Map<String, Value>,
    enrichments: &HashMap<String, Vec<Value>>,
) {
    let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut) else {
        return;
    };

    for turn in turns {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            continue;
        };

        for item in items {
            let Some(item_object) = item.as_object_mut() else {
                continue;
            };
            if item_object.get("type").and_then(Value::as_str) != Some("mcpToolCall") {
                continue;
            }
            let Some(item_id) = read_string(item_object.get("id")) else {
                continue;
            };
            let Some(enrichment_parts) = enrichments.get(&item_id) else {
                continue;
            };

            let result = item_object
                .entry("result".to_string())
                .or_insert_with(|| json!({}));
            let Some(result_object) = result.as_object_mut() else {
                continue;
            };

            let existing_has_content = result_object
                .get("content")
                .and_then(Value::as_array)
                .map(|content| !content.is_empty())
                .unwrap_or(false);
            if !existing_has_content {
                result_object.insert(
                    "content".to_string(),
                    Value::Array(enrichment_parts.clone()),
                );
                continue;
            }
            if thread_mcp_tool_result_has_image(Some(&Value::Object(result_object.clone()))) {
                continue;
            }

            let Some(content) = result_object
                .get_mut("content")
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            content.extend(
                enrichment_parts
                    .iter()
                    .filter(|entry| {
                        entry
                            .get("type")
                            .and_then(Value::as_str)
                            .map(normalize_rollout_content_type)
                            .is_some_and(|entry_type| {
                                matches!(entry_type.as_str(), "image" | "inputimage" | "localimage")
                            })
                    })
                    .cloned(),
            );
        }
    }
}

fn looks_like_thread_record(object: &serde_json::Map<String, Value>) -> bool {
    object.contains_key("id")
        || object.contains_key("turns")
        || object.contains_key("updatedAt")
        || object.contains_key("createdAt")
        || object.contains_key("cwd")
}

fn opencode_part_key(session_id: &str, part_id: &str) -> String {
    format!("{session_id}:{part_id}")
}

fn opencode_status_is_active(status: Option<&str>) -> bool {
    matches!(status, Some("busy" | "retry"))
}

fn opencode_permission_kind(permission: Option<&str>) -> &'static str {
    let normalized = permission.unwrap_or_default().trim().to_ascii_lowercase();
    if normalized.contains("write")
        || normalized.contains("edit")
        || normalized.contains("patch")
        || normalized.contains("delete")
    {
        return "fileChange";
    }

    "commandExecution"
}

fn parse_opencode_model_selector(value: &str) -> Option<(String, String)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (provider_id, model_id) = trimmed
        .split_once('/')
        .or_else(|| trimmed.split_once(':'))
        .or_else(|| trimmed.split_once('|'))?;
    let provider_id = provider_id.trim();
    let model_id = model_id.trim();
    if provider_id.is_empty() || model_id.is_empty() {
        return None;
    }

    Some((provider_id.to_string(), model_id.to_string()))
}

fn opencode_model_description(model: &serde_json::Map<String, Value>) -> Option<String> {
    let mut parts = Vec::new();

    if let Some(family) = read_string(model.get("family")).filter(|value| !value.is_empty()) {
        parts.push(family);
    }

    if let Some(status) =
        read_string(model.get("status")).filter(|value| !value.eq_ignore_ascii_case("active"))
    {
        parts.push(status);
    }

    if let Some(context_limit) = model
        .get("limit")
        .and_then(Value::as_object)
        .and_then(|limit| limit.get("context"))
        .and_then(Value::as_u64)
    {
        parts.push(format!("{context_limit} ctx"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

fn normalize_reasoning_effort_name(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("xhigh"),
        _ => None,
    }
}

fn opencode_variant_effort(
    variant_name: &str,
    variant_value: Option<&serde_json::Map<String, Value>>,
) -> Option<&'static str> {
    if let Some(effort) = variant_value.and_then(|entry| read_string(entry.get("reasoningEffort")))
    {
        if let Some(normalized) = normalize_reasoning_effort_name(&effort) {
            return Some(normalized);
        }
    }

    normalize_reasoning_effort_name(variant_name).or_else(|| {
        variant_value
            .and_then(|entry| entry.get("thinking"))
            .map(|_| "high")
    })
}

fn opencode_variant_description(
    variant_name: &str,
    effort: &str,
    variant_value: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    if variant_name.eq_ignore_ascii_case("max") {
        return Some("Max thinking budget".to_string());
    }

    if let Some(thinking) = variant_value
        .and_then(|entry| entry.get("thinking"))
        .and_then(Value::as_object)
        .and_then(|thinking| thinking.get("budgetTokens"))
        .and_then(Value::as_u64)
    {
        return Some(format!("{thinking} thinking tokens"));
    }

    if variant_name.eq_ignore_ascii_case(effort) {
        return None;
    }

    Some(format!("Uses the {variant_name} variant"))
}

fn opencode_reasoning_effort_options(model: &serde_json::Map<String, Value>) -> Vec<Value> {
    let Some(variants) = model.get("variants").and_then(Value::as_object) else {
        return Vec::new();
    };

    let effort_order = |effort: &str| match effort {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" => 5,
        _ => 99,
    };

    let mut seen = HashSet::new();
    let mut options = variants
        .iter()
        .filter_map(|(variant_name, variant_value)| {
            let variant_object = variant_value.as_object();
            let effort = opencode_variant_effort(variant_name, variant_object)?;
            if !seen.insert(effort) {
                return None;
            }

            Some((
                effort_order(effort),
                json!({
                    "effort": effort,
                    "description": opencode_variant_description(variant_name, effort, variant_object),
                }),
            ))
        })
        .collect::<Vec<_>>();

    options.sort_by_key(|entry| entry.0);
    options.into_iter().map(|(_, value)| value).collect()
}

fn opencode_variant_for_effort(
    configured_providers: &Value,
    provider_id: &str,
    model_id: &str,
    requested_effort: &str,
) -> Option<String> {
    let normalized_effort = normalize_reasoning_effort_name(requested_effort)?;
    let providers = configured_providers
        .get("providers")
        .and_then(Value::as_array)?;

    let variants = providers
        .iter()
        .filter_map(Value::as_object)
        .find(|provider| provider.get("id").and_then(Value::as_str) == Some(provider_id))
        .and_then(|provider| provider.get("models"))
        .and_then(Value::as_object)
        .and_then(|models| models.get(model_id))
        .and_then(Value::as_object)
        .and_then(|model| model.get("variants"))
        .and_then(Value::as_object)?;

    let exact_match = variants.iter().find_map(|(variant_name, variant_value)| {
        let variant_object = variant_value.as_object();
        let effort = opencode_variant_effort(variant_name, variant_object)?;
        if effort == normalized_effort && variant_name.eq_ignore_ascii_case(requested_effort) {
            Some(variant_name.to_string())
        } else {
            None
        }
    });
    if exact_match.is_some() {
        return exact_match;
    }

    variants.iter().find_map(|(variant_name, variant_value)| {
        let variant_object = variant_value.as_object();
        let effort = opencode_variant_effort(variant_name, variant_object)?;
        if effort == normalized_effort {
            Some(variant_name.to_string())
        } else {
            None
        }
    })
}

fn opencode_connected_provider_ids(provider_catalog: Option<&Value>) -> HashSet<String> {
    provider_catalog
        .and_then(Value::as_object)
        .and_then(|catalog| catalog.get("connected"))
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default()
}

fn opencode_default_model_selector(
    configured_providers: &Value,
    provider_catalog: Option<&Value>,
    config: Option<&Value>,
) -> Option<(String, String)> {
    if let Some(configured) = config
        .and_then(Value::as_object)
        .and_then(|config| config.get("model"))
        .and_then(Value::as_str)
        .and_then(parse_opencode_model_selector)
    {
        return Some(configured);
    }

    let providers = configured_providers
        .get("providers")
        .and_then(Value::as_array)?;
    let defaults = configured_providers
        .get("default")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let connected_provider_ids = opencode_connected_provider_ids(provider_catalog);
    let filter_connected = !connected_provider_ids.is_empty();
    let mut fallback: Option<(String, String)> = None;

    for provider in providers.iter().filter_map(Value::as_object) {
        let Some(provider_id) = read_string(provider.get("id")).filter(|value| !value.is_empty())
        else {
            continue;
        };
        if filter_connected && !connected_provider_ids.contains(&provider_id) {
            continue;
        }

        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };

        if fallback.is_none() {
            if let Some(first_model_id) = models.keys().min() {
                fallback = Some((provider_id.clone(), first_model_id.to_string()));
            }
        }

        if let Some(default_model_id) = defaults
            .get(&provider_id)
            .and_then(Value::as_str)
            .filter(|model_id| models.contains_key(*model_id))
        {
            return Some((provider_id, default_model_id.to_string()));
        }
    }

    fallback
}

fn opencode_flatten_model_options(
    configured_providers: &Value,
    provider_catalog: Option<&Value>,
    config: Option<&Value>,
) -> Vec<Value> {
    let Some(configured) = configured_providers.as_object() else {
        return Vec::new();
    };
    let Some(providers) = configured.get("providers").and_then(Value::as_array) else {
        return Vec::new();
    };

    let defaults = configured
        .get("default")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let connected_provider_ids = opencode_connected_provider_ids(provider_catalog);
    let filter_connected = !connected_provider_ids.is_empty();
    let configured_default =
        opencode_default_model_selector(configured_providers, provider_catalog, config);
    let configured_default_key =
        configured_default.map(|(provider_id, model_id)| format!("{provider_id}/{model_id}"));

    let mut flattened = Vec::new();

    for provider in providers {
        let Some(provider_object) = provider.as_object() else {
            continue;
        };
        let Some(provider_id) =
            read_string(provider_object.get("id")).filter(|value| !value.is_empty())
        else {
            continue;
        };
        let connected = !filter_connected || connected_provider_ids.contains(&provider_id);
        if filter_connected && !connected {
            continue;
        }

        let provider_name =
            read_string(provider_object.get("name")).unwrap_or_else(|| provider_id.clone());
        let provider_default = defaults.get(&provider_id).and_then(Value::as_str);
        let Some(models) = provider_object.get("models").and_then(Value::as_object) else {
            continue;
        };

        let mut provider_models = models
            .iter()
            .filter_map(|(model_id, model_value)| {
                let model_object = model_value.as_object()?;
                let display_name = read_string(model_object.get("name"))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| model_id.to_string());
                let full_id = format!("{provider_id}/{model_id}");
                let description = opencode_model_description(model_object);
                let reasoning_efforts = opencode_reasoning_effort_options(model_object);
                let is_default = configured_default_key
                    .as_deref()
                    .map(|default_key| default_key == full_id)
                    .unwrap_or(false);
                let provider_default_rank = provider_default
                    .map(|default_model_id| default_model_id != model_id.as_str())
                    .unwrap_or(true);

                Some((
                    provider_name.to_ascii_lowercase(),
                    provider_default_rank,
                    display_name.to_ascii_lowercase(),
                    json!({
                        "id": full_id,
                        "displayName": display_name,
                        "description": description,
                        "providerId": provider_id.clone(),
                        "providerName": provider_name.clone(),
                        "connected": connected,
                        "authRequired": !connected,
                        "hidden": false,
                        "supportsPersonality": false,
                        "isDefault": is_default,
                        "supportedReasoningEfforts": reasoning_efforts,
                    }),
                ))
            })
            .collect::<Vec<_>>();

        provider_models
            .sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.2.cmp(&right.2)));

        flattened.extend(provider_models.into_iter().map(|(_, _, _, value)| value));
    }

    flattened.sort_by(|left, right| {
        let left_object = left.as_object();
        let right_object = right.as_object();
        let left_provider = left_object
            .and_then(|entry| read_string(entry.get("providerName")))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_provider = right_object
            .and_then(|entry| read_string(entry.get("providerName")))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let left_default =
            !read_bool(left_object.and_then(|entry| entry.get("isDefault"))).unwrap_or(false);
        let right_default =
            !read_bool(right_object.and_then(|entry| entry.get("isDefault"))).unwrap_or(false);
        let left_name = left_object
            .and_then(|entry| read_string(entry.get("displayName")))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_name = right_object
            .and_then(|entry| read_string(entry.get("displayName")))
            .unwrap_or_default()
            .to_ascii_lowercase();

        left_default
            .cmp(&right_default)
            .then_with(|| left_provider.cmp(&right_provider))
            .then_with(|| left_name.cmp(&right_name))
    });

    flattened
}

fn opencode_prompt_parts_from_turn_input(input: &[Value]) -> Vec<Value> {
    let mut parts = Vec::new();

    for item in input {
        let Some(item_object) = item.as_object() else {
            continue;
        };
        let Some(item_type) = read_string(item_object.get("type")) else {
            continue;
        };

        match item_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(item_object.get("text")).filter(|text| !text.is_empty())
                {
                    parts.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            }
            "mention" => {
                if let Some(path) =
                    read_string(item_object.get("path")).filter(|path| !path.is_empty())
                {
                    let filename = Path::new(&path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("file")
                        .to_string();
                    let mime = if Path::new(&path).is_dir() {
                        "application/x-directory"
                    } else {
                        "text/plain"
                    };
                    if let Ok(url) = Url::from_file_path(&path) {
                        parts.push(json!({
                            "type": "file",
                            "url": url.to_string(),
                            "filename": filename,
                            "mime": mime,
                        }));
                    }
                }
            }
            "localImage" => {
                if let Some(path) =
                    read_string(item_object.get("path")).filter(|path| !path.is_empty())
                {
                    let filename = Path::new(&path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("image")
                        .to_string();
                    let mime =
                        infer_image_content_type_from_path(Path::new(&path)).unwrap_or("image/png");
                    if let Ok(url) = Url::from_file_path(&path) {
                        parts.push(json!({
                            "type": "file",
                            "url": url.to_string(),
                            "filename": filename,
                            "mime": mime,
                        }));
                    }
                }
            }
            _ => {}
        }
    }

    parts
}

fn opencode_tool_part_bridge_event(
    part: &serde_json::Map<String, Value>,
) -> Option<(&'static str, Value)> {
    let state = part.get("state")?.as_object()?;
    let status = read_string(state.get("status"))?;
    let status_for_item = opencode_tool_status_for_item(&status);

    let event_method = if status == "pending" || status == "running" {
        "item/started"
    } else {
        "item/completed"
    };

    let item = opencode_tool_part_item(part, status_for_item)?;

    Some((event_method, item))
}

fn opencode_tool_input_command(input: &serde_json::Map<String, Value>) -> Option<String> {
    read_shell_command(input.get("cmd"))
        .or_else(|| read_shell_command(input.get("command")))
        .or_else(|| read_string(input.get("cmd")))
        .or_else(|| read_string(input.get("command")))
}

fn opencode_tool_status_for_item(status: &str) -> &'static str {
    match status {
        "pending" | "running" => "running",
        "error" => "failed",
        _ => "completed",
    }
}

fn opencode_tool_part_item(
    part: &serde_json::Map<String, Value>,
    status_for_item: &str,
) -> Option<Value> {
    let tool_name = read_string(part.get("tool"))?;
    let state = part.get("state")?.as_object()?;
    let input = state.get("input").and_then(Value::as_object);
    let metadata = state.get("metadata").and_then(Value::as_object);
    let item_id = read_string(part.get("id")).unwrap_or_else(generate_opencode_local_id);
    let result = opencode_tool_result_value(state, metadata);
    let error = opencode_tool_error_value(state, metadata);

    if let Some((server, tool)) = parse_rollout_mcp_tool_name(&tool_name) {
        let mut item = json!({
            "id": item_id,
            "type": "mcpToolCall",
            "server": server,
            "tool": tool,
            "status": status_for_item,
        });
        if !result.is_null() {
            item["result"] = result;
        }
        if !error.is_null() {
            item["error"] = error;
        }
        return Some(item);
    }

    if opencode_permission_kind(Some(&tool_name)) == "fileChange" {
        let mut item = json!({
            "id": item_id,
            "type": "fileChange",
            "status": status_for_item,
        });
        if !error.is_null() {
            item["error"] = error;
        }
        return Some(item);
    }

    let command = input
        .and_then(opencode_tool_input_command)
        .unwrap_or(tool_name.clone());
    let mut item = json!({
        "id": item_id,
        "type": "commandExecution",
        "command": command,
        "status": status_for_item,
    });
    if let Some(output) = opencode_tool_output_text(state, metadata) {
        item["aggregatedOutput"] = json!(output);
    }
    if let Some(exit_code) = opencode_tool_exit_code(state, metadata) {
        item["exitCode"] = json!(exit_code);
    }
    if !error.is_null() {
        item["error"] = error;
    }
    Some(item)
}

fn opencode_tool_result_value(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Value {
    state
        .get("output")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            metadata.and_then(|metadata| {
                metadata
                    .get("result")
                    .filter(|value| !value.is_null())
                    .cloned()
            })
        })
        .unwrap_or(Value::Null)
}

fn opencode_tool_error_value(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Value {
    state
        .get("error")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            metadata.and_then(|metadata| {
                metadata
                    .get("error")
                    .filter(|value| !value.is_null())
                    .cloned()
            })
        })
        .unwrap_or(Value::Null)
}

fn opencode_tool_output_text(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    read_string(state.get("output"))
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("output"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("stdout"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("stderr"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn opencode_tool_exit_code(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Option<u64> {
    parse_internal_id(state.get("exitCode"))
        .or_else(|| metadata.and_then(|metadata| parse_internal_id(metadata.get("exitCode"))))
        .or_else(|| metadata.and_then(|metadata| parse_internal_id(metadata.get("exit_code"))))
}

fn opencode_latest_user_message_id(messages: &Value) -> Option<String> {
    messages
        .as_array()?
        .iter()
        .rev()
        .filter_map(Value::as_object)
        .find_map(|message| {
            let info = message.get("info")?.as_object()?;
            let role = read_string(info.get("role"))?;
            if role != "user" {
                return None;
            }
            read_string(info.get("id"))
        })
}

fn opencode_thread_preview_from_messages(messages: &Value) -> Option<String> {
    let messages = messages.as_array()?;
    for message in messages.iter().rev() {
        let Some(message_object) = message.as_object() else {
            continue;
        };
        let text = opencode_assistant_message_text(message_object)
            .or_else(|| opencode_user_message_text(message_object));
        if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
            return Some(to_preview_like(&text));
        }
    }

    None
}

fn opencode_messages_to_turns(
    session_id: &str,
    messages: &Value,
    status: Option<&str>,
    active_turn_id: Option<&str>,
) -> Vec<Value> {
    let mut turns = Vec::new();
    let mut turn_index_by_user_message = HashMap::<String, usize>::new();

    for message in messages.as_array().into_iter().flatten() {
        let Some(message_object) = message.as_object() else {
            continue;
        };
        let Some(info) = message_object.get("info").and_then(Value::as_object) else {
            continue;
        };
        let Some(role) = read_string(info.get("role")) else {
            continue;
        };

        if role == "user" {
            let turn_id =
                read_string(info.get("id")).unwrap_or_else(|| generate_opencode_local_id());
            let user_content = opencode_user_content_items(message_object);
            let mut turn = json!({
                "id": turn_id.clone(),
                "status": "completed",
                "items": [],
            });

            if !user_content.is_empty() {
                turn["items"] = json!([
                    {
                        "type": "userMessage",
                        "id": turn_id.clone(),
                        "content": user_content,
                    }
                ]);
            }

            turn_index_by_user_message.insert(turn_id, turns.len());
            turns.push(turn);
            continue;
        }

        if role != "assistant" {
            continue;
        }

        let Some(parent_id) = read_string(info.get("parentID")) else {
            continue;
        };
        let Some(index) = turn_index_by_user_message.get(&parent_id).copied() else {
            continue;
        };

        let assistant_error = info
            .get("error")
            .and_then(Value::as_object)
            .and_then(|error| read_string(error.get("message")));
        let assistant_items = opencode_assistant_message_items(message_object);
        let has_assistant_items = !assistant_items.is_empty();

        if let Some(items) = turns[index].get_mut("items").and_then(Value::as_array_mut) {
            items.extend(assistant_items);
        }

        if !has_assistant_items {
            if let Some(text) = assistant_error
                .clone()
                .filter(|text| !text.trim().is_empty())
            {
                let item_id =
                    read_string(info.get("id")).unwrap_or_else(|| generate_opencode_local_id());
                if let Some(items) = turns[index].get_mut("items").and_then(Value::as_array_mut) {
                    items.push(json!({
                        "type": "agentMessage",
                        "id": item_id,
                        "text": text,
                    }));
                }
            }
        }

        if let Some(error_message) = assistant_error {
            turns[index]["status"] = json!("failed");
            turns[index]["error"] = json!({
                "message": error_message,
            });
            continue;
        }

        turns[index]["status"] = json!("completed");
    }

    if let Some(last_turn) = turns.last_mut() {
        if opencode_status_is_active(status) {
            last_turn["status"] = json!("in_progress");
            if let Some(active_turn_id) = active_turn_id {
                last_turn["id"] = json!(active_turn_id);
            }
        } else if last_turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
        {
            last_turn["status"] = json!("completed");
        }
    }

    if turns.is_empty() && opencode_status_is_active(status) {
        turns.push(json!({
            "id": active_turn_id.unwrap_or(session_id),
            "status": "in_progress",
            "items": [],
        }));
    }

    turns
}

fn opencode_assistant_message_items(message: &serde_json::Map<String, Value>) -> Vec<Value> {
    let Some(parts) = message.get("parts").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut items = Vec::new();
    for part in parts {
        let Some(part_object) = part.as_object() else {
            continue;
        };
        let Some(part_type) = read_string(part_object.get("type")) else {
            continue;
        };
        let item_id = read_string(part_object.get("id")).unwrap_or_else(generate_opencode_local_id);

        match part_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(part_object.get("text")).filter(|text| !text.trim().is_empty())
                {
                    items.push(json!({
                        "type": "agentMessage",
                        "id": item_id,
                        "text": text,
                    }));
                }
            }
            "reasoning" => {
                if let Some(text) =
                    read_string(part_object.get("text")).filter(|text| !text.trim().is_empty())
                {
                    items.push(json!({
                        "type": "reasoning",
                        "id": item_id,
                        "text": text,
                    }));
                }
            }
            "tool" => {
                if let Some(state) = part_object.get("state").and_then(Value::as_object) {
                    let status =
                        read_string(state.get("status")).unwrap_or_else(|| "completed".to_string());
                    if let Some(item) =
                        opencode_tool_part_item(part_object, opencode_tool_status_for_item(&status))
                    {
                        items.push(item);
                    }
                }
            }
            _ => {}
        }
    }

    items
}

fn opencode_user_content_items(message: &serde_json::Map<String, Value>) -> Vec<Value> {
    let Some(parts) = message.get("parts").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut content = Vec::new();
    for part in parts {
        let Some(part_object) = part.as_object() else {
            continue;
        };
        let Some(part_type) = read_string(part_object.get("type")) else {
            continue;
        };

        match part_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(part_object.get("text")).filter(|text| !text.is_empty())
                {
                    content.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            }
            "file" => {
                let Some(url) = read_string(part_object.get("url")) else {
                    continue;
                };
                let Some(path) = opencode_file_url_to_path(&url) else {
                    continue;
                };
                let mime = read_string(part_object.get("mime")).unwrap_or_default();
                if mime.starts_with("image/") {
                    content.push(json!({
                        "type": "localImage",
                        "path": path,
                    }));
                } else {
                    content.push(json!({
                        "type": "mention",
                        "path": path,
                    }));
                }
            }
            _ => {}
        }
    }

    content
}

fn opencode_user_message_text(message: &serde_json::Map<String, Value>) -> Option<String> {
    let content = opencode_user_content_items(message);
    let mut parts = Vec::new();
    for item in content {
        let Some(item_object) = item.as_object() else {
            continue;
        };
        let item_type = read_string(item_object.get("type")).unwrap_or_default();
        match item_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(item_object.get("text")).filter(|text| !text.is_empty())
                {
                    parts.push(text);
                }
            }
            "mention" => {
                if let Some(path) = read_string(item_object.get("path")) {
                    parts.push(format!("[file: {path}]"));
                }
            }
            "localImage" => {
                if let Some(path) = read_string(item_object.get("path")) {
                    parts.push(format!("[local image: {path}]"));
                }
            }
            _ => {}
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn opencode_assistant_message_text(message: &serde_json::Map<String, Value>) -> Option<String> {
    let parts = message.get("parts").and_then(Value::as_array)?;
    let text_parts = parts
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|part| {
            let part_type = read_string(part.get("type"))?;
            if part_type != "text" {
                return None;
            }
            read_string(part.get("text")).filter(|text| !text.trim().is_empty())
        })
        .collect::<Vec<_>>();
    if !text_parts.is_empty() {
        return Some(text_parts.join("\n"));
    }

    let reasoning = parts
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|part| {
            let part_type = read_string(part.get("type"))?;
            if part_type != "reasoning" {
                return None;
            }
            read_string(part.get("text")).filter(|text| !text.trim().is_empty())
        })
        .collect::<Vec<_>>();
    if reasoning.is_empty() {
        None
    } else {
        Some(reasoning.join("\n"))
    }
}

fn opencode_file_url_to_path(raw: &str) -> Option<String> {
    Url::parse(raw)
        .ok()
        .and_then(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

fn generate_opencode_local_id() -> String {
    format!("opencode-local-{}", Utc::now().timestamp_millis())
}

fn to_preview_like(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.len() <= 180 {
        return collapsed;
    }

    format!("{}...", &collapsed[..177])
}

fn normalize_thread_status_label(value: Option<&Value>) -> Option<String> {
    let raw = read_string(value)?;
    let normalized = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn read_active_turn_id_from_thread(thread: &Value) -> Option<String> {
    let thread_object = thread.as_object()?;
    let turns = thread_object.get("turns")?.as_array()?;
    for turn in turns.iter().rev() {
        let turn_object = turn.as_object()?;
        let status = normalize_thread_status_label(turn_object.get("status"));
        if matches!(
            status.as_deref(),
            Some("inprogress" | "running" | "active" | "queued" | "pending")
        ) {
            if let Some(turn_id) = read_string(turn_object.get("id")) {
                return Some(turn_id);
            }
        }
    }
    None
}

fn thread_has_running_turn(thread: &Value) -> bool {
    let thread_object = match thread.as_object() {
        Some(object) => object,
        None => return false,
    };
    if read_active_turn_id_from_thread(thread).is_some() {
        return true;
    }

    let status = thread_object
        .get("status")
        .and_then(|value| {
            value
                .as_object()
                .and_then(|status| status.get("type"))
                .or(Some(value))
        })
        .and_then(|value| normalize_thread_status_label(Some(value)));
    matches!(
        status.as_deref(),
        Some("running" | "inprogress" | "queued" | "pending")
    )
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
        let normalized_thread = sanitize_path_segment(&decode_engine_qualified_id(thread_id));
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

fn resolve_local_image_path(raw_path: &str) -> Result<PathBuf, &'static str> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Image path is required");
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Image path must be absolute");
    }

    Ok(normalize_path(&path))
}

fn infer_image_content_type_from_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.trim().to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        _ => None,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge_chatgpt_auth_test_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    struct TestBridgeChatGptAuthCacheScope {
        _guard: std::sync::MutexGuard<'static, ()>,
        temp_dir: PathBuf,
    }

    impl TestBridgeChatGptAuthCacheScope {
        fn new() -> Self {
            let guard = bridge_chatgpt_auth_test_lock()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            clear_cached_bridge_chatgpt_auth();

            let nonce = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("valid time")
                .as_nanos();
            let temp_dir = env::temp_dir().join(format!(
                "clawdex-bridge-chatgpt-auth-test-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&temp_dir).expect("create auth cache test dir");
            set_bridge_chatgpt_auth_cache_path_override(Some(
                temp_dir.join(BRIDGE_CHATGPT_AUTH_CACHE_FILE_NAME),
            ));

            Self {
                _guard: guard,
                temp_dir,
            }
        }
    }

    impl Drop for TestBridgeChatGptAuthCacheScope {
        fn drop(&mut self) {
            clear_cached_bridge_chatgpt_auth();
            set_bridge_chatgpt_auth_cache_path_override(None);
            let _ = std::fs::remove_dir_all(&self.temp_dir);
        }
    }

    async fn build_test_bridge(hub: Arc<ClientHub>) -> Arc<AppServerBridge> {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cat process");
        let writer = child.stdin.take().expect("child stdin available");

        Arc::new(AppServerBridge {
            engine: BridgeRuntimeEngine::Codex,
            child: Mutex::new(child),
            child_pid: 0,
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

    async fn build_test_opencode_backend(hub: Arc<ClientHub>) -> Arc<OpencodeBackend> {
        let child = Command::new("cat")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cat process");

        Arc::new(OpencodeBackend {
            child: Mutex::new(child),
            child_pid: 0,
            hub,
            http: HttpClient::builder().build().expect("build reqwest client"),
            base_url: Url::parse("http://127.0.0.1:4090/").expect("valid opencode base url"),
            username: "opencode".to_string(),
            password: Some("secret-token".to_string()),
            fallback_directory: "/tmp/workdir".to_string(),
            session_directories: RwLock::new(HashMap::new()),
            session_statuses: RwLock::new(HashMap::new()),
            active_turns: RwLock::new(HashMap::new()),
            part_kinds: RwLock::new(HashMap::new()),
            interrupted_sessions: RwLock::new(HashSet::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_user_inputs: Mutex::new(HashMap::new()),
        })
    }

    async fn shutdown_test_opencode_backend(backend: &Arc<OpencodeBackend>) {
        let mut child = backend.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    fn test_codex_backend(backend: &Arc<RuntimeBackend>) -> &Arc<AppServerBridge> {
        backend
            .codex
            .as_ref()
            .expect("expected codex backend in test")
    }

    async fn shutdown_test_backend(backend: &Arc<RuntimeBackend>) {
        if let Some(codex) = &backend.codex {
            shutdown_test_bridge(codex).await;
        }
        if let Some(opencode) = &backend.opencode {
            shutdown_test_opencode_backend(opencode).await;
        }
    }

    async fn build_test_runtime_backend(
        hub: Arc<ClientHub>,
        preferred_engine: BridgeRuntimeEngine,
        include_opencode: bool,
    ) -> Arc<RuntimeBackend> {
        let codex = Some(build_test_bridge(hub.clone()).await);
        let opencode = if include_opencode {
            Some(build_test_opencode_backend(hub).await)
        } else {
            None
        };

        Arc::new(RuntimeBackend {
            preferred_engine,
            codex,
            opencode,
        })
    }

    async fn build_test_state() -> Arc<AppState> {
        let workdir = normalize_path(&env::temp_dir());
        let config = Arc::new(BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: workdir.clone(),
            cli_bin: "cat".to_string(),
            opencode_cli_bin: "opencode".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex, BridgeRuntimeEngine::Opencode],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 4090,
            opencode_server_username: "opencode".to_string(),
            opencode_server_password: Some("secret-token".to_string()),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            github_codespaces_auth: None,
            allow_outside_root_cwd: false,
            disable_terminal_exec: true,
            terminal_allowed_commands: HashSet::new(),
            show_pairing_qr: false,
        });

        let hub = Arc::new(ClientHub::new());
        let backend =
            build_test_runtime_backend(hub.clone(), BridgeRuntimeEngine::Codex, true).await;
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
        let updater = Arc::new(UpdateService::discover());
        let preview = Arc::new(BrowserPreviewService::new(
            config.port,
            config.preview_port,
            config.preview_connect_url.clone(),
        ));
        let queue = BridgeQueueService::new(backend.clone(), hub.clone());

        Arc::new(AppState {
            config,
            started_at: Instant::now(),
            hub,
            backend,
            queue,
            terminal,
            git,
            updater,
            preview,
            github_codespaces_auth: None,
        })
    }

    #[test]
    fn parse_preview_bootstrap_params_keeps_viewport_query_fields() {
        let uri: Uri =
            "/index.html?sid=session-1&st=token-1&vp=desktop&vw=1728&vh=1117&foo=bar&baz=qux"
                .parse()
                .expect("valid uri");

        let params = parse_preview_bootstrap_params(&uri);

        assert_eq!(params.session_id.as_deref(), Some("session-1"));
        assert_eq!(params.bootstrap_token.as_deref(), Some("token-1"));
        assert_eq!(
            params.viewport,
            Some(PreviewViewportConfig {
                preset: PreviewViewportPreset::Desktop,
                width: Some(1728),
                height: Some(1117),
            })
        );
        assert_eq!(
            params.sanitized_path_and_query,
            "/index.html?vp=desktop&vw=1728&vh=1117&foo=bar&baz=qux"
        );
    }

    #[test]
    fn build_preview_shell_frame_src_keeps_bootstrap_session_identity() {
        let frame_src = build_preview_shell_frame_src(
            "/index.html?vp=desktop&vw=1728&vh=1117",
            Some("session-1"),
            Some("token-1"),
        );

        assert_eq!(
            frame_src,
            "/index.html?vp=desktop&vw=1728&vh=1117&frame=1&sid=session-1&st=token-1"
        );
    }

    #[test]
    fn build_preview_shell_frame_src_strips_shell_query_before_loading_frame() {
        let frame_src = build_preview_shell_frame_src(
            "/index.html?sid=session-1&st=token-1&vp=desktop&vw=1728&vh=1117&shell=desktop",
            None,
            None,
        );

        assert_eq!(
            frame_src,
            "/index.html?sid=session-1&st=token-1&vp=desktop&vw=1728&vh=1117&frame=1"
        );
    }

    #[tokio::test]
    async fn preview_desktop_shell_response_allows_visible_stage_overflow() {
        let response = preview_desktop_shell_response(
            "/index.html?sid=session-1&st=token-1&vp=desktop&vw=1728&vh=1117",
            PreviewViewportConfig {
                preset: PreviewViewportPreset::Desktop,
                width: Some(1728),
                height: Some(1117),
            },
            Some("session-1"),
            Some("token-1"),
        );

        let body = to_bytes(response.into_body(), BROWSER_PREVIEW_HTTP_BODY_LIMIT_BYTES)
            .await
            .expect("read desktop shell body");
        let body = String::from_utf8(body.to_vec()).expect("desktop shell is utf-8");

        assert!(body.contains("overflow-x: auto;"));
        assert!(body.contains("background: #fff;"));
        assert!(body.contains("id=\"viewport-meta\""));
        assert!(body.contains("function applyInitialFit()"));
        assert!(body.contains("window.addEventListener('resize', queueMeasureFrameHeight"));
        assert!(!body.contains("window.visualViewport.addEventListener('resize'"));
        assert!(!body.contains("shell.style.transform = 'scale(' + scale + ')'"));
    }

    #[test]
    fn resolve_preview_request_target_decodes_proxied_loopback_origin() {
        let target_token = encode_preview_proxy_origin_token("http://127.0.0.1:4000");
        let target = resolve_preview_request_target(
            &Url::parse("http://127.0.0.1:3000/").expect("valid root target"),
            &format!(
                "{}/{}/api/users?limit=5",
                BROWSER_PREVIEW_PROXY_PREFIX, target_token
            ),
        )
        .expect("proxied preview target");

        let expected_prefix = format!("{}/{}", BROWSER_PREVIEW_PROXY_PREFIX, target_token);
        assert_eq!(target.target_url.as_str(), "http://127.0.0.1:4000/");
        assert_eq!(target.path_and_query, "/api/users?limit=5");
        assert_eq!(
            target.proxy_path_prefix.as_deref(),
            Some(expected_prefix.as_str())
        );
    }

    #[test]
    fn rewrite_preview_location_header_keeps_proxy_prefix_for_local_backend_redirects() {
        let location = HeaderValue::from_static("http://127.0.0.1:4000/auth/login?next=%2Fdash");
        let rewritten = rewrite_preview_location_header(
            &location,
            &Url::parse("http://127.0.0.1:4000/").expect("valid upstream request"),
            Some("100.108.165.85:8788"),
            Some("/__clawdex_proxy__/aGVsbG8"),
        )
        .expect("rewritten location");

        assert_eq!(
            rewritten.to_str().expect("header string"),
            "http://100.108.165.85:8788/__clawdex_proxy__/aGVsbG8/auth/login?next=%2Fdash"
        );
    }

    #[test]
    fn rewrite_preview_location_header_rewrites_relative_backend_redirects() {
        let location = HeaderValue::from_static("/auth/login?next=%2Fdash#top");
        let rewritten = rewrite_preview_location_header(
            &location,
            &Url::parse("http://127.0.0.1:4000/api/session").expect("valid upstream request"),
            Some("100.108.165.85:8788"),
            Some("/__clawdex_proxy__/aGVsbG8"),
        )
        .expect("rewritten location");

        assert_eq!(
            rewritten.to_str().expect("header string"),
            "http://100.108.165.85:8788/__clawdex_proxy__/aGVsbG8/auth/login?next=%2Fdash#top"
        );
    }

    #[test]
    fn rewrite_preview_location_header_rewrites_relative_query_only_redirects() {
        let location = HeaderValue::from_static("?tab=2");
        let rewritten = rewrite_preview_location_header(
            &location,
            &Url::parse("http://127.0.0.1:4000/settings/profile").expect("valid upstream request"),
            Some("100.108.165.85:8788"),
            Some("/__clawdex_proxy__/aGVsbG8"),
        )
        .expect("rewritten location");

        assert_eq!(
            rewritten.to_str().expect("header string"),
            "http://100.108.165.85:8788/__clawdex_proxy__/aGVsbG8/settings/profile?tab=2"
        );
    }

    #[test]
    fn rewrite_preview_set_cookie_header_scopes_proxy_backend_cookies() {
        let cookie = HeaderValue::from_static(
            "session=abc123; Path=/; Domain=localhost; HttpOnly; SameSite=Lax",
        );
        let rewritten =
            rewrite_preview_set_cookie_header(&cookie, Some("/__clawdex_proxy__/aGVsbG8"))
                .expect("rewritten cookie");

        assert_eq!(
            rewritten.to_str().expect("cookie string"),
            "session=abc123; Path=/__clawdex_proxy__/aGVsbG8/; HttpOnly; SameSite=Lax"
        );
    }

    #[test]
    fn rewrite_preview_html_document_injects_runtime_script_without_desktop_mode() {
        let document = b"<html><head><title>Preview</title></head><body>Hello</body></html>";
        let rewritten = rewrite_preview_html_document(document, None).expect("rewritten html");
        let rewritten = String::from_utf8(rewritten).expect("utf8 html");

        assert!(rewritten.contains(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH));
        assert!(!rewritten.contains("width=1920"));
    }

    #[test]
    fn rewrite_preview_html_document_rewrites_viewport_in_desktop_mode() {
        let document = b"<html><head><title>Preview</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body>Hello</body></html>";
        let rewritten = rewrite_preview_html_document(
            document,
            Some(PreviewViewportConfig {
                preset: PreviewViewportPreset::Desktop,
                width: Some(1728),
                height: Some(1117),
            }),
        )
        .expect("rewritten html");
        let rewritten = String::from_utf8(rewritten).expect("utf8 html");

        assert!(rewritten.contains(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH));
        assert!(rewritten.contains(
            "<meta name=\"viewport\" content=\"width=1728, height=1117, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes\">"
        ));
        assert_eq!(rewritten.matches("name=\"viewport\"").count(), 1);
    }

    #[test]
    fn inject_preview_viewport_meta_inserts_when_missing() {
        let document = "<html><head><title>Preview</title></head><body>Hello</body></html>";
        let rewritten = inject_preview_viewport_meta(
            document,
            "width=1920, height=1080, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes",
        );

        assert!(rewritten.contains(
            "<meta name=\"viewport\" content=\"width=1920, height=1080, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes\">"
        ));
        assert!(rewritten.contains("<title>Preview</title>"));
    }

    #[test]
    fn build_preview_runtime_script_includes_loopback_proxy_runtime() {
        let script = build_preview_runtime_script();

        assert!(script.contains("LOOPBACK_HOSTS"));
        assert!(script.contains(BROWSER_PREVIEW_PROXY_PREFIX));
        assert!(script.contains("XMLHttpRequest.prototype.open"));
        assert!(script.contains("new Proxy(OriginalEventSource"));
        assert!(script.contains("new Proxy(OriginalWebSocket"));
        assert!(script.contains("Reflect.construct"));
    }

    #[test]
    fn parse_listening_socket_port_accepts_loopback_and_wildcard_addresses() {
        assert_eq!(parse_listening_socket_port("127.0.0.1:3002"), Some(3002));
        assert_eq!(parse_listening_socket_port("0.0.0.0:3003"), Some(3003));
        assert_eq!(parse_listening_socket_port("*:5500"), Some(5500));
        assert_eq!(parse_listening_socket_port("[::1]:8080"), Some(8080));
        assert_eq!(parse_listening_socket_port("[::]:8081"), Some(8081));
    }

    #[test]
    fn browser_preview_label_for_port_covers_added_common_ports() {
        assert_eq!(
            browser_preview_label_for_port(3002),
            "Local dev server on :3002"
        );
        assert_eq!(
            browser_preview_label_for_port(3003),
            "Local dev server on :3003"
        );
        assert_eq!(browser_preview_label_for_port(5500), "Live Server on :5500");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn collect_ports_from_linux_proc_net_reads_loopback_and_wildcard_listeners() {
        let sample = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BBA 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 0 1 0000000000000000 100 0 0 10 0
   1: 00000000:0BBB 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 0 1 0000000000000000 100 0 0 10 0
   2: 0200007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 0 1 0000000000000000 100 0 0 10 0
";
        let mut ports = HashSet::new();

        collect_ports_from_linux_proc_net(sample, false, &mut ports);

        assert!(ports.contains(&3002));
        assert!(ports.contains(&3003));
        assert!(!ports.contains(&5432));
    }

    #[test]
    fn append_vary_header_value_adds_cookie_without_duplication() {
        let mut headers = HeaderMap::new();
        headers.insert(VARY, HeaderValue::from_static("Accept-Encoding"));

        append_vary_header_value(&mut headers, "Cookie");
        append_vary_header_value(&mut headers, "cookie");

        assert_eq!(
            headers
                .get(VARY)
                .and_then(|value| value.to_str().ok())
                .expect("vary header"),
            "Accept-Encoding, Cookie"
        );
    }

    #[test]
    fn decode_engine_qualified_id_strips_known_prefixes() {
        assert_eq!(decode_engine_qualified_id("codex:thr_123"), "thr_123");
        assert_eq!(decode_engine_qualified_id("opencode:ses_456"), "ses_456");
        assert_eq!(
            decode_engine_qualified_id(" custom-prefix:value "),
            "custom-prefix:value"
        );
        assert_eq!(decode_engine_qualified_id("thr_plain"), "thr_plain");
    }

    #[test]
    fn encode_engine_qualified_id_prefixes_raw_values_and_preserves_known_prefixes() {
        assert_eq!(
            encode_engine_qualified_id(BridgeRuntimeEngine::Codex, "thr_123"),
            "codex:thr_123"
        );
        assert_eq!(
            encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, "opencode:ses_456"),
            "opencode:ses_456"
        );
        assert_eq!(
            encode_engine_qualified_id(BridgeRuntimeEngine::Codex, " opencode:ses_789 "),
            "opencode:ses_789"
        );
    }

    #[test]
    fn normalize_forwarded_ids_recursively_decodes_thread_fields() {
        let normalized = normalize_forwarded_ids(json!({
            "threadId": "codex:thr_1",
            "conversationId": "opencode:ses_2",
            "parentThreadId": "codex:thr_parent",
            "nested": {
                "thread_id": "opencode:ses_3",
                "items": [
                    { "threadId": "codex:thr_4" },
                    { "other": "codex:thr_keep" }
                ]
            }
        }));

        assert_eq!(normalized["threadId"], "thr_1");
        assert_eq!(normalized["conversationId"], "ses_2");
        assert_eq!(normalized["parentThreadId"], "thr_parent");
        assert_eq!(normalized["nested"]["thread_id"], "ses_3");
        assert_eq!(normalized["nested"]["items"][0]["threadId"], "thr_4");
        assert_eq!(normalized["nested"]["items"][1]["other"], "codex:thr_keep");
    }

    #[test]
    fn normalize_forwarded_result_qualifies_thread_records_for_mobile() {
        let normalized = normalize_forwarded_result(
            "thread/list",
            json!({
                "data": [
                    {
                        "id": "thr_1",
                        "source": {
                            "parentThreadId": "thr_parent"
                        },
                        "updatedAt": 1700000000
                    }
                ]
            }),
            BridgeRuntimeEngine::Codex,
        );

        assert_eq!(normalized["data"][0]["id"], "codex:thr_1");
        assert_eq!(normalized["data"][0]["engine"], "codex");
        assert_eq!(
            normalized["data"][0]["source"]["parentThreadId"],
            "codex:thr_parent"
        );
    }

    #[test]
    fn normalize_thread_record_enriches_rollout_mcp_tool_images() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let rollout_path = env::temp_dir().join(format!(
            "clawdex-rollout-thread-media-{}-{}.jsonl",
            std::process::id(),
            unique
        ));
        let rollout_line = json!({
            "timestamp": "2026-04-17T17:08:12.099Z",
            "type": "event_msg",
            "payload": {
                "type": "mcp_tool_call_end",
                "call_id": "call_get_app_state",
                "invocation": {
                    "server": "computer-use",
                    "tool": "get_app_state",
                    "arguments": { "app": "Google Chrome" }
                },
                "result": {
                    "Ok": {
                        "content": [
                            {
                                "type": "text",
                                "text": "Computer Use state\nApp=com.google.Chrome"
                            },
                            {
                                "type": "image",
                                "data": "abc123",
                                "mimeType": "image/png"
                            }
                        ]
                    }
                }
            }
        });
        std::fs::write(&rollout_path, format!("{rollout_line}\n")).expect("write rollout");

        let normalized = normalize_thread_record(
            json!({
                "id": "thr_media",
                "path": rollout_path.to_string_lossy().to_string(),
                "cwd": "/tmp",
                "createdAt": 1,
                "updatedAt": 2,
                "turns": [
                    {
                        "items": [
                            {
                                "id": "call_get_app_state",
                                "type": "mcpToolCall",
                                "server": "computer-use",
                                "tool": "get_app_state",
                                "status": "completed",
                                "result": {
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Computer Use state\nApp=com.google.Chrome"
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                ]
            }),
            BridgeRuntimeEngine::Codex,
        );

        let content = normalized["turns"][0]["items"][0]["result"]["content"]
            .as_array()
            .expect("content array");
        assert_eq!(content.len(), 2);
        assert_eq!(content[1]["type"], "input_image");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,abc123");

        let _ = std::fs::remove_file(&rollout_path);
    }

    #[test]
    fn normalize_forwarded_result_qualifies_loaded_thread_ids() {
        let normalized = normalize_forwarded_result(
            "thread/loaded/list",
            json!({
                "data": ["thr_1", "opencode:ses_2"]
            }),
            BridgeRuntimeEngine::Codex,
        );

        assert_eq!(normalized["data"][0], "codex:thr_1");
        assert_eq!(normalized["data"][1], "opencode:ses_2");
    }

    #[test]
    fn merge_thread_list_results_qualifies_and_sorts_across_engines() {
        let merged = merge_thread_list_results(vec![
            (
                BridgeRuntimeEngine::Codex,
                json!({
                    "data": [
                        {
                            "id": "thr_old",
                            "updatedAt": 100,
                        }
                    ]
                }),
            ),
            (
                BridgeRuntimeEngine::Opencode,
                json!({
                    "data": [
                        {
                            "id": "ses_new",
                            "updatedAt": 200,
                        },
                        {
                            "id": "ses_mid",
                            "updatedAt": 150,
                        }
                    ]
                }),
            ),
        ]);

        assert_eq!(merged["data"][0]["id"], "opencode:ses_new");
        assert_eq!(merged["data"][0]["engine"], "opencode");
        assert_eq!(merged["data"][1]["id"], "opencode:ses_mid");
        assert_eq!(merged["data"][2]["id"], "codex:thr_old");
    }

    #[test]
    fn merge_loaded_thread_ids_results_dedups_and_sorts_across_engines() {
        let merged = merge_loaded_thread_ids_results(vec![
            (
                BridgeRuntimeEngine::Codex,
                json!({
                    "data": ["thr_2", "thr_1"]
                }),
            ),
            (
                BridgeRuntimeEngine::Opencode,
                json!({
                    "data": ["ses_9", "opencode:ses_9"]
                }),
            ),
        ]);

        assert_eq!(
            merged["data"],
            json!(["codex:thr_1", "codex:thr_2", "opencode:ses_9"])
        );
    }

    #[test]
    fn route_engine_from_params_prefers_engine_qualified_thread_ids() {
        assert_eq!(
            route_engine_from_params(Some(&json!({ "threadId": "opencode:ses_1" }))),
            Some(BridgeRuntimeEngine::Opencode)
        );
        assert_eq!(
            route_engine_from_params(Some(&json!({ "parentThreadId": "codex:thr_1" }))),
            Some(BridgeRuntimeEngine::Codex)
        );
        assert_eq!(
            route_engine_from_params(Some(&json!({ "threadId": "thr_1" }))),
            None
        );
        assert_eq!(
            route_engine_from_params(Some(&json!({ "engine": "opencode" }))),
            Some(BridgeRuntimeEngine::Opencode)
        );
        assert_eq!(
            route_engine_from_params(Some(&json!({
                "threadId": "codex:thr_1",
                "engine": "opencode"
            }))),
            Some(BridgeRuntimeEngine::Codex)
        );
    }

    #[test]
    fn normalize_forwarded_params_strips_bridge_engine_routing_field() {
        assert_eq!(
            normalize_forwarded_params(json!({
                "engine": "opencode",
                "threadId": "codex:thr_1",
                "includeHidden": false
            })),
            json!({
                "threadId": "thr_1",
                "includeHidden": false
            })
        );
    }

    #[test]
    fn opencode_prompt_parts_mapping_preserves_text_mentions_and_images() {
        let parts = opencode_prompt_parts_from_turn_input(&[
            json!({
                "type": "text",
                "text": "Inspect the repo"
            }),
            json!({
                "type": "mention",
                "path": "/tmp/project/README.md"
            }),
            json!({
                "type": "localImage",
                "path": "/tmp/project/screenshot.png"
            }),
        ]);

        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["text"], "Inspect the repo");
        assert_eq!(parts[1]["type"], "file");
        assert_eq!(parts[1]["mime"], "text/plain");
        assert_eq!(parts[2]["type"], "file");
        assert_eq!(parts[2]["mime"], "image/png");
    }

    #[test]
    fn parse_opencode_model_selector_accepts_provider_model_pairs() {
        assert_eq!(
            parse_opencode_model_selector("openai/gpt-5"),
            Some(("openai".to_string(), "gpt-5".to_string()))
        );
        assert_eq!(
            parse_opencode_model_selector("openai:gpt-5"),
            Some(("openai".to_string(), "gpt-5".to_string()))
        );
        assert_eq!(
            parse_opencode_model_selector("openai|gpt-5"),
            Some(("openai".to_string(), "gpt-5".to_string()))
        );
        assert_eq!(parse_opencode_model_selector("gpt-5"), None);
    }

    #[test]
    fn opencode_flatten_model_options_filters_to_connected_providers_and_marks_defaults() {
        let options = opencode_flatten_model_options(
            &json!({
                "providers": [
                    {
                        "id": "openai",
                        "name": "OpenAI",
                        "models": {
                            "gpt-5": {
                                "name": "GPT-5",
                                "family": "GPT-5",
                                "status": "active",
                                "limit": { "context": 400000 },
                                "variants": {
                                    "none": {
                                        "reasoningEffort": "none"
                                    },
                                    "high": {
                                        "reasoningEffort": "high"
                                    },
                                    "max": {
                                        "thinking": {
                                            "budgetTokens": 32768
                                        }
                                    }
                                }
                            }
                        }
                    },
                    {
                        "id": "anthropic",
                        "name": "Anthropic",
                        "models": {
                            "claude-sonnet-4": {
                                "name": "Claude Sonnet 4",
                                "family": "Claude",
                                "status": "active",
                                "limit": { "context": 200000 }
                            }
                        }
                    }
                ],
                "default": {
                    "openai": "gpt-5",
                    "anthropic": "claude-sonnet-4"
                }
            }),
            Some(&json!({
                "connected": ["openai"]
            })),
            Some(&json!({
                "model": "openai/gpt-5"
            })),
        );

        assert_eq!(options.len(), 1);
        assert_eq!(options[0]["id"], "openai/gpt-5");
        assert_eq!(options[0]["providerId"], "openai");
        assert_eq!(options[0]["providerName"], "OpenAI");
        assert_eq!(options[0]["connected"], true);
        assert_eq!(options[0]["authRequired"], false);
        assert_eq!(options[0]["isDefault"], true);
        assert_eq!(options[0]["description"], "GPT-5 · 400000 ctx");
        assert_eq!(
            options[0]["supportedReasoningEfforts"],
            json!([
                {
                    "effort": "none",
                    "description": null
                },
                {
                    "effort": "high",
                    "description": null
                },
                {
                    "effort": "xhigh",
                    "description": "Max thinking budget"
                }
            ])
        );
    }

    #[test]
    fn opencode_default_model_selector_falls_back_to_provider_default_without_config_model() {
        let selector = opencode_default_model_selector(
            &json!({
                "providers": [
                    {
                        "id": "anthropic",
                        "models": {
                            "claude-sonnet-4": {}
                        }
                    },
                    {
                        "id": "openai",
                        "models": {
                            "gpt-5": {},
                            "gpt-5-mini": {}
                        }
                    }
                ],
                "default": {
                    "openai": "gpt-5-mini"
                }
            }),
            Some(&json!({
                "connected": ["openai"]
            })),
            Some(&json!({})),
        );

        assert_eq!(
            selector,
            Some(("openai".to_string(), "gpt-5-mini".to_string()))
        );
    }

    #[test]
    fn opencode_variant_for_effort_maps_normalized_efforts_to_variants() {
        let variant = opencode_variant_for_effort(
            &json!({
                "providers": [
                    {
                        "id": "openai",
                        "models": {
                            "gpt-5": {
                                "variants": {
                                    "none": {
                                        "reasoningEffort": "none"
                                    },
                                    "medium": {
                                        "reasoningEffort": "medium"
                                    },
                                    "max": {
                                        "thinking": {
                                            "budgetTokens": 16384
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }),
            "openai",
            "gpt-5",
            "xhigh",
        );

        assert_eq!(variant.as_deref(), Some("max"));
    }

    #[test]
    fn opencode_message_projection_builds_turns_for_mobile_contract() {
        let turns = opencode_messages_to_turns(
            "ses_1",
            &json!([
                {
                    "info": {
                        "id": "msg_user_1",
                        "sessionID": "ses_1",
                        "role": "user",
                        "time": { "created": 1000 }
                    },
                    "parts": [
                        {
                            "id": "part_user_text",
                            "sessionID": "ses_1",
                            "messageID": "msg_user_1",
                            "type": "text",
                            "text": "hello"
                        }
                    ]
                },
                {
                    "info": {
                        "id": "msg_assistant_1",
                        "sessionID": "ses_1",
                        "role": "assistant",
                        "parentID": "msg_user_1",
                        "time": { "created": 1001, "completed": 1002 }
                    },
                    "parts": [
                        {
                            "id": "part_assistant_text",
                            "sessionID": "ses_1",
                            "messageID": "msg_assistant_1",
                            "type": "text",
                            "text": "world"
                        }
                    ]
                }
            ]),
            Some("idle"),
            None,
        );

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], "msg_user_1");
        assert_eq!(turns[0]["status"], "completed");
        assert_eq!(turns[0]["items"][0]["type"], "userMessage");
        assert_eq!(turns[0]["items"][1]["type"], "agentMessage");
        assert_eq!(turns[0]["items"][1]["text"], "world");
    }

    #[test]
    fn opencode_message_projection_preserves_reasoning_and_tool_items_in_order() {
        let turns = opencode_messages_to_turns(
            "ses_1",
            &json!([
                {
                    "info": {
                        "id": "msg_user_1",
                        "sessionID": "ses_1",
                        "role": "user",
                        "time": { "created": 1000 }
                    },
                    "parts": [
                        {
                            "id": "part_user_text",
                            "sessionID": "ses_1",
                            "messageID": "msg_user_1",
                            "type": "text",
                            "text": "inspect"
                        }
                    ]
                },
                {
                    "info": {
                        "id": "msg_assistant_1",
                        "sessionID": "ses_1",
                        "role": "assistant",
                        "parentID": "msg_user_1",
                        "time": { "created": 1001, "completed": 1002 }
                    },
                    "parts": [
                        {
                            "id": "part_reasoning",
                            "type": "reasoning",
                            "text": "Checking the workspace first"
                        },
                        {
                            "id": "part_tool",
                            "type": "tool",
                            "tool": "bash",
                            "state": {
                                "status": "completed",
                                "input": {
                                    "command": "pwd"
                                },
                                "output": "/tmp/project\n",
                                "exitCode": 0
                            }
                        },
                        {
                            "id": "part_assistant_text",
                            "type": "text",
                            "text": "Done."
                        }
                    ]
                }
            ]),
            Some("idle"),
            None,
        );

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["items"][1]["type"], "reasoning");
        assert_eq!(turns[0]["items"][1]["text"], "Checking the workspace first");
        assert_eq!(turns[0]["items"][2]["type"], "commandExecution");
        assert_eq!(turns[0]["items"][2]["command"], "pwd");
        assert_eq!(turns[0]["items"][2]["aggregatedOutput"], "/tmp/project\n");
        assert_eq!(turns[0]["items"][2]["exitCode"], 0);
        assert_eq!(turns[0]["items"][3]["type"], "agentMessage");
        assert_eq!(turns[0]["items"][3]["text"], "Done.");
    }

    #[tokio::test]
    async fn bridge_capabilities_reflect_active_engine() {
        let state = build_test_state().await;

        let capabilities = state.bridge_capabilities();
        assert_eq!(capabilities.active_engine, BridgeRuntimeEngine::Codex);
        assert_eq!(
            capabilities.available_engines,
            vec![BridgeRuntimeEngine::Codex, BridgeRuntimeEngine::Opencode]
        );
        assert!(capabilities.unified_chat_list);
        assert!(capabilities.supports.review_start);

        shutdown_test_backend(&state.backend).await;
    }

    #[test]
    fn parse_enabled_bridge_engines_csv_preserves_order_and_removes_duplicates() {
        let parsed =
            parse_enabled_bridge_engines_csv("opencode,codex,opencode").expect("engine csv");
        assert_eq!(
            parsed,
            vec![BridgeRuntimeEngine::Opencode, BridgeRuntimeEngine::Codex]
        );
    }

    #[test]
    fn parse_enabled_bridge_engines_csv_ignores_unknown_entries() {
        let parsed = parse_enabled_bridge_engines_csv("codex,t3code,opencode").expect("engine csv");
        assert_eq!(
            parsed,
            vec![BridgeRuntimeEngine::Codex, BridgeRuntimeEngine::Opencode]
        );
    }

    #[tokio::test]
    async fn bridge_capabilities_reflect_single_engine_state() {
        let hub = Arc::new(ClientHub::new());
        let backend = build_test_runtime_backend(hub, BridgeRuntimeEngine::Codex, false).await;

        let capabilities = backend.capabilities();
        assert_eq!(capabilities.active_engine, BridgeRuntimeEngine::Codex);
        assert_eq!(
            capabilities.available_engines,
            vec![BridgeRuntimeEngine::Codex]
        );
        assert!(!capabilities.unified_chat_list);
        assert!(capabilities.supports.review_start);

        shutdown_test_backend(&backend).await;
    }

    #[tokio::test]
    async fn opencode_review_start_returns_explicit_error() {
        let hub = Arc::new(ClientHub::new());
        let backend = build_test_opencode_backend(hub).await;

        let error = backend
            .dispatch_request("review/start", None)
            .await
            .expect_err("review/start should be gated for opencode");
        assert_eq!(error, "review/start is not supported for opencode threads");

        shutdown_test_opencode_backend(&backend).await;
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
        assert_eq!(reasoning.1["msg"]["thread_id"], "codex:thread-1");

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
    fn rollout_event_msg_mapping_forwards_token_count_events() {
        let token_count = build_rollout_event_msg_notification(
            json!({
                "type": "token_count",
                "info": {
                    "model_context_window": 200000
                }
            })
            .as_object()
            .expect("event payload object"),
            "thread-1",
            None,
        )
        .expect("token count notification");

        assert_eq!(token_count.0, "codex/event/token_count");
        assert_eq!(token_count.1["msg"]["type"], "token_count");
        assert_eq!(token_count.1["msg"]["thread_id"], "codex:thread-1");
        assert_eq!(token_count.1["msg"]["info"]["model_context_window"], 200000);
    }

    #[test]
    fn rollout_event_msg_mapping_ignores_noise_events() {
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
        assert_eq!(running["threadId"], "codex:thread-1");
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

        assert!(build_rollout_thread_status_notification(
            "codex/event/agent_message_delta",
            &params
        )
        .is_none());
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
        assert_eq!(exec_command.1["msg"]["thread_id"], "codex:thread-1");
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
    fn resolve_local_image_path_requires_absolute_paths() {
        assert_eq!(
            resolve_local_image_path("/tmp/../tmp/example.png").unwrap(),
            PathBuf::from("/tmp/example.png")
        );
        assert_eq!(
            resolve_local_image_path("relative/example.png").unwrap_err(),
            "Image path must be absolute"
        );
    }

    #[test]
    fn infer_image_content_type_from_path_supports_common_extensions() {
        assert_eq!(
            infer_image_content_type_from_path(Path::new("/tmp/example.png")),
            Some("image/png")
        );
        assert_eq!(
            infer_image_content_type_from_path(Path::new("/tmp/example.JPG")),
            Some("image/jpeg")
        );
        assert_eq!(
            infer_image_content_type_from_path(Path::new("/tmp/example.txt")),
            None
        );
    }

    #[test]
    fn constant_time_eq_handles_equal_and_different_strings() {
        assert!(constant_time_eq("secret-token", "secret-token"));
        assert!(!constant_time_eq("secret-token", "secret-tok3n"));
        assert!(!constant_time_eq("secret-token", "secret-token-extra"));
    }

    #[test]
    fn build_pairing_payload_includes_url_and_token_for_connectable_host() {
        let config = BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: PathBuf::from("/tmp/workdir"),
            cli_bin: "codex".to_string(),
            opencode_cli_bin: "opencode".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 4090,
            opencode_server_username: "opencode".to_string(),
            opencode_server_password: Some("secret-token".to_string()),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            github_codespaces_auth: None,
            allow_outside_root_cwd: false,
            disable_terminal_exec: false,
            terminal_allowed_commands: HashSet::new(),
            show_pairing_qr: true,
        };

        let payload = build_pairing_payload(&config).expect("pairing payload");
        let parsed: Value = serde_json::from_str(&payload).expect("valid json");

        assert_eq!(parsed["type"], "clawdex-bridge-pair");
        assert_eq!(parsed["bridgeUrl"], "http://127.0.0.1:8787");
        assert_eq!(parsed["bridgeToken"], "secret-token");
    }

    #[test]
    fn build_pairing_payload_uses_token_only_fallback_for_unspecified_bind_host() {
        let config = BridgeConfig {
            host: "0.0.0.0".to_string(),
            port: 8787,
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: PathBuf::from("/tmp/workdir"),
            cli_bin: "codex".to_string(),
            opencode_cli_bin: "opencode".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 4090,
            opencode_server_username: "opencode".to_string(),
            opencode_server_password: Some("secret-token".to_string()),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            github_codespaces_auth: None,
            allow_outside_root_cwd: false,
            disable_terminal_exec: false,
            terminal_allowed_commands: HashSet::new(),
            show_pairing_qr: true,
        };

        assert!(build_pairing_payload(&config).is_none());

        let fallback = build_token_only_pairing_payload(&config).expect("token-only payload");
        let parsed: Value = serde_json::from_str(&fallback).expect("valid json");

        assert_eq!(parsed["type"], "clawdex-bridge-token");
        assert_eq!(parsed["bridgeToken"], "secret-token");
    }

    #[test]
    fn build_pairing_payload_prefers_connect_url_when_configured() {
        let config = BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            preview_port: 8788,
            connect_url: Some("https://octocat-8787.app.github.dev".to_string()),
            preview_connect_url: Some("https://octocat-8788.app.github.dev".to_string()),
            workdir: PathBuf::from("/tmp/workdir"),
            cli_bin: "codex".to_string(),
            opencode_cli_bin: "opencode".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 4090,
            opencode_server_username: "opencode".to_string(),
            opencode_server_password: Some("secret-token".to_string()),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            github_codespaces_auth: None,
            allow_outside_root_cwd: false,
            disable_terminal_exec: false,
            terminal_allowed_commands: HashSet::new(),
            show_pairing_qr: true,
        };

        let payload = build_pairing_payload(&config).expect("pairing payload");
        let parsed: Value = serde_json::from_str(&payload).expect("valid json");

        assert_eq!(parsed["type"], "clawdex-bridge-pair");
        assert_eq!(parsed["bridgeUrl"], "https://octocat-8787.app.github.dev");
        assert_eq!(parsed["bridgeToken"], "secret-token");
    }

    #[test]
    fn bridge_config_authorization_validates_header_and_query_token_paths() {
        let base = BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: PathBuf::from("/tmp/workdir"),
            cli_bin: "codex".to_string(),
            opencode_cli_bin: "opencode".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex, BridgeRuntimeEngine::Opencode],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 4090,
            opencode_server_username: "opencode".to_string(),
            opencode_server_password: Some("secret-token".to_string()),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            allow_query_token_auth: false,
            github_codespaces_auth: None,
            allow_outside_root_cwd: false,
            disable_terminal_exec: false,
            terminal_allowed_commands: HashSet::new(),
            show_pairing_qr: false,
        };

        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            "bearer secret-token".parse().expect("header value"),
        );
        assert!(base.is_authorized_with_bridge_token(&headers, None));
        assert!(!base.is_authorized_with_bridge_token(&HeaderMap::new(), Some("secret-token")));
        assert!(!base.is_authorized_with_bridge_token(&HeaderMap::new(), Some("secret-tok3n")));

        let mut query_allowed = base.clone();
        query_allowed.allow_query_token_auth = true;
        assert!(
            query_allowed.is_authorized_with_bridge_token(&HeaderMap::new(), Some("secret-token"))
        );
        assert!(query_allowed
            .is_authorized_with_bridge_token(&HeaderMap::new(), Some("  secret-token  ")));

        let mut auth_disabled = base;
        auth_disabled.auth_enabled = false;
        auth_disabled.auth_token = None;
        assert!(!auth_disabled.is_authorized_with_bridge_token(&HeaderMap::new(), None));
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
    async fn successful_chatgpt_auth_token_login_populates_bridge_auth_cache() {
        let _auth_cache_scope = TestBridgeChatGptAuthCacheScope::new();
        clear_cached_bridge_chatgpt_auth();

        let hub = Arc::new(ClientHub::new());
        let bridge = build_test_bridge(hub.clone()).await;
        let (client_id, mut rx) = add_test_client(&hub).await;

        bridge
            .forward_request(
                client_id,
                json!("client-req-chatgpt-login"),
                "account/login/start",
                Some(json!({
                    "type": "chatgptAuthTokens",
                    "accessToken": "bridge-cached-token",
                    "chatgptAccountId": "account-123",
                    "chatgptPlanType": "team",
                })),
            )
            .await
            .expect("forward request");

        bridge
            .handle_response(json!({ "id": 1, "result": { "type": "chatgptAuthTokens" } }))
            .await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], "client-req-chatgpt-login");
        assert_eq!(payload["result"]["type"], "chatgptAuthTokens");

        let refresh_auth =
            resolve_bridge_chatgpt_auth_bundle_for_refresh().expect("cached auth bundle");
        assert_eq!(refresh_auth.access_token, "bridge-cached-token");
        assert_eq!(refresh_auth.account_id, "account-123");
        assert_eq!(refresh_auth.plan_type.as_deref(), Some("team"));

        let (url, token, uses_openai_api) =
            resolve_transcription_auth().expect("transcription auth");
        assert_eq!(url, "https://chatgpt.com/backend-api/transcribe");
        assert_eq!(token, "bridge-cached-token");
        assert!(!uses_openai_api);

        clear_cached_bridge_chatgpt_auth();
        shutdown_test_bridge(&bridge).await;
    }

    #[tokio::test]
    async fn successful_account_logout_clears_cached_bridge_chatgpt_auth() {
        let _auth_cache_scope = TestBridgeChatGptAuthCacheScope::new();
        clear_cached_bridge_chatgpt_auth();
        cache_bridge_chatgpt_auth(BridgeChatGptAuthBundle {
            access_token: "cached-before-logout".to_string(),
            account_id: "account-logout".to_string(),
            plan_type: Some("plus".to_string()),
        });

        let hub = Arc::new(ClientHub::new());
        let bridge = build_test_bridge(hub.clone()).await;
        let (client_id, mut rx) = add_test_client(&hub).await;

        bridge
            .forward_request(
                client_id,
                json!("client-req-logout"),
                "account/logout",
                None,
            )
            .await
            .expect("forward request");

        bridge
            .handle_response(json!({ "id": 1, "result": {} }))
            .await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], "client-req-logout");
        assert_eq!(payload["result"], json!({}));
        assert!(read_cached_bridge_chatgpt_auth().is_none());
        assert!(resolve_bridge_chatgpt_auth_bundle_for_refresh().is_none());

        clear_cached_bridge_chatgpt_auth();
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
            engine: BridgeRuntimeEngine::Codex,
            child: Mutex::new(child),
            child_pid: 0,
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

        shutdown_test_backend(&state.backend).await;
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

        shutdown_test_backend(&state.backend).await;
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

        shutdown_test_backend(&state.backend).await;
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

        test_codex_backend(&state.backend)
            .handle_response(json!({
                "id": 1,
                "result": { "threadId": "thr_123" }
            }))
            .await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["id"], "request-1");
        assert_eq!(payload["result"]["threadId"], "codex:thr_123");

        shutdown_test_backend(&state.backend).await;
    }

    #[tokio::test]
    async fn handle_notification_qualifies_thread_ids_for_mobile_clients() {
        let hub = Arc::new(ClientHub::new());
        let bridge = build_test_bridge(hub.clone()).await;
        let (_client_id, mut rx) = add_test_client(&hub).await;

        bridge
            .handle_notification(
                "turn/completed",
                Some(json!({
                    "threadId": "thr_done",
                    "turnId": "turn_done"
                })),
            )
            .await;

        let payload = recv_client_json(&mut rx).await;
        assert_eq!(payload["method"], "turn/completed");
        assert_eq!(payload["params"]["threadId"], "codex:thr_done");

        shutdown_test_bridge(&bridge).await;
    }

    #[tokio::test]
    async fn bridge_queue_send_enqueues_when_thread_is_running() {
        let state = build_test_state().await;
        {
            let mut threads = state.queue.threads.write().await;
            threads.insert(
                "codex:thr_queue".to_string(),
                BridgeThreadQueueRuntime {
                    thread_running: true,
                    active_turn_id: Some("turn_live".to_string()),
                    ..BridgeThreadQueueRuntime::default()
                },
            );
        }

        let result = state
            .queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: "codex:thr_queue".to_string(),
                content: "hello from queue".to_string(),
                turn_start: json!({
                    "threadId": "codex:thr_queue",
                    "input": [
                        {
                            "type": "text",
                            "text": "hello from queue",
                            "text_elements": [],
                        }
                    ],
                    "cwd": Value::Null,
                    "approvalPolicy": Value::Null,
                    "sandboxPolicy": Value::Null,
                    "model": Value::Null,
                    "effort": Value::Null,
                    "serviceTier": Value::Null,
                    "summary": "auto",
                    "personality": Value::Null,
                    "outputSchema": Value::Null,
                    "collaborationMode": Value::Null,
                }),
            })
            .await
            .expect("queue send succeeds");

        assert!(matches!(
            result.disposition,
            BridgeThreadQueueDisposition::Queued
        ));
        assert_eq!(result.queue.thread_id, "codex:thr_queue");
        assert_eq!(result.queue.items.len(), 1);
        assert_eq!(result.queue.items[0].content, "hello from queue");

        shutdown_test_backend(&state.backend).await;
    }

    #[tokio::test]
    async fn bridge_queue_send_assigns_unique_item_ids() {
        let state = build_test_state().await;
        {
            let mut threads = state.queue.threads.write().await;
            threads.insert(
                "codex:thr_queue_ids".to_string(),
                BridgeThreadQueueRuntime {
                    thread_running: true,
                    active_turn_id: Some("turn_live".to_string()),
                    ..BridgeThreadQueueRuntime::default()
                },
            );
        }

        let first = state
            .queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: "codex:thr_queue_ids".to_string(),
                content: "first queued message".to_string(),
                turn_start: json!({
                    "threadId": "codex:thr_queue_ids",
                    "input": [{ "type": "text", "text": "first queued message", "text_elements": [] }],
                    "cwd": Value::Null,
                    "approvalPolicy": Value::Null,
                    "sandboxPolicy": Value::Null,
                    "model": Value::Null,
                    "effort": Value::Null,
                    "serviceTier": Value::Null,
                    "summary": "auto",
                    "personality": Value::Null,
                    "outputSchema": Value::Null,
                    "collaborationMode": Value::Null,
                }),
            })
            .await
            .expect("first queue send succeeds");

        let second = state
            .queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: "codex:thr_queue_ids".to_string(),
                content: "second queued message".to_string(),
                turn_start: json!({
                    "threadId": "codex:thr_queue_ids",
                    "input": [{ "type": "text", "text": "second queued message", "text_elements": [] }],
                    "cwd": Value::Null,
                    "approvalPolicy": Value::Null,
                    "sandboxPolicy": Value::Null,
                    "model": Value::Null,
                    "effort": Value::Null,
                    "serviceTier": Value::Null,
                    "summary": "auto",
                    "personality": Value::Null,
                    "outputSchema": Value::Null,
                    "collaborationMode": Value::Null,
                }),
            })
            .await
            .expect("second queue send succeeds");

        assert_eq!(first.queue.items.len(), 1);
        assert_eq!(second.queue.items.len(), 2);
        assert_ne!(second.queue.items[0].id, second.queue.items[1].id);

        shutdown_test_backend(&state.backend).await;
    }

    #[tokio::test]
    async fn bridge_queue_cancel_removes_existing_item() {
        let state = build_test_state().await;
        {
            let mut threads = state.queue.threads.write().await;
            threads.insert(
                "codex:thr_cancel".to_string(),
                BridgeThreadQueueRuntime {
                    thread_running: true,
                    active_turn_id: Some("turn_live".to_string()),
                    ..BridgeThreadQueueRuntime::default()
                },
            );
        }

        let queued = state
            .queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: "codex:thr_cancel".to_string(),
                content: "cancel me".to_string(),
                turn_start: json!({
                    "threadId": "codex:thr_cancel",
                    "input": [
                        {
                            "type": "text",
                            "text": "cancel me",
                            "text_elements": [],
                        }
                    ],
                    "cwd": Value::Null,
                    "approvalPolicy": Value::Null,
                    "sandboxPolicy": Value::Null,
                    "model": Value::Null,
                    "effort": Value::Null,
                    "serviceTier": Value::Null,
                    "summary": "auto",
                    "personality": Value::Null,
                    "outputSchema": Value::Null,
                    "collaborationMode": Value::Null,
                }),
            })
            .await
            .expect("queue send succeeds");

        let queued_item_id = queued.queue.items[0].id.clone();

        let result = state
            .queue
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "codex:thr_cancel".to_string(),
                item_id: queued_item_id,
            })
            .await
            .expect("queue cancel succeeds");

        assert!(result.ok);
        assert!(result.queue.items.is_empty());

        shutdown_test_backend(&state.backend).await;
    }

    #[test]
    fn github_oauth_scope_header_parsing_is_trimmed_and_lowercased() {
        let scopes = parse_github_oauth_scopes(Some("codespace, repo, Read:User , public_repo"));
        assert_eq!(
            scopes,
            vec![
                "codespace".to_string(),
                "repo".to_string(),
                "read:user".to_string(),
                "public_repo".to_string()
            ]
        );
    }

    #[test]
    fn github_repo_scope_check_accepts_repo_and_public_repo() {
        assert!(github_scopes_allow_repo_access(&["repo".to_string()]));
        assert!(github_scopes_allow_repo_access(
            &["public_repo".to_string()]
        ));
        assert!(!github_scopes_allow_repo_access(&[
            "codespace".to_string(),
            "read:user".to_string()
        ]));
    }

    #[test]
    fn github_git_auth_accepts_github_app_user_tokens_without_scope_headers() {
        assert!(github_token_can_be_used_for_git_auth(&[]));
        assert!(github_token_can_be_used_for_git_auth(&["repo".to_string()]));
        assert!(!github_token_can_be_used_for_git_auth(&[
            "codespace".to_string(),
            "read:user".to_string()
        ]));
    }
}
