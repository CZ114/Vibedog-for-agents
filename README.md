# Clawdeck

> Floating desktop companion for Claude Code on Windows. iOS planned.

Clawdeck (internally still referred to as "Claude Code Companion" throughout the docs and protocol — same project) is a Windows-first companion for Claude Code, with iOS planned after the desktop loop feels good. The first goal is not remote terminal control. The first goal is a reliable, clear, and safe status and approval loop:

```text
Claude Code on Windows
  -> Claude Code hook
  -> Windows local daemon
  -> floating desktop companion
  -> status / waiting state / approval card
  -> approve / deny / reply
  -> Claude Code continues or blocks
```

## Current Product Position

Build an ambient companion and approval layer for Claude Code:

- Windows daemon captures Claude Code hook events and normalizes session state.
- Windows floating companion shows Claude's current state and handles lightweight approvals.
- A future visual personality layer can be explored after the minimal approval overlay is reliable.
- Future iPhone app, Live Activity, and Dynamic Island mirror the same protocol after the PC path is boringly reliable.
- Future relay may allow use outside the same local network.

## Documentation Map

- [Stage Requirements](docs/stages.md): implementation stages from technical MVP to later expansion.
- [Documentation Framework](docs/documentation-framework.md): how to maintain project docs as the product evolves.
- [Protocol](docs/protocol.md): Stage 0 HTTP and hook payloads.
- [Security](docs/security.md): safety defaults, risk classification, and trust boundaries.
- [Development Setup](docs/dev-setup.md): how to run the daemon, hook, and smoke test.
- [User Guide](docs/user-guide.md): day-to-day commands for daemon, hooks, and the floating companion.
- [Desktop Companion](docs/desktop-companion.md): Electron floating window behavior and next steps.
- [Design Language](docs/design-language.md): tokens, motion, and component recipes for any new UI work. Visual preview at [docs/design-language-v0.html](docs/design-language-v0.html).

## First Milestone

The first milestone is deliberately small:

1. Run a local daemon on Windows.
2. Register Claude Code's `PermissionRequest` hook with matcher `""` so every tool's permission gate (Bash, PowerShell, Read, Edit, Write, Glob, WebFetch, MCP servers) routes through the daemon.
3. Route `ExitPlanMode` and `AskUserQuestion` through `PreToolUse` (those don't fire `PermissionRequest`) so the bubble can show plan content + answer questions.
4. Track Claude working states like `thinking`, `running_tool`, `waiting`, `waiting_approval`, `waiting_answer`, `done`, `failed`.
5. Show the status and request in a Windows floating companion. `permission_suggestions[]` from each request render as their own buttons (mirroring Claude Code's terminal `1. Yes / 2. Yes, allow X` options).
6. Return `allow`, `deny`, `always_allow` (with `suggestionIndex`), or `answers` to Claude Code.
7. Provide a global on/off (Power button + `~/.claude-companion/disabled` flag file) so the user can hand control back to Claude Code's native UI without uninstalling.

Everything else waits until this approval loop is boringly reliable.

## Quick Start

Requires Node.js 20+.

Install dependencies + run the smoke test:

```powershell
npm install
npm run smoke
```

**Install hooks globally** (recommended — bubble works in every project):

```powershell
npm run setup-user-hooks
npm run doctor
```

`setup-user-hooks` merges the Companion `hooks` block into `%USERPROFILE%\.claude\settings.json`, preserves unrelated Claude Code settings, writes a timestamped backup before changes, and uses the current repo path automatically. Use `npm run setup-user-hooks -- --dry-run` to preview, or `npm run setup-user-hooks -- --uninstall` to remove only Companion-managed global hooks. [examples/user-settings.example.json](examples/user-settings.example.json) remains the reference shape for hand-diffing.

Per-project install (legacy, if you want hooks scoped to one repo):

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15
npm run setup-hooks -- D:\Imperial\individual\week15 --status-only
npm run setup-hooks -- D:\Imperial\individual\week15 --approval-only
npm run setup-hooks -- D:\Imperial\individual\week15 --disable
```

Runtime toggles:

```powershell
# Hard disable / re-enable from anywhere (the bubble's ⏻ button does the same):
type nul > %USERPROFILE%\.claude-companion\disabled
del %USERPROFILE%\.claude-companion\disabled

# Session-scoped env switches (take effect in the next Claude Code launched in the shell):
$env:CCC_BYPASS_APPROVAL_HOOK = "true"   # Claude Code uses native approval/question UI
$env:CCC_DISABLE_STATUS_HOOK  = "true"   # Companion stops recording status hooks
```

Run the daemon:

```powershell
npm run daemon
```

Run the floating desktop companion:

```powershell
npm run desktop
```

Approvals, sessions, devices, pairing, and audit events all live inside the
desktop bubble's dashboard mode (gear icon in the controls strip). The
daemon's HTTP root just shows a small notice now:

```text
http://127.0.0.1:4317/
```

Underneath, the bubble (and any other client) talks to the daemon over:

```text
ws://127.0.0.1:4317/ws        # realtime events
http://127.0.0.1:4317/sessions
http://127.0.0.1:4317/pending-requests
http://127.0.0.1:4317/permission-decisions
```

Native approval hook:

```powershell
npm run hook:permission-request
```

Non-blocking status hook:

```powershell
npm run hook:event
```

Pairing endpoint for future iPhone clients:

```text
http://127.0.0.1:4317/pairing-token
```

Manual approval commands:

```powershell
npm run approve -- <requestId>
npm run deny -- <requestId> "Reason"
npm run answer -- <requestId> '{"Question text":"Answer label"}'
```
