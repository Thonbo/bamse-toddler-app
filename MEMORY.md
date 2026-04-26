# Vesters App — Decision Record & Memory

A toddler-safe web app: looping Bamse & Kylling videos with a transparent paint-over-video tap game. Built iteratively from v1 to v16 — this file captures the architecture decisions, what worked, what failed, and why.

**Live:** https://vesters-app.netlify.app
**Repo:** https://github.com/Thonbo/bamse-toddler-app
**Stack:** Single-file static HTML/CSS/JS + Service Worker, hosted on Netlify, no build step.

---

## 1. Architecture Decisions

### ADR-1: Single-file PWA over native Android app

**Context:** Original ask was a native Android APK.

**Decision:** Build a single-file PWA installable via "Add to Home Screen" instead.

**Reasoning:** A toddler doesn't care about APK vs PWA. PWA: zero build pipeline, instant deploy, works on iOS too if needed later. APK would have required Android Studio, signing keys, and the full Bubblewrap/Capacitor pipeline for what is fundamentally a web view. PWAs paired with Android's Screen Pinning give equivalent kiosk behavior.

**Outcome:** Correct call. Iteration speed was the entire game.

---

### ADR-2: YouTube IFrame API → plain iframe with `playlist=` parameter

**Context:** Wanted videos to auto-advance through a sequence instead of looping the same one.

**First attempt (v13–v15):** Loaded the YouTube IFrame Player API (`youtube.com/iframe_api`), constructed `new YT.Player('ytFrame', {...})`, listened for `onStateChange` with `YT.PlayerState.ENDED`, then called `loadVideoById` for the next video.

**Why it failed:** `new YT.Player()` constructed successfully, returned a valid player object with full prototype (`getIframe`, `addEventListener`, etc.), but **`onReady` never fired and the iframe `src` stayed empty** in headless Chromium. Couldn't reproduce on a real device but couldn't verify either, and the cause stayed mysterious despite three rounds of instrumentation.

**Final solution (v16):** Drop the API entirely. Use the documented iframe URL parameter:
```
https://www.youtube.com/embed/FIRST_ID?autoplay=1&loop=1&playlist=ID2,ID3,ID4,ID5
```
YouTube auto-advances through the comma-separated playlist; `loop=1` cycles the playlist when it ends. Each tile builds its own ordered playlist starting from that tile's video, wrapping around through the others.

**Outcome:** Works in headless test, works in real browsers, requires zero JavaScript for sequencing. **Lesson: prefer URL parameters over runtime APIs whenever the parameter form exists.**

---

### ADR-3: Top-level paint layer instead of game-bound canvas

**Context:** User asked for the tap game to overlay videos transparently.

**Original design:** Rainbow canvas + game bursts lived inside `.game-view`. Pointer handlers bound to `gameView`. When you'd press the Tap Game tile, you got a separate dark-background mode.

**Problem:** Couldn't paint over videos because the canvas was a child of a hidden view.

**Decision:** Extract a top-level `.paint-layer` (z-index 10) sibling to both `.video-view` and `.game-view`. Activate it whenever a video plays OR the standalone tap game is open. Pointer handlers attach to the paint layer, not the game view.

**Constraint that fell out:** Exit zones (long-press top-right) had to bump z-index above the paint layer (now 110/111 instead of 100/101) so the kid-proof exit gesture still works while painting.

**Outcome:** Clean separation. The paint layer is always either active (during video or game) or hidden (during menu). One pointer-handler attachment, one canvas to manage.

---

### ADR-4: SVG `feTurbulence` displacement filter, applied to canvas via CSS

**Context:** User wanted Perlin-noise displacement on the rainbow trail, with the noise field hidden (only used as the displacement map).

**Decision:** Define a hidden SVG filter (`<filter id="rainbowDisplace">`) with `feTurbulence` → `feDisplacementMap`, applied to the rainbow canvas via `filter: url(#rainbowDisplace)`. Animate `baseFrequency` and `seed` over time for slow self-evolution.

**What worked:**
- `feTurbulence` is GPU-accelerated and never drawn directly — the kid sees only the warped output of the canvas
- Animating `seed` via JS every ~120 frames gives continuous evolution without restarting the noise
- Animating `baseFrequency` with sin/cos gives the field a "breathing" feel
- Setting displacement `scale="85"` after starting at 42 gave the right amount of liquid distortion without dissolving the dots

