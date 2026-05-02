const DAEMON_ORIGIN = "http://127.0.0.1:4317";
const WS_URL = "ws://127.0.0.1:4317/ws";

const STATUS_META = {
  idle: { emoji: "\u{1F4A4}", label: "Idle" },
  thinking: { emoji: "\u{1F914}", label: "Thinking" },
  running_tool: { emoji: "\u2699\uFE0F", label: "Running" },
  waiting: { emoji: "\u23F3", label: "Waiting" },
  waiting_approval: { emoji: "\u{1F7E1}", label: "Approval" },
  waiting_answer: { emoji: "\u2753", label: "Question" },
  done: { emoji: "\u2705", label: "Done" },
  failed: { emoji: "\u26A0\uFE0F", label: "Failed" },
  blocked: { emoji: "\u26D4", label: "Blocked" },
  offline: { emoji: "\u{1F50C}", label: "Offline" }
};
const DONE_ATTENTION_FROM_STATUSES = new Set([
  "thinking",
  "running_tool",
  "waiting",
  "waiting_approval",
  "waiting_answer"
]);
const DONE_ATTENTION_TRIGGER_DELAY_MS = 260;
const ISLAND_COLOR_STORAGE_KEY = "claude-code-companion.island-color.v1";
const DEFAULT_ISLAND_COLOR = "#111318";

const state = {
  socket: null,
  connected: false,
  sessions: [],
  requests: [],
  devices: [],
  events: [],
  selectedAnswers: {},
  mode: "compact",
  lastStatus: null,
  attention: null,
  eventsExpanded: false
};
let doneAttentionTimer = null;
let pairingHideTimer = null;

const els = {
  island: document.querySelector(".island"),
  statusOrb: document.getElementById("statusOrb"),
  statusEmoji: document.getElementById("statusEmoji"),
  statusText: document.getElementById("statusText"),
  statusDetail: document.getElementById("statusDetail"),
  contextLabel: document.getElementById("contextLabel"),
  contextFill: document.getElementById("contextFill"),
  requestPanel: document.getElementById("requestPanel"),
  activeRequest: document.getElementById("activeRequest"),
  requestKind: document.getElementById("requestKind"),
  requestTool: document.getElementById("requestTool"),
  requestRisk: document.getElementById("requestRisk"),
  requestSummary: document.getElementById("requestSummary"),
  requestCwd: document.getElementById("requestCwd"),
  requestReason: document.getElementById("requestReason"),
  answerForm: document.getElementById("answerForm"),
  approvalActions: document.getElementById("approvalActions"),
  approveRequest: document.getElementById("approveRequest"),
  suggestionList: document.getElementById("suggestionList"),
  denyRequest: document.getElementById("denyRequest"),
  refreshNow: document.getElementById("refreshNow"),
  changeIslandColor: document.getElementById("changeIslandColor"),
  islandColorInput: document.getElementById("islandColorInput"),
  openDashboard: document.getElementById("openDashboard"),
  maximizeWindow: document.getElementById("maximizeWindow"),
  minimizeWindow: document.getElementById("minimizeWindow"),
  closeWindow: document.getElementById("closeWindow"),
  toggleEnabled: document.getElementById("toggleEnabled"),
  pendingSection: document.getElementById("pendingSection"),
  pendingCount: document.getElementById("pendingCount"),
  pendingList: document.getElementById("pendingList"),
  sessionsCount: document.getElementById("sessionsCount"),
  sessionsList: document.getElementById("sessionsList"),
  generatePairingToken: document.getElementById("generatePairingToken"),
  pairingPanel: document.getElementById("pairingPanel"),
  pairingTokenValue: document.getElementById("pairingTokenValue"),
  pairingTokenMeta: document.getElementById("pairingTokenMeta"),
  devicesList: document.getElementById("devicesList"),
  toggleEvents: document.getElementById("toggleEvents"),
  eventsList: document.getElementById("eventsList"),
  dashHealthLabel: document.getElementById("dashHealthLabel"),
  dashHealthMeta: document.getElementById("dashHealthMeta")
};

function latestSession() {
  return [...state.sessions].sort((a, b) => {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  })[0];
}

function activeRequest() {
  const waiting = state.requests.find((request) => {
    return request.approvalKind === "ask_user_question" || request.risk === "high";
  });
  return waiting || state.requests[0] || null;
}

