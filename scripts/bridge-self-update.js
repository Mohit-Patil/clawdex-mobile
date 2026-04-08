#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

function parseArgs(argv) {
  const parsed = {
    action: "update",
    jobId: "",
    bridgePid: 0,
    version: "latest",
    statusPath: "",
    logPath: "",
    startedAt: new Date().toISOString(),
  };

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || typeof value !== "string") {
      throw new Error("invalid updater arguments");
    }

    switch (flag) {
      case "--action":
        parsed.action = value;
        break;
      case "--job-id":
        parsed.jobId = value;
        break;
      case "--bridge-pid":
        parsed.bridgePid = Number.parseInt(value, 10);
        break;
      case "--version":
        parsed.version = value;
        break;
      case "--status-path":
        parsed.statusPath = value;
        break;
      case "--log-path":
        parsed.logPath = value;
        break;
      case "--started-at":
        parsed.startedAt = value;
        break;
      default:
        throw new Error(`unknown updater flag: ${flag}`);
    }
  }

  if (!parsed.jobId || !parsed.bridgePid || !parsed.statusPath) {
    throw new Error("missing updater arguments");
  }

  if (parsed.action !== "update" && parsed.action !== "restart") {
    throw new Error(`unsupported bridge maintenance action: ${parsed.action}`);
  }

  return parsed;
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

function writeStatus(statusPath, payload) {
  const nextPayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(nextPayload, null, 2)}\n`);
}

function readNonEmptyEnv(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

function backupSecureEnv(packageRoot, jobId) {
  const secureEnvPath = path.join(packageRoot, ".env.secure");
  if (!fs.existsSync(secureEnvPath)) {
    return null;
  }

  const backupPath = path.join(os.tmpdir(), `${jobId}.env.secure.backup`);
  fs.copyFileSync(secureEnvPath, backupPath);
  return {
    originalPath: secureEnvPath,
    backupPath,
  };
}

function restoreSecureEnv(backup) {
  if (!backup || !fs.existsSync(backup.backupPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(backup.originalPath), { recursive: true });
  fs.copyFileSync(backup.backupPath, backup.originalPath);
}

function cleanupSecureEnvBackup(backup) {
  if (!backup) {
    return;
  }

  try {
    fs.unlinkSync(backup.backupPath);
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function nodeCommand() {
  return process.execPath || (process.platform === "win32" ? "node.exe" : "node");
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? -1}`));
    });
  });
}

function killBridgeProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillBridgeProcess(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    if (result.error && result.error.code !== "ENOENT") {
      throw result.error;
    }
    return;
  }

  process.kill(pid, "SIGKILL");
}

function listMatchingPids(pattern) {
  const result = spawnSync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        command: match[2],
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.pid) && pattern.test(entry.command))
    .map((entry) => entry.pid);
}

function isOpencodeEnabled(env) {
  const activeEngine = readNonEmptyEnv(env, "BRIDGE_ACTIVE_ENGINE");
  const enabledEngines = readNonEmptyEnv(env, "BRIDGE_ENABLED_ENGINES");
  return [activeEngine, enabledEngines].some((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .includes("opencode")
  );
}

function buildOpencodeServePattern(port) {
  const normalizedPort = String(port).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bopencode(?:\\.cmd|\\.exe)?\\b.*\\bserve\\b.*--port\\s+${normalizedPort}\\b`);
}

async function stopLingeringOpencodeServer(packageRoot) {
  const secureEnvPath = path.join(packageRoot, ".env.secure");
  if (!fs.existsSync(secureEnvPath)) {
    return;
  }

  const secureEnv = readEnvFile(secureEnvPath);
  if (!isOpencodeEnabled(secureEnv)) {
    return;
  }

  const opencodePort = readNonEmptyEnv(secureEnv, "BRIDGE_OPENCODE_PORT") || "4090";
  const pids = listMatchingPids(buildOpencodeServePattern(opencodePort));
  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stillRunning = pids.filter((pid) => isProcessAlive(pid));
    if (stillRunning.length === 0) {
      return;
    }
    await sleep(250);
  }

  for (const pid of pids) {
    if (!isProcessAlive(pid)) {
      continue;
    }
    try {
      forceKillBridgeProcess(pid);
    } catch {}
  }
}

async function waitForBridgeExit(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(250);
  }

  try {
    forceKillBridgeProcess(pid);
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(250);
  }

  throw new Error("bridge process did not exit in time");
}

function startBridge(packageRoot, logPath) {
  const bridgeLogPath = path.join(packageRoot, ".bridge.log");
  const output = fs.openSync(bridgeLogPath, "a");
  const error = fs.openSync(bridgeLogPath, "a");
  const child = spawn(
    nodeCommand(),
    [path.join(packageRoot, "scripts", "start-bridge-secure.js")],
    {
      cwd: packageRoot,
      env: process.env,
      detached: true,
      stdio: ["ignore", output, error],
    }
  );
  child.unref();
  if (logPath) {
    console.log(`Bridge restart command launched. Logs: ${bridgeLogPath}`);
  }
}

async function waitForHealth(envFilePath, timeoutMs) {
  const secureEnv = readEnvFile(envFilePath);
  const host = secureEnv.BRIDGE_HOST || "127.0.0.1";
  const port = secureEnv.BRIDGE_PORT || "8787";
  const url = new URL(`http://${formatHostForUrl(host)}:${port}/health`);
  const client = url.protocol === "https:" ? https : http;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
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

    if (ok) {
      return;
    }

    await sleep(750);
  }

  throw new Error("bridge health check did not recover in time");
}

