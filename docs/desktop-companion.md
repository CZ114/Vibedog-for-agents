# Desktop Companion

The desktop companion is the current Stage 1 client. It is an Electron floating island that connects to the local daemon and renders Claude Code status, approvals, and questions without requiring the user to watch the terminal every second.

## Current Shape

Run it from the repo root:

```powershell
npm run desktop
```

It expects the daemon to be running:

```powershell
npm run daemon
```

Runtime files:

- `packages/desktop/main.js`: Electron window creation and desktop IPC.
- `packages/desktop/preload.js`: narrow renderer bridge.
- `packages/desktop/renderer/index.html`: static UI shell.
- `packages/desktop/renderer/styles.css`: compact island, expanded approval panel, and state animations.
- `packages/desktop/renderer/app.js`: WebSocket, polling fallback, rendering, and decisions.

## Data Flow

```text
Claude Code hook
  -> local daemon
  -> ws://127.0.0.1:4317/ws
  -> Electron renderer
  -> approval or answer decision
  -> POST /permission-decisions or websocket permission_decision
  -> daemon wakes hook
  -> Claude Code continues or blocks
```

The window does not inspect Claude Code directly. It only consumes daemon summaries.

## Window Geometry

There are two parallel size systems:

- **CAPSULE_BOUNDS** — the visible bubble:
  - Resting compact: `124 x 42`
  - Hover compact: `224 x 42`
  - Approval expanded: `360 x 238`
  - Question expanded: `360 x 300`
  - Dashboard expanded: `420 x 540`
- **MODE_BOUNDS** — the BrowserWindow, which adds `BUBBLE_PADDING = 12 px` on every side around the capsule for a transparent gutter where the soft drop shadow renders.

Snap, peek, and distance math is implemented in CAPSULE coordinates (the user-perceived shape) and translated to BrowserWindow coordinates via `snapInset()` whenever bounds are computed. When snapped to an edge in compact mode, the BrowserWindow overhangs the work area by `BUBBLE_PADDING` so the capsule itself sits flush with the edge.

Desktop placement is persisted in `~/.claude-companion/desktop-state.json`. The main process stores the current BrowserWindow bounds, mode, snapped edge, and peek state, then clamps the restored bounds back into the current screen work area on startup so a monitor or resolution change cannot leave the island unreachable.

The BrowserWindow uses `alwaysOnTop: true`, `fullscreenable: false`, and a recurring priority guard that reapplies `setAlwaysOnTop(true, "screen-saver", 1)`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, and `moveTop()` while the island is visible. This is best-effort Windows topmost behavior for borderless/full-screen apps; exclusive full-screen renderers may still be outside Electron's control.

## Pure Capsule Treatment

The BrowserWindow opts out of every Win11 source that would paint a rectangle around a transparent frameless window:

| Option | Reason |
|---|---|
| `frame: false` | No system chrome |
| `transparent: true` | Window background is transparent |
| `thickFrame: false` | Suppresses `WS_THICKFRAME` (the default 1–2 px DWM frame) |
| `roundedCorners: false` | Disables Win11's auto-rounded corners and the subtle outline they add |
| `backgroundMaterial: "none"` | Disables Mica/Acrylic so no accent border is layered on |
| `hasShadow: false` | Suppresses DWM drop shadow that would bound-trace the rectangle |

The capsule fills the BrowserWindow at `margin: 12px / width: calc(100% - 24px) / height: calc(100% - 24px)`. The 12 px gutter only carries the CSS drop shadow; nothing else paints there.

## Interaction Model

Four states animate between each other:

- Resting compact: status emoji with the context-usage ring + status label.
- Hover compact: also reveals the window controls strip (toggle, capsule color, settings, expand, minimize).
- Request expanded: approval card with command, meta, suggestion buttons, deny / approve, OR question card with answer form.
- Dashboard expanded: full vertical feed of (1) the active request, when one is pending, (2) other pending requests with inline approve / deny, (3) all known Claude sessions with status chips, (4) paired devices with revoke + a button to generate a fresh pairing token, (5) the audit-event drawer (last 30, collapsible), and (6) a health footer that flips between sage "live" and rose "offline" depending on the WebSocket connection. Replaces the legacy browser dashboard at `http://127.0.0.1:4317/` — that URL now serves a small notice page directing users back to the bubble.

