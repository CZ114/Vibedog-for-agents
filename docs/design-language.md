# Design Language

Tokens, motion, and recipes that govern every visual surface in the desktop companion. New components must reference this file; new colors and curves require a token here first, not an inline value.

## Principles

1. **Tech, not toy.** Architectural neutrals lead. Saturation is reserved for status.
2. **Premium, not loud.** Depth comes from layered highlight + soft shadow, never from heavy strokes or hard outlines.
3. **Humanistic warmth.** Whites are warm (`oklch(95% 0.014 80)`, never pure `#fff`); idle motion is ≥ 5 seconds (a sleeping pet, not a nervous tic).
4. **Color carries meaning.** A saturated surface must encode a status the user cares about. Decoration uses neutrals.

## Forbidden

- Primary saturated red, yellow, blue, purple, green (`#15803d`, `#b91c1c`, `#2563eb` and friends are out)
- Purple-pink-blue gradients
- Solid bright color blocks on buttons (replace with muted-tint-on-charcoal compositions)
- Colored left-border accent cards (AI cliché)
- Outer rectangular outline around the bubble (`thickFrame: false` on the BrowserWindow; no transparent gutter outside the capsule)
- Inter / Roboto / Arial / Fraunces / `system-ui` (overused). Use Segoe UI Variable on Windows; Cascadia Mono for code.
- Disney-bounce entry animations (overshoot > 1.2× scale)

## Color Tokens

Authored in `oklch()` so derivations stay perceptually uniform. Hex equivalents are documentation only — CSS uses OKLCH.

### Surfaces (cool dusk ladder)

| Token | oklch | Hex ≈ | Use |
|---|---|---|---|
| `--surface-0` | `oklch(13% 0.012 270)` | `#16181f` | desktop / behind everything |
| `--surface-1` | `oklch(17% 0.014 270)` | `#1d1f29` | bubble body, default panel |
| `--surface-2` | `oklch(22% 0.016 270)` | `#272a36` | raised inner cards, command preview |
| `--surface-glass` | `oklch(20% 0.014 270 / 0.86)` | semi | hover controls strip |

### Ink

| Token | oklch | Hex ≈ | Use |
|---|---|---|---|
| `--ink-0` | `oklch(95% 0.014 80)` | `#f1ede4` | primary text (warm white) |
| `--ink-1` | `oklch(70% 0.012 250)` | `#a4a8b3` | secondary / labels |
| `--ink-2` | `oklch(50% 0.010 250)` | `#73778a` | tertiary / disabled |
| `--line` | `oklch(60% 0 0 / 0.10)` | rgba | hairlines, never used as a frame |

### Accents (semantic, low-saturation)

| Token | oklch | Hex ≈ | Mapped to |
|---|---|---|---|
| `--accent` | `oklch(72% 0.06 195)` | `#7fb1ad` | thinking, default context ring |
| `--accent-slate` | `oklch(60% 0.03 250)` | `#7d8a9b` | running_tool |
| `--accent-warm` | `oklch(78% 0.08 70)` | `#d4ad7a` | waiting, waiting_answer, medium risk |
| `--accent-warm-hi` | `oklch(82% 0.10 70)` | `#e3b87f` | waiting_approval, attention |
| `--accent-sage` | `oklch(72% 0.06 150)` | `#9ab59a` | done, approve |
| `--accent-rose` | `oklch(70% 0.07 25)` | `#cd9a93` | failed, blocked, high risk, deny |

### State → palette mapping

| Status | Ring | Text accent | Background tint |
|---|---|---|---|
| `idle` | `--ink-2` | `--ink-0` | none |
| `thinking` | `--accent` | `--ink-0` | none |
| `running_tool` | `--accent-slate` | `--ink-0` | none |
| `waiting` / `waiting_answer` | `--accent-warm` | `--ink-0` | very subtle warm wash |
| `waiting_approval` | `--accent-warm-hi` | `--ink-0` | subtle warm wash |
| `done` | `--accent-sage` | `--accent-sage` | very subtle sage wash (during attention only) |
| `failed` / `blocked` | `--accent-rose` | `--accent-rose` | none |

