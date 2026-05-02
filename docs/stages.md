# Stage Requirements

This document defines the staged path from a minimal approval spike to a desktop-first companion, then to iOS and remote use. Each stage should have a clear demo, exit criteria, and docs updated before moving on.

## Product Principle

Do not build a full remote terminal first. Build the smallest safe loop where Claude needs the user and a companion surface helps the user answer. The PC companion comes before phone pairing so the core interaction can be tuned locally.

## Stage 0: Technical Approval Spike

Goal: Prove that Companion can approve, deny, or answer Claude Code requests running on Windows.

Scope:

- Windows local daemon with HTTP server.
- Claude Code native `PermissionRequest` hook for Bash and PowerShell approval.
- Claude Code `PreToolUse` hook for `AskUserQuestion` answer handoff.
- Non-blocking lifecycle status hook for prompt, tool, notification, failure, and stop events.
- Hooks send request JSON to daemon and wait for a decision.
- Temporary web or CLI test client can approve, deny, always-allow, or answer before richer clients exist.
- Local web page shows current Claude session status.
- Setup CLI installs, updates, partially enables, or disables target repo hook configuration.
- User-level setup CLI installs, refreshes, dry-runs, or uninstalls Companion-managed global hooks without overwriting unrelated Claude Code settings.
- Doctor CLI checks global hook coverage, hook paths, daemon health, disabled flag state, and global/project double-hook risk.
- Runtime switches can bypass remote approval or status capture without editing settings JSON.
- Basic risk label for commands: `low`, `medium`, `high`.

Required APIs:

- `GET /health`
- `POST /hook/pre-tool-use`
- `POST /hook/permission-request`
- `POST /hook/event`
- `GET /sessions`
- `GET /pending-requests`
- `POST /permission-decisions`
- `GET /ws`

Exit criteria:

- A harmless Bash command can be approved remotely.
- A PowerShell command can be approved through the native `PermissionRequest` hook.
- `AskUserQuestion` can be answered remotely with `updatedInput.answers`.
- Session status changes can be observed as `thinking`, `running_tool`, `waiting`, `waiting_approval`, `waiting_answer`, `done`, `failed`, or `blocked`.
- A target repo can be configured idempotently without hand-editing JSON.
- User-level hooks can be installed idempotently with `npm run setup-user-hooks`.
- `npm run doctor` reports missing global hooks, bad paths, daemon status, disabled flag state, and double-hook risk.
- `CCC_BYPASS_APPROVAL_HOOK=true` hands approval/question control back to Claude Code's native UI.
- `CCC_DISABLE_STATUS_HOOK=true` stops Companion status capture.
- `npm run setup-hooks -- <target-repo> --disable` removes Companion-managed hooks while preserving unrelated settings.
- Hook timeout behavior is defined.
- Logs show request id, session id, tool summary, and decision.

Docs to update:

- `docs/protocol.md`
- `docs/security.md`
- `docs/dev-setup.md`

## Stage 1: Windows Floating Companion

Goal: Make Claude Code status and approvals visible from a tiny always-on-top desktop surface.

Scope:

