# Vesters App — Development Memory

A retrospective of the build, kept so future-me (or any AI agent) doesn't repeat the same mistakes.

## What it is

Toddler-safe PWA for Philip's son Vester. Five looping Bamse & Kylling / Danish kids' songs that auto-advance through the playlist, plus a "Tap Game" mode where dragging fingers paints rainbows distorted by a Perlin displacement filter. Locked to landscape, long-press top-right to exit. Hosted on Netlify, source on GitHub.

- Live: https://vesters-app.netlify.app
- Repo: https://github.com/Thonbo/bamse-toddler-app
- Netlify site ID: `b8a0aeff-d9d7-44f7-89c6-f964290b5ee7`
- Single-file architecture: everything in `index.html` + `sw.js` + `manifest.json` + icons.

---

## Architectural decisions

### Static single-file HTML, not React or a framework
Rationale: the whole app is one screen with three states (menu, video, game) and no backend. A 35 KB `index.html` ships fully self-contained and cache-friendly. Anything fancier would have multiplied the deploy surface area for zero benefit on a kid's tablet.

### Material 3 Expressive design tokens for the menu, custom for game/video
Started raw, user asked for "a popular open source design system." Picked M3 because it's Google's, native-feeling on Android, and the "Expressive" 2025 variant is genuinely playful (big shapes, springy easing, bold color containers). Implemented as CSS custom properties — no JS framework dependency. Game and video views deliberately kept un-tokenized because they need to feel immersive, not corporate.

### YouTube playlist param, NOT the IFrame Player API
**Big lesson here.** First implementation used `loop=1&playlist=ID` for single-video looping. User then asked for sequential auto-advance through all videos. Tried the YouTube IFrame Player API — `new YT.Player(...)`, `onStateChange` listening for `ENDED`, then `loadVideoById(next)`. Spent v13–v15 on it. It would not work in headless Chromium and was fragile. **The simple iframe with `playlist=ID2,ID3,ID4,ID5&loop=1` does exactly the same thing in 5 lines instead of 60, and works everywhere.** Rule: reach for the official API only when the URL params can't express the requirement.

### Top-level paint layer overlaying both video AND game
User wanted the rainbow paint to also work on top of videos, not just in game mode. Refactored the canvas + SVG filter + game-canvas into a `.paint-layer` sibling to `.video-view` and `.game-view`, with `z-index: 10`. Pointer handlers attached to the paint layer, not the game view. Active during both video and game modes. This is the cleanest refactor that came out of the build — one place to draw, two contexts to draw over.

