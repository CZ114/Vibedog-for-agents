#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PROTOCOL_VERSION,
  claudePermissionRequestDecision,
  claudePreToolUseDecision,
  createId,
  jsonResponse,
  normalizeDecision,
  nowIso,
  readJsonBody
} = require("../../shared/protocol");
const { assessToolRisk, summarizeToolInput } = require("../../shared/risk");
const { acceptWebSocket } = require("./websocket");
const { DeviceStore, PairingManager } = require("./devices");

const PORT = Number(process.env.CCC_PORT || 4317);
const HOST = process.env.CCC_HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.CCC_APPROVAL_TIMEOUT_MS || 55_000);
const DATA_DIR = process.env.CCC_DATA_DIR || path.join(process.cwd(), ".claude-companion");
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const EXTENDED_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CONTEXT_WINDOW_OVERRIDE_TOKENS = Number(process.env.CCC_CONTEXT_WINDOW_TOKENS || 0);
const MODEL_CONTEXT_WINDOW_OVERRIDES = parseModelContextWindowOverrides(process.env.CCC_MODEL_CONTEXT_WINDOWS);
// Claude Code auto-upgrades Opus 4.6/4.7 and Sonnet 4.6 to a 1M window on
// Max/Team/Enterprise plans unless CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set.
// The transcript itself only records the bare model id (e.g. "claude-opus-4-7"),
// so we mirror Claude Code's own gating here instead of waiting for a [1m] tag.
const CLAUDE_DISABLE_1M = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === "1" ||
  process.env.CCC_DISABLE_1M_CONTEXT === "true";
const ONE_M_MODEL_PATTERNS = [
  /claude[-_ ]?opus[-_ ]?4[-_ ]?6/,
  /claude[-_ ]?opus[-_ ]?4[-_ ]?7/,
  /claude[-_ ]?sonnet[-_ ]?4[-_ ]?6/
];

// Per-user store of windows we've learned by direct observation. Keyed by
// model family ("opus-4-7"), so a fresh build like claude-opus-4-7-20251115
// inherits the same window without re-learning.
const LEARNED_CONTEXT_FILE = path.join(os.homedir(), ".claude-companion", "learned-context.json");
// Compact heuristic: a usage drop counts only if the prior peak was substantial.
// 50k filters out start-of-session jitter and short tool round-trips.
const COMPACT_PEAK_THRESHOLD = 50_000;
const COMPACT_DROP_RATIO = 0.3;
// Fixed buckets we snap a learned window into; new buckets get added as
// Anthropic ships them. Keep ascending.
const KNOWN_WINDOW_BUCKETS = [DEFAULT_CONTEXT_WINDOW_TOKENS, EXTENDED_CONTEXT_WINDOW_TOKENS];

const pendingRequests = new Map();
const sessionStates = new Map();
const auditEvents = [];
const wsClients = new Set();
const deviceStore = new DeviceStore({ dataDir: DATA_DIR });
const pairingManager = new PairingManager();
let stateSequence = 0;

function htmlResponse(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store"
  });
  res.end(html);
}

function audit(event) {
  const item = {
    eventId: createId("evt"),
    createdAt: nowIso(),
    ...event
  };
  auditEvents.push(item);
  if (auditEvents.length > 500) {
    auditEvents.shift();
  }
  return item;
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket.remoteAddress);
}

function bearerToken(req, url) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return url.searchParams.get("token");
}

function authenticatedDevice(req, url) {
  return deviceStore.authenticate(bearerToken(req, url), nowIso());
}

function requireLocalRequest(req, res) {
  if (isLoopbackRequest(req)) {
    return true;
  }

  jsonResponse(res, 403, {
    error: "This endpoint is only available from the local machine."
  });
  return false;
}

function requireAuthorizedRequest(req, res, url) {
  const token = bearerToken(req, url);
  if (token) {
    const device = deviceStore.authenticate(token, nowIso());
    if (device) {
      return device;
    }
  }

  if (isLoopbackRequest(req)) {
    return {
      deviceId: "local",
      deviceName: "Local browser"
    };
  }

  jsonResponse(res, 401, {
    error: "Missing or invalid device token."
  });
  return null;
}

function unauthorizedUpgrade(socket) {
  const body = "Missing or invalid token.";
  socket.write(
    [
      "HTTP/1.1 401 Unauthorized",
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body
    ].join("\r\n")
  );
  socket.destroy();
}

function pendingRequestList() {
  return Array.from(pendingRequests.values()).map((entry) => entry.request);
}

