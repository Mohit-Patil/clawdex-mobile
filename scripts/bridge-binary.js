#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SUPPORTED_RUNTIME_TARGETS = {
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    rustTarget: "aarch64-apple-darwin",
    binaryName: "codex-rust-bridge",
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    rustTarget: "x86_64-apple-darwin",
    binaryName: "codex-rust-bridge",
  },
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    rustTarget: "x86_64-unknown-linux-gnu",
    binaryName: "codex-rust-bridge",
  },
  "linux-arm64": {
    platform: "linux",
    arch: "arm64",
    rustTarget: "aarch64-unknown-linux-gnu",
    binaryName: "codex-rust-bridge",
  },
  "linux-armv7l": {
    platform: "linux",
    arch: "arm",
    machine: ["armv7l", "armv8l"],
    rustTarget: "armv7-unknown-linux-gnueabihf",
    binaryName: "codex-rust-bridge",
  },
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    rustTarget: "x86_64-pc-windows-msvc",
    binaryName: "codex-rust-bridge.exe",
  },
};

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function currentMachine() {
  return typeof os.machine === "function" ? os.machine() : "";
}

function resolveRuntimeTarget(platform = os.platform(), arch = os.arch(), machine = currentMachine()) {
  for (const [target, metadata] of Object.entries(SUPPORTED_RUNTIME_TARGETS)) {
    if (metadata.platform !== platform || metadata.arch !== arch) {
      continue;
    }
    if (metadata.machine && !metadata.machine.includes(machine)) {
      continue;
    }
    return target;
  }
  return null;
}

function binaryNameForTarget(target) {
  const metadata = SUPPORTED_RUNTIME_TARGETS[target];
  if (!metadata) {
    throw new Error(`Unsupported bridge target '${target}'.`);
  }
  return metadata.binaryName;
}

function packagedBinaryPath(rootDir = repoRoot(), target = resolveRuntimeTarget()) {
  if (!target) {
    return null;
  }
  return path.join(rootDir, "vendor", "bridge-binaries", target, binaryNameForTarget(target));
}

function builtBinaryPath(rootDir = repoRoot(), platform = os.platform(), profile = "release") {
  const binaryName = platform === "win32" ? "codex-rust-bridge.exe" : "codex-rust-bridge";
  return path.join(rootDir, "services", "rust-bridge", "target", profile, binaryName);
}

function ensureExecutable(filePath) {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
}

function stageBinary({ rootDir = repoRoot(), from, target = resolveRuntimeTarget() }) {
  if (!from) {
    throw new Error("--from is required.");
  }
  if (!target) {
    throw new Error("No supported runtime target for this host. Pass --target explicitly.");
  }

  const destination = packagedBinaryPath(rootDir, target);
  if (!destination) {
    throw new Error(`Unable to compute packaged path for target '${target}'.`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(from, destination);
  ensureExecutable(destination);
  return destination;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }

  return { positional, flags };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const rootDir = flags.root ? path.resolve(flags.root) : repoRoot();

  switch (command) {
    case "current-target": {
      const target = resolveRuntimeTarget();
      if (!target) {
        process.exit(1);
      }
      console.log(target);
      return;
    }
    case "has-current-packaged": {
      const filePath = packagedBinaryPath(rootDir);
      if (filePath && fs.existsSync(filePath)) {
        console.log(filePath);
        return;
      }
      process.exit(1);
      return;
    }
    case "current-packaged-path": {
      const target = flags.target || resolveRuntimeTarget();
      const filePath = packagedBinaryPath(rootDir, target);
      if (!filePath) {
        process.exit(1);
      }
      console.log(filePath);
      return;
    }
    case "current-built-path": {
      console.log(builtBinaryPath(rootDir, os.platform(), flags.profile || "release"));
      return;
    }
    case "stage-current": {
      const destination = stageBinary({
        rootDir,
        from: builtBinaryPath(rootDir, os.platform(), flags.profile || "release"),
        target: flags.target || resolveRuntimeTarget(),
      });
      console.log(destination);
      return;
    }
    case "stage": {
      const destination = stageBinary({
        rootDir,
        from: flags.from ? path.resolve(flags.from) : "",
        target: flags.target || resolveRuntimeTarget(),
      });
      console.log(destination);
      return;
    }
    default:
      console.error("Usage:");
      console.error("  node scripts/bridge-binary.js current-target");
      console.error("  node scripts/bridge-binary.js has-current-packaged");
      console.error("  node scripts/bridge-binary.js current-packaged-path [--target <target>]");
      console.error("  node scripts/bridge-binary.js current-built-path [--profile <debug|release>]");
      console.error("  node scripts/bridge-binary.js stage-current [--target <target>] [--profile <debug|release>]");
      console.error("  node scripts/bridge-binary.js stage --from <binary> [--target <target>]");
      process.exit(1);
  }
}

module.exports = {
  SUPPORTED_RUNTIME_TARGETS,
  binaryNameForTarget,
  builtBinaryPath,
  ensureExecutable,
  packagedBinaryPath,
  resolveRuntimeTarget,
  stageBinary,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