The renderer picks the mode from daemon state; the main process animates native bounds. `:root` has a registered `@property --context-angle` so the conic ring fill morphs over `720ms` instead of jumping when ctx percentage updates.

When the user drags near a screen edge, the main process snaps and stays anchored through subsequent expand / collapse. Snap is debounced about 160 ms after the last move event. Programmatic moves from animations are skipped via the `boundsAnimation` guard.

Compact edge snap auto-enters a peek state: the BrowserWindow slides mostly past the edge, leaving a 12 px capsule strip + the gutter visible. In that strip, the normal status UI is hidden and only a sage / warm context fill bar shows. Pulling the slit away from the edge past `SNAP_DETACH_DISTANCE` clears snap and re-floats.

**Slit hover detection.** Browsers don't synthesize `pointerleave` / `pointerenter` when a window slides out from under a stationary cursor — so a later cursor entry into the slit never refires `pointerenter` and the slit feels dead. The main process polls `screen.getCursorScreenPoint()` every 80 ms while peeking; entering the BrowserWindow bounds triggers `setCompactHover(true)` directly, bypassing the web hover state machine entirely.

## Context Usage

The daemon adds `contextUsage` to session and pending-request payloads when it can read the Claude transcript. It reads the latest assistant `usage` block and estimates current context occupancy from:

```text
input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

The context window is derived from the `message.model` recorded on the same transcript line and from any explicit usage metadata Claude provides. Resolution order:

1. Explicit `usage.context_window_tokens` / `usage.max_context_tokens`.
2. `CCC_CONTEXT_WINDOW_TOKENS`, when you need to force one value for local testing.
3. `CCC_MODEL_CONTEXT_WINDOWS`, a JSON map for model-specific overrides.
4. A learned window for the model family, persisted in `~/.claude-companion/learned-context.json`. The daemon writes here whenever it observes a per-line peak above 200k (a 200k model can't physically hold that much) or a sharp drop characteristic of `/compact`. See `docs/protocol.md` for the file shape and detection thresholds.
5. Model ids or aliases containing `[1m]` / `1m` use a 1,000,000-token window.
6. Claude Code's own 1M default for Opus 4.6, Opus 4.7, and Sonnet 4.6, mirrored locally. The transcript records bare model ids (e.g. `claude-opus-4-7`) without the `[1m]` marker, so the daemon recognizes the family directly. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (the same flag Claude Code itself honors) or `CCC_DISABLE_1M_CONTEXT=true` falls these models back to 200,000.
7. Other current Claude model families fall back to 200,000.

If the observed `usedTokens` count for a transcript line already exceeds the resolved window, the daemon promotes the window to 1,000,000 and tags it `windowSource: "observed-overrun"`, so the ring never reports above 100% just because the resolution layer guessed too low. The same observation also writes through to the learned-context file so subsequent sessions of that model family start at the right value.

```powershell
$env:CCC_CONTEXT_WINDOW_TOKENS = "200000"
$env:CCC_MODEL_CONTEXT_WINDOWS = '{"claude-opus-4-7":1000000,"sonnet":200000}'
$env:CLAUDE_CODE_DISABLE_1M_CONTEXT = "1"
```

Context occupancy renders as the conic ring around the status orb in compact/expanded modes, and as the fill bar in the edge peek slit. When a session transitions from active work into `done` while tucked, the main process slides the capsule back out for `DONE_ATTENTION_MS` (10 minutes) with a sage→warm sweep across the bubble and a sage glow on the status text. After that window expires, the capsule re-tucks but the slit keeps pulsing — sage background + box-shadow halo + a 1→1.08 transform scale at 1.2 s — until the user moves the pointer over it (`acknowledgeAttentionFromPointer`).

## Status Mapping

- `idle`: sleeping emoji, no pending request.
- `thinking`: thinking emoji, Claude is reasoning after a prompt or tool.
- `running_tool`: gear emoji, Claude is about to run or has just run a tool.
- `waiting`: hourglass emoji, Claude Code sent a notification that it is waiting for user input or terminal attention, but there is no Companion answer form.
- `waiting_approval`: yellow indicator and approval card.
- `waiting_answer`: question emoji and answer form for a real `AskUserQuestion` request.
- `done`: check emoji.
- `failed`: warning emoji.
- `blocked`: blocked emoji.

## Controls

Compact controls live in a `surface-glass` strip that fades in on hover (left to right):

- **Power (⏻)** — toggles the Companion approval / status hooks globally. Sand-gold tint when off; the orb desaturates as a passive cue. Backed by `~/.claude-companion/disabled` flag file (see [Pluggable on/off](#pluggable-onoff)).
- **Color swatch** — opens the system color picker for the compact capsule surface. The selected color is stored locally in the renderer via `localStorage`; light colors switch compact status/control text to a darker contrast color while expanded approval/question panels keep the standard dark surface.
- **Gear (⚙)** — toggles the bubble's dashboard mode (`420 × 540`). Click again from inside the dashboard to collapse back to compact. The legacy browser dashboard at `http://127.0.0.1:4317/` is gone — its content lives here now.
- **Square (▢)** — toggles compact / expanded size. With a pending request it opens approval / question; otherwise the dashboard.
- **Minus (−)** — minimizes the window.