function requestQuestions(request) {
  if (Array.isArray(request.questions)) {
    return request.questions;
  }
  if (request.toolInput && Array.isArray(request.toolInput.questions)) {
    return request.toolInput.questions;
  }
  return [];
}

function questionKey(question, index) {
  return String((question && question.question) || `Question ${index + 1}`);
}

function optionLabel(option) {
  if (typeof option === "string") {
    return option;
  }
  return String((option && option.label) || "");
}

function isQuestionRequest(request) {
  return request && (request.approvalKind === "ask_user_question" || request.tool === "AskUserQuestion");
}

async function setMode(mode) {
  if (state.mode === mode) {
    return;
  }
  state.mode = mode;
  document.body.dataset.mode = mode;
  if (window.companionDesktop && window.companionDesktop.setMode) {
    await window.companionDesktop.setMode(mode);
  }
}

function normalizeHexColor(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
  }
  return null;
}

function hexColorIsLight(color) {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return false;
  }
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(normalized.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.45;
}

function applyIslandColor(color) {
  const nextColor = normalizeHexColor(color);
  if (!nextColor) {
    document.documentElement.style.removeProperty("--island-surface");
    document.documentElement.style.removeProperty("--island-glass");
    document.documentElement.style.setProperty("--island-color-preview", DEFAULT_ISLAND_COLOR);
    delete document.body.dataset.islandTone;
    if (els.islandColorInput) {
      els.islandColorInput.value = DEFAULT_ISLAND_COLOR;
    }
    return;
  }

  document.documentElement.style.setProperty("--island-surface", nextColor);
  document.documentElement.style.setProperty("--island-glass", `color-mix(in oklch, ${nextColor}, transparent 14%)`);
  document.documentElement.style.setProperty("--island-color-preview", nextColor);
  document.body.dataset.islandTone = hexColorIsLight(nextColor) ? "light" : "dark";
  if (els.islandColorInput) {
    els.islandColorInput.value = nextColor;
  }
}

function initIslandColorPicker() {
  if (!els.changeIslandColor || !els.islandColorInput) {
    return;
  }

  let storedColor = null;
  try {
    storedColor = window.localStorage.getItem(ISLAND_COLOR_STORAGE_KEY);
  } catch (_error) {
    storedColor = null;
  }

  applyIslandColor(storedColor);

  els.changeIslandColor.addEventListener("click", () => {
    els.islandColorInput.click();
  });

  const saveSelectedColor = () => {
    const nextColor = normalizeHexColor(els.islandColorInput.value);
    if (!nextColor) {
      return;
    }
    applyIslandColor(nextColor);
    try {
      window.localStorage.setItem(ISLAND_COLOR_STORAGE_KEY, nextColor);
    } catch (_error) {
      // Visual preference only; keep the current color even if persistence fails.
    }
  };

  els.islandColorInput.addEventListener("input", saveSelectedColor);
  els.islandColorInput.addEventListener("change", saveSelectedColor);
}

function contextUsageFrom(subject) {
  const contextUsage = subject && subject.contextUsage;
  if (!contextUsage || typeof contextUsage !== "object") {
    return {
      percent: 0,
      label: "ctx --"
    };
  }

  const percent = Math.max(0, Math.min(100, Number(contextUsage.percent || 0)));
  return {
    percent,
    label: contextUsage.label || `ctx ${Math.round(percent)}%`
  };
}

function colorForContext(percent) {
  // Tokens kept in sync with docs/design-language.md.
  if (percent >= 85) {
    return "oklch(70% 0.07 25)"; // dusty rose — alarm
  }
  if (percent >= 65) {
    return "oklch(78% 0.08 70)"; // sand gold — caution
  }
  return "oklch(72% 0.06 195)"; // titanium teal — calm
}

function renderContext(contextUsage) {
  const percent = Math.round(contextUsage.percent || 0);
  const color = colorForContext(percent);
  document.documentElement.style.setProperty("--context-color", color);
  document.documentElement.style.setProperty("--context-angle", `${percent * 3.6}deg`);
  document.documentElement.style.setProperty("--context-percent", `${percent}%`);
  els.contextFill.style.width = `${percent}%`;
  els.contextLabel.textContent = contextUsage.label || `ctx ${percent}%`;
  const model = contextUsage.model ? ` - ${contextUsage.model}` : "";
  const source = contextUsage.windowSource ? ` - ${contextUsage.windowSource}` : "";
  els.statusOrb.title = `${contextUsage.label || `ctx ${percent}%`}${model}${source}`;
}

