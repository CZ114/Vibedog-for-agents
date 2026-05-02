# Development Setup

The daemon and hook scripts require Node.js 20 or newer. The Windows floating companion uses Electron as a development dependency.

## Requirements

- Windows 11
- Git
- Node.js 20+
- Claude Code

Check Node:

```powershell
node --version
```

Install dependencies:

```powershell
npm install
```

## Run The Daemon

From the repo root:

```powershell
npm run daemon
```

Default URL:

```text
http://127.0.0.1:4317
```

Local approval page:

```text
http://127.0.0.1:4317/
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/health
```

## Run The Smoke Test

In a separate terminal, or with no daemon already running:

```powershell
npm run smoke
```

The smoke test starts a daemon on port `54317`, invokes the status hook, the PreToolUse hook, and the native PermissionRequest hook, approves or answers through the decision endpoint, and verifies Claude Code would receive valid decisions and session states.

## Manual Approval Flow

Terminal 1:

```powershell
npm run daemon
```

Open the local approval page:

```text
http://127.0.0.1:4317/
```

When Claude Code creates a pending request, the page shows the current Claude status, tool, command summary, working directory, risk level, reason, and Approve/Deny buttons.

The page uses WebSocket realtime updates at:

```text
ws://127.0.0.1:4317/ws
```

If the WebSocket disconnects, it falls back to polling `GET /sessions` and `GET /pending-requests`.

## Run The Floating Desktop Companion

Terminal 1:

```powershell
npm run daemon
```

Terminal 2:

```powershell
npm run desktop
```

The desktop companion is a transparent always-on-top Electron island. It connects only to the local daemon at:

```text
ws://127.0.0.1:4317/ws
```

At rest, it shows a compact status emoji with the context ring plus the Claude state label. Hovering the island expands it to reveal controls without hiding the status. Dragging it to a screen edge tucks it into a small context-only slit; dragging that slit back out detaches it into a standalone bubble again. When Claude reaches `done` while tucked, the bubble briefly slides out with a green completion glow and can tuck itself back, but the completion reminder stays active until the user moves the pointer over the bubble; the slit pulses only while that reminder is unacknowledged. When Claude needs input, it expands into an approval or answer panel.

The island persists its last bounds, mode, snapped edge, and tucked state in `~/.claude-companion/desktop-state.json`. Startup clamps the saved bounds back into the current work area, and the main process periodically reapplies a high always-on-top level so normal full-screen windows are less likely to cover the bubble.

The hover-only controls are:

- gear opens the local browser dashboard/settings.
- square toggles compact/expanded size.
- minus minimizes the window.

The window does not start or stop Claude Code. It is another local client of the daemon, so the terminal remains the source of truth and Claude Code's native UI still works when the Companion approval hook is bypassed.

The daemon also prints fallback commands:

```powershell
node scripts/decide.js approve req_abc
node scripts/decide.js deny req_abc
```

Fallback CLI approval from Terminal 2:

```powershell
npm run approve -- req_abc
```

or:

```powershell
npm run deny -- req_abc "Not safe"
```

Answer a pending `AskUserQuestion` request from the CLI:

```powershell
npm run answer -- req_abc '{"Which implementation should I use?":"Simple"}'
```

## Configure Claude Code Hooks

Two installation models. Pick one:

### Global (one-time, covers every project)

Recommended. The Companion bubble fires for every project on the machine without any per-repo setup. Hooks live in your user-level `~/.claude/settings.json` and point at absolute paths under this repo.