**What we tried and dropped:**
- `feOffset` to translate the noise field (driven by tilt sensor) — user reported the trail "flowed off to the side" which broke the painting feel. Removed.
- Tilt sensor entirely — without translation it had nothing to do.
- Multi-octave Perlin field with two different baseFrequencies for R vs G channels — the SVG primitive doesn't directly support per-channel noise sources, would have required two filter chains. Dropped as overengineered for the result wanted.

---

### ADR-5: Per-frame dot drawing instead of line segments

**Context:** Originally drew rainbow trail with `lineTo`/`stroke` between consecutive pointer positions.

**Decision (v8+):** Each animation frame, draw a single colored dot at each pointer's current position. Hue cycles +3°/frame, radius pulses 10-18px via `Math.sin(frame * 0.15)`.

**Why:** Lines required interpolation and were thin and uniform. Dots are thicker, support the size-pulse effect, and look more organic when hit by the displacement filter. The displacement is the visual character — it needs blobby shapes to chew on, not thin lines.

---

### ADR-6: Per-frame alpha-fade + accumulating blur for trail history

**Context:** User wanted history to fade out and grow soft over time.

**Original approach:** `globalCompositeOperation = 'destination-out'` + low-alpha black rectangle each frame. Got the fade but no blur, and dimming was uneven.

**Final approach (v8):** Each frame:
1. Snapshot rainbow canvas → offscreen blur canvas with `ctx.filter = 'blur(0.6px)'`
2. Clear rainbow canvas
3. Draw blur canvas back at `globalAlpha = 0.985`
4. Draw fresh dots on top with full opacity

**Why this works:** Old strokes accumulate ~30 frames of 0.6px blur per second → softens to dreamy trails over a few seconds. Alpha decay 0.985 → ~4-second visible lifetime. New dots stay crisp because they're drawn after the blur step.

**Cost:** One offscreen `drawImage` per frame. On modern GPUs negligible. On older Android, fine.

---

### ADR-7: Service worker — network-first for HTML, cache-first for assets

**Context:** v3-v9 used cache-first for everything. Resulted in stuck old versions on the user's installed PWA, despite multiple deploys. User couldn't see version updates.

**Investigation:** Found that Netlify CDN was occasionally returning 18-byte "DNS cache overflow" stubs. The cache-first SW happily cached them, then served them as the offline shell for hours.

**Decision (v10):** Two-tier strategy:
- **HTML (`index.html`, `/`):** network-first. Try the network with `cache: 'no-store'`. If response is valid (>1KB, 2xx), update cache. If response is bad/empty, fall back to cached good copy. If offline, serve cached.
- **Assets (icons, manifest, fonts):** cache-first. These rarely change.
- **YouTube traffic:** never intercept. Pass through to network.
- **`MIN_HTML_BYTES = 1000` guard:** any HTML response under 1KB is treated as bad and not cached.

**Outcome:** New deploys appear on next launch. Stale cache problem solved. PWA still works fully offline (videos still need WiFi but the shell loads).

---

### ADR-8: Cache version + visible version badge for verification

**Context:** User couldn't tell whether they were looking at the latest version after a deploy.

**Decision:** Three signals visible at all times:
1. Subtitle on the menu: "v16 · Tap to play" (impossible to miss)
2. Tiny version badge in bottom-right of menu: "v16"
3. Tiny version badge in bottom-left of game view: "v16"

Bump the SW `CACHE` constant on every deploy (`vesters-v3` → `vesters-v16`). The cache version is what triggers the SW update lifecycle.

**Plus auto-reload on SW update:** Listen for `navigator.serviceWorker.controllerchange` and call `window.location.reload()` once. Means the user gets the new version without manual intervention after one launch.

---

### ADR-9: Material 3 Expressive design tokens for the menu

**Context:** User asked to use a popular open-source design system.

**Decision:** Adopt M3 design tokens (color roles, shape scale, type scale, elevation, state layers, motion easing) — but tuned to the Expressive variant: vibrant primary container colors, larger shape scale (28–36px corners), Roboto Flex with extreme variable settings (wght 900, wdth 125, italic accents), springy `cubic-bezier(0.42, 1.67, 0.21, 0.90)` easing.

**Why M3 Expressive over Bootstrap/Chakra/Radix/shadcn:** Those are built for adult productivity UIs. Toddlers need bold color, big shapes, playful motion. M3 Expressive is the only "real" design system whose visual language is already tuned that way.

