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

## Current Interaction Model

The window has three compact/expanded states:

- Resting compact: `124 x 42`, showing the status emoji with the context-usage ring plus the Claude state label.
- Hover compact: `202 x 42`, keeping the Claude state visible while revealing settings/dashboard, expand, and minimize controls.
- Request expanded: `360 x 238` for approvals or `360 x 300` for questions.

The renderer chooses the mode from daemon state. The main process animates the native window bounds, keeping the window centered around its current position. CSS transitions handle the capsule-to-card shape change and content fade-in.

This mimics the Dynamic Island idea without using iOS APIs: compact and readable at rest, wider on hover, expanded only when action is needed.

When the user drags the island near a screen edge, the main process snaps it to that edge and preserves that edge alignment while expanding or collapsing. Edge snap is debounced about 160 ms after the last move event so it only triggers once the drag stops. Programmatic moves from the expand/collapse animation are skipped via the `boundsAnimation` guard.

Compact edge snap auto-enters a peek state. The native window slides mostly past the snapped edge and leaves only a `12 px` slit visible. In that slit, the normal status UI is hidden and only a context-usage indicator remains. Hovering the slit expands the compact island back out and reveals the state plus hover controls; leaving it re-tucks the island. The slit itself is draggable: pulling it away from the edge past the detach threshold clears the snapped state, suppresses immediate re-snap, and turns it back into a standalone floating bubble.

Hover state is intentionally debounced and hysteretic. The renderer waits briefly before sending hover-in and hover-out signals, while the main process keeps the expanded compact island visible for a minimum period and only collapses it after the cursor is outside the current native bounds plus a small margin. This prevents the native window resize animation from causing self-generated enter/leave loops.

## Context Usage

The daemon adds `contextUsage` to session and pending-request payloads when it can read the Claude transcript. It reads the latest assistant `usage` block and estimates current context occupancy from:

```text
input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

The context window is derived from the `message.model` recorded on the same transcript line and from any explicit usage metadata Claude provides. Resolution order:

1. Explicit `usage.context_window_tokens` / `usage.max_context_tokens`.
2. `CCC_CONTEXT_WINDOW_TOKENS`, when you need to force one value for local testing.
3. `CCC_MODEL_CONTEXT_WINDOWS`, a JSON map for model-specific overrides.
4. Model ids or aliases containing `[1m]` / `1m` use a 1,000,000-token window.
5. Current Claude model families fall back to 200,000.

```powershell
$env:CCC_CONTEXT_WINDOW_TOKENS = "200000"
$env:CCC_MODEL_CONTEXT_WINDOWS = '{"claude-opus-4-7":1000000,"sonnet":200000}'
```

Context occupancy appears as the circular ring around the status emoji in compact/expanded modes, and as the only visible indicator in the edge peek slit. When the session transitions from active work into `done` while tucked at an edge, the main process briefly slides the bubble back out and highlights `Done` with a green glow and sweep animation. The bubble can re-tuck to stay out of the way, but the completion reminder remains active until the user moves the pointer over the bubble. The tucked slit pulses only while that completion reminder is still unacknowledged. Hovering the emoji shows the label, model id, and window source.

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

Compact controls appear only on hover, after the compact island expands:

- gear opens the local browser dashboard/settings.
- square toggles compact/expanded size.
- minus minimizes the window.
- `Approve` allows the current request.
- `Always Allow` applies Claude's native allow suggestion when available.
- `Deny` blocks the current request immediately with the desktop Companion reason.
- `Answer` submits `AskUserQuestion` answers.

## Visual Identity Policy

The current stage intentionally avoids a concrete mascot. Keep the surface minimal until the state and approval interaction feels right. Future visual personality work should use original, generated, or clearly licensed assets.

## Next Desktop Work

- Persist window position and compact mode.
- Add tray menu for dashboard, compact mode, and quit.
- Tune compact and expanded sizes after real use.
- Add optional click-to-expand details when no approval is pending.
- Improve attention cues for waiting approval without becoming distracting.
- Add visual screenshots or GIFs to the README after the UI stabilizes.
