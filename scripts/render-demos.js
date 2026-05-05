#!/usr/bin/env node
/*
 * scripts/render-demos.js
 *
 * Headless-renders every sequence in demo/bubble-mockup.html into an APNG
 * under media/. No more manual ScreenToGif. Run with:
 *
 *     npm run render-demos
 *
 * Pipeline per sequence:
 *   1. Playwright launches headless Chromium with video recording enabled.
 *   2. Page loads demo/bubble-mockup.html?seq=<name>&ui=hidden.
 *   3. The demo's autoplay block fires runSeqByName(name); we poll the
 *      window.__seqDone flag the demo flips at the end of every sequence.
 *   4. Page closes → Playwright finalises the .webm.
 *   5. ffmpeg crops to the record-frame's bounding rect captured before
 *      close, scales to a sane width, encodes APNG with infinite loop.
 *   6. Source .webm gets cleaned up.
 *
 * Requires:
 *   - playwright (devDependency, plus `npx playwright install chromium`)
 *   - ffmpeg on PATH (`winget install ffmpeg` on Windows)
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_err) {
  console.error(
    "[render-demos] playwright is not installed.\n" +
    "  → npm install\n" +
    "  → npx playwright install chromium\n"
  );
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEMO_PATH = path.join(PROJECT_ROOT, "demo", "bubble-mockup.html");
const TMP_DIR = path.join(PROJECT_ROOT, ".tmp", "render-demos");
const OUT_DIR = path.join(PROJECT_ROOT, "media");

// Sequences mirror demo/bubble-mockup.html#sequences. `timeout` is the
// upper-bound wait for window.__seqDone (the 200 ms settle delay + the
// sequence's own playtime + a generous tail). `width` is the target APNG
// width — kept tight on simple sequences (status / themes are just the
// bubble) so the file stays small, full record-frame on the spatial
// sequences (edges / morph) so all 4 sides are visible.
// `width` is the encoded APNG width (preserves aspect). `fps` lets us trade
// motion-smoothness for file size on the dense sequences — cards / morph
// have lots of pixel churn (text changes, panel scrolls, cursor + ripple
// + heatmap highlight + button state flicks) so they balloon at 24 fps;
// 18-20 fps + tighter width keeps them under GitHub's 10 MB inline limit.
// `xhsTight` (default false) = use the bubble/panel's max-area bbox over the
// sequence as the XHS crop instead of the whole record-frame. Switch on for
// sequences where the action stays centered (the .bubble-shell expands and
// contracts) — gets the UI filling the portrait canvas instead of swimming
// in dark padding. Leave off for sequences where the bubble physically
// translates across the frame (edges) — there we want the full frame so
// motion stays visible.
const SEQUENCES = [
  { name: "status",   output: "hero-status.apng",   timeout: 18000, width: 480, fps: 24, xhsTight: true },
  { name: "themes",   output: "themes-cycle.apng",  timeout: 14000, width: 480, fps: 24, xhsTight: true },
  { name: "edges",    output: "edges-cycle.apng",   timeout: 22000, width: 640, fps: 24, xhsTight: false },
  { name: "approval", output: "approval-flow.apng", timeout: 12000, width: 520, fps: 24, xhsTight: true },
  { name: "cards",    output: "cards-review.apng",  timeout: 22000, width: 460, fps: 18, xhsTight: true },
  { name: "morph",    output: "hero-morph.apng",    timeout: 26000, width: 480, fps: 15, xhsTight: true },
];

const VIEWPORT = { width: 1130, height: 1174 };
// Source pixel density. We tried DPR=2 to feed the XHS export a sharper
// source, but Playwright's recordVideo produced garbage pixels in the
// half of the canvas that wasn't backed by the rendered viewport at
// 2× — coords mapped correctly to where content lived but the rest of
// the frame was uninitialized GPU memory. DPR=1 keeps the webm 1:1
// with the logical viewport. Sharpness on XHS is still good because
// the bubble panel fills most of the cropped area (xhsTight=true).
const SOURCE_DPR = 1;
// Final XHS portrait dimensions. 1080×1440 is XHS's native preview
// aspect; combined with the 2× DPR source above it gets us sharp text
// from a lanczos *down*sample (vs the old 1× source which was
// up*scaled and slightly blurry). Bumping to 1440×1920 + 60fps with
// motion-compensated interpolation produced broken frames in some
// sequences — staying at 30fps with native source frames is safer.
const XHS_OUT = { width: 1080, height: 1440 };
const XHS_FPS = 30;

function checkFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error(
      "[render-demos] ffmpeg not on PATH.\n" +
      "  → winget install ffmpeg   (Windows)\n" +
      "  → brew install ffmpeg     (macOS)\n" +
      "  → apt install ffmpeg      (Linux)\n"
    );
    process.exit(1);
  }
}

async function renderOne(browser, seq) {
  const start = Date.now();
  process.stdout.write(`[${seq.name}] launching… `);

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SOURCE_DPR,
    recordVideo: {
      dir: TMP_DIR,
      // Match the DPR-scaled viewport so Playwright captures the high-res
      // composited output 1:1 (no resampling at capture time).
      size: { width: VIEWPORT.width * SOURCE_DPR, height: VIEWPORT.height * SOURCE_DPR },
    },
  });

  const page = await context.newPage();
  const url = pathToFileURL(DEMO_PATH).toString() + `?seq=${seq.name}&ui=hidden`;
  await page.goto(url, { waitUntil: "load" });

  // Capture the .record-frame's screen-space bounds BEFORE running the
  // sequence — used as ffmpeg crop coords below.
  const cropRect = await page.evaluate(() => {
    const el = document.querySelector(".record-frame");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
  if (!cropRect) throw new Error("record-frame not found in demo");

  // For xhsTight sequences, install a 50 ms poller that tracks the
  // .bubble-shell's max bounding box throughout the sequence — used as
  // the XHS crop so the panel fills the portrait canvas instead of the
  // ~half-empty record-frame.
  if (seq.xhsTight) {
    await page.evaluate(() => {
      window.__xhsTrack = { maxArea: 0, bbox: null };
      window.__xhsTick = setInterval(() => {
        const el = document.querySelector(".bubble-shell");
        if (!el) return;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > window.__xhsTrack.maxArea) {
          window.__xhsTrack.maxArea = area;
          window.__xhsTrack.bbox = {
            x: Math.round(r.left),
            y: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        }
      }, 50);
    });
  }

  process.stdout.write("recording… ");
  await page.waitForFunction(() => window.__seqDone === true, {
    timeout: seq.timeout,
  });

  // Pull out the max bbox the poller saw. If the sequence didn't expand
  // the bubble (poller returned nothing wider than its compact form),
  // we fall back to the full record-frame crop.
  let xhsBbox = null;
  if (seq.xhsTight) {
    xhsBbox = await page.evaluate(() => {
      clearInterval(window.__xhsTick);
      return window.__xhsTrack.bbox;
    });
  }

  // Grab the demo's body background as hex BEFORE close — needed as the
  // pad colour for the XHS portrait export below so the letterbox bands
  // blend invisibly into the mockup canvas.
  const bgHex = await page.evaluate(() => {
    const rgb = getComputedStyle(document.body).backgroundColor;
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m
      ? "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")
      : "#000000";
  });

  // Tail so the final frame settles + Playwright flushes the encoder
  await page.waitForTimeout(400);
  await page.close();
  await context.close();

  // Find the most recently written webm in TMP_DIR (Playwright assigns a
  // random name per recording session)
  const webms = fs
    .readdirSync(TMP_DIR)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!webms.length) throw new Error(`[${seq.name}] no webm produced`);
  const webmPath = path.join(TMP_DIR, webms[0].f);

  // The webm Playwright produced is at SOURCE_DPR× resolution, so every
  // crop coord captured in CSS px needs scaling up to webm px.
  const D = SOURCE_DPR;
  const cssToPx = (r) => ({ x: r.x * D, y: r.y * D, w: r.w * D, h: r.h * D });
  const cropRectPx = cssToPx(cropRect);

  // The same crop/scale filter chain feeds both encoders below. Source is
  // 2× — output `seq.width` is the same as before, so APNG/GIF benefit
  // from a lanczos downsample (crisper than the previous 1× input).
  const baseFilter =
    `crop=${cropRectPx.w}:${cropRectPx.h}:${cropRectPx.x}:${cropRectPx.y},` +
    `fps=${seq.fps},scale=${seq.width}:-1:flags=lanczos`;

  // 1) APNG — full 24-bit colour, infinite loop. -pred mixed keeps colour
  //    transitions smooth without ballooning size.
  const apngPath = path.join(OUT_DIR, seq.output);
  process.stdout.write("apng… ");
  const ffApng = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", webmPath,
      "-vf", baseFilter,
      "-plays", "0",
      "-pred", "mixed",
      apngPath,
    ],
    { stdio: "ignore" }
  );

  // 2) GIF — same dims, palette generated from the clip itself for the
  //    best possible 256-colour approximation. Floyd-Steinberg dither
  //    smooths the OKLCH gradients GIF can't represent natively.
  const gifPath = apngPath.replace(/\.apng$/, ".gif");
  process.stdout.write("gif… ");
  const ffGif = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", webmPath,
      "-vf",
      `${baseFilter},split[s0][s1];` +
      `[s0]palettegen=stats_mode=diff[p];` +
      `[s1][p]paletteuse=dither=floyd_steinberg:diff_mode=rectangle`,
      "-loop", "0",
      gifPath,
    ],
    { stdio: "ignore" }
  );

  // 3) XHS portrait MP4 + cover JPG — 1080×1440 (3:4), the in-feed preview
  //    aspect Xiaohongshu uses. The record-frame is 720×620 landscape-ish,
  //    so we pad top+bottom with the demo's own bg colour to reach 4:3
  //    height, then upscale 1.5× to 1080×1440. yuv420p + faststart for
  //    mobile compat. Cover JPG is the second-to-last frame (more interesting
  //    than the title-card first frame).
  const XHS_DIR = path.join(OUT_DIR, "xhs");
  fs.mkdirSync(XHS_DIR, { recursive: true });
  const mp4Path = path.join(XHS_DIR, `${seq.name}-portrait.mp4`);
  const jpgPath = path.join(XHS_DIR, `${seq.name}-cover.jpg`);

  // XHS crop: prefer the bubble-shell's peak bbox (inflated 24 CSS px
  // breathing room each side) so panels fill the portrait canvas; fall
  // back to the full record-frame for movement-heavy sequences. Then
  // pad to 3:4 with the demo's bg colour and upscale to XHS_OUT dims.
  let xhsCrop;
  if (xhsBbox && xhsBbox.w > 100 && xhsBbox.h > 80) {
    const PAD = 24;
    xhsCrop = {
      x: Math.max(0, xhsBbox.x - PAD),
      y: Math.max(0, xhsBbox.y - PAD),
      w: xhsBbox.w + 2 * PAD,
      h: xhsBbox.h + 2 * PAD,
    };
  } else {
    xhsCrop = cropRect;
  }
  const xhsCropPx = cssToPx(xhsCrop);

  // Pad direction depends on cropped aspect: if wider than 3:4 (W/H > 0.75)
  // we add top+bottom; if taller, we add left+right; if it's already 3:4
  // pad does nothing.
  const cropAspect = xhsCropPx.w / xhsCropPx.h;
  const padExpr = cropAspect > 0.75
    ? `pad=iw:iw*4/3:0:(oh-ih)/2:color=${bgHex}`     // letterbox top/bottom
    : `pad=ih*3/4:ih:(ow-iw)/2:0:color=${bgHex}`;    // pillarbox left/right

  // Filter order: crop → pad to 3:4 → scale to final dims (lanczos for
  // crisp downsample from the 2× DPR source) → ensure yuv420p for mobile
  // compat. No motion interpolation — Playwright's ~25fps capture cadence
  // is fine for these UI animations and avoids the artifacts mci produced
  // on this material.
  const xhsFilter =
    `crop=${xhsCropPx.w}:${xhsCropPx.h}:${xhsCropPx.x}:${xhsCropPx.y},` +
    `${padExpr},` +
    `fps=${XHS_FPS},scale=${XHS_OUT.width}:${XHS_OUT.height}:flags=lanczos,format=yuv420p`;

  process.stdout.write("xhs-mp4… ");
  const ffMp4 = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", webmPath,
      "-vf", xhsFilter,
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "16",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      "-r", String(XHS_FPS),
      mp4Path,
    ],
    { stdio: "ignore" }
  );

  // Cover JPG — pull a frame at ~45% of the sequence so we land on the
  // peak action (panel fully expanded / cards mid-review / approval card
  // visible) instead of the title or the post-sequence Idle revert.
  if (ffMp4.status === 0 && fs.existsSync(mp4Path)) {
    process.stdout.write("xhs-jpg… ");
    const ffProbe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration",
       "-of", "default=nw=1:nk=1", mp4Path],
      { encoding: "utf8" }
    );
    const dur = Number((ffProbe.stdout || "").trim()) || 5;
    const seekAt = (dur * 0.45).toFixed(2);
    spawnSync(
      "ffmpeg",
      [
        "-y", "-ss", seekAt, "-i", mp4Path,
        "-frames:v", "1",
        "-q:v", "2",
        jpgPath,
      ],
      { stdio: "ignore" }
    );
  }

  fs.unlinkSync(webmPath);

  if (ffApng.status !== 0) {
    console.error(`\n[${seq.name}] apng ffmpeg failed (exit ${ffApng.status})`);
    return null;
  }
  if (ffGif.status !== 0) {
    console.error(`\n[${seq.name}] gif ffmpeg failed (exit ${ffGif.status})`);
  }

  const apngMB = fs.statSync(apngPath).size / 1024 / 1024;
  const gifMB =
    ffGif.status === 0 && fs.existsSync(gifPath)
      ? fs.statSync(gifPath).size / 1024 / 1024
      : 0;
  const mp4MB =
    fs.existsSync(mp4Path) ? fs.statSync(mp4Path).size / 1024 / 1024 : 0;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `done · apng ${apngMB.toFixed(2)} · gif ${gifMB.toFixed(2)} · mp4 ${mp4MB.toFixed(2)} MB · ${elapsed}s`
  );
  return apngPath;
}

async function main() {
  checkFfmpeg();
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const seq of SEQUENCES) {
    try {
      const out = await renderOne(browser, seq);
      if (out) results.push(out);
    } catch (err) {
      console.error(`\n[${seq.name}] ${err.message}`);
    }
  }

  await browser.close();

  // Best-effort cleanup of any leftover .webm
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (f.endsWith(".webm")) {
      try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (_) {}
    }
  }

  console.log(`\nDone — ${results.length} / ${SEQUENCES.length} demos rendered.`);
  if (results.length < SEQUENCES.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
