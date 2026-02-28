#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function readJson(relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeJson(relativePath, value) {
  const fullPath = path.join(rootDir, relativePath);
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`);
}

function updateCargoTomlVersion(relativePath, version) {
  const fullPath = path.join(rootDir, relativePath);
  const current = fs.readFileSync(fullPath, 'utf8');
  const next = current.replace(/^version\s*=\s*".*"$/m, `version = "${version}"`);
  if (next === current) {
    throw new Error(`Could not find Cargo.toml version field in ${relativePath}`);
  }
  fs.writeFileSync(fullPath, next);
}

function syncVersions() {
  const rootPkg = readJson('package.json');
  const version = rootPkg.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('Root package.json version is empty.');
  }

  const mobilePkgPath = 'apps/mobile/package.json';
  const mobilePkg = readJson(mobilePkgPath);
  mobilePkg.version = version;
  writeJson(mobilePkgPath, mobilePkg);

  const bridgePkgPath = 'services/rust-bridge/package.json';
  const bridgePkg = readJson(bridgePkgPath);
  bridgePkg.version = version;
  writeJson(bridgePkgPath, bridgePkg);

  updateCargoTomlVersion('services/rust-bridge/Cargo.toml', version);

  const appJsonPath = 'apps/mobile/app.json';
  const appConfig = readJson(appJsonPath);
  if (!appConfig.expo || typeof appConfig.expo !== 'object') {
    throw new Error('apps/mobile/app.json is missing expo config.');
  }
  appConfig.expo.version = version;
  writeJson(appJsonPath, appConfig);

  console.log(`Synchronized app and bridge versions to ${version}`);
}

try {
  syncVersions();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