function maybeTriggerDoneAttention(status) {
  const previousStatus = state.lastStatus;
  state.lastStatus = status;

  if (doneAttentionTimer && status !== "done") {
    window.clearTimeout(doneAttentionTimer);
    doneAttentionTimer = null;
  }

  if (status !== "done" && state.attention === "done") {
    state.attention = null;
    if (window.companionDesktop && window.companionDesktop.clearAttention) {
      window.companionDesktop.clearAttention();
    }
  }

  if (status !== "done" || !DONE_ATTENTION_FROM_STATUSES.has(previousStatus)) {
    return;
  }
  if (!window.companionDesktop || !window.companionDesktop.doneAttention) {
    return;
  }

  if (doneAttentionTimer) {
    window.clearTimeout(doneAttentionTimer);
  }
  doneAttentionTimer = window.setTimeout(() => {
    doneAttentionTimer = null;
    if (els.island.dataset.status === "done") {
      window.companionDesktop.doneAttention();
    }
  }, DONE_ATTENTION_TRIGGER_DELAY_MS);
}

function renderStatus(status, detail, contextUsage) {
  const meta = STATUS_META[status] || STATUS_META.idle;
  els.island.dataset.status = status;
  els.statusEmoji.textContent = meta.emoji;
  els.statusText.textContent = meta.label;
  els.statusDetail.textContent = detail || "";
  renderContext(contextUsage);
  maybeTriggerDoneAttention(status);
}

function renderSession() {
  const request = activeRequest();
  const session = latestSession();
  const status = request
    ? isQuestionRequest(request)
      ? "waiting_answer"
      : "waiting_approval"
    : state.connected
      ? session && session.status
        ? session.status
        : "idle"
      : "offline";

  const detail = request
    ? request.summary || request.tool || "Waiting for a decision"
    : session && session.summary
      ? session.summary
      : state.connected
        ? "No request"
        : "Daemon offline";

  const contextUsage = contextUsageFrom((request && request.contextUsage) ? request : session);
  renderStatus(status, detail, contextUsage);
}

function renderRequest() {
  const request = activeRequest();
  state.selectedAnswers = {};
  const inDashboard = state.mode === "dashboard";

  if (!request) {
    els.activeRequest.hidden = true;
    if (inDashboard) {
      // Dashboard stays open even with nothing pending — pending queue,
      // sessions, devices, and audit events are still useful.
      els.requestPanel.hidden = false;
    } else {
      els.requestPanel.hidden = true;
      setMode("compact");
    }
    return;
  }

  const question = isQuestionRequest(request);
  els.requestPanel.hidden = false;
  els.activeRequest.hidden = false;
  els.requestKind.textContent = question ? "question" : "approval";
  els.requestTool.textContent = request.tool || "Tool request";
  els.requestRisk.textContent = request.risk || "low";
  els.requestRisk.dataset.risk = request.risk || "low";
  els.requestSummary.textContent = request.summary || "";
  els.requestCwd.textContent = request.cwd || "";
  els.requestReason.textContent = request.reason || "";
  els.answerForm.hidden = !question;
  els.approvalActions.hidden = question;
  renderSuggestionList(request);

  if (question) {
    renderAnswerForm(request);
  } else {
    els.answerForm.replaceChildren();
  }

  // Don't override dashboard mode when a new request lands — the user has
  // already chosen the overview surface. In any other expanded state, snap
  // to the focused approval / question card.
  if (!inDashboard) {
    setMode(question ? "question" : "approval");
  }
}

function suggestionLabel(suggestion) {
  if (!suggestion) {
    return "Always allow";
  }
  const rules = Array.isArray(suggestion.rules) ? suggestion.rules : [];
  if (!rules.length) {
    return "Always allow this";
  }
  const parts = rules.map((rule) => {
    const tool = rule && (rule.toolName || rule.tool) ? String(rule.toolName || rule.tool) : "";
    const content = rule && (rule.ruleContent || rule.scope || rule.path)
      ? String(rule.ruleContent || rule.scope || rule.path)
      : "";
    if (tool && content) return `${tool} ${content}`;
    return tool || content;
  }).filter(Boolean);
  return parts.length ? `Always allow ${parts.join(", ")}` : "Always allow this";
}

