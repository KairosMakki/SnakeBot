# Architecture

This document explains how the bot is put together: the runtime loop, the vision pipeline, the
tracker, the state machine, key dispatch, restart logic and the performance budget.

For the planning algorithm itself see [PLANNER.md](PLANNER.md). For user-facing options see
[CONFIGURATION.md](CONFIGURATION.md).

---

## 1. Design constraints

The project has a few deliberate constraints that explain most of the code structure:

| Constraint | Consequence |
|---|---|
| **One installable file** | Everything lives in `google_snake_bot_user.js`. There is no bundler, no `@require`, no build step. |
| **Zero dependencies** | The bot must work when pasted into a console on a page where no package manager exists. |
| **Pixels only** | The bot never inspects the game's JavaScript state, network traffic or DOM internals. It reads the canvas and presses keys, exactly like a human. |
| **Never die to walls/self** | Safety is enforced at several independent layers rather than by one clever heuristic. |
| **Testable without a browser** | The pure half (`Core`) is exported through CommonJS so Node can plan and play games. |

Because of the last point, the file has two halves:

```js
const Core = (function () {
  //  ... pure logic: geometry, vision, tracking, planning ...
  return { DIRS, nbr, detectBoard, readGrid, headEntering, orderCells, Tracker, plan };
})();

// Under Node there is no `window`, no DOM and no canvas: hand the pure half to the test suite
// and stop before the browser half is evaluated.
if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }

//  ... browser half: canvas capture, key presses, restart detection, stats, panel, loop ...
```

The early `return` is what makes the same file both a userscript and a Node module.

---

## 2. Module map

```text
google_snake_bot_user.js
│
├── CONFIG .................... user-facing runtime options
│
├── Core (pure, exported)
│   ├── DIRS, nbr() ........... geometry / flat-index helpers
│   ├── detectBoard() ......... find the playfield + grid dimensions
│   ├── readGrid() ............ classify cells, find head/apple/walls
│   ├── headEntering() ........ "has the head started entering the next cell?"
│   ├── orderCells() .......... rebuild an ordered snake from an unordered set
│   ├── Tracker ............... incremental body model between frames
│   └── plan() ................ choose the next direction (see PLANNER.md)
│
└── Browser half
    ├── KEYS / SPACE / ENTER ... synthetic keyboard events
    ├── stats .................. load / save / update localStorage
    ├── S ...................... mutable runtime state
    ├── findCanvas() ........... pick the largest canvas on the page
    ├── readPixels() ........... copy canvas -> scratch canvas -> getImageData
    ├── updateWalls() .......... temporal wall stabilisation
    ├── step() ................. one iteration of the whole pipeline
    ├── sendDir() / isReverse()  guarded key dispatch
    ├── attemptRestart() ....... Play / Play again / Space / Enter
    ├── watchPlayButton() ...... independent 100 ms watcher
    ├── panel + debug overlay .. UI
    └── loop() ................. self-scheduling fast loop
```

---

## 3. Execution model

### 3.1 The fast loop

`setTimeout` is clamped to ~4 ms in browsers. To hit a 2 ms read interval the loop uses a
`MessageChannel`, which posts a macrotask without the timer clamp:

```js
const chan = new MessageChannel();

function loop() {
  if (document.hidden) { setTimeout(loop, 250); return; }   // throttled tab: back off
  const t0 = performance.now();
  try { step(); } catch (e) { S.error = 'step: ' + e.message; }

  const active = S.enabled && (S.mode === 'PLAY' || S.mode === 'READY');
  const target = !S.enabled ? 150 : active ? CONFIG.readIntervalMs : Math.max(30, CONFIG.readIntervalMs);

  const wait = target - (performance.now() - t0);
  if (wait >= 2) setTimeout(loop, wait); else chan.port2.postMessage(0);
}
chan.port1.onmessage = loop;
loop();
```

Notes:

- When the bot is **off**, the loop wakes every 150 ms only to keep state fresh.
- When the bot is **playing**, it targets `readIntervalMs` (2 ms) between iterations.
- If a `step()` already took longer than the target, the next iteration is posted immediately
  through the channel; there is no artificial delay.