The full hook set covers every interaction event Claude Code can preempt — `PreToolUse` (matcher `ExitPlanMode|AskUserQuestion` for the answer / plan flow), `PreToolUse` matcher `""` for status, `PermissionRequest` matcher `""` for all permission gates including MCP tools, `WebFetch`, file edits outside cwd, and the rest, plus `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `Notification` / `Stop` / `SessionEnd` for status. `Notification` is what surfaces MCP `Elicitation` dialogs as `waiting` (we deliberately don't preempt those — the form input is too rich to render in the bubble; user answers in terminal, status reflects state).

Install or refresh global hooks from the Companion repo:

```powershell
npm run setup-user-hooks
```

The installer reads `%USERPROFILE%\.claude\settings.json`, removes older Companion-managed hook entries, adds the current global hook set with this repo's absolute paths, preserves unrelated settings such as `enabledPlugins`, and writes a timestamped backup before saving. Preview without writing:

```powershell
npm run setup-user-hooks -- --dry-run
```

Remove only Companion-managed global hooks:

```powershell
npm run setup-user-hooks -- --uninstall
```

Run the doctor after install:

```powershell
npm run doctor
```

`doctor` checks Node version, hook file paths, user-level hook coverage, the disabled flag, daemon health, and whether a project also has Companion-managed hooks that could double-fire. A reference copy of the hook shape is checked in at [examples/user-settings.example.json](../examples/user-settings.example.json) for hand-diffing.

**On / off switch.** Two equivalent ways:

- **Bubble button** — the power glyph on the left of the hover-controls strip toggles approvals globally. Sand-gold tint = off; the orb desaturates as a passive indicator.
- **Flag file** — `~/.claude-companion/disabled` (created/removed by the button). Touch it manually when scripting (`type nul > %USERPROFILE%\.claude-companion\disabled`), delete to re-enable. Each hook script checks this file at startup and returns noop if present, so Claude Code falls back to its native terminal prompts.

The env vars `CCC_BYPASS_APPROVAL_HOOK=true` (approval) and `CCC_DISABLE_STATUS_HOOK=true` (status) remain as session-scoped equivalents for shell-level overrides.

### Per-project (legacy)

Original install model. Runs `setup-hooks` against a target repo and writes hooks to its `.claude/settings.json`. Useful when you want Companion behavior for one repo only, or want to override the global config for a specific project (in that case, drop the `hooks` block in `~/.claude/settings.json` first to avoid double-firing).

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15
```

The setup command creates or merges:

- `permissions.ask`: `Bash`, `PowerShell`
- `permissions.deny`: `.env` and `secrets/**` reads
- lifecycle status hooks for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, and `Stop`
- native approval hook for `PermissionRequest`
- answer hook for `AskUserQuestion`

It preserves unrelated existing settings and hook entries. To preview the generated settings without writing:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --dry-run
```

Install only one side of Companion:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --status-only
npm run setup-hooks -- D:\Imperial\individual\week15 --approval-only
```

`--status-only` removes Companion-managed approval hooks and leaves Claude Code's native permission UI in charge. `--approval-only` removes Companion-managed lifecycle status hooks but keeps remote approval and `AskUserQuestion` answer support.

Remove all Companion-managed hooks from the target repo:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --disable
```

`--disable` removes hook entries that point to Companion's `event.js`, `pre-tool-use.js`, or `permission-request.js`. It keeps unrelated Claude Code settings and user-managed hooks.

The example asks for Bash and PowerShell commands, forwards Claude's native permission request to Companion, routes `AskUserQuestion` through the answer flow, and sends non-blocking status events to Companion.

The hook groups in the global config are:

- `PreToolUse` matcher `ExitPlanMode|AskUserQuestion` -> `packages/hooks/pre-tool-use.js` (plan + answer flow)
- `PreToolUse` matcher `""` -> `packages/hooks/event.js` (status: `running_tool`)
- `PermissionRequest` matcher `""` -> `packages/hooks/permission-request.js` (every permission gate, including MCP servers, `WebFetch`, `Read` / `Edit` / `Write` on new paths, and `Bash` / `PowerShell` commands not in `permissions.allow`)
- `PostToolUse` matcher `""` -> `packages/hooks/event.js` (status: `thinking`)
- `PostToolUseFailure` matcher `""` -> `packages/hooks/event.js` (status: `failed`)
- `UserPromptSubmit` -> `packages/hooks/event.js` (status: `thinking`)
- `Notification` -> `packages/hooks/event.js` (status: `waiting` for permission prompts, MCP elicitation, idle prompts)
- `Stop` -> `packages/hooks/event.js` (status: `done`)
- `SessionEnd` -> `packages/hooks/event.js` (status: `idle`)

See [examples/user-settings.example.json](../examples/user-settings.example.json) for the canonical JSON. `PermissionRequest` is the primary path because it fires only when Claude Code would actually show a prompt; pre-approved tools / paths skip it. `PreToolUse` is reserved for `ExitPlanMode` (the plan flow doesn't go through `PermissionRequest`) and `AskUserQuestion` (the hook must return `permissionDecision: "allow"` with `updatedInput.answers`).

`packages/hooks/event.js` is intentionally non-blocking. If the daemon is down, Claude Code should continue; only the approval hooks fail closed.

## Environment Variables

```text
CCC_PORT=4317
CCC_HOST=127.0.0.1
CCC_APPROVAL_TIMEOUT_MS=55000
CCC_HOOK_TIMEOUT_MS=58000
CCC_FAIL_OPEN=false
CCC_BYPASS_APPROVAL_HOOK=false
CCC_DISABLE_STATUS_HOOK=false
CCC_DATA_DIR=.claude-companion
CCC_CONTEXT_WINDOW_TOKENS=
CCC_MODEL_CONTEXT_WINDOWS=
CCC_DISABLE_1M_CONTEXT=false
CLAUDE_CODE_DISABLE_1M_CONTEXT=
```

Use `CCC_FAIL_OPEN=true` only while debugging. The default is fail-closed.

Runtime switches:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"
```