- Electron floating island for Windows development.
- Transparent, frameless, movable, always-on-top window. All Win11 rectangle sources opted out (`thickFrame: false`, `roundedCorners: false`, `backgroundMaterial: "none"`, `hasShadow: false`) so the visible surface is a pure capsule.
- Two-tier sizing: CAPSULE_BOUNDS for the visible bubble, MODE_BOUNDS = capsule + `BUBBLE_PADDING` (12 px gutter) for the BrowserWindow. Snap and peek math operates in capsule coords.
- Resting compact state shows the status emoji + conic context-usage ring + status label.
- Hover compact state reveals the controls strip (toggle / settings / expand / minimize).
- Native window bounds animation expands from compact capsule to approval / question panel.
- Screen-edge snapping with a context-only peek slit on drag-to-edge.
- Slit hover detection via main-process cursor polling (browser hover state is stale after the BrowserWindow slides off-screen).
- Done-state attention cue: capsule slides out for `DONE_ATTENTION_MS = 10 min` with a sage→warm sweep; after re-tucking, the slit pulses with sage glow until acknowledged.
- Desktop placement persistence in `~/.claude-companion/desktop-state.json` for bounds, mode, snapped edge, and tucked state, with startup clamping for monitor/resolution changes.
- Higher-priority always-on-top guard so the island reasserts topmost behavior while visible.
- Status summary for `idle`, `thinking`, `running_tool`, `waiting`, `waiting_approval`, `waiting_answer`, `done`, `failed`, `blocked`.
- Approval card covers every event Claude Code can hook for user input: `PreToolUse(Bash|PowerShell|ExitPlanMode|AskUserQuestion)`, `PermissionRequest` matcher `""` (Read / Edit / Write / Glob / Grep / WebFetch / MCP tools).
- `permission_suggestions[]` rendered as one button per "always allow X"; the picked index round-trips to the daemon as `decision.updatedPermissions`.
- Answer form for `AskUserQuestion` (option pills + free-text fallback).
- Pluggable on/off via `~/.claude-companion/disabled` flag file (Power button on the bubble + manual `type nul`).
- Per-family learned context window in `~/.claude-companion/learned-context.json` (peak-overrun + compact-observed signals; never auto-demotes).
- Design tokens, motion library, and component recipes codified in [docs/design-language.md](design-language.md) with a v0 visual preview at [docs/design-language-v0.html](design-language-v0.html).
- WebSocket first, HTTP polling fallback.

Non-goals:

- Do not control the terminal process directly.
- Do not read Claude Code memory, terminal buffers, or transcript files directly.
- Do not replace Claude Code's native approval UI when `CCC_BYPASS_APPROVAL_HOOK=true`.
- Do not add LAN or iPhone pairing in this stage.

Exit criteria:

- `npm run desktop` opens the compact companion island.
- With the daemon running, the window connects to `ws://127.0.0.1:4317/ws`.
- A real pending Bash or PowerShell request can be approved or denied from the floating window.
- A real `AskUserQuestion` request can be answered from the floating window.
- The user can glance at the window and know whether Claude is running, blocked, waiting, failed, or done.
- The window stays compact by default and expands only when action is needed.
- A tucked edge bubble visibly announces a fresh `done` transition and clears that reminder only after pointer acknowledgement.
- Window position, edge tuck, and mode survive desktop restart, and restored bounds stay reachable after display changes.

Docs to update:

- `README.md`
- `docs/dev-setup.md`
- `docs/user-guide.md`
- `docs/desktop-companion.md`
- `docs/security.md`

## Stage 2: Desktop Personality Layer

Goal: Add optional personality after the minimal approval loop feels right.

Scope:

- Optional visual identity or pet mode.
- More animation states: idle, working, waiting, happy, failed, sleeping.
- Optional icon-only mode.
- Click or hover expands into the approval/status panel.
- Local notification or attention cue when Claude needs the user.
- Basic positioning persistence.
- Tray menu, approval history, and stronger high-risk confirmation are captured as later product hardening work, not blockers for the first pet mode.

Non-goals:

- Do not ship copied proprietary mascot assets.
- Do not commit to a specific mascot before the minimal interaction is validated.
- Do not let decorative animation obscure approval details.
- Do not add gamification that slows down approvals.

Exit criteria:

- The pet can sit on the desktop without blocking normal work.
- The pet clearly signals waiting approval or waiting answer.
- The full approval controls remain one interaction away.
- Window position and compact/pet mode survive restart.

Docs to update:

- `docs/desktop-companion.md`
- `docs/security.md`
- `docs/user-guide.md`

## Stage 3: Local Network iOS MVP

Goal: Make the same approval loop usable from a real iPhone on the same Wi-Fi or hotspot.

Scope:

- SwiftUI iOS app.
- Manual IP connection first, then QR pairing.
- WebSocket from iPhone to Windows daemon.
- Pending permission request UI.
- Approve / deny / answer actions.
- Basic current state view.
- Token-based pairing.
- Local-only mode, no cloud account.

Required daemon capabilities:

- HTTP API for pairing and hook ingestion.
- WebSocket broadcast for state and permission requests.
- Pending request queue.
- Device token storage.
- Simple local config file.

Required iOS capabilities:

- Connection screen.
- Pairing screen.
- Session status screen.
- Permission request detail screen.
- Decision submission.
- Local notification when app is foreground/background-capable enough for MVP testing.

Exit criteria:

- A new tester can install daemon, run setup, connect iPhone, and approve a request.
- App shows tool, command or question, working directory, risk, reason, and session.
- If the phone disconnects, hook behavior remains safe.
- No full source code or large logs are sent to the phone by default.

Docs to update:

- `docs/protocol.md`
- `docs/security.md`
- `docs/troubleshooting.md`
- `docs/user-testing.md`

## Stage 4: iOS Alpha Hardening

Goal: Make the local iOS MVP reliable enough for a small open-source tester group.

Scope:

- Bonjour / mDNS discovery where available.
- QR fallback remains available.
- Improved reconnect behavior.
- Approval history.
- Better command risk classification.
- Always-allow rules for safe repeated commands.
- TestFlight or source-build instructions for iOS testers.

Exit criteria:

- 3-5 testers can complete setup with documented steps.
- Common Windows firewall issues are documented.
- Connection recovery is predictable.
- High-risk actions require a stronger confirmation in the iOS app.
- Approval history can be inspected locally.

Docs to update:

- `docs/dev-setup.md`
- `docs/testflight.md`
- `docs/security.md`
- `docs/release-checklist.md`

## Stage 5: Live Activity / Dynamic Island

Goal: Add glanceable iPhone status after leaving the app.

Scope:

- ActivityKit + WidgetKit extension.
- Local Live Activity updates while app is active enough to update state.
- Lock Screen and Dynamic Island status summary.
- Tap opens the relevant request or session screen.

Non-goals:

- Do not put sensitive approval details directly in the Dynamic Island.
- Do not rely on Live Activity as the only approval notification path.

Exit criteria:

- Running command, waiting approval, failed, and done states display correctly.
- Live Activity can be started and ended from the app.
- Sensitive command details remain inside the app detail screen.

Docs to update:

- `docs/ios-live-activity.md`
- `docs/security.md`

## Stage 6: Remote Relay

Goal: Allow use outside the same local network while preserving trust boundaries.

Scope:

- Cloud relay prototype.
- Device binding.
- End-to-end or relay-minimized encryption design.
- APNs for notifications and Live Activity remote updates.
- Token rotation.
- Lost-device unlink flow.

Exit criteria:

- Remote approval works without exposing Windows daemon directly to the internet.
- Relay does not store source code or full command output by default.
- Threat model is documented.

Docs to update:

- `docs/relay.md`
- `docs/security.md`
- `docs/privacy.md`

## Stage 7: Community Release

Goal: Make the project understandable and usable for open-source users.

Scope:

- Public GitHub README.
- Windows installer or clear package command.
- iOS source-build guide and/or TestFlight public link.
- Demo video or GIF.
- Issue templates.
- Contribution guide.
- Stable protocol version.

Exit criteria:

- A developer who did not build the project can run the daemon and connect the desktop companion by following docs.
- iOS setup is documented when that stage exists.
- Security limitations are visible before installation.
- Protocol compatibility is versioned.
- Release checklist is repeatable.

Docs to update:

- `README.md`
- `docs/dev-setup.md`
- `docs/release-checklist.md`
- `docs/contributing.md`

## Stage Gate Rule

Before moving to the next stage:

1. Update the stage status.
2. Add or update at least one demo note.
3. Record any architectural decision that changed the plan.
4. Update security notes if permissions, networking, storage, or phone-visible data changed.