function renderSuggestionList(request) {
  if (!els.suggestionList) {
    return;
  }
  els.suggestionList.replaceChildren();

  const suggestions = request.approvalKind === "permission_request" && Array.isArray(request.permissionSuggestions)
    ? request.permissionSuggestions
    : [];

  suggestions.forEach((suggestion, index) => {
    if (!suggestion || suggestion.behavior !== "allow") {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "allow";
    button.textContent = suggestionLabel(suggestion);
    button.addEventListener("click", () => {
      const requestId = currentRequestId();
      if (requestId) {
        decide(requestId, "always_allow", "Always allow from desktop companion", { suggestionIndex: index });
      }
    });
    els.suggestionList.append(button);
  });
}

function renderAnswerForm(request) {
  const questions = requestQuestions(request);
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "Answer";

  const fields = questions.length ? questions : [{ question: "Answer", options: [] }];
  const children = fields.map((question, index) => {
    const block = document.createElement("div");
    block.className = "question";

    const title = document.createElement("div");
    title.className = "question-title";
    title.textContent = questionKey(question, index);
    block.append(title);

    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length) {
      const list = document.createElement("div");
      list.className = "option-list";
      options.forEach((option) => {
        const label = optionLabel(option);
        if (!label) {
          return;
        }
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          state.selectedAnswers[questionKey(question, index)] = label;
          Array.from(list.children).forEach((item) => item.classList.remove("selected"));
          button.classList.add("selected");
        });
        list.append(button);
      });
      block.append(list);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Other answer";
    input.dataset.questionKey = questionKey(question, index);
    block.append(input);
    return block;
  });

  els.answerForm.replaceChildren(...children, submit);
  els.answerForm.onsubmit = (event) => {
    event.preventDefault();
    const answers = {};
    for (const input of els.answerForm.querySelectorAll("input[data-question-key]")) {
      const key = input.dataset.questionKey;
      const value = input.value.trim() || state.selectedAnswers[key];
      if (!value) {
        input.focus();
        return;
      }
      answers[key] = value;
    }
    decide(request.requestId, "answer", "Answered from desktop companion", { answers });
  };
}

/* ============================================================
   Dashboard rendering (pending queue, sessions, devices,
   pairing, audit events, health footer). Only paints when
   the user is in dashboard mode; cheap no-ops otherwise so
   the renderer doesn't churn on every WebSocket event. */

function renderPendingQueue() {
  if (!els.pendingSection || !els.pendingList) {
    return;
  }
  const activeId = currentRequestId();
  const others = state.requests.filter((req) => req.requestId !== activeId);

  if (els.pendingCount) {
    els.pendingCount.textContent = String(state.requests.length);
  }

  if (!others.length) {
    els.pendingSection.hidden = true;
    els.pendingList.replaceChildren();
    return;
  }

  els.pendingSection.hidden = false;
  const rows = others.map((req) => {
    const row = document.createElement("div");
    row.className = "dash-row";

    const head = document.createElement("div");
    head.className = "dash-row-head";

    const title = document.createElement("span");
    title.className = "dash-row-title";
    title.textContent = req.tool || "Tool request";

    const chip = document.createElement("span");
    chip.className = "dash-chip";
    chip.dataset.risk = req.risk || "low";
    chip.textContent = req.risk || "low";
    head.append(title, chip);
    row.append(head);

    if (req.summary) {
      const summary = document.createElement("span");
      summary.className = "dash-row-summary";
      summary.textContent = req.summary;
      row.append(summary);
    }

    const metaParts = [req.cwd, req.createdAt].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement("span");
      meta.className = "dash-row-meta";
      meta.textContent = metaParts.join(" · ");
      row.append(meta);
    }

    const actions = document.createElement("div");
    actions.className = "dash-row-actions";

    const allowBtn = document.createElement("button");
    allowBtn.type = "button";
    allowBtn.className = "dash-row-action";
    allowBtn.dataset.variant = "approve";
    allowBtn.textContent = "Approve";
    allowBtn.addEventListener("click", () => {
      decide(req.requestId, "allow", "Approved from desktop companion");
    });

    const denyBtn = document.createElement("button");
    denyBtn.type = "button";
    denyBtn.className = "dash-row-action";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => {
      decide(req.requestId, "deny", "Denied from desktop companion");
    });

    actions.append(allowBtn, denyBtn);
    row.append(actions);
    return row;
  });

  els.pendingList.replaceChildren(...rows);
}

