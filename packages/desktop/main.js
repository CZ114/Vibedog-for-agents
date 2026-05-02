#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

// Same path the hook scripts check via shared/protocol.js#isCompanionDisabled.
const COMPANION_DIR = path.join(os.homedir(), ".claude-companion");
const COMPANION_DISABLED_FLAG = path.join(COMPANION_DIR, "disabled");
const DESKTOP_STATE_FILE = path.join(COMPANION_DIR, "desktop-state.json");
const DESKTOP_STATE_VERSION = 1;
const DESKTOP_STATE_WRITE_DELAY_MS = 220;
const WINDOW_PRIORITY_REAPPLY_MS = 2500;

function readCompanionEnabled() {
  try {
    return !fs.existsSync(COMPANION_DISABLED_FLAG);
  } catch (_error) {
    return true;
  }
}

function setCompanionEnabled(enabled) {
  try {
    if (enabled) {
      if (fs.existsSync(COMPANION_DISABLED_FLAG)) {
        fs.unlinkSync(COMPANION_DISABLED_FLAG);
      }
    } else {
      fs.mkdirSync(COMPANION_DIR, { recursive: true });
      fs.writeFileSync(COMPANION_DISABLED_FLAG, "1", "utf8");
    }
  } catch (error) {
    console.warn(`[warn] Failed to flip companion-disabled flag: ${error.message}`);
  }
  if (mainWindow) {
    mainWindow.webContents.send("companion:enabled-changed", enabled);
  }
  return enabled;
}

// CAPSULE_BOUNDS = the visible bubble (what the user perceives as the
// island). MODE_BOUNDS adds BUBBLE_PADDING on every side so the soft drop
// shadow has somewhere to render — Win11 won't paint a rectangle in the
// gutter as long as the BrowserWindow opts out of thickFrame, mica, and
// roundedCorners (see createWindow).
const BUBBLE_PADDING = 12;
const CAPSULE_BOUNDS = {
  compact: { width: 124, height: 42 },
  approval: { width: 360, height: 238 },
  question: { width: 360, height: 300 },
  // dashboard: full overview that replaces the legacy browser dashboard at
  // http://127.0.0.1:4317/ — pending queue, sessions, devices, pairing,
  // audit events, health footer. Internal scroll handles overflow.
  dashboard: { width: 420, height: 540 }
};
const COMPACT_HOVER_CAPSULE = { width: 224, height: 42 };
function paddedBounds(b) {
  return { width: b.width + 2 * BUBBLE_PADDING, height: b.height + 2 * BUBBLE_PADDING };
}
const MODE_BOUNDS = {
  compact: paddedBounds(CAPSULE_BOUNDS.compact),
  approval: paddedBounds(CAPSULE_BOUNDS.approval),
  question: paddedBounds(CAPSULE_BOUNDS.question),
  dashboard: paddedBounds(CAPSULE_BOUNDS.dashboard)
};
const COMPACT_HOVER_BOUNDS = paddedBounds(COMPACT_HOVER_CAPSULE);
const EDGE_PADDING = 8;
const SNAP_DISTANCE = 48;
const SNAP_DETACH_DISTANCE = 24;
const SNAP_REATTACH_COOLDOWN_MS = 650;
const MOVE_DEBOUNCE_MS = 160;
const PEEK_VISIBLE_PX = 12;
const AUTO_PEEK_ON_EDGE = true;
const HOVER_COLLAPSE_DELAY_MS = 280;
const HOVER_MIN_VISIBLE_MS = 700;
const HOVER_HYSTERESIS_PX = 18;
// How long the bubble stays expanded after a session reaches `done` while
// snapped at an edge. After this it tucks back into a peek slit, but the
// peek slit keeps pulsing (see styles.css peekDoneGlow) until the user
// actually moves the pointer over it.
const DONE_ATTENTION_MS = 10 * 60 * 1000;

let mainWindow = null;
let currentMode = "compact";
let boundsAnimation = null;
let snappedEdges = { horizontal: null, vertical: null };
let snapDebounceTimer = null;
let isPeeking = false;
let compactHoverExpanded = false;
let snapSuppressedUntil = 0;
let compactCollapseTimer = null;
let compactHoverVisibleSince = 0;
let attentionState = null;
let doneAttentionTimer = null;
let peekHoverPollTimer = null;
let desktopStateWriteTimer = null;
let windowPriorityTimer = null;
let initialDesktopState = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function normalizeEdge(value, allowed) {
  return allowed.includes(value) ? value : null;
}

