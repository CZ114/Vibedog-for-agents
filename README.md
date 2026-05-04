# Clawdeck

> Floating Windows companion for Claude Code — approvals, status, and a daily knowledge-card review, all in one bubble that morphs like a liquid droplet between modes.

<p align="center">
  <img src="media/hero-status.apng" alt="Floating bubble cycling through Idle, Thinking, Running tool, Awaiting approval, Done — the orb tells you what Claude is doing at a glance" width="480">
</p>

> The orb tells you what Claude is doing at a glance. No alt-tab.

<p align="center">
  <img src="media/edges-cycle.apng" alt="Bubble docks to right, top, left, bottom — and tucks behind each edge to a thin context slit when not in use" width="640">
</p>

> Drag it to any screen edge. When you're not looking at it, it tucks behind the edge to a 4-px context-percent slit — out of your way, still glanceable.

> iOS planned. Internally still referred to as "Claude Code Companion" in protocol code and env vars (`CCC_*`) — same project.

---

## Why

- **Claude Code's permission prompts steal your terminal focus.** Clawdeck routes them through a floating bubble — one click to approve, deny, answer, or always-allow; bubble dismisses; back to your editor.
- **Status is ambient.** The orb shows `thinking` / `running_tool` / `waiting_approval` / `done` so you know what Claude is doing without alt-tabbing. Snap it to a screen edge and it peeks out instead of getting in your way.
- **Your Claude sessions become study material.** Stage 1.5 Knowledge Cards turn yesterday's transcripts into spaced-repetition cards with verbatim source quotes — no hallucinations.

---

## The bubble has 5 modes

| Mode | Trigger | What it shows |
|---|---|---|
| **Compact** | default resting state | status orb + status text + context meter; auto-peeks when snapped to a screen edge |
| **Approval / Question** | auto on permission request | risk chip · tool / cwd / reason · Approve / Deny / Always-allow, or a freeform answer for question requests |
| **📚 Cards** | 📚 button | Today · History · Wrong-book · Generation Record |
| **⚙ Settings** | ⚙ button | left-rail nav: Knowledge cards · Storage · Export · Companion (themes + EN/中文 + hook status) |
| **⤢ Live** | ⤢ button | semi-transparent monitor with breathing pulse: today's deck summary + active Claude sessions |

Transitions use a single liquid water-droplet morph — the OS window resize and the renderer's `border-radius` interpolate on a synchronized bouncy curve, so the bubble stretches rather than snapping.

<p align="center">
  <img src="media/approval-flow.apng" alt="Bash request lands → bubble auto-morphs to approval card → click Approve → bubble glides back to compact, status flashes Done" width="520">
</p>

<p align="center">
  <img src="media/hero-morph.apng" alt="Settings → drag-select 5 days in the heatmap picker → Live → click Generate → 📚 fresh deck" width="480">
</p>

---

## Knowledge Cards (Stage 1.5)

Generated locally. Companion pipes a redacted slice of `~/.claude/projects/` JSONLs into a `claude -p` subprocess; the model returns cards keyed back to verbatim source quotes.

- **Strict source policy** — every card cites a real session line; optional web fallback cites the URL it pulled from
- **Redaction before send** — `.env*` adjacent lines dropped, token-shaped strings (GitHub PAT / Anthropic key / AWS key) substituted, usernames collapsed to `~`
- **Local only** — uses your authenticated `claude -p`; no direct Anthropic API call from Companion
- **Today / History / Wrong-book / Generation Record** tabs
- **Wrong cards return** until mastered (consecutive-correct threshold per difficulty)
- **Streak counter** survives one empty day with a 🛡 shield
- **Difficulty preset** — Casual / Balanced / Deep adjusts the easy / medium / hard mix
- **Heatmap session picker** — drag-select which days feed the generator; Auto top-3 / All / None shortcuts
- **Bilingual** — generator prompt branches on locale (English / 中文)
- **Export** — Today, all abstracts, or wrong-book → markdown that pastes cleanly into Obsidian / Notion

First generation is gated by an opt-in consent modal explaining the data flow.

<p align="center">
  <img src="media/cards-review.apng" alt="Cards mode: Today's deck → Start review → answer correct + wrong, with verbatim source citations" width="460">
</p>

---

## Themes

Four presets, every body-text contrast holds at WCAG-AA or better. Approve is always sage-green, Deny is always rose-red across all themes.

- **Midnight Teal** 深海青夜 — cool dusk surfaces with teal accent (default)
- **Amber Hearth** 暖夜炉火 — warm browns and amber, easy on the eyes after sundown
- **Paper Light** 晨纸轻亮 — white surfaces, slate ink, calm accents — daytime use
- **Aurora Indigo** 极光紫夜 — deep indigo with lavender + peach, cinematic

The swatch button on the controls strip cycles through them; the previews in Settings → Companion let you pick directly.

<p align="center">
  <img src="media/themes-cycle.apng" alt="Cycling through the four theme presets" width="480">
</p>

---

## Quick Start

Requires Node.js 20+.