function renderSessionsList() {
  if (!els.sessionsList) {
    return;
  }
  if (els.sessionsCount) {
    els.sessionsCount.textContent = String(state.sessions.length);
  }
  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "dash-empty";
    empty.textContent = "No Claude session state yet.";
    els.sessionsList.replaceChildren(empty);
    return;
  }

  const sorted = [...state.sessions].sort((a, b) => {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  const rows = sorted.map((session) => {
    const row = document.createElement("div");
    row.className = "dash-row";

    const head = document.createElement("div");
    head.className = "dash-row-head";
    const title = document.createElement("span");
    title.className = "dash-row-title";
    title.textContent = session.tool || session.hookEventName || "Claude Code";
    const chip = document.createElement("span");
    chip.className = "dash-chip";
    chip.dataset.status = session.status || "idle";
    chip.textContent = session.status || "idle";
    head.append(title, chip);
    row.append(head);

    if (session.summary) {
      const summary = document.createElement("span");
      summary.className = "dash-row-summary";
      summary.textContent = session.summary;
      row.append(summary);
    }

    const sessionShort = session.sessionId ? String(session.sessionId).slice(0, 12) : "";
    const metaParts = [sessionShort, session.cwd, session.updatedAt].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement("span");
      meta.className = "dash-row-meta";
      meta.textContent = metaParts.join(" · ");
      row.append(meta);
    }
    return row;
  });

  els.sessionsList.replaceChildren(...rows);
}

function renderDevices() {
  if (!els.devicesList) {
    return;
  }
  const active = state.devices.filter((device) => !device.revokedAt);
  if (!active.length) {
    const empty = document.createElement("div");
    empty.className = "dash-empty";
    empty.textContent = "No paired devices.";
    els.devicesList.replaceChildren(empty);
    return;
  }

  const rows = active.map((device) => {
    const row = document.createElement("div");
    row.className = "dash-row";

    const head = document.createElement("div");
    head.className = "dash-row-head";
    const title = document.createElement("span");
    title.className = "dash-row-title";
    title.textContent = device.deviceName || "Unnamed device";
    head.append(title);
    row.append(head);

    const idShort = device.deviceId ? String(device.deviceId).slice(0, 10) : "";
    const lastSeen = device.lastSeenAt ? `last seen ${device.lastSeenAt}` : `paired ${device.createdAt || ""}`;
    const meta = document.createElement("span");
    meta.className = "dash-row-meta";
    meta.textContent = [idShort, lastSeen].filter(Boolean).join(" · ");
    row.append(meta);

    const actions = document.createElement("div");
    actions.className = "dash-row-actions";
    const revokeBtn = document.createElement("button");
    revokeBtn.type = "button";
    revokeBtn.className = "dash-row-action";
    revokeBtn.textContent = "Revoke";
    revokeBtn.addEventListener("click", () => revokeDevice(device.deviceId));
    actions.append(revokeBtn);
    row.append(actions);
    return row;
  });

  els.devicesList.replaceChildren(...rows);
}

function describeEvent(ev) {
  if (!ev || typeof ev !== "object") {
    return "";
  }
  if (ev.type === "permission_request") {
    const parts = [ev.tool, ev.risk ? `(${ev.risk})` : "", ev.summary].filter(Boolean);
    return parts.join(" ");
  }
  if (ev.type === "permission_decision") {
    const idShort = ev.requestId ? String(ev.requestId).slice(0, 8) : "";
    const parts = [ev.decision, idShort && `[${idShort}]`, ev.reason].filter(Boolean);
    return parts.join(" ");
  }
  if (ev.type === "device_paired" || ev.type === "device_revoked") {
    return ev.deviceName || ev.deviceId || "";
  }
  return "";
}

function renderEvents() {
  if (!els.eventsList) {
    return;
  }
  const recent = state.events.slice(-30).reverse();
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "dash-empty";
    empty.textContent = "No audit events yet.";
    els.eventsList.replaceChildren(empty);
    return;
  }

  const rows = recent.map((ev) => {
    const row = document.createElement("div");
    row.className = "dash-event-row";
    row.dataset.type = ev.type || "";

    const time = document.createElement("time");
    if (ev.createdAt) {
      const date = new Date(ev.createdAt);
      time.textContent = Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    const desc = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = ev.type || "event";
    desc.append(strong);
    const detail = describeEvent(ev);
    if (detail) {
      desc.append(" ", document.createTextNode(detail));
    }

    row.append(time, desc);
    return row;
  });

  els.eventsList.replaceChildren(...rows);
}