function normalizeSnappedEdges(value) {
  const edges = value && typeof value === "object" ? value : {};
  return {
    horizontal: normalizeEdge(edges.horizontal, ["left", "right"]),
    vertical: normalizeEdge(edges.vertical, ["top", "bottom"])
  };
}

function normalizeMode(value) {
  return MODE_BOUNDS[value] ? value : "compact";
}

function isPlainBounds(value) {
  return value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height);
}

function readDesktopState() {
  const state = readJsonFile(DESKTOP_STATE_FILE);
  if (!state || state.version !== DESKTOP_STATE_VERSION) {
    return null;
  }

  const mode = normalizeMode(state.mode);
  const edges = normalizeSnappedEdges(state.snappedEdges);
  const bounds = isPlainBounds(state.bounds) ? state.bounds : null;
  return {
    mode,
    bounds,
    snappedEdges: edges,
    isPeeking: Boolean(state.isPeeking && mode === "compact" && (edges.horizontal || edges.vertical))
  };
}

function displayForBounds(bounds) {
  const { screen } = require("electron");
  if (bounds) {
    return screen.getDisplayMatching(bounds);
  }
  return screen.getPrimaryDisplay();
}

function clampBoundsToWorkArea(bounds) {
  const display = displayForBounds(bounds);
  const workArea = display.workArea;
  const maxX = workArea.x + workArea.width - bounds.width + BUBBLE_PADDING;
  const maxY = workArea.y + workArea.height - bounds.height + BUBBLE_PADDING;
  return {
    ...bounds,
    x: clamp(bounds.x, workArea.x - BUBBLE_PADDING, maxX),
    y: clamp(bounds.y, workArea.y - BUBBLE_PADDING, maxY)
  };
}

function defaultInitialBounds() {
  const { screen } = require("electron");
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const initial = MODE_BOUNDS.compact;
  return {
    width: initial.width,
    height: initial.height,
    x: workArea.x + Math.round((workArea.width - initial.width) / 2),
    y: workArea.y + 18
  };
}

function initialBoundsFromDesktopState(state) {
  if (!state || !state.bounds) {
    return defaultInitialBounds();
  }

  const mode = normalizeMode(state.mode);
  const size = MODE_BOUNDS[mode] || MODE_BOUNDS.compact;
  return clampBoundsToWorkArea({
    x: Math.round(state.bounds.x),
    y: Math.round(state.bounds.y),
    width: size.width,
    height: size.height
  });
}

function desktopStateSnapshot() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }
  const { screen } = require("electron");
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    version: DESKTOP_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    mode: currentMode,
    bounds,
    snappedEdges,
    isPeeking,
    displayId: display.id
  };
}

function writeDesktopStateNow() {
  const snapshot = desktopStateSnapshot();
  if (!snapshot) {
    return;
  }
  try {
    fs.mkdirSync(COMPANION_DIR, { recursive: true });
    fs.writeFileSync(DESKTOP_STATE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`[warn] Failed to persist desktop state: ${error.message}`);
  }
}

function scheduleDesktopStateSave() {
  if (desktopStateWriteTimer) {
    clearTimeout(desktopStateWriteTimer);
  }
  desktopStateWriteTimer = setTimeout(() => {
    desktopStateWriteTimer = null;
    writeDesktopStateNow();
  }, DESKTOP_STATE_WRITE_DELAY_MS);
}

function compactSize() {
  return compactHoverExpanded ? COMPACT_HOVER_BOUNDS : MODE_BOUNDS.compact;
}

// All snap math operates on the BrowserWindow size, but the user perceives
// the CAPSULE (BrowserWindow minus BUBBLE_PADDING gutter on every side).
// Helper to translate desired capsule-edge offsets into BrowserWindow ones.
function snapInset(mode) {
  const edgeGap = mode === "compact" ? 0 : EDGE_PADDING;
  return edgeGap - BUBBLE_PADDING;
}