function sessionStateList() {
  return Array.from(sessionStates.values()).sort((a, b) => {
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function isAskUserQuestionRequest(request) {
  return request && request.tool === "AskUserQuestion";
}

function questionList(toolInput) {
  return toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
}

function questionKey(question, index) {
  return String((question && question.question) || `Question ${index + 1}`);
}

function normalizeQuestionAnswers(questions, rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    return {
      answers: {},
      missing: questions.map((question, index) => questionKey(question, index))
    };
  }

  const normalized = {};
  const missing = [];

  if (!questions.length) {
    for (const [key, value] of Object.entries(rawAnswers)) {
      const answer = Array.isArray(value) ? value.join(", ") : String(value || "").trim();
      if (key && answer) {
        normalized[key] = answer;
      }
    }
    return {
      answers: normalized,
      missing: Object.keys(normalized).length ? [] : ["Answer"]
    };
  }

  questions.forEach((question, index) => {
    const key = questionKey(question, index);
    const value = rawAnswers[key];
    const answer = Array.isArray(value) ? value.join(", ") : String(value || "").trim();
    if (!answer) {
      missing.push(key);
      return;
    }
    normalized[key] = answer;
  });

  return { answers: normalized, missing };
}

function normalizeIncomingDecision(rawDecision) {
  if (rawDecision === "always_allow") {
    return "always_allow";
  }
  return normalizeDecision(rawDecision);
}

function truncateText(value, maxLength = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "...";
}

function compactTokenCount(value) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) {
    return "0";
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}m`;
  }
  if (count >= 1_000) {
    return `${Math.round(count / 100) / 10}k`;
  }
  return String(Math.round(count));
}

function numberFromAny(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return 0;
}

function parseModelContextWindowOverrides(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    return Object.entries(parsed)
      .map(([pattern, tokens]) => ({
        pattern: String(pattern || "").trim().toLowerCase(),
        tokens: Number(tokens)
      }))
      .filter((item) => item.pattern && Number.isFinite(item.tokens) && item.tokens > 0);
  } catch (error) {
    console.warn(`[warn] Ignoring invalid CCC_MODEL_CONTEXT_WINDOWS: ${error.message}`);
    return [];
  }
}

function modelFamilyFromText(text) {
  if (text.includes("opus")) {
    return "opus";
  }
  if (text.includes("sonnet")) {
    return "sonnet";
  }
  if (text.includes("haiku")) {
    return "haiku";
  }
  return "unknown";
}

// Family-versioned key — "claude-opus-4-7" / "claude-opus-4-7-20251115" both
// collapse to "opus-4-7", so a learned window survives minor build bumps.
function modelFamilyKey(model) {
  if (!model) {
    return null;
  }
  const text = String(model).toLowerCase();
  const match = text.match(/(opus|sonnet|haiku)[-_ ]?(\d+)[-_ ]?(\d+)/);
  if (!match) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function snapToKnownBucket(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  let best = KNOWN_WINDOW_BUCKETS[0];
  let bestDistance = Math.abs(value - best);
  for (const bucket of KNOWN_WINDOW_BUCKETS) {
    const distance = Math.abs(value - bucket);
    if (distance < bestDistance) {
      best = bucket;
      bestDistance = distance;
    }
  }
  return best;
}

function loadLearnedContext() {
  try {
    const raw = fs.readFileSync(LEARNED_CONTEXT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object") {
      return parsed;
    }
  } catch (_error) {
    // Missing file or unparseable JSON: start fresh.
  }
  return { version: 1, models: {} };
}

let learnedContext = loadLearnedContext();
let learnedContextWriteTimer = null;

function saveLearnedContextSoon() {
  if (learnedContextWriteTimer) {
    return;
  }
  learnedContextWriteTimer = setTimeout(() => {
    learnedContextWriteTimer = null;
    try {
      const dir = path.dirname(LEARNED_CONTEXT_FILE);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${LEARNED_CONTEXT_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(learnedContext, null, 2), "utf8");
      fs.renameSync(tmp, LEARNED_CONTEXT_FILE);
    } catch (error) {
      console.warn(`[warn] Failed to persist learned-context.json: ${error.message}`);
    }
  }, 500);
}

function getLearnedWindow(model) {
  const key = modelFamilyKey(model);
  if (!key) {
    return null;
  }
  const entry = learnedContext.models[key];
  if (!entry || !Number.isFinite(entry.window) || entry.window <= 0) {
    return null;
  }
  return { window: entry.window, key };
}

function recordLearnedWindow(model, window, peakSeen, reason) {
  const key = modelFamilyKey(model);
  if (!key || !Number.isFinite(window) || window <= 0) {
    return;
  }
  const previous = learnedContext.models[key];
  // Never demote — a previously-confirmed 1M wins over a later weaker signal.
  if (previous && previous.window >= window) {
    if (Number.isFinite(peakSeen) && peakSeen > 0 && (!previous.peakSeen || peakSeen > previous.peakSeen)) {
      previous.peakSeen = peakSeen;
      saveLearnedContextSoon();
    }
    return;
  }
  learnedContext.models[key] = {
    window,
    peakSeen: Number.isFinite(peakSeen) && peakSeen > 0 ? peakSeen : null,
    confirmedAt: nowIso(),
    confirmedBy: reason
  };
  saveLearnedContextSoon();
}

function modelOverrideFromEnv(modelText) {
  const exact = MODEL_CONTEXT_WINDOW_OVERRIDES.find((item) => modelText === item.pattern);
  if (exact) {
    return exact;
  }
  return MODEL_CONTEXT_WINDOW_OVERRIDES.find((item) => modelText.includes(item.pattern)) || null;
}

function contextWindowRecord(maxTokens, source, model, rule) {
  return {
    maxTokens,
    source,
    rule,
    model: model ? String(model) : null,
    modelFamily: model ? modelFamilyFromText(String(model).toLowerCase()) : "unknown"
  };
}

function contextWindowFromModel(model) {
  if (!model) {
    return contextWindowRecord(DEFAULT_CONTEXT_WINDOW_TOKENS, "default", null, "missing-model");
  }

  const text = String(model).toLowerCase();
  const override = modelOverrideFromEnv(text);
  if (override) {
    return contextWindowRecord(override.tokens, "model-override", model, override.pattern);
  }

  // Learned per-family from observed transcripts. Wins over [1m] / family
  // defaults because it reflects what we've actually seen this model do.
  const learned = getLearnedWindow(model);
  if (learned) {
    return contextWindowRecord(learned.window, "learned", model, learned.key);
  }

  // Claude Code's model aliases sometimes carry an explicit [1m] marker.
  if (text.includes("[1m]") || /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(text)) {
    return contextWindowRecord(EXTENDED_CONTEXT_WINDOW_TOKENS, "model-id", model, "1m");
  }

  // Opus 4.6/4.7 and Sonnet 4.6 default to 1M on Claude Code unless the
  // CLAUDE_CODE_DISABLE_1M_CONTEXT escape hatch is set.
  if (!CLAUDE_DISABLE_1M && ONE_M_MODEL_PATTERNS.some((pattern) => pattern.test(text))) {
    return contextWindowRecord(EXTENDED_CONTEXT_WINDOW_TOKENS, "claude-code-default", model, "1m-default");
  }

  if (text.includes("claude") || ["opus", "sonnet", "haiku"].some((name) => text.includes(name))) {
    return contextWindowRecord(DEFAULT_CONTEXT_WINDOW_TOKENS, "model-default", model, modelFamilyFromText(text));
  }

  return contextWindowRecord(DEFAULT_CONTEXT_WINDOW_TOKENS, "default", model, "fallback");
}

function contextWindowFromUsage(usage, model) {
  const explicit = numberFromAny(
    usage.context_window_tokens,
    usage.contextWindowTokens,
    usage.context_window,
    usage.contextWindow,
    usage.max_context_tokens,
    usage.maxContextTokens
  );

  if (explicit) {
    return contextWindowRecord(explicit, "usage", model, "usage-field");
  }

  if (CONTEXT_WINDOW_OVERRIDE_TOKENS) {
    return contextWindowRecord(CONTEXT_WINDOW_OVERRIDE_TOKENS, "env", model, "CCC_CONTEXT_WINDOW_TOKENS");
  }

  return contextWindowFromModel(model);
}

function contextUsageFromUsage(usage, model) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }

  const inputTokens = numberFromAny(usage.input_tokens, usage.inputTokens);
  const cacheReadTokens = numberFromAny(usage.cache_read_input_tokens, usage.cacheReadInputTokens);
  const cacheCreationTokens = numberFromAny(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  const outputTokens = numberFromAny(usage.output_tokens, usage.outputTokens);
  const usedTokens = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
  let contextWindow = contextWindowFromUsage(usage, model);

  // If observed usage already exceeds the resolved window, the model must
  // have a larger window than we guessed. Promote to 1M rather than show >100%.
  if (usedTokens > contextWindow.maxTokens && contextWindow.maxTokens < EXTENDED_CONTEXT_WINDOW_TOKENS) {
    contextWindow = contextWindowRecord(EXTENDED_CONTEXT_WINDOW_TOKENS, "observed-overrun", model, "exceeded-200k");
  }

  const maxTokens = contextWindow.maxTokens;

  if (!usedTokens || !maxTokens) {
    return null;
  }

  const percent = Math.max(0, Math.min(100, Math.round((usedTokens / maxTokens) * 100)));
  return {
    usedTokens,
    maxTokens,
    percent,
    label: `${compactTokenCount(usedTokens)} / ${compactTokenCount(maxTokens)}`,
    model: model ? String(model) : null,
    modelFamily: contextWindow.modelFamily,
    windowSource: contextWindow.source,
    windowRule: contextWindow.rule,
    source: "transcript"
  };
}

function claudeProjectSlug(cwd) {
  const text = String(cwd || "").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1-");
  return text.replace(/\/+/g, "-").replace(/^-+/, "");
}

function transcriptCandidates(transcriptPath, sessionId, cwd) {
  const candidates = [];
  if (transcriptPath) {
    candidates.push(transcriptPath);
  }

  const slug = claudeProjectSlug(cwd);
  if (slug && sessionId && sessionId !== "unknown") {
    candidates.push(path.join(os.homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function latestContextUsageFromTranscript(transcriptPath, sessionId, cwd) {
  for (const candidate of transcriptCandidates(transcriptPath, sessionId, cwd)) {
    const contextUsage = latestContextUsageFromTranscriptFile(candidate);
    if (contextUsage) {
      return contextUsage;
    }
  }
  return null;
}

function usedTokensFromUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return 0;
  }
  return numberFromAny(usage.input_tokens, usage.inputTokens) +
    numberFromAny(usage.cache_read_input_tokens, usage.cacheReadInputTokens) +
    numberFromAny(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) +
    numberFromAny(usage.output_tokens, usage.outputTokens);
}

// Scan a transcript file for the latest usage line plus any peak / compact
// signals visible in the suffix we read. Returning a single struct lets us
// fold both display data and learned-context updates into one I/O pass.
function scanTranscriptUsage(transcriptPath) {
  try {
    const stats = fs.statSync(transcriptPath);
    const readSize = Math.min(stats.size, 256 * 1024);
    const fd = fs.openSync(transcriptPath, "r");
    let lines;
    try {
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
      lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }

    let latestUsage = null;
    let latestModel = null;
    let peak = 0;
    let runningPeak = 0;
    let compactDetected = false;
    let peakBeforeCompact = 0;

    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      const usage = item && item.message && item.message.usage;
      if (!usage) {
        continue;
      }
      const used = usedTokensFromUsage(usage);
      if (used <= 0) {
        continue;
      }

      // A sharp drop after a substantial peak is our compact signal — the
      // suffix may even straddle the compact boundary. Reset the running peak
      // afterwards so we don't re-trigger on the same drop.
      if (runningPeak >= COMPACT_PEAK_THRESHOLD && used < runningPeak * COMPACT_DROP_RATIO) {
        compactDetected = true;
        peakBeforeCompact = Math.max(peakBeforeCompact, runningPeak);
        runningPeak = used;
      } else if (used > runningPeak) {
        runningPeak = used;
      }
      if (used > peak) {
        peak = used;
      }

      latestUsage = usage;
      const model = item.message.model;
      if (model) {
        latestModel = model;
      }
    }

    return { latestUsage, latestModel, peak, compactDetected, peakBeforeCompact };
  } catch (_error) {
    return null;
  }
}

function latestContextUsageFromTranscriptFile(transcriptPath) {
  const scan = scanTranscriptUsage(transcriptPath);
  if (!scan) {
    return null;
  }

  // Promote learned window: peak-overrun is unambiguous (a 200k model can't
  // hold more than 200k); compact-detected snaps to the nearest known bucket.
  if (scan.latestModel) {
    if (scan.peak > DEFAULT_CONTEXT_WINDOW_TOKENS) {
      recordLearnedWindow(scan.latestModel, EXTENDED_CONTEXT_WINDOW_TOKENS, scan.peak, "peak-overrun");
    } else if (scan.compactDetected && scan.peakBeforeCompact >= COMPACT_PEAK_THRESHOLD) {
      const bucket = snapToKnownBucket(scan.peakBeforeCompact);
      if (bucket) {
        recordLearnedWindow(scan.latestModel, bucket, scan.peakBeforeCompact, "compact-observed");
      }
    }
  }

  if (!scan.latestUsage) {
    return null;
  }
  return contextUsageFromUsage(scan.latestUsage, scan.latestModel);
}

function sessionIdFromHookInput(hookInput) {
  return String((hookInput && hookInput.session_id) || "unknown");
}

function sessionSummaryFromHookInput(hookInput) {
  const eventName = String((hookInput && hookInput.hook_event_name) || "Unknown");
  const toolName = String((hookInput && hookInput.tool_name) || "");
  const toolInput = (hookInput && hookInput.tool_input) || {};

  if (eventName === "UserPromptSubmit") {
    return truncateText(hookInput.prompt || "User submitted a prompt");
  }

  if (toolName) {
    return summarizeToolInput(toolName, toolInput);
  }

  if (eventName === "Notification") {
    return truncateText(hookInput.message || hookInput.notification || "Claude Code notification");
  }

  if (eventName === "Stop") {
    return "Claude finished the current turn";
  }

  if (eventName === "SessionEnd") {
    return "Claude Code session ended";
  }

  return eventName;
}

function statusForHookInput(hookInput) {
  const eventName = String((hookInput && hookInput.hook_event_name) || "");
  const toolName = String((hookInput && hookInput.tool_name) || "");
  const message = String((hookInput && (hookInput.message || hookInput.notification)) || "").toLowerCase();

  if (eventName === "UserPromptSubmit") {
    return "thinking";
  }
  if (eventName === "PreToolUse") {
    return toolName === "AskUserQuestion" ? "waiting_answer" : "running_tool";
  }
  if (eventName === "PostToolUse") {
    return "thinking";
  }
  if (eventName === "PostToolUseFailure") {
    return "failed";
  }
  if (eventName === "PermissionRequest") {
    return "waiting_approval";
  }
  if (eventName === "Notification") {
    if (message.includes("permission")) {
      return "waiting_approval";
    }
    if (message.includes("input") || message.includes("waiting")) {
      return "waiting";
    }
    return "thinking";
  }
  if (eventName === "Stop") {
    return "done";
  }
  if (eventName === "SessionEnd") {
    return "idle";
  }
  return "thinking";
}

function updateSessionStateFromHook(hookInput, status, details = {}) {
  const sessionId = sessionIdFromHookInput(hookInput);
  const previous = sessionStates.get(sessionId);
  const now = nowIso();
  const toolName = String((hookInput && hookInput.tool_name) || details.tool || "");
  const transcriptPath = (hookInput && hookInput.transcript_path) || (previous && previous.transcriptPath) || null;
  const cwd = String((hookInput && hookInput.cwd) || (previous && previous.cwd) || process.cwd());
  const contextUsage = latestContextUsageFromTranscript(transcriptPath, sessionId, cwd) ||
    details.contextUsage ||
    (previous && previous.contextUsage) ||
    null;
  const next = {
    protocolVersion: PROTOCOL_VERSION,
    type: "session_state",
    sessionId,
    status,
    cwd,
    transcriptPath,
    permissionMode: (hookInput && hookInput.permission_mode) || (previous && previous.permissionMode) || null,
    hookEventName: String((hookInput && hookInput.hook_event_name) || details.hookEventName || ""),
    tool: toolName || null,
    summary: details.summary || sessionSummaryFromHookInput(hookInput),
    requestId: details.requestId || null,
    risk: details.risk || null,
    reason: details.reason || null,
    decision: details.decision || null,
    contextUsage,
    sequence: ++stateSequence,
    createdAt: (previous && previous.createdAt) || now,
    updatedAt: now
  };

  sessionStates.set(sessionId, next);
  audit({
    type: "session_state",
    sessionId,
    status,
    hookEventName: next.hookEventName,
    tool: next.tool,
    summary: next.summary,
    requestId: next.requestId,
    decision: next.decision
  });
  broadcastSessionStates();
  return next;
}

function updateSessionStateFromRequest(request, status, details = {}) {
  return updateSessionStateFromHook(
    {
      session_id: request.sessionId,
      transcript_path: request.transcriptPath,
      cwd: request.cwd,
      permission_mode: request.permissionMode,
      hook_event_name: request.hookEventName,
      tool_name: request.tool,
      tool_input: request.toolInput
    },
    status,
    {
      requestId: request.requestId,
      summary: request.summary,
      risk: request.risk,
      reason: request.reason,
      ...details
    }
  );
}

function statusAfterDecision(request, decision) {
  if (decision === "deny" || decision === "block") {
    return "blocked";
  }
  if (decision === "ask") {
    return isAskUserQuestionRequest(request) ? "waiting_answer" : "waiting_approval";
  }
  if (decision === "answer") {
    return "thinking";
  }
  return isAskUserQuestionRequest(request) ? "thinking" : "running_tool";
}

function makeEvent(type, payload = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    eventId: createId("evt"),
    createdAt: nowIso(),
    ...payload
  };
}

function sendWsEvent(client, type, payload) {
  client.sendJson(makeEvent(type, payload));
}

function broadcastWsEvent(type, payload) {
  const event = makeEvent(type, payload);
  for (const client of wsClients) {
    client.sendJson(event);
  }
}

function broadcastPendingRequests() {
  broadcastWsEvent("pending_requests_snapshot", {
    requests: pendingRequestList()
  });
}

function broadcastSessionStates() {
  broadcastWsEvent("session_states_snapshot", {
    sessions: sessionStateList()
  });
}

// The legacy browser dashboard at http://127.0.0.1:4317/ has been replaced by
// the desktop bubble's dashboard mode. This page is only ever seen when
// somebody hits the daemon URL in a browser by mistake — keep it tiny and
// direct so they know where to go instead.
function daemonRootNoticeHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Code Companion</title>
  <style>
    body {
      margin: 0;
      display: grid;
      place-items: center;
      min-height: 100vh;
      background: #111315;
      color: #f4f4f5;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    main { max-width: 32rem; padding: 32px; text-align: center; }
    h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; letter-spacing: 0.005em; }
    p { margin: 6px 0; color: #9ca3af; font-size: 14px; line-height: 1.55; }
    code {
      padding: 1px 6px; border-radius: 4px;
      background: #191d21; color: #e5e7eb;
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12.5px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Claude Code Companion</h1>
    <p>The browser dashboard has been replaced by the desktop bubble.</p>
    <p>Run <code>npm run desktop</code> from the repo root to launch it. Approvals, sessions, devices, pairing tokens, and audit events all live inside the bubble's dashboard mode now (gear icon in the controls strip).</p>
  </main>
</body>
</html>`;
}