function renderHealth() {
  if (!els.dashHealthLabel || !els.dashHealthMeta) {
    return;
  }
  const live = state.connected;
  els.dashHealthLabel.textContent = live ? "live" : "offline";
  const footer = els.dashHealthLabel.closest(".dash-footer");
  if (footer) {
    footer.dataset.state = live ? "live" : "offline";
  }

  const sessionsLabel = `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`;
  const pendingLabel = `${state.requests.length} pending`;
  els.dashHealthMeta.textContent = [pendingLabel, sessionsLabel, "127.0.0.1:4317"].join(" · ");
}

async function fetchDevices() {
  try {
    const data = await fetchJson("/devices");
    state.devices = Array.isArray(data.devices) ? data.devices : [];
  } catch (_error) {
    state.devices = [];
  }
  renderDevices();
}

async function fetchEvents() {
  try {
    const data = await fetchJson("/events");
    state.events = Array.isArray(data.events) ? data.events : [];
  } catch (_error) {
    state.events = [];
  }
  renderEvents();
}

async function revokeDevice(deviceId) {
  if (!deviceId) {
    return;
  }
  try {
    await fetchJson("/devices/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId })
    });
  } catch (_error) {
    // No retry — user will see the device still listed and can try again.
  }
  fetchDevices();
}

async function generatePairingToken() {
  if (!els.pairingPanel || !els.pairingTokenValue || !els.pairingTokenMeta) {
    return;
  }
  if (pairingHideTimer) {
    clearTimeout(pairingHideTimer);
    pairingHideTimer = null;
  }
  els.pairingPanel.hidden = false;
  els.pairingTokenValue.textContent = "...";
  els.pairingTokenMeta.textContent = "";

  try {
    const data = await fetchJson("/pairing-token");
    els.pairingTokenValue.textContent = data.pairingToken || "";
    if (data.expiresAt) {
      els.pairingTokenMeta.textContent = `expires ${data.expiresAt}`;
      const ttl = new Date(data.expiresAt).getTime() - Date.now();
      if (Number.isFinite(ttl) && ttl > 0) {
        pairingHideTimer = setTimeout(() => {
          pairingHideTimer = null;
          els.pairingPanel.hidden = true;
          els.pairingTokenValue.textContent = "";
          els.pairingTokenMeta.textContent = "";
        }, ttl);
      }
    }
  } catch (error) {
    els.pairingTokenValue.textContent = "";
    els.pairingTokenMeta.textContent = `error: ${error.message}`;
  }
}

function refreshDashboardSnapshot() {
  if (state.mode !== "dashboard") {
    return;
  }
  fetchDevices();
  if (state.eventsExpanded) {
    fetchEvents();
  }
}