function targetBoundsForMode(mode) {
  const { screen } = require("electron");
  const size = mode === "compact" ? compactSize() : MODE_BOUNDS[mode] || MODE_BOUNDS.compact;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const inset = snapInset(mode);
  const centeredX = current.x + Math.round((current.width - size.width) / 2);
  let x = clamp(centeredX, workArea.x + inset, workArea.x + workArea.width - size.width - inset);
  let y = clamp(current.y, workArea.y + inset, workArea.y + workArea.height - size.height - inset);

  if (snappedEdges.horizontal === "left") {
    x = workArea.x + inset;
  } else if (snappedEdges.horizontal === "right") {
    x = workArea.x + workArea.width - size.width - inset;
  }

  if (snappedEdges.vertical === "top") {
    y = workArea.y + inset;
  } else if (snappedEdges.vertical === "bottom") {
    y = workArea.y + workArea.height - size.height - inset;
  }

  return { x, y, width: size.width, height: size.height };
}

function animateWindowBounds(target, durationMs = 190, onComplete) {
  if (!mainWindow) {
    return;
  }

  if (boundsAnimation) {
    clearInterval(boundsAnimation);
    boundsAnimation = null;
  }

  const start = mainWindow.getBounds();
  const startedAt = Date.now();

  boundsAnimation = setInterval(() => {
    if (!mainWindow) {
      clearInterval(boundsAnimation);
      boundsAnimation = null;
      return;
    }

    const progress = clamp((Date.now() - startedAt) / durationMs, 0, 1);
    const eased = easeOutCubic(progress);
    const next = {
      x: Math.round(start.x + (target.x - start.x) * eased),
      y: Math.round(start.y + (target.y - start.y) * eased),
      width: Math.round(start.width + (target.width - start.width) * eased),
      height: Math.round(start.height + (target.height - start.height) * eased)
    };

    mainWindow.setBounds(next);

    if (progress >= 1) {
      clearInterval(boundsAnimation);
      boundsAnimation = null;
      mainWindow.setBounds(target);
      if (typeof onComplete === "function") {
        onComplete();
      }
    }
  }, 16);
}

function compactSnappedBounds(expanded = compactHoverExpanded) {
  // For compact + snapped, the CAPSULE is flush with the work area edge.
  // The BrowserWindow extends BUBBLE_PADDING past the edge so the gutter
  // (where the shadow renders) overhangs into the screen bezel area.
  const { screen } = require("electron");
  const size = expanded ? COMPACT_HOVER_BOUNDS : MODE_BOUNDS.compact;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const inset = -BUBBLE_PADDING; // capsule-flush in compact mode
  const centeredX = current.x + Math.round((current.width - size.width) / 2);
  let x = clamp(centeredX, workArea.x + inset, workArea.x + workArea.width - size.width - inset);
  let y = clamp(current.y, workArea.y + inset, workArea.y + workArea.height - size.height - inset);

  if (snappedEdges.horizontal === "left") {
    x = workArea.x + inset;
  } else if (snappedEdges.horizontal === "right") {
    x = workArea.x + workArea.width - size.width - inset;
  }

  if (snappedEdges.vertical === "top") {
    y = workArea.y + inset;
  } else if (snappedEdges.vertical === "bottom") {
    y = workArea.y + workArea.height - size.height - inset;
  }

  return { x, y, width: size.width, height: size.height };
}

function compactPeekBounds() {
  const full = compactSnappedBounds();
  const result = { ...full };

  // Show PEEK_VISIBLE_PX of the CAPSULE past the snapped edge. We have to
  // subtract 2*BUBBLE_PADDING because the BrowserWindow already overhangs
  // the work area by BUBBLE_PADDING in compactSnappedBounds AND the shift
  // needs to expose only the capsule (not the gutter) in the visible PEEK.
  const capsuleSpan = (axis) => axis === "x"
    ? full.width - 2 * BUBBLE_PADDING - PEEK_VISIBLE_PX
    : full.height - 2 * BUBBLE_PADDING - PEEK_VISIBLE_PX;

  if (snappedEdges.horizontal === "left") {
    result.x = full.x - capsuleSpan("x");
  } else if (snappedEdges.horizontal === "right") {
    result.x = full.x + capsuleSpan("x");
  } else if (snappedEdges.vertical === "top") {
    result.y = full.y - capsuleSpan("y");
  } else if (snappedEdges.vertical === "bottom") {
    result.y = full.y + capsuleSpan("y");
  }

  return result;
}

function isSnapped() {
  return Boolean(snappedEdges.horizontal || snappedEdges.vertical);
}