## Spacing

4-pixel base. Allowed values: `4, 6, 8, 12, 16, 24`.

## Radius

- Capsule (compact island): `999px`
- Expanded card: `18px` (down from 28; sharper without feeling square)
- Inner buttons: `12px` (down from 999; capsule buttons read as candy)
- Inner inputs: `10px`
- Status orb: `50%`

## Depth

Layered, never a single hard stroke.

```css
--shadow-inner-highlight:
  0 1px 0 inset oklch(100% 0 0 / 0.04),
  0 0 0 1px inset oklch(100% 0 0 / 0.05);

--shadow-float:
  0 12px 28px -10px oklch(0% 0 0 / 0.55),
  0 2px 6px -2px oklch(0% 0 0 / 0.45);

--shadow-float-tall:
  0 22px 44px -14px oklch(0% 0 0 / 0.62),
  0 4px 10px -4px oklch(0% 0 0 / 0.5);
```

Compact bubble uses `--shadow-inner-highlight, --shadow-float`. Expanded card uses `--shadow-inner-highlight, --shadow-float-tall`.

## Motion

Aim is "Apple-like" smoothness — soft easing, durations long enough to perceive but short enough to not feel laggy. Two practical rules that get us there:

- **Animate `transform` and `opacity`, not `background` / `box-shadow` / `width`.** Halos are pseudo-elements that scale + fade. The compositor handles the rest.
- **`@property --context-angle` and `@property --context-percent`** are registered on `:root` with a 720 ms transition, so the conic ring and the edge slit fill morph between values instead of jumping when ctx percentage updates.

| Token | Curve | Duration | Use |
|---|---|---|---|
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 220–320ms | size, opacity, color |
| `--ease-spring-soft` | `cubic-bezier(0.34, 1.2, 0.64, 1)` | 360–380ms | mode transitions, panel expansion |
| `--ease-decel` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | 240–320ms | hover reveals |
| `emojiBreathe` | `ease-in-out infinite` | 6s (idle) / 4.4s (thinking) | rest, thinking |
| `orbHalo` | `ease-in-out infinite` | 3.6s (think) / 1.8s (approval) / 2.6s (waiting) | halo bloom on `::after` |
| `orbSpin` | `linear infinite` | 2.6s | running_tool ring + counter-spin emoji |
| `orbAttention` | `ease-in-out infinite` | 1.8s | waiting_approval orb scale |
| `orbSway` | `ease-in-out infinite` | 3.4s | failed / blocked subtle drift |
| `emojiBob` | `ease-in-out infinite` | 3s | done resting |
| `emojiCelebrate` | `ease-in-out` | 980ms ×3 | done attention burst |
| `doneSweep` | `ease-out` | 1.6s ×2 | done celebration sweep |
| `peekDoneGlow` + `peekDoneFill` | `ease-in-out infinite` | 1.2s | edge slit attention while a `done` session is unacknowledged — sage glow via box-shadow plus a brightened fill, large amplitude on purpose so it stays catchable in peripheral vision |
| ctx ring fill | `--ease-standard` | 720ms | smooth `--context-angle` change |
| reduced motion | all paused | — | `@media (prefers-reduced-motion: reduce)` |

## Typography

```css
--font-ui: "Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
--font-mono: "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
```

- Status text: variable weight `600`, 13px, tracking `0.005em`. (Was `850` — too heavy, reads as cheap bold sans.)
- Eyebrows (`approval`, `question`): variable `500`, uppercase, `0.10em` tracking, `--ink-1`, 10px.
- Tool / question heading: variable `600`, 15px.
- Body / detail: variable `400`.
- **No numeric labels in any state** — the conic ring is the single context surface. `.context-label`, `.status-detail`, and `.context-meter` are CSS-hidden everywhere; the JS still updates them so we can re-enable per-mode if a future requirement returns numbers.
- Mono is reserved for command previews and ids — never used to make UI text feel "techy."