function render() {
  renderSession();
  renderRequest();
  renderPendingQueue();
  renderSessionsList();
  renderHealth();
  if (state.eventsExpanded) {
    renderEvents();
  }
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${DAEMON_ORIGIN}${pathname}`, {
    cache: "no-store",
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function refresh() {
  try {
    const [sessions, pending] = await Promise.all([
      fetchJson("/sessions"),
      fetchJson("/pending-requests")
    ]);
    state.sessions = sessions.sessions || [];
    state.requests = pending.requests || [];
  } catch (_error) {
    state.connected = false;
  }
  // Audit events change on every approval flow; refresh them too when the
  // user has the events drawer open. Devices are touched only on pair /
  // revoke so we don't refetch them on each tick — see refreshDashboardSnapshot.
  if (state.mode === "dashboard" && state.eventsExpanded) {
    fetchEvents();
  }
  render();
}

function connectSocket() {
  const socket = new WebSocket(WS_URL);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.connected = true;
    if (state.mode === "dashboard") {
      refreshDashboardSnapshot();
    }
    render();
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_error) {
      return;
    }

    if (message.type === "hello") {
      state.sessions = message.sessions || [];
      state.requests = message.requests || [];
      render();
      return;
    }

    if (message.type === "session_states_snapshot") {
      state.sessions = message.sessions || [];
      render();
      return;
    }

    if (message.type === "pending_requests_snapshot") {
      state.requests = message.requests || [];
      render();
      return;
    }

    if (message.type === "permission_request" || message.type === "permission_decision_result") {
      refresh();
    }
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    render();
    setTimeout(connectSocket, 1200);
  });

  socket.addEventListener("error", () => {
    state.connected = false;
    render();
  });
}

async function decide(requestId, decision, reason, extra = {}) {
  const payload = {
    type: "permission_decision",
    requestId,
    decision,
    reason,
    ...extra
  };

  if (state.connected && state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
    window.setTimeout(refresh, 120);
    return;
  }

  await fetchJson("/permission-decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  await refresh();
}

function currentRequestId() {
  const request = activeRequest();
  return request && request.requestId;
}

els.approveRequest.addEventListener("click", () => {
  const requestId = currentRequestId();
  if (requestId) {
    decide(requestId, "allow", "Approved from desktop companion");
  }
});

els.denyRequest.addEventListener("click", () => {
  const requestId = currentRequestId();
  if (!requestId) {
    return;
  }
  decide(requestId, "deny", "Denied from desktop companion");
});

if (els.refreshNow) {
  els.refreshNow.addEventListener("click", refresh);
}
if (els.openDashboard) {
  els.openDashboard.addEventListener("click", () => window.companionDesktop.openDashboard());
}
if (els.generatePairingToken) {
  els.generatePairingToken.addEventListener("click", generatePairingToken);
}
if (els.toggleEvents && els.eventsList) {
  els.toggleEvents.addEventListener("click", () => {
    state.eventsExpanded = !state.eventsExpanded;
    els.eventsList.hidden = !state.eventsExpanded;
    els.toggleEvents.textContent = state.eventsExpanded ? "Hide" : "Show";
    els.toggleEvents.setAttribute("aria-expanded", String(state.eventsExpanded));
    if (state.eventsExpanded) {
      fetchEvents();
    }
  });
}
if (els.maximizeWindow) {
  els.maximizeWindow.addEventListener("click", () => {
    // Smart expand: collapse if already expanded; otherwise pick the right
    // expanded mode based on what's live. A pending request snaps to its
    // approval / question card; an idle bubble opens the dashboard so the
    // gear and square buttons aren't fighting for "show the overview."
    if (state.mode !== "compact") {
      window.companionDesktop.setMode("compact");
      return;
    }
    const request = activeRequest();
    if (request) {
      window.companionDesktop.setMode(isQuestionRequest(request) ? "question" : "approval");
      return;
    }
    window.companionDesktop.setMode("dashboard");
  });
}
if (els.minimizeWindow) {
  els.minimizeWindow.addEventListener("click", () => window.companionDesktop.minimize());
}
if (els.closeWindow) {
  els.closeWindow.addEventListener("click", () => window.companionDesktop.close());
}

function applyEnabledState(enabled) {
  if (enabled) {
    delete document.body.dataset.companionDisabled;
    if (els.toggleEnabled) {
      els.toggleEnabled.title = "Disable Companion approvals (fall back to terminal)";
      els.toggleEnabled.setAttribute("aria-pressed", "false");
    }
  } else {
    document.body.dataset.companionDisabled = "true";
    if (els.toggleEnabled) {
      els.toggleEnabled.title = "Enable Companion approvals";
      els.toggleEnabled.setAttribute("aria-pressed", "true");
    }
  }
}

if (els.toggleEnabled && window.companionDesktop.getEnabled) {
  window.companionDesktop.getEnabled().then(applyEnabledState);
  els.toggleEnabled.addEventListener("click", async () => {
    const next = document.body.dataset.companionDisabled === "true";
    const result = await window.companionDesktop.setEnabled(next);
    applyEnabledState(result);
  });
}

if (window.companionDesktop.onEnabledChanged) {
  window.companionDesktop.onEnabledChanged(applyEnabledState);
}

window.companionDesktop.onModeChanged((mode) => {
  const previous = state.mode;
  state.mode = mode;
  document.body.dataset.mode = mode;

  // Entering dashboard mode pulls fresh device + event data once. The
  // pending queue, sessions, and health footer paint from existing state.
  if (mode === "dashboard" && previous !== "dashboard") {
    refreshDashboardSnapshot();
  }
  // Mode flips reshape what's visible (active-request vs full feed), so
  // re-render once the new data-mode attribute is set on <body>.
  render();
});

window.companionDesktop.onPeekChanged((peeking) => {
  document.body.dataset.peeking = peeking ? "true" : "false";
});

if (window.companionDesktop.onSnapChanged) {
  window.companionDesktop.onSnapChanged((edges) => {
    if (edges.horizontal) {
      document.body.dataset.snapHorizontal = String(edges.horizontal);
    } else {
      delete document.body.dataset.snapHorizontal;
    }
    if (edges.vertical) {
      document.body.dataset.snapVertical = String(edges.vertical);
    } else {
      delete document.body.dataset.snapVertical;
    }
  });
}

if (window.companionDesktop.onAttentionChanged) {
  window.companionDesktop.onAttentionChanged((attention) => {
    state.attention = attention || null;
    if (attention) {
      document.body.dataset.attention = String(attention);
    } else {
      delete document.body.dataset.attention;
    }
  });
}

initIslandColorPicker();

const HOVER_TO_EXPAND_MS = 100;
const LEAVE_TO_COLLAPSE_MS = 320;
// Window controls strip (power / color / gear / expand / minus) is JS-driven
// instead of pure :hover so a brief drift off the painted capsule — into the
// transparent 12 px BrowserWindow gutter, or a 1-frame hover flicker while
// the window animates between compact and hover widths — doesn't snap the
// strip closed mid-reach. Show is instant; hide waits CONTROLS_LEAVE_GRACE_MS.
const CONTROLS_LEAVE_GRACE_MS = 420;
let peekHoverTimer = null;
let peekLeaveTimer = null;
let controlsHideTimer = null;

function acknowledgeAttentionFromPointer() {
  if (state.attention && window.companionDesktop.ackAttention) {
    state.attention = null;
    window.companionDesktop.ackAttention();
  }
}

function showWindowControls() {
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  document.body.dataset.controls = "visible";
}

function controlsKeepAliveFocused() {
  const active = document.activeElement;
  return !!(active && active !== document.body && active.closest && active.closest(".window-actions"));
}

function scheduleHideWindowControls() {
  if (controlsHideTimer) {
    return;
  }
  if (controlsKeepAliveFocused()) {
    return;
  }
  controlsHideTimer = setTimeout(() => {
    controlsHideTimer = null;
    if (controlsKeepAliveFocused()) {
      return;
    }
    delete document.body.dataset.controls;
  }, CONTROLS_LEAVE_GRACE_MS);
}

document.body.addEventListener("pointerenter", () => {
  acknowledgeAttentionFromPointer();
  showWindowControls();

  // Compact mode uses hover to expand the tiny island or reveal the edge peek.
  // Approval and question modes stay fully visible so the request is actionable.
  if (state.mode !== "compact") {
    return;
  }
  if (peekLeaveTimer) {
    clearTimeout(peekLeaveTimer);
    peekLeaveTimer = null;
  }
  if (peekHoverTimer) {
    return;
  }
  peekHoverTimer = setTimeout(() => {
    peekHoverTimer = null;
    window.companionDesktop.peekHover();
  }, HOVER_TO_EXPAND_MS);
});

document.body.addEventListener("pointermove", () => {
  acknowledgeAttentionFromPointer();
  // Cheap re-assertion: any cursor motion inside the BrowserWindow keeps the
  // controls strip alive and cancels a pending hide.
  showWindowControls();

  // When the bubble peeks past a screen edge, the window slides out from
  // under the cursor without dispatching pointerleave/enter — so a later
  // hover never re-fires pointerenter and the slit feels dead. pointermove
  // always fires on cursor movement, so it's the reliable hover signal here.
  if (state.mode !== "compact") {
    return;
  }
  if (document.body.dataset.peeking !== "true") {
    return;
  }
  if (peekLeaveTimer) {
    clearTimeout(peekLeaveTimer);
    peekLeaveTimer = null;
  }
  if (peekHoverTimer) {
    return;
  }
  peekHoverTimer = setTimeout(() => {
    peekHoverTimer = null;
    window.companionDesktop.peekHover();
  }, HOVER_TO_EXPAND_MS);
});

document.body.addEventListener("pointerleave", () => {
  scheduleHideWindowControls();

  if (state.mode !== "compact") {
    return;
  }
  if (peekHoverTimer) {
    clearTimeout(peekHoverTimer);
    peekHoverTimer = null;
  }
  if (peekLeaveTimer) {
    return;
  }
  peekLeaveTimer = setTimeout(() => {
    peekLeaveTimer = null;
    window.companionDesktop.peekUnhover();
  }, LEAVE_TO_COLLAPSE_MS);
});

// If a control had focus and then loses it (e.g., color picker dialog closes),
// run the leave check so the strip can fade out cleanly.
document.addEventListener("focusout", () => {
  if (document.body.dataset.controls === "visible" && !document.body.matches(":hover")) {
    scheduleHideWindowControls();
  }
});

connectSocket();
refresh();
setInterval(() => {
  if (!state.connected) {
    refresh();
  }
}, 1800);