**Outcome:** Looks intentional, not generic-AI. Roboto Flex variable axes give one font family the range from "tiny utility caption" to "huge bouncy headline."

---

### ADR-10: Landscape lock + 6-tile 3×2 grid

**Context:** Original 5-tile-wide landscape layout overflowed off-screen. User then asked to lock orientation. Then user asked to add a 6th video.

**Decision:**
- Lock orientation to landscape via both `manifest.json` (`"orientation": "landscape"`) and JS (`screen.orientation.lock('landscape')`).
- Landscape grid: `grid-template-columns: repeat(3, 1fr)` × 2 rows = 6 tiles.
- All sizing uses `clamp()` with vh-based bounds so nothing clips.

**Why both manifest AND JS:** The manifest controls the installed PWA launch orientation. The JS lock catches the in-browser case where the manifest doesn't apply.

---

## 2. What Failed (and Why)

### F1: TDZ ReferenceError silently killed the tap game (v8-v12)

The `resizeRainbow()` function referenced `blurCanvas`, but `blurCanvas` was declared with `const` *later* in the script. Even with a `typeof blurCanvas !== 'undefined'` guard, the temporal dead zone threw `ReferenceError: Cannot access 'blurCanvas' before initialization` when the function was called during script evaluation.

**Effect:** The error happened mid-script, killed all the JavaScript that came after. Pointer handlers were registered (they came before the bug), but the drawing loop never started. Pointer events fired into the void and nothing painted.

**How we found it:** Playwright. The diagnostic test caught the error in `pageerror` and revealed the real cause in seconds. Without Playwright, I'd have kept guessing at pointer-events stacking issues.

**Fix:** Move `const blurCanvas = document.createElement('canvas')` before the first call to `resizeRainbow()`.

**Lesson:** `typeof` checks don't save you from TDZ. The reference itself throws, before `typeof` runs. Always declare → use, never use → declare.

---

### F2: YouTube IFrame API silently failed in headless Chromium

Spent v13-v15 trying to make `new YT.Player()` work for sequential playback. Construction succeeded, callbacks didn't fire, iframe stayed empty. Couldn't reproduce on real devices (no test environment) but couldn't verify either.

**Resolution:** Switched to URL parameters (ADR-2). Fixed the symptom and made the code simpler — about 75 lines of JS deleted.

**Lesson:** When a third-party JS API fails opaquely in your test environment, don't assume "it works on real devices, ship it." Find a simpler integration path that works everywhere. URL parameters > runtime APIs whenever both exist.

---

### F3: Gigantic stale-cache problem with cache-first SW

Multiple deploys went out and the user kept seeing the old version on the installed PWA. The user manually had to clear app storage every time. Worst-case: a transient Netlify edge error got cached as the "good" version and served from then on.

**Fix:** ADR-7 (network-first for HTML + size guard). After v10, deploys propagate within one launch.

**Lesson:** Cache-first is wrong for HTML in any app where the user expects updates. The classic SW recipe ("cache the shell, network for data") doesn't fit single-page apps where the shell IS the app.

---

### F4: Pointer-events misrouted to `.game-canvas` (v11)

`.game-canvas` (the burst-effect container) sat at `position: absolute; inset: 0` with no `pointer-events: none`. It blocked all touches before they reached `gameView`.

**Symptom:** "Tap game receives no input."
**Fix:** Add `pointer-events: none` to `.game-canvas` (and later `.game-bg`).

**Lesson:** Anything `absolute`-positioned with `inset: 0` in a game/canvas-heavy app needs `pointer-events: none` unless it's specifically supposed to capture touches. Audit the entire stack with `document.elementsFromPoint()` when input mysteriously disappears.

---

### F5: Forcing landscape lock broke rotation

Locked orientation to landscape, then user wanted free rotation. Removed lock, then user wanted lock-back. Each toggle required updates in three places: manifest, JS lock call, CSS media queries.

**Lesson:** Orientation policy is a global app contract. Decide it once, document it (ADR-10), and the CSS landscape/portrait queries should still work fine because the OS just reports landscape constantly.

---

### F6: Trying to translate the displacement map

Spent a session adding `feOffset` between turbulence and displacement, hooked it up to the device tilt sensor (gamma/beta), and made the trail "flow" with device tilt. Tested fine in concept. User actually used it and said "the trail is moving off to the side, that's not the intention."