```powershell
npm install
npm run smoke
```

**Install hooks globally** so the bubble works in every Claude Code project:

```powershell
npm run setup-user-hooks
npm run doctor
```

`setup-user-hooks` merges the Companion `hooks` block into `%USERPROFILE%\.claude\settings.json`, preserves unrelated settings, and writes a timestamped backup before changes. Use `-- --dry-run` to preview, or `-- --uninstall` to remove only Companion-managed hooks.

Run the daemon and bubble (two terminals):

```powershell
npm run daemon
npm run desktop
```

That's it — open Claude Code in any directory; permission prompts now route through the bubble.

### Kill-switch

The bubble's ⏻ button is equivalent to a sentinel file:

```powershell
type nul > %USERPROFILE%\.claude-companion\disabled    # disable
del %USERPROFILE%\.claude-companion\disabled           # re-enable
```

Per-shell escape hatches (next Claude Code launched in that shell):

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"   # use Claude Code's native approval / question UI
$env:CCC_DISABLE_STATUS_HOOK  = "true"   # stop recording status hook events
```

---

## Hooks Companion installs

Three Claude Code hooks, all merged into `~/.claude/settings.json` by `setup-user-hooks` (or per-project after `setup-hooks -- <path>`). Verify any time with:

```powershell
npm run doctor
```

| Hook | Fires when | What it does | Mode |
|---|---|---|---|
| `PreToolUse` | Before every tool call (Bash, Edit, Write, …) | Routes Claude's permission prompt through the bubble's approval card; the approve / deny / answer reply goes back to Claude as the hook's exit decision | **blocking** — Claude waits for your decision |
| `PermissionRequest` | On any explicit `ask` permission decision | Surfaces the request in the bubble, awaits decide / approve / deny / answer over WebSocket | **blocking** |
| `Event` | On every Claude lifecycle event (`thinking`, `tool_started`, `tool_finished`, `done`, …) | Feeds session state to the bubble's status orb and the Live monitor session list | **non-blocking** — fire-and-forget, never delays Claude |

The hook scripts themselves live in [`packages/hooks/`](packages/hooks/) — they're plain Node entry points that POST to the local daemon and write the daemon's reply back to stdout in Claude's hook protocol. `setup-user-hooks` only writes a JSON entry pointing to them; nothing is bundled into Claude Code.

**Toggling individual hooks** (per-shell — affects the next Claude Code launched in that shell):

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"   # PreToolUse + PermissionRequest fall through → Claude Code's native UI handles approvals
$env:CCC_DISABLE_STATUS_HOOK  = "true"   # Event hook returns noop → bubble stops receiving status updates
```

**Hard disable everything** without uninstalling:

```powershell
type nul > %USERPROFILE%\.claude-companion\disabled    # all hooks return noop on next fire
del %USERPROFILE%\.claude-companion\disabled           # re-enable
```

The bubble's ⏻ button writes / removes the same sentinel file.

**Uninstall**:

```powershell
npm run setup-user-hooks -- --uninstall   # removes only Companion-managed entries; leaves your other hooks alone
```

---

## Architecture

```
Claude Code (your terminal)
  ↓ hook (PreToolUse / PermissionRequest / Event)
Local daemon — http://127.0.0.1:4317
  ↕ ws://127.0.0.1:4317/ws    realtime events
Electron bubble (renderer + main)
```

HTTP endpoints used by the bubble (and any future client):

```
/sessions                  list of active Claude Code sessions
/pending-requests          permission requests awaiting decision
/permission-decisions      decision log
/pairing-token             for the planned iPhone client
```

<details>
<summary>Per-project hook install (legacy — use only if you want hooks scoped to one repo)</summary>

```powershell
npm run setup-hooks -- D:\path\to\project
npm run setup-hooks -- D:\path\to\project --status-only
npm run setup-hooks -- D:\path\to\project --approval-only
npm run setup-hooks -- D:\path\to\project --disable
```
</details>

<details>
<summary>Manual approval CLI (for headless / scripting use)</summary>

```powershell
npm run approve -- <requestId>
npm run deny -- <requestId> "Reason"
npm run answer -- <requestId> '{"Question text":"Answer label"}'
```

The Electron bubble does the same internally over WebSocket.
</details>

<details>
<summary>Hook entry points</summary>

```powershell
npm run hook:permission-request   # blocking — gates approvals
npm run hook:event                # non-blocking — feeds status / context
```
</details>

---

## Roadmap

| Stage | What | Status |
|---|---|---|
| 0 | Technical approval spike (daemon + hook) | shipped |
| 1 | Windows floating companion (5 modes + liquid morph) | shipped |
| 1.5 | Knowledge Cards | **shipped — v1.2.0** |
| 2 | Desktop personality layer | deferred |
| 3 | iPhone client over local network | unbuilt |
| 4 | Live Activity / Dynamic Island mirror | unbuilt |
| 5 | Remote relay (use outside the same LAN) | unbuilt |

Stage 2 is re-evaluated only after 1.5 has seen real use.