With this set before launching Claude Code, `permission-request.js` and `pre-tool-use.js` return no-op hook JSON. Claude Code keeps its native terminal approval/question behavior, while status hooks can still run.

```powershell
$env:CCC_DISABLE_STATUS_HOOK = "true"
```

With this set before launching Claude Code, `event.js` returns no-op hook JSON and does not update Companion session status.

Aliases:

```text
CCC_REMOTE_APPROVAL=off
CCC_STATUS_HOOK=off
```

Context ring sizing:

- Leave `CCC_CONTEXT_WINDOW_TOKENS` empty for normal model-based behavior.
- Set `CCC_CONTEXT_WINDOW_TOKENS=200000` to force one window size while debugging.
- Set `CCC_MODEL_CONTEXT_WINDOWS` to a JSON map when a model id or alias needs a local override, for example `{"claude-opus-4-7":1000000,"sonnet":200000}`.
- Opus 4.6 / 4.7 and Sonnet 4.6 default to 1M because Claude Code itself does on Max/Team/Enterprise plans. Set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (the upstream Claude Code flag) or `CCC_DISABLE_1M_CONTEXT=true` to fall those models back to 200,000.
- If `usedTokens` ever exceeds the resolved window, the daemon promotes that line to 1M and tags it `windowSource: "observed-overrun"` so the ring never overshoots 100%.

Learned context windows:

- The daemon writes confirmed per-family windows to `~/.claude-companion/learned-context.json` (per-user, shared across projects). Keys are model families (`opus-4-7`, `sonnet-4-6`).
- A peak `usedTokens > 200,000` for a family records that family at 1M. A drop pattern (`current < peak * 0.3`, with `peak >= 50,000`) treats the prior peak as the model's compact threshold and snaps to the nearest of 200k / 1M.
- Learned values never auto-demote. Delete the file to reset, or override at runtime with `CCC_MODEL_CONTEXT_WINDOWS`.

## Pairing Token Flow

The daemon now has a pairing model for future iPhone connections. Local browser approval still works without a token on `127.0.0.1`.

Get a one-time pairing token:

```powershell
$pairing = Invoke-RestMethod http://127.0.0.1:4317/pairing-token
$pairing.pairingToken
```

Pair a test device:

```powershell
$body = @{
  pairingToken = $pairing.pairingToken
  deviceName = "Test iPhone"
} | ConvertTo-Json

$device = Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4317/pair `
  -ContentType "application/json" `
  -Body $body

$device.authToken
```

Use the token for future remote-style connections:

```text
ws://127.0.0.1:4317/ws?token=<authToken>
```

List paired devices:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/devices
```

Revoke a device:

```powershell
$body = @{ deviceId = $device.deviceId } | ConvertTo-Json
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4317/devices/revoke `
  -ContentType "application/json" `
  -Body $body
```

## Troubleshooting

If every Bash or PowerShell command is denied:

1. Make sure `npm run daemon` is running.
2. Check that Claude Code started from the repo root.
3. Check `.claude/settings.local.json`.
4. Temporarily set `CCC_FAIL_OPEN=true` if you need Claude Code's normal permission UI while debugging.

If the hook cannot find the script:

- Run `npm run setup-hooks -- <target-repo>` again from the Companion repo.
- Keep quotes around hook script paths if you edit `.claude/settings.local.json` manually.

If port `4317` is busy, the daemon now exits with a `[error] Port 4317 ... is already in use` message instead of an unhandled `EADDRINUSE` stack trace. The most common cause is an older daemon process still running. Stop it on Windows:

```powershell
Get-NetTCPConnection -LocalPort 4317 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Or move the new daemon to a different port and use the same `CCC_PORT` when launching Claude Code so the hook talks to the right daemon:

```powershell
$env:CCC_PORT = "4318"
npm run daemon
```
