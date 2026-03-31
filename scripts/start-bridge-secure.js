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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

function bridgePidFile(rootDir) {
  return path.join(rootDir, ".bridge.pid");
}

function bridgeLogFile(rootDir) {
  return path.join(rootDir, ".bridge.log");
}

function extractLatestPairingQrBlock(logContents) {
  const lines = logContents.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.includes("Bridge pairing QR (scan from mobile onboarding):")) {
      const endIndex = lines.findIndex(
        (entry, offset) =>
          offset > index && entry.includes("QR contains bridge URL + token for one-tap onboarding.")
      );
      if (endIndex !== -1) {
        return lines.slice(index, endIndex + 1).join("\n").trimEnd();
      }
    }

    if (line.includes("Bridge token QR fallback (scan from mobile onboarding):")) {
      const endIndex = lines.findIndex(
        (entry, offset) =>
          offset > index &&
          entry.includes("Full pairing QR unavailable because BRIDGE_HOST=")
      );
      if (endIndex !== -1) {
        return lines.slice(index, endIndex + 1).join("\n").trimEnd();
      }
    }
  }

  return null;
}

function printLatestPairingQr(logPath, startOffset = 0) {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const contents = startOffset > 0 ? raw.slice(startOffset) : raw;
    const qrBlock = extractLatestPairingQrBlock(contents);
    if (!qrBlock) {
      return false;
    }
    console.log("");
    console.log(qrBlock);
    console.log("");
    return true;
  } catch {
    return false;
  }
}

async function waitForLatestPairingQr(logPath, startOffset, timeoutMs = 4000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (printLatestPairingQr(logPath, startOffset)) {
      return true;
    }
    await sleep(250);
  }

  return false;
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

function spawnAndRelay(command, args, options) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  });

  child.on("error", (error) => {
    console.error(`error: failed to start ${command}: ${error.message}`);
    process.exit(1);
  });

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
  const healthUrl = new URL(`http://${formatHostForUrl(host)}:${port}/health`);
  const existingPid = readPidFile(rootDir);

  if (existingPid && isProcessAlive(existingPid)) {
    if (await probeHealth(healthUrl)) {
      console.log(`Bridge already running (pid ${existingPid}).`);
      console.log(`Logs: ${logPath}`);
      console.log(`Bridge is healthy at http://${formatHostForUrl(host)}:${port}`);
      printLatestPairingQr(logPath);
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
  const logStartOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

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
    console.log(`Bridge is healthy at http://${formatHostForUrl(endpoint.host)}:${endpoint.port}`);
    if (!(await waitForLatestPairingQr(logPath, logStartOffset))) {
      console.log("Pairing QR not found in the new bridge startup log. Open logs if you need to inspect startup output.");
    }
  } catch (error) {
    removePidFile(rootDir);
    console.error(`error: ${error.message}. Check logs: ${logPath}`);
    process.exit(1);
  }
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

function resolveLaunch(rootDir, env, { devMode, forceSourceBuild }) {
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
      cwd: rootDir,
      env,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
    };
  }

  const packagedBinary = packagedBinaryPath(rootDir, resolveRuntimeTarget());
  if (!forceSourceBuild && packagedBinary && fs.existsSync(packagedBinary)) {
    ensureExecutable(packagedBinary);
    return {
      command: packagedBinary,
      args: [],
      cwd: rootDir,
      env,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
    };
  }

  const builtBinary = builtBinaryPath(rootDir, os.platform());
  if (isBuiltBinaryFresh(rootDir, builtBinary)) {
    ensureExecutable(builtBinary);
    return {
      command: builtBinary,
      args: [],
      cwd: rootDir,
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

  buildBridgeFromSource(rootDir, env);

  if (!fs.existsSync(builtBinary)) {
    console.error(`error: expected built bridge binary at ${builtBinary}, but it was not created.`);
    process.exit(1);
  }

  ensureExecutable(builtBinary);
  return {
    command: builtBinary,
    args: [],
    cwd: rootDir,
    env,
    healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
  };
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
  const backgroundMode = process.argv.includes("--background");
  const forceSourceBuild = env.CLAWDEX_BRIDGE_FORCE_SOURCE_BUILD === "true";
  const launch = resolveLaunch(rootDir, env, { devMode, forceSourceBuild });

  if (backgroundMode) {
    await spawnDetachedAndWait(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      rootDir,
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