**Fix:** Removed `feOffset`, removed tilt sensor handling, kept only the slow self-evolution of the noise via `baseFrequency` + `seed` animation.

**Lesson:** Cool ≠ good. The user's mental model was "displacement that warps in place," not "a flow field that moves the painting." When the result doesn't match the user's intention, simpler is better.

---

## 3. What Worked Well (Beyond ADRs)

### S1: Playwright as a debug tool, not just a test runner

Used Playwright less for regression and more as a **diagnostic** tool: load the live URL, click stuff, dump `window.__state`, check `document.elementsFromPoint`, log all `pageerror` events. Found the TDZ bug in 30 seconds. Confirmed paint-over-video works visually. Caught silent YT API failures.

The `__ytApiReady` and `__ytPlayer` window-exposure trick: surface internal state on `window.__*` for tests to inspect without changing public API.

### S2: Version badge as a debugging tool

Visible "v16" in the menu subtitle saved hours of "is this the new version?" back-and-forth. Bumping the badge with every deploy is a tiny cost for permanent end-to-end verification.

### S3: Single-file architecture

Whole app is one HTML file with embedded CSS and JS, plus a small `sw.js`, manifest, and icons. Deploy = `git push`. No build step, no dependencies, no transpilation, no module resolution. Iteration speed mattered far more than code organization at this scale.

### S4: Snapshot-blur-redraw for trail effects

The offscreen-canvas trick (snapshot → blur → redraw at reduced alpha) is reusable. Works for any "history fades and softens over time" effect. Cheaper than ImageData manipulation, more controllable than `destination-out` compositing.

### S5: URL-parameter-based YouTube playlist

`?autoplay=1&loop=1&playlist=ID,ID,ID` is the simplest possible video-sequencing primitive. No script tag, no postMessage, no event handlers. Five iframe URL parameters do what 75 lines of JS were trying to do.

---

## 4. Things Deliberately NOT Done

- **Video offline caching.** YouTube licenses don't permit it. Would require hosting copies, which is legally questionable and would balloon the app to hundreds of MB.
- **Native APK packaging.** PWA + Screen Pinning is sufficient for the use case. PWABuilder remains an option if real APK is later needed.
- **Preventing video skipping/scrubbing in the iframe.** The `controls=0` parameter hides them but YouTube still allows keyboard skipping. Acceptable tradeoff because toddlers don't use keyboards. The `.video-blocker` div is the second line of defense for accidental video-controls activation.
- **A "next" or "previous" button.** YouTube's playlist auto-advance handles this. Adding manual controls would clutter the UI and toddlers can't read button labels.
- **Audio analytics or play-count tracking.** Out of scope; no analytics anywhere in the app.
- **Multi-language UI.** All UI is Danish/English mixed (matches user). Adding i18n would require more structure than this single file deserves.

---

## 5. Final State (v16)

| Component | Implementation |
|---|---|
| Hosting | Netlify, project ID `b8a0aeff-d9d7-44f7-89c6-f964290b5ee7` |
| Deploy method | `git push` (no auto-deploy hook configured; manual via MCP) |
| URL | https://vesters-app.netlify.app |
| GitHub repo | `Thonbo/bamse-toddler-app` |
| Files | `index.html` (~38KB), `sw.js`, `manifest.json`, 4 icon PNGs, `README.md` |
| Videos | 5 (Jodlesangen, Brum Brum, Okay Okay, Bamses Sang, Hjulene) |
| Auto-advance | Native YouTube `playlist=ID,ID,ID,ID` + `loop=1` |
| Tap game | Per-frame colored dots, hue-cycling, sine-pulse radius |
| Visual effect | SVG `feTurbulence` + `feDisplacementMap` filter on canvas |
| Trail decay | Offscreen blur canvas, alpha 0.985, blur 0.6px/frame |
| Paint over video | Top-level `.paint-layer` with z-index 10 |
| Exit gesture | 2-second long-press top-right corner, z-index 110 |
| Menu | Material 3 Expressive, Roboto Flex variable, 3×2 landscape grid |
| Service worker | Network-first HTML, cache-first assets, YouTube passthrough, size-validity guard |
| Tests | Playwright suite: 20/20 passing as of v16 |

---

*Last updated: v16, April 2026*
