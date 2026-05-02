const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROTOCOL_VERSION = 1;

// Single global on/off switch for the Companion. Presence of this file means
// every hook returns noop and Claude Code falls back to its native prompts.
// The desktop bubble's power button toggles this file; users can also touch
// or remove it manually.
const COMPANION_DISABLED_FLAG = path.join(os.homedir(), ".claude-companion", "disabled");

function isCompanionDisabled() {
  try {
    return fs.existsSync(COMPANION_DISABLED_FLAG);
  } catch (_error) {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function claudePreToolUseDecision(permissionDecision, reason, extra = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
      ...extra
    }
  };
}

function claudePermissionRequestDecision(decision) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision
    }
  };
}

function claudeNoopDecision() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    suppressOutput: true
  };
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function normalizeDecision(value) {
  if (value === "approve" || value === "allow") {
    return "allow";
  }
  if (value === "deny" || value === "block") {
    return "deny";
  }
  if (value === "ask") {
    return "ask";
  }
  if (value === "answer") {
    return "answer";
  }
  return null;
}

module.exports = {
  PROTOCOL_VERSION,
  COMPANION_DISABLED_FLAG,
  claudeNoopDecision,
  claudePermissionRequestDecision,
  claudePreToolUseDecision,
  createId,
  isCompanionDisabled,
  jsonResponse,
  normalizeDecision,
  nowIso,
  readJsonBody
};
