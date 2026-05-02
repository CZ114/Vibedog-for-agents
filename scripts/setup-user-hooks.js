#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  USER_SETTINGS_PATH,
  mergeManagedHooks,
  readSettings
} = require("./lib/claude-settings");

function usage() {
  console.error("Usage: node scripts/setup-user-hooks.js [--dry-run] [--uninstall] [--settings <path>]");
  console.error("Example: npm run setup-user-hooks");
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    uninstall: false,
    settingsPath: USER_SETTINGS_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--uninstall" || arg === "--remove") {
      options.uninstall = true;
    } else if (arg === "--settings") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--settings requires a path.");
      }
      options.settingsPath = path.resolve(next);
      index += 1;
    } else if (arg.startsWith("--settings=")) {
      options.settingsPath = path.resolve(arg.slice("--settings=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function backupSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${settingsPath}.bak-${stamp}`;
  fs.copyFileSync(settingsPath, backupPath);
  return backupPath;
}

function writeSettings(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(settings, null, 2) + "\n";
  const tmp = `${settingsPath}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, settingsPath);
  return payload;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const settings = readSettings(options.settingsPath);
  const before = JSON.stringify(settings, null, 2) + "\n";
  const report = mergeManagedHooks(settings, { uninstall: options.uninstall });
  const after = JSON.stringify(settings, null, 2) + "\n";
  const changed = before !== after;

  if (!options.dryRun && changed) {
    const backupPath = backupSettings(options.settingsPath);
    writeSettings(options.settingsPath, settings);
    if (backupPath) {
      console.log(`backup: ${backupPath}`);
    }
  }

  console.log(`${options.dryRun ? "Dry run for" : changed ? "Updated" : "No changes for"} ${options.settingsPath}`);
  console.log(`mode: ${options.uninstall ? "uninstall" : "install"}`);
  console.log(`managed hook entries removed: ${report.removedManagedHookEntries}`);
  console.log(`managed hook entries installed: ${report.addedHookEntries}`);

  if (options.dryRun) {
    console.log(after);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