- `document.hidden` short-circuits to 250 ms because browsers throttle timers in background tabs;
  trying to read at 2 ms there only wastes battery.

Two independent intervals support the loop:

| Interval | Period | Purpose |
|---|---:|---|
| `watchPlayButton` | 100 ms | Click Play when the game-over/start screen appears, even between frames. |
| `refreshPanel` + `drawDebug` | 250 ms | UI only; never touches the game. |

### 3.2 One `step()`

```text
step()
 ├─ find canvas (cached 500 ms)
 ├─ detect board?  ── yes → full-canvas getImageData → detectBoard()
 │                   no  → cropped getImageData around the playfield
 ├─ readGrid()          → snake cells, apple, obstacle cells
 ├─ updateWalls()       → temporal wall stabilisation
 ├─ detect death?       → Play button visible + no movement, or the snake vanished
 ├─ SEARCH / DEAD handling, tracker init
 ├─ early reaction?     → plan + press before the centre of the next cell
 ├─ tracker.update()    → ordered body, heading, growth
 ├─ plan() + sendDir()  → exactly one key per game tick
 └─ update stats / info
```

The full-canvas read is comparatively expensive (the canvas can be 600×600 or more), so it only
happens when:

- there is no board yet,
- the canvas element changed size,
- or the bot is **not** playing and 1 500 ms have passed (to re-check the grid after a restart).

During play, only `cropFor(board)` is read: the exact playfield rectangle plus one pixel.

---

## 4. Coordinate system

Cells are a flat row-major index:

```js
const idx = (x, y) => y * cols + x;
const x = i % cols;
const y = (i / cols) | 0;
```

Directions are fixed and used everywhere (planner, keys, tests):

| `d` | Direction | `DIRS[d]` | Key |
|---:|---|---|---|
| 0 | up | `[0, -1]` | `ArrowUp` |
| 1 | right | `[1, 0]` | `ArrowRight` |
| 2 | down | `[0, 1]` | `ArrowDown` |
| 3 | left | `[-1, 0]` | `ArrowLeft` |

`nbr(cell, d, cols, rows)` returns the neighbouring flat index or `-1` when the move would leave
the grid. `-1` is the outermost safety boundary: the planner can never produce it, and the game
loop checks it again.

A direction is the **opposite** of another with `(d + 2) & 3`. Reverse moves are lethal in Snake
(the head enters the neck), so they are blocked in three places: the search, the emergency
planner and `sendDir`.

---

## 5. Vision pipeline

### 5.1 Canvas discovery

`findCanvas()` scans every `<canvas>` on the page and keeps the one with the largest
`width × height` that is at least 150×150 CSS pixels. The result is cached for 500 ms to avoid
layout work on every frame, and the bot's own overlay/sparkline canvases are excluded.

If no canvas exists, the state becomes `SEARCH` and the message is
`no game canvas - search "snake game"`.

### 5.2 Reading pixels

`readPixels(canvas, rect)` copies the requested rectangle into a persistent scratch canvas with
`globalCompositeOperation = 'copy'` and calls `getImageData`. The scratch canvas is only resized
when the rectangle size changes, which avoids reallocating a backing store every frame.

If the canvas is cross-origin tainted, `getImageData` throws a `SecurityError`; the bot catches it
and displays `Canvas is cross-origin tainted - pixels cannot be read`.

### 5.3 Board detection

`detectBoard(data, W, H, cfg, prev)` works in four stages.

**Stage 1 — bounding box.** Scan every pixel for the light board green. The min/max x/y of
matching pixels is the playfield. If nothing matches, or the box is smaller than 100×100, return
`null`.

**Stage 2 — never shrink on partial occlusion.** When the snake covers an entire edge, the
bounding box would shrink. If a previous detection exists for the same canvas size, the box is
expanded back towards the previous edges when the difference is within
`max(cellX, cellY) × 1.1`:

```js
if (minX > prev.minX && minX - prev.minX <= tol) minX = prev.minX;
if (maxX < pMaxX && pMaxX - maxX <= tol) maxX = Math.round(pMaxX);
// ... same for Y
```

**Stage 3 — measure the cell size.** The board is a checkerboard of two light-green shades. For
nine horizontal scan lines (10 %, 20 %, … 90 % of the board height) the code records runs of
constant "light" vs "dark" classification and takes the **most frequent run length ≥ 8 px**. That
is the cell size in pixels.

**Stage 4 — choose the grid dimensions.** Two candidates are scored:

1. the configured hint (`CONFIG.cols × CONFIG.rows`),
2. the measured size (`round(boardW / cell) × round(boardH / cell)`).

The score is how **square** the resulting cells are:

```js
err = |ln((boardW / cols) / (boardH / rows))| + (measured ? 0.004 : 0);
```

The config hint wins exact ties, but a clearly non-square hint loses to the measurement. Candidates
outside 4…80 cells per axis are rejected, and the best candidate is rejected if `err > 0.1`.
The result object carries `minX, minY, cols, rows, cellX, cellY, W, H`.

### 5.4 Colour predicates

All classification is threshold-based on RGB values sampled from the canvas:

| Class | Predicate |
|---|---|
| Board (light green) | `g > r + 30 && g > b + 90 && r > 140` |
| Apple (red) | `r > g + 90 && r > b + 100` |
| Obstacle (dark green) | `g > r + 20 && g > b + 40 && r < 130 && g > 90` |
| Snake | anything else that is not board/apple/obstacle |
| Head eyes | `r > 225 && g > 225 && b > 225` |