function localAddresses() {
  const result = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        result.push(entry.address);
      }
    }
  }
  return result;
}

function makePermissionRequest(hookInput, approvalKind) {
  const requestId = createId("req");
  const toolName = String(hookInput.tool_name || "Unknown");
  const toolInput = hookInput.tool_input || {};
  const risk = assessToolRisk(toolName, toolInput);
  const effectiveApprovalKind = toolName === "AskUserQuestion" ? "ask_user_question" : approvalKind;
  const transcriptPath = hookInput.transcript_path || null;
  const sessionId = String(hookInput.session_id || "unknown");
  const cwd = String(hookInput.cwd || process.cwd());

  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "permission_request",
    approvalKind: effectiveApprovalKind,
    hookEventName: hookInput.hook_event_name || (effectiveApprovalKind === "permission_request" ? "PermissionRequest" : "PreToolUse"),
    requestId,
    sessionId,
    transcriptPath,
    cwd,
    permissionMode: hookInput.permission_mode || null,
    tool: toolName,
    toolInput,
    questions: questionList(toolInput),
    summary: summarizeToolInput(toolName, toolInput),
    risk: risk.level,
    reason: risk.reason,
    permissionSuggestions: Array.isArray(hookInput.permission_suggestions) ? hookInput.permission_suggestions : [],
    contextUsage: latestContextUsageFromTranscript(transcriptPath, sessionId, cwd),
    createdAt: nowIso(),
    timeoutMs: REQUEST_TIMEOUT_MS
  };
}

