#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function printUsage() {
  console.log(`Usage: clawdex <command> [options]

Commands:
  init [--no-start] [--platform <mobile|ios|android>]
      Run interactive onboarding and secure setup.
      By default, this also starts bridge + Expo at the end.
      Use --no-start to skip auto-launch.

  stop
      Stop bridge + Expo services for this project.

  upgrade [--version <latest|x.y.z>] [--restart]
  update  [--version <latest|x.y.z>] [--restart]
      Upgrade clawdex-mobile globally.
      --restart stops running services first, upgrades, then runs 'clawdex init'.

  version
      Print current CLI package version.

  help
      Show this help.
`);
}

function runCommand(command, args = [], options = {}) {
  const child = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
    ...options,
  });

  if (child.error) {
    return {
      ok: false,
      status: child.status ?? 1,
      error: child.error,
    };
  }

  return {
    ok: (child.status ?? 1) === 0,
    status: child.status ?? 1,
    error: null,
  };
}

function runScript(scriptName, args = [], { exitOnComplete = true } = {}) {
  const scriptPath = path.resolve(__dirname, "..", "scripts", scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`error: script not found at ${scriptPath}`);
    process.exit(1);
  }

  const result = runCommand(scriptPath, args);
  if (!result.ok && result.error) {
    console.error(`error: failed to run ${scriptName}: ${result.error.message}`);
  }

  if (exitOnComplete) {
    process.exit(result.status);
  }

  return result;
}

function runInit(args) {
  runScript("setup-wizard.sh", args);
}

function runStop(args) {
  runScript("stop-services.sh", args);
}

function getCliVersion() {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return parsed.version || "unknown";
  } catch {
    return "unknown";
  }
}

function parseUpgradeArgs(args) {
  let targetVersion = "latest";
  let restart = false;
  let noStop = false;

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--version") {
      const candidate = args[i + 1];
      if (!candidate || candidate.startsWith("-")) {
        throw new Error("--version requires a value (for example: latest, 1.1.2)");
      }
      targetVersion = candidate;
      i += 1;
      continue;
    }

    if (value === "--restart") {
      restart = true;
      continue;
    }

    if (value === "--no-stop") {
      noStop = true;
      continue;
    }

    if (value === "--help" || value === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`unknown option '${value}'`);
  }

  return { targetVersion, restart, noStop };
}

function runUpgrade(args) {
  let options;
  try {
    options = parseUpgradeArgs(args);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }

  const previousVersion = getCliVersion();
  const packageSpecifier =
    options.targetVersion === "latest"
      ? "clawdex-mobile@latest"
      : `clawdex-mobile@${options.targetVersion}`;

  console.log(`Current clawdex-mobile version: ${previousVersion}`);
  if (!options.noStop) {
    console.log("Stopping running bridge/Expo services before upgrade...");
    const stopResult = runScript("stop-services.sh", [], { exitOnComplete: false });
    if (!stopResult.ok) {
      console.error("error: failed to stop services before upgrade.");
      process.exit(stopResult.status);
    }
  }

  console.log(`Upgrading via npm: ${packageSpecifier}`);
  const installResult = runCommand("npm", ["install", "-g", packageSpecifier]);
  if (!installResult.ok) {
    const platformHint =
      os.platform() === "win32"
        ? "Run terminal as Administrator and retry."
        : "If this is a permissions error, retry with sudo or fix npm global prefix.";
    console.error(`error: upgrade failed. ${platformHint}`);
    process.exit(installResult.status);
  }

  console.log("Upgrade completed.");
  if (options.restart) {
    console.log("Restarting with updated setup: clawdex init");
    const restartResult = runCommand("clawdex", ["init"]);
    process.exit(restartResult.status);
  }

  console.log("Run 'clawdex init' to start services with the updated version.");
  process.exit(0);
}

function runVersion() {
  console.log(getCliVersion());
  process.exit(0);
}

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

if (command === "init") {
  runInit(argv.slice(1));
}

if (command === "stop") {
  runStop(argv.slice(1));
}

if (command === "upgrade" || command === "update") {
  runUpgrade(argv.slice(1));
}

if (command === "version" || command === "--version" || command === "-v") {
  runVersion();
}

console.error(`error: unknown command '${command}'`);
printUsage();
process.exit(1);