function sendSnapChanged() {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send("window:snap-changed", snappedEdges);
}

function sendAttentionChanged() {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send("window:attention-changed", attentionState);
}

function reinforceWindowPriority() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!mainWindow.isMinimized() && mainWindow.isVisible()) {
      mainWindow.moveTop();
    }
  } catch (error) {
    console.warn(`[warn] Failed to reinforce desktop window priority: ${error.message}`);
  }
}

function startWindowPriorityGuard() {
  reinforceWindowPriority();
  if (windowPriorityTimer) {
    clearInterval(windowPriorityTimer);
  }
  windowPriorityTimer = setInterval(reinforceWindowPriority, WINDOW_PRIORITY_REAPPLY_MS);
}

function stopWindowPriorityGuard() {
  if (windowPriorityTimer) {
    clearInterval(windowPriorityTimer);
    windowPriorityTimer = null;
  }
}

function setAttentionState(nextState) {
  const normalized = nextState || null;
  if (attentionState === normalized) {
    return;
  }
  attentionState = normalized;
  sendAttentionChanged();
}

function clearCompactCollapseTimer() {
  if (compactCollapseTimer) {
    clearTimeout(compactCollapseTimer);
    compactCollapseTimer = null;
  }
}

function clearDoneAttentionTimer() {
  if (doneAttentionTimer) {
    clearTimeout(doneAttentionTimer);
    doneAttentionTimer = null;
  }
}

function clearDoneAttention() {
  clearDoneAttentionTimer();
  setAttentionState(null);
}

function pointInBounds(point, bounds, padding = 0) {
  return point.x >= bounds.x - padding &&
    point.x <= bounds.x + bounds.width + padding &&
    point.y >= bounds.y - padding &&
    point.y <= bounds.y + bounds.height + padding;
}

function distanceFromSnappedEdge(bounds) {
  if (!isSnapped()) {
    return 0;
  }

  const { screen } = require("electron");
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const values = [];

  // Reference values are in CAPSULE coords; subtract BUBBLE_PADDING to bring
  // them back to BrowserWindow coords (since `bounds` is the BrowserWindow
  // and is offset by the gutter).
  if (snappedEdges.horizontal === "left") {
    const reference = isPeeking
      ? workArea.x - (bounds.width - BUBBLE_PADDING - PEEK_VISIBLE_PX)
      : workArea.x - BUBBLE_PADDING;
    values.push(bounds.x - reference);
  } else if (snappedEdges.horizontal === "right") {
    const reference = isPeeking
      ? workArea.x + workArea.width - PEEK_VISIBLE_PX - BUBBLE_PADDING
      : workArea.x + workArea.width - bounds.width + BUBBLE_PADDING;
    values.push(reference - bounds.x);
  }

  if (snappedEdges.vertical === "top") {
    const reference = isPeeking
      ? workArea.y - (bounds.height - BUBBLE_PADDING - PEEK_VISIBLE_PX)
      : workArea.y - BUBBLE_PADDING;
    values.push(bounds.y - reference);
  } else if (snappedEdges.vertical === "bottom") {
    const reference = isPeeking
      ? workArea.y + workArea.height - PEEK_VISIBLE_PX - BUBBLE_PADDING
      : workArea.y + workArea.height - bounds.height + BUBBLE_PADDING;
    values.push(reference - bounds.y);
  }

  return Math.max(...values.map((value) => Math.max(0, value)), 0);
}

function detachFromEdge() {
  if (!mainWindow || !isSnapped()) {
    return;
  }

  snappedEdges = { horizontal: null, vertical: null };
  isPeeking = false;
  compactHoverExpanded = false;
  clearCompactCollapseTimer();
  clearDoneAttention();
  snapSuppressedUntil = Date.now() + SNAP_REATTACH_COOLDOWN_MS;
  mainWindow.webContents.send("window:peek-changed", false);
  sendSnapChanged();
  scheduleDesktopStateSave();
}

function enterPeek() {
  if (!mainWindow || isPeeking) {
    return;
  }
  if (!AUTO_PEEK_ON_EDGE) {
    return;
  }
  if (currentMode !== "compact" || !isSnapped()) {
    return;
  }
  clearCompactCollapseTimer();
  compactHoverExpanded = false;
  isPeeking = true;
  animateWindowBounds(compactPeekBounds(), 180, scheduleDesktopStateSave);
  mainWindow.webContents.send("window:peek-changed", true);
  startPeekHoverPolling();
}