function waitForDecision(request) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!pendingRequests.has(request.requestId)) {
        return;
      }
      pendingRequests.delete(request.requestId);
      updateSessionStateFromRequest(request, "blocked", {
        decision: "deny",
        reason: "Timed out waiting for approval"
      });
      audit({
        type: "permission_decision",
        requestId: request.requestId,
        decision: "deny",
        reason: "Timed out waiting for approval"
      });
      broadcastWsEvent("permission_decision", {
        requestId: request.requestId,
        decision: "deny",
        reason: "Timed out waiting for approval"
      });
      broadcastPendingRequests();
      resolve({
        decision: "deny",
        reason: "Timed out waiting for Claude Code Companion approval."
      });
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(request.requestId, {
      request,
      resolve: (decision) => {
        clearTimeout(timeout);
        resolve(decision);
      }
    });
    updateSessionStateFromRequest(request, isAskUserQuestionRequest(request) ? "waiting_answer" : "waiting_approval");
    broadcastWsEvent("permission_request", { request });
    broadcastPendingRequests();
  });
}

async function handlePreToolUse(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const hookInput = await readJsonBody(req);
  const request = makePermissionRequest(hookInput, "pre_tool_use");

  audit({
    type: "permission_request",
    requestId: request.requestId,
    sessionId: request.sessionId,
    tool: request.tool,
    summary: request.summary,
    risk: request.risk,
    reason: request.reason
  });

  console.log(`[pending] ${request.requestId} ${request.risk.toUpperCase()} ${request.tool}: ${request.summary}`);
  if (isAskUserQuestionRequest(request)) {
    console.log(`          answer:  node scripts/decide.js answer ${request.requestId} '{"Question":"Answer"}'`);
  } else {
    console.log(`          approve: node scripts/decide.js approve ${request.requestId}`);
  }
  console.log(`          deny:    node scripts/decide.js deny ${request.requestId}`);

  const decision = await waitForDecision(request);
  if (isAskUserQuestionRequest(request)) {
    const rawDecision = String(decision.decision || "");
    const normalizedDecision = normalizeDecision(rawDecision) || "deny";
    const reason = decision.reason || "Decision from Claude Code Companion";

    if (rawDecision === "answer" || normalizedDecision === "allow") {
      const normalized = normalizeQuestionAnswers(request.questions, decision.answers);
      if (normalized.missing.length) {
        jsonResponse(
          res,
          200,
          claudePreToolUseDecision(
            "deny",
            `AskUserQuestion requires answers for: ${normalized.missing.join(", ")}`
          )
        );
        return;
      }

      jsonResponse(
        res,
        200,
        claudePreToolUseDecision("allow", reason, {
          updatedInput: {
            ...request.toolInput,
            questions: request.questions,
            answers: normalized.answers
          }
        })
      );
      return;
    }

    jsonResponse(res, 200, claudePreToolUseDecision(normalizedDecision, reason));
    return;
  }

  let permissionDecision = normalizeDecision(decision.decision) || "deny";
  if (permissionDecision === "answer") {
    permissionDecision = "deny";
  }
  const reason = decision.reason || `Decision from Claude Code Companion: ${permissionDecision}`;

  jsonResponse(res, 200, claudePreToolUseDecision(permissionDecision, reason));
}

