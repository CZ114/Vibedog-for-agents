const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const MANAGED_SCRIPT_NAMES = ["event.js", "pre-tool-use.js", "permission-request.js"];
const USER_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

function normalizeForCommand(filePath) {
  return filePath;
}

function hookCommand(relativeScriptPath) {
  return `node "${normalizeForCommand(path.join(ROOT, relativeScriptPath))}"`;
}

function commandHook(relativeScriptPath, timeout, statusMessage) {
  const hook = {
    type: "command",
    shell: "powershell",
    timeout,
    command: hookCommand(relativeScriptPath)
  };

  if (statusMessage) {
    hook.statusMessage = statusMessage;
  }

  return hook;
}

function desiredUserHooks() {
  const eventHook = commandHook("packages/hooks/event.js", 10);
  const approvalHook = commandHook(
    "packages/hooks/pre-tool-use.js",
    60,
    "Waiting for Claude Code Companion approval"
  );
  const permissionHook = commandHook(
    "packages/hooks/permission-request.js",
    60,
    "Waiting for Claude Code Companion approval"
  );

  return {
    PreToolUse: [
      {
        matcher: "ExitPlanMode|AskUserQuestion",
        hooks: [approvalHook]
      },
      {
        matcher: "",
        hooks: [eventHook]
      }
    ],
    PermissionRequest: [
      {
        matcher: "",
        hooks: [permissionHook]
      }
    ],
    PostToolUse: [
      {
        matcher: "",
        hooks: [eventHook]
      }
    ],
    PostToolUseFailure: [
      {
        matcher: "",
        hooks: [eventHook]
      }
    ],
    UserPromptSubmit: [
      {
        hooks: [eventHook]
      }
    ],
    Notification: [
      {
        hooks: [eventHook]
      }
    ],
    Stop: [
      {
        hooks: [eventHook]
      }
    ],
    SessionEnd: [
      {
        hooks: [eventHook]
      }
    ]
  };
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  const raw = fs.readFileSync(settingsPath, "utf8");
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must contain a JSON object.`);
  }
  return parsed;
}

function isManagedCommand(command) {
  const normalized = String(command || "").replace(/\\/g, "/");
  return MANAGED_SCRIPT_NAMES.some((scriptName) => {
    return normalized.includes(`/packages/hooks/${scriptName}`) ||
      normalized.includes(`\\packages\\hooks\\${scriptName}`);
  });
}

function hookEntryContainsManagedScript(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
    return false;
  }

  return entry.hooks.some((hook) => isManagedCommand(hook && hook.command));
}

function managedHookEvents() {
  return Object.keys(desiredUserHooks());
}

function mergeManagedHooks(settings, options = {}) {
  const report = {
    removedManagedHookEntries: 0,
    addedHookEntries: 0
  };

  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  for (const eventName of managedHookEvents()) {
    if (!Array.isArray(settings.hooks[eventName])) {
      continue;
    }

    const originalLength = settings.hooks[eventName].length;
    settings.hooks[eventName] = settings.hooks[eventName].filter((entry) => {
      return !hookEntryContainsManagedScript(entry);
    });
    report.removedManagedHookEntries += originalLength - settings.hooks[eventName].length;

    if (!settings.hooks[eventName].length) {
      delete settings.hooks[eventName];
    }
  }

  if (!options.uninstall) {
    const desired = desiredUserHooks();
    for (const [eventName, entries] of Object.entries(desired)) {
      if (!Array.isArray(settings.hooks[eventName])) {
        settings.hooks[eventName] = [];
      }
      for (const entry of entries) {
        settings.hooks[eventName].push(entry);
        report.addedHookEntries += 1;
      }
    }
  }

  if (!Object.keys(settings.hooks).length) {
    delete settings.hooks;
  }

  return report;
}

function findManagedHookEntries(settings) {
  const matches = [];
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return matches;
  }

  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    entries.forEach((entry, entryIndex) => {
      const hookList = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
      hookList.forEach((hook, hookIndex) => {
        if (isManagedCommand(hook && hook.command)) {
          matches.push({
            eventName,
            entryIndex,
            hookIndex,
            matcher: entry && Object.prototype.hasOwnProperty.call(entry, "matcher") ? String(entry.matcher) : null,
            command: String(hook.command || "")
          });
        }
      });
    });
  }
  return matches;
}

function extractQuotedNodeScript(command) {
  const text = String(command || "");
  const quoted = text.match(/\bnode(?:\.exe)?\s+"([^"]+)"/i);
  if (quoted) {
    return quoted[1];
  }
  const unquoted = text.match(/\bnode(?:\.exe)?\s+([^\s]+)/i);
  return unquoted ? unquoted[1] : null;
}

function projectSettingsPaths(projectRoot) {
  return [
    path.join(projectRoot, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.local.json")
  ];
}

module.exports = {
  ROOT,
  USER_SETTINGS_PATH,
  desiredUserHooks,
  extractQuotedNodeScript,
  findManagedHookEntries,
  hookEntryContainsManagedScript,
  managedHookEvents,
  mergeManagedHooks,
  projectSettingsPaths,
  readSettings
};