function exitPeek() {
  if (!mainWindow || !isPeeking) {
    return;
  }
  isPeeking = false;
  stopPeekHoverPolling();
  if (currentMode === "compact" && isSnapped()) {
    compactHoverExpanded = true;
    compactHoverVisibleSince = Date.now();
    animateWindowBounds(compactSnappedBounds(true), 170, scheduleDesktopStateSave);
  }
  mainWindow.webContents.send("window:peek-changed", false);
}

// The renderer's pointerenter/pointerleave fire stale signals after the
// window slides off-screen for peek — Chromium doesn't synthesize an enter
// event when the bounds shift out from under a stationary cursor. Polling
// the OS cursor directly here bypasses the whole web hover state machine.
function startPeekHoverPolling() {
  if (peekHoverPollTimer || !mainWindow) {
    return;
  }
  peekHoverPollTimer = setInterval(() => {
    if (!mainWindow || !isPeeking) {
      stopPeekHoverPolling();
      return;
    }
    const { screen } = require("electron");
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    if (pointInBounds(cursor, bounds)) {
      stopPeekHoverPolling();
      setCompactHover(true);
    }
  }, 80);
}

function stopPeekHoverPolling() {
  if (peekHoverPollTimer) {
    clearInterval(peekHoverPollTimer);
    peekHoverPollTimer = null;
  }
}

function collapseCompactHoverNow() {
  if (!mainWindow || currentMode !== "compact") {
    return;
  }

  compactHoverExpanded = false;
  if (isSnapped()) {
    enterPeek();
    return;
  }

  animateWindowBounds(targetBoundsForMode("compact"), 150);
}

function scheduleCompactCollapse() {
  if (!mainWindow || currentMode !== "compact") {
    return;
  }

  clearCompactCollapseTimer();
  const visibleFor = Date.now() - compactHoverVisibleSince;
  const delay = Math.max(HOVER_COLLAPSE_DELAY_MS, HOVER_MIN_VISIBLE_MS - visibleFor);

  compactCollapseTimer = setTimeout(() => {
    compactCollapseTimer = null;

    if (!mainWindow || currentMode !== "compact") {
      return;
    }

    const { screen } = require("electron");
    const cursor = screen.getCursorScreenPoint();
    if (pointInBounds(cursor, mainWindow.getBounds(), HOVER_HYSTERESIS_PX)) {
      scheduleCompactCollapse();
      return;
    }

    collapseCompactHoverNow();
  }, delay);
}

function setCompactHover(expanded) {
  if (!mainWindow || currentMode !== "compact") {
    return;
  }

  if (expanded) {
    clearCompactCollapseTimer();
    clearDoneAttention();
    if (compactHoverExpanded && !isPeeking) {
      return;
    }
    compactHoverExpanded = true;
    compactHoverVisibleSince = Date.now();
    if (isPeeking) {
      exitPeek();
      return;
    }
    const target = isSnapped() ? compactSnappedBounds(true) : targetBoundsForMode("compact");
    animateWindowBounds(target, 170);
    return;
  }

  scheduleCompactCollapse();
}

function setIslandMode(mode) {
  if (!mainWindow) {
    return { mode: currentMode };
  }

  // Switching mode invalidates any prior peek state; leaving compact takes
  // the window to a different size/position; entering compact may want to
  // re-engage peek after the animation settles.
  isPeeking = false;
  compactHoverExpanded = false;
  clearCompactCollapseTimer();
  clearDoneAttention();
  currentMode = MODE_BOUNDS[mode] ? mode : "compact";
  const target = currentMode === "compact" && isSnapped()
    ? compactSnappedBounds()
    : targetBoundsForMode(currentMode);
  animateWindowBounds(target, 190, () => {
    if (currentMode === "compact" && isSnapped()) {
      enterPeek();
    } else {
      scheduleDesktopStateSave();
    }
  });
  mainWindow.webContents.send("window:mode-changed", currentMode);
  mainWindow.webContents.send("window:peek-changed", false);
  sendSnapChanged();
  return { mode: currentMode };
}