async function handlePermissionRequestHook(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const hookInput = await readJsonBody(req);
  const request = makePermissionRequest(hookInput, "permission_request");

  audit({
    type: "permission_request",
    requestId: request.requestId,
    sessionId: request.sessionId,
    hookEventName: "PermissionRequest",
    tool: request.tool,
    summary: request.summary,
    risk: request.risk,
    reason: request.reason
  });

  console.log(`[native] ${request.requestId} ${request.risk.toUpperCase()} ${request.tool}: ${request.summary}`);
  console.log(`         approve: node scripts/decide.js approve ${request.requestId}`);
  console.log(`         deny:    node scripts/decide.js deny ${request.requestId}`);

  const approval = await waitForDecision(request);
  jsonResponse(res, 200, claudePermissionRequestDecision(permissionRequestDecision(request, approval)));
}

async function handleHookEvent(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const hookInput = await readJsonBody(req);
  const status = statusForHookInput(hookInput);
  const state = updateSessionStateFromHook(hookInput, status);

  jsonResponse(res, 200, {
    ok: true,
    state
  });
}

function permissionRequestDecision(request, approval) {
  const rawDecision = String(approval.decision || "");
  const reason = approval.reason || "Decision from Claude Code Companion";

  if (rawDecision === "allow" || rawDecision === "approve" || rawDecision === "always_allow") {
    const decision = {
      behavior: "allow"
    };

    if (rawDecision === "always_allow") {
      // Renderer ships the index of the suggestion the user picked from the
      // bubble; legacy CLI / web UI clients leave it undefined and we fall
      // back to the first allow-style suggestion.
      const idx = Number(approval.suggestionIndex);
      const suggestions = Array.isArray(request.permissionSuggestions) ? request.permissionSuggestions : [];
      const suggestion = Number.isInteger(idx) && idx >= 0 && idx < suggestions.length
        ? suggestions[idx]
        : suggestions.find((item) => item && item.behavior === "allow");
      if (suggestion) {
        decision.updatedPermissions = [suggestion];
      }
    }

    return decision;
  }

  return {
    behavior: "deny",
    message: reason
  };
}