## Component recipes

### Compact island — rest

- Capsule, 124 × 42, `--surface-1`.
- `--shadow-inner-highlight` + `--shadow-float`.
- Status orb **26 × 26** (was 30 — felt orb-heavy versus text), conic-gradient ring at ~1.5px thickness, status emoji at 13.5px centered on `oklch(11% 0.01 270)` inner well.
- `--ink-0` status text only (no ctx number, no detail line).
- Halo is a `.status-orb::after` radial-gradient that fades and scales (transform + opacity) — keeps the loop smooth without needing extra hints.

### Compact island — hover

- Width animates to 202 × 42 with `--ease-spring-soft`.
- Window controls (gear / expand / minus) materialize in `--surface-glass` strip with `backdrop-filter: blur(10px) saturate(1.2)`. Buttons **20 × 20**, radius 7, `--ink-1` glyph; hover lifts to `--ink-0` with a subtle background tint (no fill color shift).
- Status text remains; **no ctx label appears on hover** (deliberate — the ring already encodes ctx).

### Expanded panel — approval

- 360 × 238, radius 18, `--surface-1` + `--shadow-float-tall`.
- Header layout: eyebrow over heading on the left, risk pill on the right.
- Risk pill: **outline style** — 1px solid `--accent-{warm,rose,sage}` border, transparent fill, tinted text. No solid color blocks.
- Command preview: `--surface-2` card, `--font-mono` 12px, 3-line clamp.
- Meta (`cwd`, `reason`): two rows, `--ink-1` label, `--ink-0` value.
- Buttons row: Approve (sage), Deny (rose); Always Allow above when present (warm).

### Buttons (action)

```css
.btn-approve {
  background: oklch(22% 0.025 150);   /* surface-2 with sage hint */
  color: var(--accent-sage);
  box-shadow: var(--shadow-inner-highlight);
}
.btn-deny {
  background: oklch(22% 0.025 25);    /* surface-2 with rose hint */
  color: var(--accent-rose);
  box-shadow: var(--shadow-inner-highlight);
}
.btn-allow {
  background: oklch(22% 0.025 70);    /* surface-2 with warm hint */
  color: var(--accent-warm);
  box-shadow: var(--shadow-inner-highlight);
}
```

Hover: bump inner highlight opacity + 1px translateY (no color shift; the muted base does the work).

### Done celebration

- Bubble slides out of edge tuck (existing main.js logic).
- 380ms `--ease-spring-soft` entry.
- 1.4s `done-sweep` — diagonal sage→warm gradient washes across the bubble at low opacity (`max alpha 0.18`).
- Status text gains a subtle sage glow (`text-shadow: 0 0 10px oklch(72% 0.06 150 / 0.35)`).
- No bright green flash. No saturated borders. No "💚" emoji or sparkles.

### Edge peek slit

- 12px slit, `--surface-1`, fills with current ring color at `var(--context-percent)` height.
- During unacknowledged `done`: 1.35s pulse uses sage glow only.

## Do / Don't

### Do

- Use **outline pills** (1px tint border + transparent fill + tinted text) for tags, eyebrows, risk indicators.
- Pair `--shadow-inner-highlight` with one outer shadow — that pairing is what reads as "premium."
- Prefer slower idle motion (≥ 4s loops) so the rest state feels content.
- Reserve sage exclusively for completion-class signals.
- Honor `prefers-reduced-motion` — disable all looping animations.

### Don't

- Don't put a solid bright color on a button. Tint over surface-2 instead.
- Don't add a colored left bar to cards.
- Don't use mono for non-code text.
- Don't introduce new hues; derive variants in OKLCH from existing accents.
- Don't bounce past 1.2× in entries.
- Don't surround the bubble with a transparent margin — the OS compositor will draw a faint frame in that gutter.