function triggerDoneAttention() {
  if (!mainWindow || currentMode !== "compact" || !isSnapped()) {
    return { shown: false };
  }

  clearDoneAttentionTimer();
  clearCompactCollapseTimer();
  isPeeking = false;
  compactHoverExpanded = true;
  compactHoverVisibleSince = Date.now();
  setAttentionState("done");
  animateWindowBounds(compactSnappedBounds(true), 190);
  mainWindow.webContents.send("window:peek-changed", false);

  doneAttentionTimer = setTimeout(() => {
    doneAttentionTimer = null;

    if (!mainWindow || currentMode !== "compact") {
      return;
    }

    const { screen } = require("electron");
    const cursor = screen.getCursorScreenPoint();
    if (pointInBounds(cursor, mainWindow.getBounds(), HOVER_HYSTERESIS_PX)) {
      compactHoverVisibleSince = Date.now();
      scheduleCompactCollapse();
      return;
    }

    compactHoverExpanded = false;
    if (isSnapped()) {
      enterPeek();
      return;
    }
    animateWindowBounds(targetBoundsForMode("compact"), 150);
  }, DONE_ATTENTION_MS);

  return { shown: true };
}

function scheduleSnapAfterMove() {
  // On Windows, "moved" fires continuously during a drag and also during our
  // own animateWindowBounds setBounds calls. Snap only after the user has
  // actually stopped moving, and never during a programmatic animation.
  if (boundsAnimation) {
    return;
  }

  if (isSnapped() && distanceFromSnappedEdge(mainWindow.getBounds()) > SNAP_DETACH_DISTANCE) {
    detachFromEdge();
  }

  // The user is moving the window themselves; drop any peek state without
  // animating, otherwise a programmatic slide would fight the cursor.
  if (isPeeking) {
    isPeeking = false;
    mainWindow.webContents.send("window:peek-changed", false);
  }
  if (snapDebounceTimer) {
    clearTimeout(snapDebounceTimer);
  }
  snapDebounceTimer = setTimeout(() => {
    snapDebounceTimer = null;
    snapWindowToNearbyEdge();
  }, MOVE_DEBOUNCE_MS);
  scheduleDesktopStateSave();
}

function snapWindowToNearbyEdge() {
  if (!mainWindow || boundsAnimation) {
    return;
  }
  if (attentionState === "done") {
    return;
  }
  if (Date.now() < snapSuppressedUntil) {
    return;
  }

  const { screen } = require("electron");
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const distances = {
    left: Math.abs(bounds.x - workArea.x),
    right: Math.abs(workArea.x + workArea.width - (bounds.x + bounds.width)),
    top: Math.abs(bounds.y - workArea.y),
    bottom: Math.abs(workArea.y + workArea.height - (bounds.y + bounds.height))
  };

  const horizontal = distances.left <= SNAP_DISTANCE
    ? "left"
    : distances.right <= SNAP_DISTANCE
      ? "right"
      : null;
  const vertical = distances.top <= SNAP_DISTANCE
    ? "top"
    : distances.bottom <= SNAP_DISTANCE
      ? "bottom"
      : null;

  snappedEdges = { horizontal, vertical };
  sendSnapChanged();

  if (!horizontal && !vertical) {
    scheduleDesktopStateSave();
    return;
  }

  // The capsule should sit flush in compact mode, with EDGE_PADDING gap in
  // expanded modes. snapInset() returns the BrowserWindow inset (negative
  // because the gutter overhangs past the work area edge).
  const inset = snapInset(currentMode);
  const target = {
    x: horizontal === "left"
      ? workArea.x + inset
      : horizontal === "right"
        ? workArea.x + workArea.width - bounds.width - inset
        : clamp(bounds.x, workArea.x + inset, workArea.x + workArea.width - bounds.width - inset),
    y: vertical === "top"
      ? workArea.y + inset
      : vertical === "bottom"
        ? workArea.y + workArea.height - bounds.height - inset
        : clamp(bounds.y, workArea.y + inset, workArea.y + workArea.height - bounds.height - inset),
    width: bounds.width,
    height: bounds.height
  };

  animateWindowBounds(target, 120, () => {
    if (currentMode === "compact") {
      enterPeek();
    } else {
      scheduleDesktopStateSave();
    }
  });
}