async function handlePermissionDecision(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) {
    return;
  }

  const body = await readJsonBody(req);
  const requestId = String(body.requestId || "");
  const rawDecision = String(body.decision || "");
  const decision = normalizeIncomingDecision(rawDecision);

  if (!requestId || !decision) {
    jsonResponse(res, 400, {
      error: "requestId and decision are required. decision must be approve/allow/deny/block/ask/answer/always_allow."
    });
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (!pending) {
    jsonResponse(res, 404, { error: `No pending request found for ${requestId}` });
    return;
  }
  if (decision === "answer" && !isAskUserQuestionRequest(pending.request)) {
    jsonResponse(res, 400, { error: "answer decisions are only valid for AskUserQuestion requests." });
    return;
  }
  if (decision === "answer" && (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))) {
    jsonResponse(res, 400, { error: "answer decisions require an answers object." });
    return;
  }

  pendingRequests.delete(requestId);
  const reason = String(body.reason || `User selected ${decision}`);
  updateSessionStateFromRequest(pending.request, statusAfterDecision(pending.request, decision), {
    decision,
    reason
  });
  audit({
    type: "permission_decision",
    requestId,
    decision,
    reason,
    answerKeys: decision === "answer" ? Object.keys(body.answers) : undefined,
    deviceId: device.deviceId,
    deviceName: device.deviceName
  });

  pending.resolve({ decision, reason, answers: body.answers, suggestionIndex: body.suggestionIndex });
  broadcastWsEvent("permission_decision", {
    requestId,
    decision,
    reason
  });
  broadcastPendingRequests();
  jsonResponse(res, 200, { ok: true, requestId, decision, reason });
}

