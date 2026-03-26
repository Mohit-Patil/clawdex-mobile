#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  builtBinaryPath,
  ensureExecutable,
  packagedBinaryPath,
  resolveRuntimeTarget,
} = require("./bridge-binary");

const MANAGED_T3_PID_FILE = ".t3code.pid";

function resolveRootDir() {
  let rootDir = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : path.resolve(__dirname, "..");
  if (!fs.existsSync(path.join(rootDir, "package.json"))) {
    rootDir = path.resolve(__dirname, "..");
  }
  return rootDir;
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

function commandExists(command) {
  if (!command) {
    return false;
  }
  if (command.includes(path.sep) || (process.platform === "win32" && command.includes("/"))) {
    return fs.existsSync(command);
  }
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function parseEnabledEngines(env) {
  const activeEngine = (env.BRIDGE_ACTIVE_ENGINE || "codex").trim().toLowerCase();
  const supported = new Set(["codex", "opencode", "t3code"]);
  const engines = new Set();
  for (const rawEntry of (env.BRIDGE_ENABLED_ENGINES || activeEngine).split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (supported.has(entry)) {
      engines.add(entry);
    }
  }
  if (supported.has(activeEngine)) {
    engines.add(activeEngine);
  }
  if (engines.size === 0) {
    engines.add("codex");
  }
  return engines;
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

function isBuiltBinaryFresh(rootDir, binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    return false;
  }

  const binaryMtime = fs.statSync(binaryPath).mtimeMs;
  const watchPaths = [
    path.join(rootDir, "services", "rust-bridge", "Cargo.toml"),
    path.join(rootDir, "services", "rust-bridge", "Cargo.lock"),
  ];
  const sourceDir = path.join(rootDir, "services", "rust-bridge", "src");

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

function safeUnlink(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePidFile(filePath, pid) {
  if (!pid) {
    return;
  }
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function terminateChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  try {
    child.kill(signal);
  } catch {}
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

function defaultT3Url(env) {
  let host = (env.T3CODE_HOST || "127.0.0.1").trim();
  const port = (env.T3CODE_PORT || "3773").trim() || "3773";
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    host = "127.0.0.1";
  }
  return `http://${formatHostForUrl(host)}:${port}`;
}

function parseT3Url(rawUrl) {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isManageableLocalT3Url(url) {
  return isLoopbackHost(url.hostname) && (url.protocol === "http:" || url.protocol === "ws:");
}

function t3ProbeUrl(url) {
  const probe = new URL(url.toString());
  if (probe.protocol === "ws:") {
    probe.protocol = "http:";
  } else if (probe.protocol === "wss:") {
    probe.protocol = "https:";
  }
  probe.pathname = "/";
  probe.search = "";
  probe.hash = "";
  return probe.toString();
}

async function isHttpUrlReachable(rawUrl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetch(rawUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForUrlReachable(rawUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHttpUrlReachable(rawUrl, 1000)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function stopPidFileProcess(pidFile) {
  if (!fs.existsSync(pidFile)) {
    return;
  }

  const rawPid = fs.readFileSync(pidFile, "utf8").trim();
  const pid = Number.parseInt(rawPid, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    safeUnlink(pidFile);
    return;
  }

  if (!isPidAlive(pid)) {
    safeUnlink(pidFile);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {}

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      safeUnlink(pidFile);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  safeUnlink(pidFile);
}

async function maybeStartManagedT3(rootDir, env, enabledEngines) {
  if (!enabledEngines.has("t3code")) {
    return null;
  }

  env.BRIDGE_T3CODE_URL = env.BRIDGE_T3CODE_URL || defaultT3Url(env);
  const parsedUrl = parseT3Url(env.BRIDGE_T3CODE_URL);
  if (!parsedUrl) {
    console.error(`error: invalid BRIDGE_T3CODE_URL '${env.BRIDGE_T3CODE_URL}'.`);
    process.exit(1);
  }
  if (!isManageableLocalT3Url(parsedUrl)) {
    console.error(`error: managed T3 requires a local loopback BRIDGE_T3CODE_URL, got ${env.BRIDGE_T3CODE_URL}`);
    process.exit(1);
  }

  const pidFile = path.join(rootDir, MANAGED_T3_PID_FILE);
  await stopPidFileProcess(pidFile);

  const probeUrl = t3ProbeUrl(parsedUrl);
  if (await isHttpUrlReachable(probeUrl)) {
    console.error(`error: refusing to attach to an already running T3 server at ${env.BRIDGE_T3CODE_URL}`);
    console.error("Stop the existing T3 server or change T3CODE_PORT before starting Clawdex.");
    process.exit(1);
  }

  const t3Binary = env.T3CODE_CLI_BIN || "t3";
  if (!commandExists(t3Binary)) {
    console.error(`error: T3 Code is enabled but '${t3Binary}' was not found in PATH.`);
    console.error("Install the T3 CLI or remove t3code from the managed runtime list.");
    process.exit(1);
  }

  const host = parsedUrl.hostname === "localhost" ? "127.0.0.1" : parsedUrl.hostname;
  const port = parsedUrl.port || "3773";
  const args = ["--host", host, "--port", port];
  if (env.BRIDGE_T3CODE_AUTH_TOKEN) {
    args.push("--auth-token", env.BRIDGE_T3CODE_AUTH_TOKEN);
  }
  args.push("--no-browser");

  console.log(`Starting managed T3 server on ${host}:${port}`);
  const child = spawn(t3Binary, args, {
    cwd: rootDir,
    env: {
      ...env,
      T3CODE_HOST: host,
      T3CODE_PORT: port,
      T3CODE_AUTH_TOKEN: env.BRIDGE_T3CODE_AUTH_TOKEN || env.T3CODE_AUTH_TOKEN || "",
      T3CODE_NO_BROWSER: env.T3CODE_NO_BROWSER || "true",
    },
    stdio: "inherit",
  });

  writePidFile(pidFile, child.pid);
  child.on("exit", () => {
    safeUnlink(pidFile);
  });

  const startupResult = await Promise.race([
    waitForUrlReachable(probeUrl, 15000).then((reachable) => ({ reachable })),
    new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal, exited: true }));
      child.once("error", (error) => resolve({ error, exited: true }));
    }),
  ]);

  if (startupResult && startupResult.reachable) {
    return { child, pidFile };
  }

  terminateChild(child);
  safeUnlink(pidFile);

  if (startupResult && startupResult.error) {
    console.error(`error: failed to start managed T3 server: ${startupResult.error.message}`);
  } else if (startupResult && startupResult.exited) {
    console.error("error: managed T3 server exited before it became reachable.");
  } else {
    console.error("error: managed T3 server did not become reachable in time.");
  }
  process.exit(1);
}

function spawnAndRelay(command, args, options, runtime = {}) {
  const { sidecars = [], cleanupFiles = [] } = runtime;
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    for (const sidecar of sidecars) {
      terminateChild(sidecar);
    }
    for (const filePath of cleanupFiles) {
      safeUnlink(filePath);
    }
  };

  const forwardSignal = (signal) => {
    terminateChild(child, signal);
    for (const sidecar of sidecars) {
      terminateChild(sidecar, signal);
    }
  };

  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  process.once("SIGHUP", () => forwardSignal("SIGHUP"));
  process.once("exit", cleanup);

  child.on("error", (error) => {
    cleanup();
    console.error(`error: failed to start ${command}: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function buildBridgeFromSource(rootDir, env) {
  const cargoCmd = "cargo";
  const args = ["build", "--release", "--locked"];
  const result = spawnSync(cargoCmd, args, {
    cwd: path.join(rootDir, "services", "rust-bridge"),
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

function resolveBridgeLaunch(rootDir, env, devMode, forceSourceBuild) {
  if (devMode) {
    if (!commandExists("cargo")) {
      console.error("error: missing Rust/Cargo toolchain for dev bridge mode.");
      process.exit(1);
    }
    return {
      command: "cargo",
      args: ["run"],
      cwd: path.join(rootDir, "services", "rust-bridge"),
      env,
    };
  }

  const overrideBinary = env.CLAWDEX_BRIDGE_BINARY ? path.resolve(env.CLAWDEX_BRIDGE_BINARY) : "";
  if (overrideBinary) {
    if (!fs.existsSync(overrideBinary)) {
      console.error(`error: CLAWDEX_BRIDGE_BINARY not found at ${overrideBinary}`);
      process.exit(1);
    }
    ensureExecutable(overrideBinary);
    return { command: overrideBinary, args: [], cwd: rootDir, env };
  }

  const packagedBinary = packagedBinaryPath(rootDir, resolveRuntimeTarget());
  if (!forceSourceBuild && packagedBinary && fs.existsSync(packagedBinary)) {
    ensureExecutable(packagedBinary);
    return { command: packagedBinary, args: [], cwd: rootDir, env };
  }

  const builtBinary = builtBinaryPath(rootDir, os.platform());
  if (isBuiltBinaryFresh(rootDir, builtBinary)) {
    ensureExecutable(builtBinary);
    return { command: builtBinary, args: [], cwd: rootDir, env };
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

  buildBridgeFromSource(rootDir, env);

  if (!fs.existsSync(builtBinary)) {
    console.error(`error: expected built bridge binary at ${builtBinary}, but it was not created.`);
    process.exit(1);
  }

  ensureExecutable(builtBinary);
  return { command: builtBinary, args: [], cwd: rootDir, env };
}

async function start() {
  const rootDir = resolveRootDir();
  const secureEnvFile = path.join(rootDir, ".env.secure");
  if (!fs.existsSync(secureEnvFile)) {
    console.error(`error: ${secureEnvFile} not found. Run: npm run secure:setup`);
    process.exit(1);
  }

  const fileEnv = readEnvFile(secureEnvFile);
  const env = { ...fileEnv, ...process.env };
  const devMode = process.argv.includes("--dev") || env.BRIDGE_RUN_MODE === "dev";
  const forceSourceBuild = env.CLAWDEX_BRIDGE_FORCE_SOURCE_BUILD === "true";
  const enabledEngines = parseEnabledEngines(env);
  if (!enabledEngines.has("t3code")) {
    delete env.BRIDGE_T3CODE_URL;
    delete env.BRIDGE_T3CODE_AUTH_TOKEN;
  }

  const managedT3 = await maybeStartManagedT3(rootDir, env, enabledEngines);
  const bridgeLaunch = resolveBridgeLaunch(rootDir, env, devMode, forceSourceBuild);
  spawnAndRelay(
    bridgeLaunch.command,
    bridgeLaunch.args,
    {
      cwd: bridgeLaunch.cwd,
      env: bridgeLaunch.env,
    },
    {
      sidecars: managedT3 ? [managedT3.child] : [],
      cleanupFiles: managedT3 ? [managedT3.pidFile] : [],
    },
  );
}

start().catch((error) => {
  console.error(`error: failed to start secure bridge: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
