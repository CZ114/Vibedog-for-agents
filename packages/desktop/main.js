#!/usr/bin/env node

const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");

const MODE_BOUNDS = {
  compact: { width: 176, height: 44 },
  approval: { width: 360, height: 238 },
  question: { width: 360, height: 300 }
};
const EDGE_PADDING = 8;
const SNAP_DISTANCE = 22;
const MOVE_DEBOUNCE_MS = 160;
const PEEK_VISIBLE_PX = 16;

let mainWindow = null;
let currentMode = "compact";
let boundsAnimation = null;
let snappedEdges = { horizontal: null, vertical: null };
let snapDebounceTimer = null;
let isPeeking = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function targetBoundsForMode(mode) {
  const { screen } = require("electron");
  const size = MODE_BOUNDS[mode] || MODE_BOUNDS.compact;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const centeredX = current.x + Math.round((current.width - size.width) / 2);
  let x = clamp(centeredX, workArea.x + EDGE_PADDING, workArea.x + workArea.width - size.width - EDGE_PADDING);
  let y = clamp(current.y, workArea.y + EDGE_PADDING, workArea.y + workArea.height - size.height - EDGE_PADDING);

  if (snappedEdges.horizontal === "left") {
    x = workArea.x + EDGE_PADDING;
  } else if (snappedEdges.horizontal === "right") {
    x = workArea.x + workArea.width - size.width - EDGE_PADDING;
  }

  if (snappedEdges.vertical === "top") {
    y = workArea.y + EDGE_PADDING;
  } else if (snappedEdges.vertical === "bottom") {
    y = workArea.y + workArea.height - size.height - EDGE_PADDING;
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

function compactSnappedBounds() {
  // For compact mode + snapped, the window touches the snapped edge with no
  // padding. Touching the edge keeps the peek/expand transition stable: when
  // the user hovers into the visible peek strip, the expanded window always
  // contains that strip, so the cursor never falls "outside" the expanded
  // window and we don't oscillate.
  const { screen } = require("electron");
  const size = MODE_BOUNDS.compact;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const centeredX = current.x + Math.round((current.width - size.width) / 2);
  let x = clamp(centeredX, workArea.x, workArea.x + workArea.width - size.width);
  let y = clamp(current.y, workArea.y, workArea.y + workArea.height - size.height);

  if (snappedEdges.horizontal === "left") {
    x = workArea.x;
  } else if (snappedEdges.horizontal === "right") {
    x = workArea.x + workArea.width - size.width;
  }

  if (snappedEdges.vertical === "top") {
    y = workArea.y;
  } else if (snappedEdges.vertical === "bottom") {
    y = workArea.y + workArea.height - size.height;
  }

  return { x, y, width: size.width, height: size.height };
}

function compactPeekBounds() {
  const full = compactSnappedBounds();
  const result = { ...full };

  // Hide along whichever axis we snapped to. For corners, prefer hiding
  // horizontally so the user keeps a horizontal peek strip cue.
  if (snappedEdges.horizontal === "left") {
    result.x = full.x - (full.width - PEEK_VISIBLE_PX);
  } else if (snappedEdges.horizontal === "right") {
    result.x = full.x + (full.width - PEEK_VISIBLE_PX);
  } else if (snappedEdges.vertical === "top") {
    result.y = full.y - (full.height - PEEK_VISIBLE_PX);
  } else if (snappedEdges.vertical === "bottom") {
    result.y = full.y + (full.height - PEEK_VISIBLE_PX);
  }

  return result;
}

function isSnapped() {
  return Boolean(snappedEdges.horizontal || snappedEdges.vertical);
}

function enterPeek() {
  if (!mainWindow || isPeeking) {
    return;
  }
  if (currentMode !== "compact" || !isSnapped()) {
    return;
  }
  isPeeking = true;
  animateWindowBounds(compactPeekBounds(), 180);
  mainWindow.webContents.send("window:peek-changed", true);
}

function exitPeek() {
  if (!mainWindow || !isPeeking) {
    return;
  }
  isPeeking = false;
  if (currentMode === "compact" && isSnapped()) {
    animateWindowBounds(compactSnappedBounds(), 160);
  }
  mainWindow.webContents.send("window:peek-changed", false);
}

function setIslandMode(mode) {
  if (!mainWindow) {
    return { mode: currentMode };
  }

  // Switching mode invalidates any prior peek state — leaving compact takes
  // the window to a different size/position; entering compact may want to
  // re-engage peek after the animation settles.
  isPeeking = false;
  currentMode = MODE_BOUNDS[mode] ? mode : "compact";
  const target = currentMode === "compact" && isSnapped()
    ? compactSnappedBounds()
    : targetBoundsForMode(currentMode);
  animateWindowBounds(target, 190, () => {
    if (currentMode === "compact" && isSnapped()) {
      enterPeek();
    }
  });
  mainWindow.webContents.send("window:mode-changed", currentMode);
  mainWindow.webContents.send("window:peek-changed", false);
  return { mode: currentMode };
}

function scheduleSnapAfterMove() {
  // On Windows, "moved" fires continuously during a drag and also during our
  // own animateWindowBounds setBounds calls. Snap only after the user has
  // actually stopped moving, and never during a programmatic animation.
  if (boundsAnimation) {
    return;
  }
  // The user is moving the window themselves — drop any peek state without
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
}

function snapWindowToNearbyEdge() {
  if (!mainWindow || boundsAnimation) {
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

  if (!horizontal && !vertical) {
    return;
  }

  // For compact mode, snap right against the edge (no padding) so the peek
  // transition is stable. For approval/question modes, keep an EDGE_PADDING
  // gap so the user can see the panel comfortably.
  const padding = currentMode === "compact" ? 0 : EDGE_PADDING;
  const target = {
    x: horizontal === "left"
      ? workArea.x + padding
      : horizontal === "right"
        ? workArea.x + workArea.width - bounds.width - padding
        : clamp(bounds.x, workArea.x + padding, workArea.x + workArea.width - bounds.width - padding),
    y: vertical === "top"
      ? workArea.y + padding
      : vertical === "bottom"
        ? workArea.y + workArea.height - bounds.height - padding
        : clamp(bounds.y, workArea.y + padding, workArea.y + workArea.height - bounds.height - padding),
    width: bounds.width,
    height: bounds.height
  };

  animateWindowBounds(target, 120, () => {
    if (currentMode === "compact") {
      enterPeek();
    }
  });
}

function createWindow() {
  const { screen } = require("electron");
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const initial = MODE_BOUNDS.compact;

  mainWindow = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    minWidth: 180,
    minHeight: 48,
    maxWidth: 420,
    maxHeight: 360,
    x: workArea.x + Math.round((workArea.width - initial.width) / 2),
    y: workArea.y + 18,
    frame: false,
    show: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
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

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("moved", scheduleSnapAfterMove);
  mainWindow.once("ready-to-show", () => {
    mainWindow.showInactive();
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

ipcMain.handle("open:dashboard", () => {
  shell.openExternal("http://127.0.0.1:4317/");
});

ipcMain.handle("window:peek-hover", () => {
  // Renderer signals that the cursor has settled on the visible peek strip.
  // Hover/unhover debouncing already happened in the renderer.
  exitPeek();
});

ipcMain.handle("window:peek-unhover", () => {
  enterPeek();
});