Expanded panel actions:

- **Approve** — single-shot allow.
- **Suggestion buttons** — for `PermissionRequest` events, every `permission_suggestions[i]` with `behavior: "allow"` renders as its own labeled button (e.g. `Always allow Read /tmp/**`). Clicking sends `decide(..., "always_allow", ..., { suggestionIndex: i })` which the daemon packs into `decision.updatedPermissions` for Claude Code.
- **Deny** — blocks the request with `Denied from desktop companion`.
- **Answer** — submits `AskUserQuestion` responses (text input or option pill selection).

## Pluggable on/off

Two equivalent ways to disable Companion approvals across every project on the machine:

- **Power button** in the controls strip. One click writes `~/.claude-companion/disabled`; another click removes it.
- **Flag file** directly: `type nul > %USERPROFILE%\.claude-companion\disabled` to disable, `del %USERPROFILE%\.claude-companion\disabled` to re-enable. Each hook script (`pre-tool-use.js`, `permission-request.js`, `event.js`) checks `isCompanionDisabled()` from `packages/shared/protocol.js` at startup and returns a noop if present, so Claude Code falls back to its native terminal prompts.

Env vars `CCC_BYPASS_APPROVAL_HOOK=true` (approval) and `CCC_DISABLE_STATUS_HOOK=true` (status) remain as session-scoped equivalents for shell-level overrides.

Global hook installation is handled by `npm run setup-user-hooks`, which merges only Companion-managed hooks into `%USERPROFILE%\.claude\settings.json` and backs up the prior file. `npm run doctor` verifies hook coverage, paths, daemon health, disabled-flag state, and possible global/project double-firing.

## Visual Identity Policy

Tokens, motion, and component recipes are codified in [docs/design-language.md](design-language.md). A standalone v0 preview lives at [docs/design-language-v0.html](design-language-v0.html) — open it in a browser to inspect every state side-by-side.

The current stage intentionally avoids a concrete mascot. Status emoji are product iconography (they encode state); they're not used as filler. Future personality work should use original, generated, or clearly licensed assets.

## Next Desktop Work

- Add tray menu for dashboard, compact mode, and quit.
- Truly content-driven dynamic resize (ResizeObserver → IPC → `setBounds`), so compact width fits text instead of staying at 124 px.
- Render MCP `Elicitation` form fields directly in the bubble (currently surfaces only as `waiting` status).
- Wire `ExitPlanMode` mode picker (1/2/3/4) into the bubble once Claude Code ships [PrePlanMode hooks](https://github.com/anthropics/claude-code/issues/14259).
- Add visual screenshots or GIFs to the README after the UI stabilizes.
