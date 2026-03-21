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

function start() {
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

  if (devMode) {
    if (!commandExists("cargo")) {
      console.error("error: missing Rust/Cargo toolchain for dev bridge mode.");
      process.exit(1);
    }

    spawnAndRelay("cargo", ["run"], {
      cwd: path.join(rootDir, "services", "rust-bridge"),
      env,
    });
    return;
  }

  const overrideBinary = env.CLAWDEX_BRIDGE_BINARY ? path.resolve(env.CLAWDEX_BRIDGE_BINARY) : "";
  if (overrideBinary) {
    if (!fs.existsSync(overrideBinary)) {
      console.error(`error: CLAWDEX_BRIDGE_BINARY not found at ${overrideBinary}`);
      process.exit(1);
    }
    ensureExecutable(overrideBinary);
    spawnAndRelay(overrideBinary, [], { cwd: rootDir, env });
    return;
  }

  const packagedBinary = packagedBinaryPath(rootDir, resolveRuntimeTarget());
  if (!forceSourceBuild && packagedBinary && fs.existsSync(packagedBinary)) {
    ensureExecutable(packagedBinary);
    spawnAndRelay(packagedBinary, [], { cwd: rootDir, env });
    return;
  }

  const builtBinary = builtBinaryPath(rootDir, os.platform());
  if (isBuiltBinaryFresh(rootDir, builtBinary)) {
    ensureExecutable(builtBinary);
    spawnAndRelay(builtBinary, [], { cwd: rootDir, env });
    return;
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
  spawnAndRelay(builtBinary, [], { cwd: rootDir, env });
}

start();