function createWindow() {
  initialDesktopState = readDesktopState();
  currentMode = initialDesktopState ? normalizeMode(initialDesktopState.mode) : "compact";
  snappedEdges = initialDesktopState ? normalizeSnappedEdges(initialDesktopState.snappedEdges) : { horizontal: null, vertical: null };
  isPeeking = Boolean(initialDesktopState && initialDesktopState.isPeeking);
  compactHoverExpanded = false;
  const initial = initialBoundsFromDesktopState(initialDesktopState);

  mainWindow = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    minWidth: 46,
    minHeight: 40,
    maxWidth: MODE_BOUNDS.dashboard.width,
    maxHeight: MODE_BOUNDS.dashboard.height,
    x: initial.x,
    y: initial.y,
    frame: false,
    show: false,
    transparent: true,
    // Multiple Win11 sources can paint a rectangle around a transparent
    // frameless window:
    //   - thickFrame: WS_THICKFRAME style (defaults true even with frame:false)
    //   - hasShadow: DWM drop-shadow that bounds-traces the rectangle
    //   - roundedCorners: Win11 auto-rounding adds a subtle 1px outline
    //   - backgroundMaterial mica/acrylic: window-level accent border
    // Switching them all off, plus matching the BrowserWindow size to the
    // visible capsule (no transparent gutter), is what gives the pure
    // capsule with zero rectangle.
    thickFrame: false,
    roundedCorners: false,
    backgroundMaterial: "none",
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  reinforceWindowPriority();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("move", scheduleSnapAfterMove);
  mainWindow.on("moved", scheduleSnapAfterMove);
  mainWindow.on("show", reinforceWindowPriority);
  mainWindow.on("restore", reinforceWindowPriority);
  mainWindow.on("focus", reinforceWindowPriority);
  mainWindow.on("blur", reinforceWindowPriority);
  mainWindow.on("close", () => {
    if (desktopStateWriteTimer) {
      clearTimeout(desktopStateWriteTimer);
      desktopStateWriteTimer = null;
    }
    writeDesktopStateNow();
  });
  mainWindow.on("closed", () => {
    stopWindowPriorityGuard();
    stopPeekHoverPolling();
    clearCompactCollapseTimer();
    clearDoneAttentionTimer();
    if (desktopStateWriteTimer) {
      clearTimeout(desktopStateWriteTimer);
      desktopStateWriteTimer = null;
    }
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => {
    if (currentMode === "compact" && isSnapped()) {
      mainWindow.setBounds(isPeeking ? compactPeekBounds() : compactSnappedBounds());
    } else {
      isPeeking = false;
    }
    mainWindow.webContents.send("window:mode-changed", currentMode);
    mainWindow.webContents.send("window:snap-changed", snappedEdges);
    mainWindow.webContents.send("window:peek-changed", isPeeking);
    mainWindow.showInactive();
    startWindowPriorityGuard();
    scheduleDesktopStateSave();
    if (isPeeking) {
      startPeekHoverPolling();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (desktopStateWriteTimer) {
    clearTimeout(desktopStateWriteTimer);
    desktopStateWriteTimer = null;
  }
  writeDesktopStateNow();
  stopWindowPriorityGuard();
});

ipcMain.handle("window:close", () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

ipcMain.handle("window:minimize", () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.handle("window:toggle-compact", () => {
  return setIslandMode(currentMode === "compact" ? "approval" : "compact");
});

ipcMain.handle("window:set-mode", (_event, mode) => {
  return setIslandMode(mode);
});

// Gear button — toggle in-app dashboard. The legacy browser page at
// http://127.0.0.1:4317/ has been removed; everything it used to show
// now lives inside the bubble's dashboard mode.
ipcMain.handle("open:dashboard", () => {
  const target = currentMode === "dashboard" ? "compact" : "dashboard";
  return setIslandMode(target);
});

ipcMain.handle("window:peek-hover", () => {
  setCompactHover(true);
});

ipcMain.handle("window:peek-unhover", () => {
  setCompactHover(false);
});

ipcMain.handle("window:done-attention", () => {
  return triggerDoneAttention();
});

ipcMain.handle("window:ack-attention", () => {
  clearDoneAttention();
  return { acknowledged: true };
});

ipcMain.handle("window:clear-attention", () => {
  clearDoneAttention();
  return { cleared: true };
});

ipcMain.handle("companion:get-enabled", () => readCompanionEnabled());

ipcMain.handle("companion:set-enabled", (_event, enabled) => setCompanionEnabled(Boolean(enabled)));
