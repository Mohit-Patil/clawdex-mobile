#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const {
  builtBinaryPath,
  ensureExecutable,
  packagedBinaryPath,
  resolveRuntimeTarget,
} = require("./bridge-binary");

const DEFAULT_HEALTH_TIMEOUT_MS = 15000;
const DEV_HEALTH_TIMEOUT_MS = 60000;
let qrcodeTerminal = null;
let qrcodeTerminalLoaded = false;
let qrcodeTerminalLoadError = null;
let pairingQrRenderError = null;

function resolvePackageDir() {
  return path.resolve(__dirname, "..");
}

function resolveWorkspaceDir() {
  const candidates = [
    process.env.CLAWDEX_WORKSPACE_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }
    return path.resolve(candidate);
  }

  return resolvePackageDir();
}

function readEnvFile(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  const nextEnv = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    nextEnv[key] = value;
  }

  return nextEnv;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNonEmptyEnv(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

function buildBridgeUrl(host, port) {
  return `http://${formatHostForUrl(host)}:${port}`;
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function normalizeBaseUrl(rawUrl) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      return "";
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = normalizedPath || "";
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isCodespacesMode(env) {
  const networkMode = readNonEmptyEnv(env, "BRIDGE_NETWORK_MODE").toLowerCase();
  const rawCodespaces = readNonEmptyEnv(env, "CODESPACES").toLowerCase();
  return networkMode === "codespaces" || rawCodespaces === "true";
}

function resolveBridgeBuildProfile(env) {
  const explicitProfile = readNonEmptyEnv(env, "CLAWDEX_BRIDGE_BUILD_PROFILE").toLowerCase();
  if (explicitProfile === "debug" || explicitProfile === "release") {
    return explicitProfile;
  }

  return isCodespacesMode(env) ? "debug" : "release";
}

function isCodespacesAutoPublicEnabled(env) {
  const raw = readNonEmptyEnv(env, "BRIDGE_CODESPACES_AUTO_PUBLIC").toLowerCase();
  return raw ? raw !== "false" : true;
}

function buildCodespacesForwardedUrl(env, port) {
  const codespaceName = readNonEmptyEnv(env, "CODESPACE_NAME");
  const forwardingDomain = readNonEmptyEnv(env, "GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN");
  if (!codespaceName || !forwardingDomain) {
    return "";
  }
  return `https://${codespaceName}-${port}.${forwardingDomain}`;
}

function resolveBridgeAccessUrl(env, endpoint) {
  const configured = normalizeBaseUrl(readNonEmptyEnv(env, "BRIDGE_CONNECT_URL"));
  if (configured) {
    return configured;
  }

  if (isCodespacesMode(env)) {
    const forwarded = normalizeBaseUrl(buildCodespacesForwardedUrl(env, endpoint.port));
    if (forwarded) {
      return forwarded;
    }
  }

  if (isUnspecifiedBindHost(endpoint.host)) {
    return "";
  }

  return buildBridgeUrl(endpoint.host, endpoint.port);
}

function isUnspecifiedBindHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function buildPairingPayload(env, endpoint) {
  const token = readNonEmptyEnv(env, "BRIDGE_AUTH_TOKEN");
  const bridgeUrl = resolveBridgeAccessUrl(env, endpoint);
  if (!token || !bridgeUrl) {
    return null;
  }

  return JSON.stringify({
    type: "clawdex-bridge-pair",
    bridgeUrl,
    bridgeToken: token,
  });
}

function buildTokenOnlyPairingPayload(env) {
  const token = readNonEmptyEnv(env, "BRIDGE_AUTH_TOKEN");
  if (!token) {
    return null;
  }

  return JSON.stringify({
    type: "clawdex-bridge-token",
    bridgeToken: token,
  });
}

function loadQrcodeTerminal() {
  if (qrcodeTerminalLoaded) {
    return qrcodeTerminal;
  }

  qrcodeTerminalLoaded = true;
  try {
    qrcodeTerminal = require("qrcode-terminal");
  } catch (error) {
    qrcodeTerminal = null;
    qrcodeTerminalLoadError = error;
  }

  return qrcodeTerminal;
}

function printPairingQr(env, endpoint) {
  pairingQrRenderError = null;
  const qr = loadQrcodeTerminal();
  if (!qr) {
    return false;
  }

  try {
    const payload = buildPairingPayload(env, endpoint);
    if (payload) {
      console.log("");
      console.log("Bridge pairing QR (scan from mobile onboarding):");
      qr.generate(payload, { small: true });
      console.log("QR contains bridge URL + token for one-tap onboarding.");
      console.log("");
      return true;
    }

    const tokenPayload = buildTokenOnlyPairingPayload(env);
    if (!tokenPayload) {
      return false;
    }

    console.log("");
    console.log("Bridge token QR fallback (scan from mobile onboarding):");
    qr.generate(tokenPayload, { small: true });
    console.log("Full pairing QR unavailable because no phone-connectable bridge URL was resolved. Enter URL manually in onboarding.");
    console.log("");
    return true;
  } catch (error) {
    pairingQrRenderError = error;
    return false;
  }
}

function printPairingQrUnavailableMessage(env) {
  const token = readNonEmptyEnv(env, "BRIDGE_AUTH_TOKEN");
  if (!token) {
    console.log(
      "Pairing QR unavailable because BRIDGE_AUTH_TOKEN is not set. Bridge URL is above for manual onboarding."
    );
    return;
  }

  if (pairingQrRenderError) {
    console.log(
      `Pairing QR unavailable because terminal rendering failed: ${pairingQrRenderError.message}. Bridge URL/token are above for manual onboarding.`
    );
    return;
  }

  if (qrcodeTerminalLoaded && !qrcodeTerminal) {
    const detail =
      qrcodeTerminalLoadError && qrcodeTerminalLoadError.message
        ? ` (${qrcodeTerminalLoadError.message})`
        : "";
    console.log(
      `Pairing QR unavailable because the terminal QR renderer could not be loaded${detail}. Bridge URL/token are above for manual onboarding.`
    );
    return;
  }

  console.log(
    "Pairing QR unavailable due to an unexpected startup condition. Bridge URL/token are above for manual onboarding."
  );
}

function shouldShowPairingQr(env) {
  const raw = readNonEmptyEnv(env, "BRIDGE_SHOW_PAIRING_QR");
  return raw ? raw.toLowerCase() !== "false" : true;
}

function printBridgeAccessDetails(env, endpoint) {
  const bridgeUrl = resolveBridgeAccessUrl(env, endpoint);
  console.log(`Bridge URL: ${bridgeUrl || "not resolved automatically"}`);

  const token = readNonEmptyEnv(env, "BRIDGE_AUTH_TOKEN");
  if (token) {
    console.log(`Bridge token: ${token}`);
  }

  if (!bridgeUrl || bridgeUrl !== buildBridgeUrl(endpoint.host, endpoint.port)) {
    console.log(`Bridge bind: ${buildBridgeUrl(endpoint.host, endpoint.port)}`);
  }

  if (readNonEmptyEnv(env, "BRIDGE_GITHUB_CODESPACES_AUTH").toLowerCase() === "true") {
    console.log("GitHub auth: enabled for Codespaces direct sign-in");
  }

  return bridgeUrl;
}

function ghAuthEnv(env) {
  const githubToken =
    readNonEmptyEnv(process.env, "GH_TOKEN") ||
    readNonEmptyEnv(process.env, "GITHUB_TOKEN") ||
    readNonEmptyEnv(env, "GH_TOKEN") ||
    readNonEmptyEnv(env, "GITHUB_TOKEN");

  if (!githubToken) {
    return { ...process.env, ...env };
  }

  return {
    ...process.env,
    ...env,
    GH_TOKEN: githubToken,
  };
}

function codespaceSelectionArgs(env) {
  const name = readNonEmptyEnv(env, "CODESPACE_NAME");
  return name ? ["-c", name] : [];
}

function formatCodespacesVisibilityCommand(env, ports) {
  const uniquePorts = [...new Set(ports.filter((value) => Number.isFinite(value) && value > 0))];
  const visibilityArgs = uniquePorts.map((port) => `${port}:public`);
  const selectionArgs = codespaceSelectionArgs(env);
  return ["gh", "codespace", "ports", "visibility", ...visibilityArgs, ...selectionArgs].join(" ");
}

function updateCodespacesBrowseUrls(env, ports) {
  if (!commandExists("gh")) {
    return;
  }

  const result = spawnSync(
    "gh",
    ["codespace", "ports", "--json", "sourcePort,browseUrl", ...codespaceSelectionArgs(env)],
    {
      encoding: "utf8",
      env: ghAuthEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if ((result.status ?? 1) !== 0 || !result.stdout) {
    return;
  }

  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return;
  }

  if (!Array.isArray(rows)) {
    return;
  }

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const sourcePort = parsePort(row.sourcePort, 0);
    const browseUrl = normalizeBaseUrl(row.browseUrl);
    if (!sourcePort || !browseUrl || !ports.includes(sourcePort)) {
      continue;
    }

    if (sourcePort === parsePort(env.BRIDGE_PORT, 8787)) {
      env.BRIDGE_CONNECT_URL = browseUrl;
    }
    if (sourcePort === parsePort(env.BRIDGE_PREVIEW_PORT, sourcePort + 1)) {
      env.BRIDGE_PREVIEW_CONNECT_URL = browseUrl;
    }
  }
}

function ensureCodespacesPortsArePublic(env, ports) {
  if (!isCodespacesMode(env) || !isCodespacesAutoPublicEnabled(env)) {
    return [];
  }

  const uniquePorts = [...new Set(ports.filter((value) => Number.isFinite(value) && value > 0))];
  const notes = [];

  if (uniquePorts.length === 0) {
    return notes;
  }

  if (!commandExists("gh")) {
    notes.push(
      `Codespaces mode detected, but GitHub CLI is unavailable. Run '${formatCodespacesVisibilityCommand(
        env,
        uniquePorts
      )}' or mark those forwarded ports public in the Ports panel.`
    );
    return notes;
  }

  const result = spawnSync(
    "gh",
    [
      "codespace",
      "ports",
      "visibility",
      ...uniquePorts.map((port) => `${port}:public`),
      ...codespaceSelectionArgs(env),
    ],
    {
      encoding: "utf8",
      env: ghAuthEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  if ((result.status ?? 1) !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    const suffix = detail ? ` (${detail.split(/\r?\n/, 1)[0]})` : "";
    notes.push(
      `Could not set Codespaces forwarded ports public automatically${suffix}. Run '${formatCodespacesVisibilityCommand(
        env,
        uniquePorts
      )}' or update the Ports panel manually.`
    );
    return notes;
  }

  updateCodespacesBrowseUrls(env, uniquePorts);
  notes.push(
    `Codespaces forwarded ports are set to public for bridge access: ${uniquePorts.join(", ")}.`
  );
  return notes;
}

function bridgePidFile(rootDir) {
  return path.join(rootDir, ".bridge.pid");
}

function bridgeLogFile(rootDir) {
  return path.join(rootDir, ".bridge.log");
}

function readPidFile(rootDir) {
  try {
    const raw = fs.readFileSync(bridgePidFile(rootDir), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(rootDir, pid) {
  fs.writeFileSync(bridgePidFile(rootDir), `${pid}\n`);
}

function removePidFile(rootDir) {
  try {
    fs.unlinkSync(bridgePidFile(rootDir));
  } catch {}
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(env, pid, timeoutMs) {
  const host = env.BRIDGE_HOST || "127.0.0.1";
  const port = env.BRIDGE_PORT || "8787";
  const url = new URL(`http://${formatHostForUrl(host)}:${port}/health`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const ok = await probeHealth(url);

    if (ok) {
      if (!isProcessAlive(pid)) {
        throw new Error("bridge health endpoint responded, but the started process already exited");
      }
      return { host, port };
    }

    if (!isProcessAlive(pid)) {
      throw new Error("bridge process exited before becoming healthy");
    }

    await sleep(500);
  }

  throw new Error("bridge health check did not recover in time");
}

async function probeHealth(url) {
  const client = url.protocol === "https:" ? https : http;
  return await new Promise((resolve) => {
    const req = client.request(
      url,
      { method: "GET", timeout: 3000 },
      (response) => {
        resolve(response.statusCode === 200);
        response.resume();
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function commandExists(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function walkFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function isBuiltBinaryFresh(packageDir, binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    return false;
  }

  const binaryMtime = fs.statSync(binaryPath).mtimeMs;
  const watchPaths = [
    path.join(packageDir, "services", "rust-bridge", "Cargo.toml"),
    path.join(packageDir, "services", "rust-bridge", "Cargo.lock"),
  ];
  const sourceDir = path.join(packageDir, "services", "rust-bridge", "src");

  if (fs.existsSync(sourceDir)) {
    watchPaths.push(...walkFiles(sourceDir));
  }

  return watchPaths.every((watchPath) => {
    if (!fs.existsSync(watchPath)) {
      return true;
    }
    return fs.statSync(watchPath).mtimeMs <= binaryMtime;
  });
}

function printMissingCompilerHint() {
  if (process.platform === "win32") {
    console.error("Install Visual Studio Build Tools (Desktop development with C++) and Rust, then retry.");
    return;
  }
  if (commandExists("apt-get")) {
    console.error("Install on Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y build-essential");
    return;
  }
  if (commandExists("dnf")) {
    console.error("Install on Fedora/RHEL: sudo dnf install -y gcc gcc-c++ make");
    return;
  }
  if (commandExists("yum")) {
    console.error("Install on CentOS/RHEL: sudo yum install -y gcc gcc-c++ make");
    return;
  }
  if (commandExists("apk")) {
    console.error("Install on Alpine: sudo apk add build-base");
    return;
  }
  if (commandExists("xcode-select")) {
    console.error("Install on macOS: xcode-select --install");
  }
}

function spawnAndRelay(command, args, options) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  });

  const env = options?.env ?? process.env;
  const healthTimeoutMs = options?.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  child.on("error", (error) => {
    console.error(`error: failed to start ${command}: ${error.message}`);
    process.exit(1);
  });

  if (child.pid) {
    const bridgePort = parsePort(env.BRIDGE_PORT, 8787);
    const previewPort = parsePort(env.BRIDGE_PREVIEW_PORT, bridgePort + 1);
    void waitForHealth(env, child.pid, healthTimeoutMs)
      .then(() => {
        const notes = ensureCodespacesPortsArePublic(env, [bridgePort, previewPort]);
        for (const note of notes) {
          console.log(note);
        }
      })
      .catch(() => {});
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function spawnDetachedAndWait(command, args, options) {
  const { cwd, env, rootDir, healthTimeoutMs } = options;
  const logPath = bridgeLogFile(rootDir);
  const host = env.BRIDGE_HOST || "127.0.0.1";
  const port = env.BRIDGE_PORT || "8787";
  const previewPort = parsePort(env.BRIDGE_PREVIEW_PORT, parsePort(port, 8787) + 1);
  const healthUrl = new URL(`http://${formatHostForUrl(host)}:${port}/health`);
  const existingPid = readPidFile(rootDir);

  if (existingPid && isProcessAlive(existingPid)) {
    if (await probeHealth(healthUrl)) {
      console.log(`Bridge already running (pid ${existingPid}).`);
      console.log(`Logs: ${logPath}`);
      console.log("Bridge is healthy.");
      const endpoint = { host, port };
      const notes = ensureCodespacesPortsArePublic(env, [parsePort(port, 8787), previewPort]);
      printBridgeAccessDetails(env, endpoint);
      for (const note of notes) {
        console.log(note);
      }
      if (shouldShowPairingQr(env) && !printPairingQr(env, endpoint)) {
        printPairingQrUnavailableMessage(env);
      }
      return;
    }
  } else if (existingPid) {
    removePidFile(rootDir);
  }

  if (await probeHealth(healthUrl)) {
    console.error(
      `error: another bridge is already responding at http://${formatHostForUrl(host)}:${port}. Stop it first with 'clawdex stop'.`
    );
    process.exit(1);
  }

  const output = fs.openSync(logPath, "a");
  const error = fs.openSync(logPath, "a");

  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", output, error],
  });

  child.on("error", (spawnError) => {
    console.error(`error: failed to start ${command}: ${spawnError.message}`);
    removePidFile(rootDir);
    process.exit(1);
  });

  if (!child.pid) {
    console.error(`error: failed to determine pid for ${command}`);
    process.exit(1);
  }

  writePidFile(rootDir, child.pid);
  child.unref();

  console.log(`Bridge starting in background (pid ${child.pid}).`);
  console.log(`Logs: ${logPath}`);

  try {
    const endpoint = await waitForHealth(env, child.pid, healthTimeoutMs);
    console.log("Bridge is healthy.");
    const notes = ensureCodespacesPortsArePublic(env, [parsePort(endpoint.port, 8787), previewPort]);
    printBridgeAccessDetails(env, endpoint);
    for (const note of notes) {
      console.log(note);
    }

    if (shouldShowPairingQr(env) && !printPairingQr(env, endpoint)) {
      printPairingQrUnavailableMessage(env);
    }
  } catch (error) {
    removePidFile(rootDir);
    console.error(`error: ${error.message}. Check logs: ${logPath}`);
    process.exit(1);
  }
}

function buildBridgeFromSource(packageDir, env, profile) {
  const cargoCmd = "cargo";
  const args = ["build", "--locked"];
  if (profile === "release") {
    args.push("--release");
  }
  const result = spawnSync(cargoCmd, args, {
    cwd: path.join(packageDir, "services", "rust-bridge"),
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`error: failed to run cargo build: ${result.error.message}`);
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function resolveLaunch(workspaceDir, packageDir, env, { devMode, forceSourceBuild }) {
  if (devMode) {
    if (!commandExists("cargo")) {
      console.error("error: missing Rust/Cargo toolchain for dev bridge mode.");
      process.exit(1);
    }

    return {
      command: "cargo",
      args: ["run"],
      cwd: path.join(packageDir, "services", "rust-bridge"),
      env,
      healthTimeoutMs: DEV_HEALTH_TIMEOUT_MS,
    };
  }

  const overrideBinary = env.CLAWDEX_BRIDGE_BINARY ? path.resolve(env.CLAWDEX_BRIDGE_BINARY) : "";
  if (overrideBinary) {
    if (!fs.existsSync(overrideBinary)) {
      console.error(`error: CLAWDEX_BRIDGE_BINARY not found at ${overrideBinary}`);
      process.exit(1);
    }
    ensureExecutable(overrideBinary);
    return {
      command: overrideBinary,
      args: [],
      cwd: workspaceDir,
      env,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
    };
  }

  const buildProfile = resolveBridgeBuildProfile(env);
  const packagedBinary = packagedBinaryPath(packageDir, resolveRuntimeTarget());
  if (!forceSourceBuild && packagedBinary && fs.existsSync(packagedBinary)) {
    ensureExecutable(packagedBinary);
    return {
      command: packagedBinary,
      args: [],
      cwd: workspaceDir,
      env,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
    };
  }

  const builtBinary = builtBinaryPath(packageDir, os.platform(), buildProfile);
  if (isBuiltBinaryFresh(packageDir, builtBinary)) {
    ensureExecutable(builtBinary);
    return {
      command: builtBinary,
      args: [],
      cwd: workspaceDir,
      env,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
    };
  }

  if (!commandExists("cargo")) {
    console.error("error: no packaged bridge binary was found for this host, and cargo is not installed.");
    console.error("Reinstall a published clawdex-mobile package with bundled bridge binaries, or install Rust and retry.");
    process.exit(1);
  }

  if (process.platform !== "win32" && !commandExists("cc")) {
    console.error("error: missing system C compiler/linker ('cc'). Rust bridge cannot compile without it.");
    printMissingCompilerHint();
    process.exit(1);
  }

  buildBridgeFromSource(packageDir, env, buildProfile);

  if (!fs.existsSync(builtBinary)) {
    console.error(`error: expected built bridge binary at ${builtBinary}, but it was not created.`);
    process.exit(1);
  }

  ensureExecutable(builtBinary);
  return {
    command: builtBinary,
    args: [],
    cwd: workspaceDir,
    env,
    healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
  };
}

async function start() {
  const workspaceDir = resolveWorkspaceDir();
  const packageDir = resolvePackageDir();
  const secureEnvFile = path.join(workspaceDir, ".env.secure");
  if (!fs.existsSync(secureEnvFile)) {
    console.error(`error: ${secureEnvFile} not found. Run: npm run secure:setup`);
    process.exit(1);
  }

  const fileEnv = readEnvFile(secureEnvFile);
  const env = {
    ...fileEnv,
    ...process.env,
    CLAWDEX_WORKSPACE_ROOT: workspaceDir,
    INIT_CWD: process.env.INIT_CWD || workspaceDir,
  };
  const devMode = process.argv.includes("--dev") || env.BRIDGE_RUN_MODE === "dev";
  if (devMode) {
    env.BRIDGE_RUN_MODE = "dev";
  }
  const backgroundMode = process.argv.includes("--background");
  const prepareOnly = process.argv.includes("--prepare-only");
  const forceSourceBuild = env.CLAWDEX_BRIDGE_FORCE_SOURCE_BUILD === "true";
  const launch = resolveLaunch(workspaceDir, packageDir, env, { devMode, forceSourceBuild });

  if (prepareOnly) {
    console.log(`Bridge binary ready: ${launch.command}`);
    return;
  }

  if (backgroundMode) {
    await spawnDetachedAndWait(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      rootDir: workspaceDir,
      healthTimeoutMs: launch.healthTimeoutMs,
    });
    return;
  }

  spawnAndRelay(launch.command, launch.args, { cwd: launch.cwd, env: launch.env });
}

start().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