### Network-first service worker for HTML, cache-first for assets
Started cache-first for everything. Caused pain when v9 went out: the installed PWAs kept serving v8 because the SW never asked for fresh HTML. Rewrote as: HTML uses network-first with cache fallback (so users always see latest when online), assets stay cache-first (so they load fast offline). Also added a check that rejects responses smaller than 1KB (defends against Netlify's "DNS cache overflow" 18-byte error stubs being cached).

---

## Successes

- **Single-file PWA installs cleanly** as a standalone Android app via "Add to Home Screen" — proper icon, fullscreen launch, landscape-locked.
- **Long-press exit zone** with 2-second progress ring works reliably and toddler-can't-trigger-by-accident. z-index above paint layer so it's reachable during video and game.
- **Hold-to-spawn particles** + **drag-to-paint rainbow** + **per-frame sine-pulsed dots** feel right.
- **SVG `feTurbulence` + `feDisplacementMap`** applied via CSS `filter: url(#x)` to a 2D canvas — no shader code, no WebGL, GPU-accelerated. Slow self-evolution via animating `baseFrequency` (sine breathing) + bumping `seed` every ~120 frames.
- **Per-frame alpha-fade + accumulating blur** trick: snapshot canvas → blur it onto offscreen canvas → redraw at 0.985 alpha. Old strokes go soft and dreamy, new dots stay crisp.
- **20/20 Playwright tests passing** at v16 against the live site, including visual screenshot verification of menu, game-drawing, and paint-over-video.
- **Auto-reload-on-SW-update logic** fires `controllerchange` listener once per page so users land on the latest version after a deploy without manual cache clearing.

---

## Failures (mostly self-inflicted) and what was learned

### TDZ ReferenceError silently killed all drawing JS (v11→v13)
`resizeRainbow()` was called at module top-level and referenced `blurCanvas`, but `const blurCanvas` was declared 80 lines later. The `typeof blurCanvas !== 'undefined'` guard didn't save us — `const` TDZ throws synchronously before the typeof check evaluates. The whole script after that point silently never ran. Tap game appeared to "work" (pointer events fired) but never drew anything because the draw loop was never installed.
**Lesson:** when something appears completely dead, run Playwright with `page.on('pageerror', ...)` first thing. Would have caught this in 30 seconds. Spent two reply rounds guessing.

### Locked orientation in manifest broke device rotation
Set `"orientation": "landscape"` in manifest + `screen.orientation.lock('landscape')` in JS. User rotated device, app refused to follow. User said "it's ok if you lock just pick landscape for all." Kept it locked. Lesson: confirm the rotation requirement before locking.

### YouTube IFrame API failed in headless Chromium
v13–v15 used `new YT.Player(...)`. `window.YT.Player` constructor returned an object, but it never replaced the iframe with a real YouTube embed (iframe `src` stayed empty, no `onReady` fired). On a real device with autoplay + user gesture it likely would have worked, but the headless test environment couldn't verify. Also fragile because callback timing depended on whether YT script was cached. Rewrote in v16 using the URL `playlist=...&loop=1` parameter — instantly worked everywhere.
**Lesson:** if a URL parameter can express what you want, prefer it over a JavaScript SDK.

### `.game-canvas` and `.game-bg` blocked taps before pointer-events fix
`.game-canvas` is the div containing burst-effect particles, sized `inset: 0`. Without `pointer-events: none`, it sat over the gameView and absorbed every touch. The Playwright test caught this immediately by reporting "0 non-transparent pixels after dragging" + a stack trace showing `.game-bg` as the topmost element under the click point. Same fix needed for `.game-bg`.
**Lesson:** any decorative absolute-positioned full-screen child needs `pointer-events: none` unless it has a reason to receive input.

### Netlify CDN intermittent "DNS cache overflow" 18-byte responses
At one point the live URL returned `HTTP/2 200` with 18 bytes of body text "DNS cache overflow". Service worker happily cached this as the homepage. Users saw a blank page even after I'd deployed fixes. Resolved itself within minutes but spooked us. SW now refuses to cache HTML responses smaller than 1 KB.

### URL-encoded commas in test assertions
v16 test failed on `playlist=ID%2CID%2CID` not matching `playlist=ID,ID,ID`. Test bug, not app bug. Always decode before string-checking URL parameters.

### YouTube embed disabling on some unofficial uploads
A few of the user's chosen video IDs are fan re-uploads. Some may have embedding disabled or get taken down. The app shows YouTube's "Video unavailable" inside the iframe when this happens — not pretty, but unavoidable without ripping/hosting the videos ourselves (which we won't).

### Service worker cache version had to be bumped manually every release
Every deploy required: bump `const CACHE = 'vesters-vN';` in sw.js, bump version badge in index.html, bump subtitle text. Easy to forget, easy to mismatch. Worth automating with a build step if this ever leaves "weekend project" territory.

---

## Operational notes

- **GitHub authentication** uses Philip's throwaway PAT stored in user memory. Pushed via HTTPS with the token inline in the remote URL. Should rotate or revoke when development pauses.
- **Deploys** go via the Netlify MCP `npx -y @netlify/mcp@latest --site-id ... --proxy-path ...`. The proxy path is single-use and provided fresh each `deploy-site` call. The CLI sometimes errors transiently — retrying works.
- **Testing harness:** Playwright + Chromium headless-shell installed at `/home/claude/`. Test file at `/home/claude/test-app.js` — 20 assertions covering menu rendering, error monitoring, tap-game drawing, long-press exit, video iframe construction, paint-over-video overlay, and playlist composition. Visual regression via PNG screenshots in `/home/claude/test-output/`.
- **Service worker cache key** is currently at `vesters-v16`. Bump on every deploy that changes index.html.
- **Real-device test path:** open `https://vesters-app.netlify.app/` in Chrome (NOT the installed PWA), confirm version badge shows expected vN. If installed PWA isn't updating, long-press app icon → App Info → Storage & cache → Clear storage.

---

## File layout

```
toddler-app/
├── index.html       — entire app (HTML + CSS + JS, ~35 KB)
├── sw.js            — service worker; bump CACHE constant per release
├── manifest.json    — PWA manifest, locked to landscape
├── icon-192.png     — app icon (rainbow + bold V on cream)
├── icon-512.png
├── icon-maskable.png
├── favicon.png
├── README.md
└── LEARNINGS.md     — this file
```

## Version history (highlights)

| v | Change |
|---|---|
| 1–4 | Initial build, tile colors, video IDs from user (Jodlesangen, Brum Brum, Okay Okay, Bamses Sang) |
| 5 | Material 3 Expressive design tokens for menu |
| 6–7 | Renamed to "Vesters App", landscape lock |
| 8 | Hold-to-spawn particles + drag-to-rainbow trail |
| 9 | SVG Perlin displacement filter via `feTurbulence` + `feDisplacementMap` |
| 10 | Network-first SW for HTML; reject empty responses |
| 11 | Visible version badge in subtitle + game-view corner |
| 12 | 5th video tile (Hjulene); landscape grid reflowed to 3×2 |
| 13 | **Fix TDZ crash that broke tap game**; paint layer moved to top-level overlay |
| 14–15 | YouTube IFrame API attempts (didn't work) |
| 16 | Reverted to simple iframe + `playlist=` URL param for sequential playback. **Current.** |