These are tuned for the default Google Snake skin. Custom themes may need them adjusted; see
[FAQ.md](FAQ.md#can-i-use-a-different-theme-or-a-custom-board).

### 5.5 Cell classification

`readGrid(data, W, B)` samples **three points** per cell, at the vertical centre and at horizontal
offsets `-0.12, 0, +0.12` of a cell width. For each sample:

```js
if (isBoardGreen) continue;                 // empty cell sample
if (isAppleRed)  appleVotes++;
else if (isWallGreen) wallVotes++;
else snakeVotes++;
```

The final class needs at least two of three votes:

```js
if (appleVotes >= 2) apple = idx;
else if (wallVotes >= 2) walls.push(idx);
else if (snakeVotes >= 2) snake.push(idx);
else if (appleVotes + snakeVotes >= 2) { /* apple wins ties */ }
```

The **outer ring is not forced to be wall**. In Google Snake the dark frame is outside the grid
and the planner can never leave the grid anyway (`nbr()` returns `-1`), so marking the ring as an
obstacle would make edge apples unreachable. Only actual dark-green obstacle pixels become walls.

### 5.6 Head detection

The snake's head is the only cell containing white "eyes". For every snake cell the bot counts
near-white pixels in the whole cell and keeps the maximum:

```js
if (white > bestWhite) { bestWhite = white; head = idx; }
```

`bestWhite` starts at 5, so a cell needs at least six white pixels to be considered a head. When no
cell qualifies, `head` is `-1` and the tracker falls back to geometric ordering.

### 5.7 Temporal wall stabilisation

Obstacles are static, but eating animations, the apple glow or compression artefacts can make a
single frame lie. `updateWalls()` keeps a hit counter per cell:

```text
seen as wall   → hits = min(hits + 1, 6)
not seen       → hits = max(hits - 1, 0)
wall           → hits >= 3
```

A cell must therefore be seen as an obstacle for three consecutive frames before the planner
treats it as solid, and it disappears after three frames without evidence. The trade-off is
deliberate: a few frames of latency on a new obstacle is much safer than a phantom wall that
blocks the only escape route.

> **Note:** `CONFIG.wallThreshold` is a legacy option; the current hysteresis is hardcoded to 3.

### 5.8 `headEntering()`

To turn *before* the head reaches the centre of the next cell, the bot samples the leading 22 % of
the target cell (the edge the head is crossing) at three offsets. If at least two of the three
samples are non-board (i.e. snake-coloured), the head is already entering that cell.

This is what allows reactions in the 50–150 ms range: the bot does not have to wait for the next
logical game tick to know that a wall or its own body is straight ahead.

---

## 6. Tracking

`readGrid()` returns an **unordered** set of snake cells (row-major order). The `Tracker` turns
that into a body array with the head at index 0.

### 6.1 `orderCells()`

The snake's cells form a path graph: every cell has at most two neighbours inside the set. The
ordering algorithm is:

1. Build adjacency lists inside the set.
2. Candidate starts are cells of degree ≤ 1 (the true head and tail). If the snake forms a loop
   (head adjacent to tail, every degree 2), every cell is a candidate.
3. Sort candidates by Manhattan distance to a hint (the previous head), or by x-coordinate when
   there is no hint.
4. From each candidate, run a depth-first search for a Hamiltonian path through the set, with a
   global budget of 20 000 expansions.
5. Return the first complete path, or `null` if no ordering exists (corrupt read).

The budget keeps a bad frame from stalling the browser loop; a failed ordering triggers a resync
on the next frame instead.

### 6.2 `Tracker.update()`

| Situation | Result | Meaning |
|---|---|---|
| No body yet, ordering succeeded | `init` | A new run is starting; `beginRun()` records the start length. |
| Eyes moved to an adjacent cell, body matches with or without growth | `moved` | Normal tick. |
| Nothing changed, same head | `same` | No tick has happened yet (or the page is stalled). |
| One new cell at the head, one cell gone at the tail | `moved` | Normal movement. |
| New length = old + 1 and no cell disappeared | `moved` | The apple was eaten. |
| Anything ambiguous | `resync` | Rebuild the order from scratch. |
| Fewer cells than before | `shrunk` | Four consecutive frames mean a new game started. |
| No valid ordering | `lost` | Skip this frame. |

`setHeading()` derives the heading from the first two cells: the direction `d` for which
`nbr(body[1], d) === body[0]`. This is the heading the planner receives; it is never inferred from
the last key pressed, so a dropped key cannot desynchronise the model.

---

## 7. Planning

`plan(body, apple, cols, rows, walls, heading, opts)` is the only decision point. It:

1. Builds an `occ` lookup from cell → body index.
2. Computes the currently reachable free area (`floodArea`).
3. Tries a safe route to the apple (`safePath`, with `bfsTimed` as a backup).
4. Validates the route with `walkSafe()` (moving-body replay), an immediate-step tail/area gate,
   and an endgame area-shrink rule.
5. If no route survives, scores every legal move with a risk/reward function and returns the best
   one (or `-1` if the snake is genuinely trapped).

The complete description — including every cost term, the tail-prediction maths, the fallback
formula and the A/B tuning data — is in [PLANNER.md](PLANNER.md).

---

## 8. State machine

```text
            ┌──────────────────────────────────────────────┐
            │                                              │
            ▼                                              │
        ┌────────┐   canvas + snake found   ┌────────┐     │
   ┌───▶│ SEARCH │ ───────────────────────▶ │ READY  │     │
   │    └────────┘                          └────────┘     │
   │        ▲                                    │          │
   │        │ new game detected                  │ first key│
   │        │                                    ▼          │
   │    ┌────────┐        died / no moves    ┌────────┐     │
   └────│  DEAD  │ ◀──────────────────────── │  PLAY  │ ────┘
        └────────┘                           └────────┘  restart
            │                                     ▲
            └────────── Play clicked ─────────────┘
```

| Mode | Meaning | What `step()` does |
|---|---|---|
| `SEARCH` | Looking for the canvas / a fresh snake | Detect board, read grid, initialise tracker. |
| `READY` | A run started; the first key has not been sent yet | Sends one forced direction after 150 ms, then waits for the first movement. |
| `PLAY` | Normal play | Early reaction, tracker update, plan, one key per tick. |
| `DEAD` | The run ended | Waits until the pixels change to a new game, then restarts. |

The mode is displayed in the panel's state line, so "stuck" states are diagnosable at a glance.

### 8.1 Death detection

There is no "game over" DOM element that can be relied on, so death is inferred from pixels and
timing:

1. **Play button + stalled head** — if the Play button is visible and the head has not moved for
   `max(120 ms, tick × 1.5)`, the run is over. This is the fastest signal.
2. **Snake disappeared** — if `readGrid()` returns no snake cells while playing for longer than
   `stallMs = max(400 ms, min(deadTimeoutMs, tick × 5))`, the run is over.
3. **Head not moving** — the tracker reports `same` for longer than `stallMs` while playing.

`tickMs` is an exponential moving average of observed head movements, clamped to ignore gaps above
1 s (tab switches, pauses). This makes the timers adapt to the game's speed setting instead of
using a fixed timeout.

When a run ends, `finishRun()` records the score, stores the dead snake set, switches to `DEAD`,
and (if `autoRestart` is on) the watcher clicks Play. Once the snake pixels change, the bot resets
the tracker and re-enters `SEARCH`.

A brand-new game that starts without a game-over screen is detected by `shrunk`: four consecutive
frames with fewer snake cells than the model had means the board was reset.

---

## 9. Actuation

### 9.1 Synthetic key events

`pressKey(spec)` dispatches `keydown` and `keyup` events with the correct `key`, `code` and
`keyCode`/`which` on the game's target element. `keyCode` is defined with `Object.defineProperty`
because it is read-only on modern `KeyboardEvent`s, and some games still check the legacy field.

### 9.2 `sendDir()` guards

Every direction goes through three checks before a key is dispatched:

```js
function sendDir(d, force) {
  if (d < 0) return;                          // no legal move
  if (isReverse(d)) return;                   // d === (tracker.heading + 2) & 3
  if (!force && d === S.tracker.heading) return;  // already going that way
  pressKey(KEYS[d]);
  S.lastKeyT = performance.now();
  S.lastDir = d;
  S.lastSentDir = d;
  S.lastSentT = S.lastKeyT;
  S.lastSentHead = S.tracker.body[0];
}
```

`isReverse()` is the last line of defence: even if the planner or a stale tracker produced a
180° turn, it is dropped here.

### 9.3 One key per tick

Google Snake buffers a second turn pressed inside the same tick and applies it on the next one.
That is a classic way to turn into your own body a tick later, so the game loop only sends one key
per head cell:

```js
const alreadySent = S.lastSentHead === T.body[0] && S.lastSentT >= S.lastMoveT;
if (!alreadySent && !(S.earlyHead === T.body[0] && S.earlyDir === nd)) sendDir(nd, false);
```

### 9.4 Early reaction

Two triggers run before the normal `plan()` call, at most once per head cell:

1. **Deadly cell straight ahead** — the next cell is outside the board, a wall, or a body segment
   that is not the current tail. The bot plans and presses *immediately*, without waiting for the
   head to reach the centre.
2. **Head already entering the next cell** — `headEntering()` says the head has crossed the edge.
   The bot plans one tick early, using the projected body.

The current tail cell is explicitly **not** deadly: it vacates exactly one move from now, so
following it is legal and often the only escape.

Early planning is skipped for the apple cell, because eating changes the board and the normal path
handles that case with the correct growth simulation.

---

## 10. Restart logic

Two mechanisms cooperate:

1. **`attemptRestart()`** — called from `DEAD`. It first tries a known Play button (cached in
   `S.playBtn`), then searches the DOM for a visible element whose text matches
   `/^(play|play again|replay|restart|try again|new game)$/i`. If no button is found it presses
   `Space` and `Enter` alternately.
2. **`watchPlayButton()`** — an independent 100 ms interval that does the same while the bot is on.
   It deliberately refuses to act while the snake is visibly moving, so it cannot steal focus or
   press a key mid-game.

Restarts are throttled (`500 ms`) and counted (`restartTries`); after eight failed attempts the
panel tells you to click Play manually.

The watcher also covers the **start screen**: as soon as a visible Play button appears and the bot
is enabled, it is clicked — even before the first run.

---

## 11. Stats and persistence

Stats are stored in `localStorage` under `gsnakebot.stats.v1`:

```ts
interface Stats {
  runs: number;            // completed runs
  apples: number;          // total apples eaten
  best: number;            // best single-run score
  clears: number;          // full-board clears
  fastestClearMs: number | null;
  playMs: number;          // total playing time
  scores: number[];        // last 300 run scores
  since: number;           // epoch ms of first run
}
```

`finishRun()` updates the counters and saves. `RESET STATS` replaces the object with
`freshStats()`. Storage failures (private mode, quota) are swallowed: the bot keeps working with
in-memory stats.

The panel derives `average`, `average (last 20)`, apples/minute and the sparkline from this object
on every refresh.

---

## 12. Debug overlay

`CONFIG.debug = true` (or the DEBUG button) draws a second canvas exactly on top of the game canvas:

| Colour | Meaning |
|---|---|
| Magenta grid | Detected `cols × rows`, cell size and origin. |
| Yellow squares | `readGrid()` snake cells. |
| Cyan circle | Detected apple. |
| Red squares | Stabilised wall cells (`S.walls`). |
| White circle | Tracker head (`body[0]`). |

If the magenta grid does not align with the game's cells, the problem is detection, not planning.
The panel info line also prints canvas size, grid size, cell size and obstacle count.

---

## 13. Performance budget

| Work | Cost | Frequency |
|---|---|---|
| Cropped `getImageData` (≈ 340×300) | ~0.2–0.6 ms | every 2 ms while playing |
| Full-canvas `getImageData` | ~1–3 ms | on board changes / every 1.5 s when idle |
| `readGrid` (255 cells × 3 samples) | < 0.2 ms | per frame |
| `tracker.update` | O(len) | per frame |
| `plan` | ~0.1–2 ms (short snake) | per game tick + early reactions |
| Panel refresh | ~0.1 ms | every 250 ms |

The planner is the only potentially expensive call, and it runs once per **game tick**
(~90–150 ms), not once per read. The 2 ms loop exists to catch the head crossing a cell edge
early — not to re-plan continuously.

`npm run bench` prints the measured per-call cost on your machine.

If CPU usage matters more than reaction time, set `snakeBot.config.readIntervalMs = 4` or `6`.
The bot still reacts well inside one tick.

---

## 14. Privacy and security

- No network requests, no remote `@require`, no analytics, no telemetry.
- Reads only the game canvas and (for the Play button) visible DOM text.
- Writes only `localStorage['gsnakebot.stats.v1']`.
- The userscript matches `www.google.com` and regional `www.google.tld` domains, but does nothing
  until you click START.
- It does not attempt to hide from anti-cheat or automate anything other than key presses on the
  local page.

---

## 15. Extending the bot

### Different skin / colours

Edit the predicates in `Core` (`isBoardGreen`, `isAppleRed`, `isWallGreen`) and the white-eye
threshold in `readGrid`. Then update the synthetic colours in `tests/vision.test.js` so the vision
tests describe the new theme.

### Different board size

Nothing to do: the grid is measured. If detection is ambiguous, set `CONFIG.cols`/`rows` or
`CONFIG.cell`. The planner works on any `cols × rows` (tested with 11×21 as well as 17×15).

### Different game mode

Modes that keep the same movement rules (classic, walls, speed) work as-is. Modes with portals or
moving obstacles would need new logic in `readGrid` (portal colours) and in `plan` (teleport edges).
Open an issue with a screenshot and a description of the rules.

### A stronger endgame

The remaining failure mode is a late-game checkmate. Fixing it means replacing the local planner
with a board-wide strategy — a Hamiltonian path/cycle or a perfect-matching approach. The current
architecture already isolates planning in `Core.plan()`, so that can be swapped without touching
vision or actuation. See [PLANNER.md](PLANNER.md#9-why-checkmates-still-happen).