async function restartBridge(packageRoot, statusPath, payload, message) {
  await stopLingeringOpencodeServer(packageRoot);
  writeStatus(statusPath, {
    ...payload,
    state: "starting",
    message,
  });
  startBridge(packageRoot, payload.logPath);
  writeStatus(statusPath, {
    ...payload,
    state: "waitingForHealth",
    message: "Waiting for bridge health to recover.",
  });
  await waitForHealth(path.join(packageRoot, ".env.secure"), 45_000);
}

async function stopCurrentBridge(statusPath, payload, bridgePid) {
  writeStatus(statusPath, {
    ...payload,
    state: "stopping",
    message: "Stopping the current bridge process.",
  });
  killBridgeProcess(bridgePid);
  await waitForBridgeExit(bridgePid);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageRoot = path.resolve(__dirname, "..");
  const secureEnvBackup = backupSecureEnv(packageRoot, args.jobId);
  const baseStatus = {
    jobId: args.jobId,
    targetVersion: args.action === "restart" ? args.version || "current" : args.version,
    startedAt: args.startedAt,
    logPath: args.logPath || null,
  };

  writeStatus(args.statusPath, {
    ...baseStatus,
    state: "scheduled",
    message:
      args.action === "restart"
        ? "Bridge restart scheduled."
        : `Bridge update scheduled for ${args.version}.`,
  });
  try {
    await sleep(800);
    await stopCurrentBridge(args.statusPath, baseStatus, args.bridgePid);

    if (args.action === "restart") {
      try {
        await restartBridge(
          packageRoot,
          args.statusPath,
          baseStatus,
          "Starting the bridge process."
        );
        writeStatus(args.statusPath, {
          ...baseStatus,
          state: "completed",
          message: "Bridge restarted successfully.",
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        writeStatus(args.statusPath, {
          ...baseStatus,
          state: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Bridge restart failed and the bridge did not recover automatically.",
          completedAt: new Date().toISOString(),
        });
        process.exitCode = 1;
      }
      return;
    }

    let upgraded = false;
    try {
      writeStatus(args.statusPath, {
        ...baseStatus,
        state: "upgrading",
        message: `Installing clawdex-mobile@${args.version}.`,
      });
      await runCommand(npmCommand(), ["install", "-g", `clawdex-mobile@${args.version}`], {
        cwd: packageRoot,
        env: process.env,
      });
      restoreSecureEnv(secureEnvBackup);
      upgraded = true;
      await restartBridge(
        packageRoot,
        args.statusPath,
        baseStatus,
        "Starting the updated bridge process."
      );
      writeStatus(args.statusPath, {
        ...baseStatus,
        state: "completed",
        message: `Bridge updated to ${args.version} and restarted successfully.`,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      try {
        restoreSecureEnv(secureEnvBackup);
        await restartBridge(
          packageRoot,
          args.statusPath,
          baseStatus,
          upgraded
            ? "Updated bridge failed to come up; restarting the previous bridge."
            : "Upgrade failed; restarting the previous bridge."
        );
        writeStatus(args.statusPath, {
          ...baseStatus,
          state: "recovered",
          message: upgraded
            ? "Bridge update failed after install. The previous bridge was restarted."
            : "Bridge upgrade failed. The previous bridge was restarted.",
          completedAt: new Date().toISOString(),
        });
      } catch (restartError) {
        writeStatus(args.statusPath, {
          ...baseStatus,
          state: "failed",
          message:
            restartError instanceof Error
              ? restartError.message
              : "Bridge update failed and automatic recovery did not complete.",
          completedAt: new Date().toISOString(),
        });
        process.exitCode = 1;
      }
    }
  } catch (error) {
    writeStatus(args.statusPath, {
      ...baseStatus,
      state: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Bridge maintenance failed before restart or recovery could begin.",
      completedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  } finally {
    cleanupSecureEnvBackup(secureEnvBackup);
  }
}

void main();