function applyPermissionDecisionFromWebSocket(client, body) {
  const requestId = String(body.requestId || "");
  const rawDecision = String(body.decision || "");
  const decision = normalizeIncomingDecision(rawDecision);

  if (!requestId || !decision) {
    sendWsEvent(client, "error", {
      error: "requestId and decision are required. decision must be approve/allow/deny/block/ask/answer/always_allow."
    });
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (!pending) {
    sendWsEvent(client, "error", {
      error: `No pending request found for ${requestId}`
    });
    return;
  }
  if (decision === "answer" && !isAskUserQuestionRequest(pending.request)) {
    sendWsEvent(client, "error", {
      error: "answer decisions are only valid for AskUserQuestion requests."
    });
    return;
  }
  if (decision === "answer" && (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))) {
    sendWsEvent(client, "error", {
      error: "answer decisions require an answers object."
    });
    return;
  }

  pendingRequests.delete(requestId);
  const reason = String(body.reason || `User selected ${decision}`);
  updateSessionStateFromRequest(pending.request, statusAfterDecision(pending.request, decision), {
    decision,
    reason
  });
  audit({
    type: "permission_decision",
    requestId,
    decision,
    reason,
    answerKeys: decision === "answer" ? Object.keys(body.answers) : undefined,
    deviceId: client.device && client.device.deviceId,
    deviceName: client.device && client.device.deviceName
  });

  pending.resolve({ decision, reason, answers: body.answers, suggestionIndex: body.suggestionIndex });
  sendWsEvent(client, "permission_decision_result", {
    ok: true,
    requestId,
    decision,
    reason
  });
  broadcastWsEvent("permission_decision", {
    requestId,
    decision,
    reason
  });
  broadcastPendingRequests();
}

