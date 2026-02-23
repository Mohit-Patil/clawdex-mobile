#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function printUsage() {
  console.log(`Usage: clawdex <command> [options]

Commands:
  init [--no-start] [--platform <mobile|ios|android>]
      Run interactive onboarding and secure setup.
      By default, this also starts bridge + Expo at the end.
      Use --no-start to skip auto-launch.

  stop
      Stop bridge + Expo services for this project.

  help
      Show this help.
`);
}

function runScript(scriptName, args = []) {
  const scriptPath = path.resolve(__dirname, "..", "scripts", scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`error: script not found at ${scriptPath}`);
    process.exit(1);
  }

  const child = spawnSync(scriptPath, args, {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });

  if (child.error) {
    console.error(`error: failed to run ${scriptName}: ${child.error.message}`);
    process.exit(1);
  }

  process.exit(child.status ?? 1);
}

function runInit(args) {
  runScript("setup-wizard.sh", args);
}

function runStop(args) {
  runScript("stop-services.sh", args);
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

console.error(`error: unknown command '${command}'`);
printUsage();
process.exit(1);