async function handlePairingToken(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  jsonResponse(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    type: "pairing_token",
    ...pairingManager.current(nowIso()),
    service: "claude-code-companion-daemon",
    connect: {
      host: HOST,
      port: PORT,
      localAddresses: localAddresses(),
      websocketPath: "/ws"
    }
  });
}

async function handlePair(req, res) {
  const body = await readJsonBody(req);
  const pairingToken = String(body.pairingToken || "");
  const deviceName = String(body.deviceName || "Unnamed device");

  if (!pairingManager.consume(pairingToken)) {
    jsonResponse(res, 401, {
      error: "Invalid or expired pairing token."
    });
    return;
  }

  const result = deviceStore.createDevice(deviceName, nowIso());
  audit({
    type: "device_paired",
    deviceId: result.device.deviceId,
    deviceName: result.device.deviceName
  });

  jsonResponse(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    type: "paired_device",
    deviceId: result.device.deviceId,
    deviceName: result.device.deviceName,
    authToken: result.authToken
  });
}

async function handleDevices(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  jsonResponse(res, 200, {
    devices: deviceStore.list()
  });
}

async function handleRevokeDevice(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const body = await readJsonBody(req);
  const deviceId = String(body.deviceId || "");
  const revoked = deviceStore.revoke(deviceId, nowIso());
  if (!revoked) {
    jsonResponse(res, 404, {
      error: `No active device found for ${deviceId}`
    });
    return;
  }

  audit({
    type: "device_revoked",
    deviceId: revoked.deviceId,
    deviceName: revoked.deviceName
  });
  jsonResponse(res, 200, {
    ok: true,
    device: revoked
  });
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    jsonResponse(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/") {
    htmlResponse(res, daemonRootNoticeHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    jsonResponse(res, 200, {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      service: "claude-code-companion-daemon",
      pendingRequests: pendingRequests.size,
      sessions: sessionStates.size,
      port: PORT,
      host: HOST,
      localAddresses: localAddresses()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pairing-token") {
    await handlePairingToken(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/pair") {
    await handlePair(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/devices") {
    await handleDevices(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/devices/revoke") {
    await handleRevokeDevice(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook/pre-tool-use") {
    await handlePreToolUse(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook/permission-request") {
    await handlePermissionRequestHook(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook/event") {
    await handleHookEvent(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/pending-requests") {
    const device = requireAuthorizedRequest(req, res, url);
    if (!device) {
      return;
    }

    jsonResponse(res, 200, {
      requests: pendingRequestList()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const device = requireAuthorizedRequest(req, res, url);
    if (!device) {
      return;
    }

    jsonResponse(res, 200, {
      sessions: sessionStateList()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/permission-decisions") {
    await handlePermissionDecision(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const device = requireAuthorizedRequest(req, res, url);
    if (!device) {
      return;
    }

    jsonResponse(res, 200, { events: auditEvents.slice(-100) });
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("[error]", error);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: error.message });
    } else {
      res.end();
    }
  });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  let device = null;
  const token = bearerToken(req, url);
  if (token) {
    device = authenticatedDevice(req, url);
  } else if (isLoopbackRequest(req)) {
    device = {
      deviceId: "local",
      deviceName: "Local browser"
    };
  }

  if (!device) {
    unauthorizedUpgrade(socket);
    return;
  }

  const client = acceptWebSocket(req, socket, {
    onMessage: (wsClient, text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        sendWsEvent(wsClient, "error", { error: `Invalid JSON: ${error.message}` });
        return;
      }

      if (message.type === "permission_decision") {
        applyPermissionDecisionFromWebSocket(wsClient, message);
        return;
      }

      sendWsEvent(wsClient, "error", { error: `Unsupported message type: ${message.type || "unknown"}` });
    },
    onClose: (wsClient) => {
      wsClients.delete(wsClient);
    },
    onError: (_wsClient, error) => {
      console.error("[ws]", error.message);
    }
  });

  if (!client) {
    return;
  }

  client.device = device;
  wsClients.add(client);
  sendWsEvent(client, "hello", {
    service: "claude-code-companion-daemon",
    device,
    requests: pendingRequestList(),
    sessions: sessionStateList()
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[error] Port ${PORT} on ${HOST} is already in use.`);
    console.error("[error] Another Claude Code Companion daemon is likely already running.");
    console.error("[error] To stop it on Windows, run in PowerShell:");
    console.error(
      `        Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
    );
    console.error("[error] Or set $env:CCC_PORT to a different port before starting the daemon.");
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Code Companion daemon listening on http://${HOST}:${PORT}`);
  console.log("Daemon home: http://" + HOST + ":" + PORT + "/  (visiting in a browser shows a redirect notice; the dashboard now lives in the desktop bubble)");
  console.log("Realtime events: ws://" + HOST + ":" + PORT + "/ws");
  console.log("Pairing token endpoint: http://" + HOST + ":" + PORT + "/pairing-token");
  console.log("Stage 0 endpoints: GET /health, POST /hook/pre-tool-use, POST /hook/permission-request, POST /hook/event, GET /sessions, GET /pending-requests, POST /permission-decisions");
});
