<div align="center">

# 🐍 SnakeBot

**A Google Snake userscript that refuses to die to walls — or to itself.**

A safety-first Dijkstra planner with explicit tail prediction, 2 ms pixel reads and
automatic restarts, wrapped in a single dependency-free userscript.

[![CI](https://github.com/KairosMakki/SnakeBot/actions/workflows/ci.yml/badge.svg)](https://github.com/KairosMakki/SnakeBot/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-34%20passing-6ee7a0)](#tests-and-reliability)
[![Userscript](https://img.shields.io/badge/userscript-Tampermonkey%20%7C%20Violentmonkey-2b3550)](#installation)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Configuration](#configuration) ·
[Tests](#tests-and-reliability) · [Documentation](#documentation) · [Limitations](#limitations)

</div>

---

> **Disclaimer** — this is an educational automation / computer-vision / pathfinding project.
> It is not affiliated with, endorsed by or supported by Google. It reads pixels from your own
> browser canvas and presses arrow keys locally; it makes no network requests and stores nothing
> outside your browser's `localStorage`.

## Contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The panel](#the-panel)
- [How it works](#how-it-works)
- [The safety model](#the-safety-model)
- [Configuration](#configuration)
- [Tests & reliability](#tests-and-reliability)
- [Development](#development)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)

## What it does

| | |
|---|---|
| 🧠 **Plans ahead** | Dijkstra search over `(cell, heading)` states, not a naive greedy walk. Turning early is cheaper than turning at the last moment. |
| 👁️ **Reads the real board** | Detects the playfield, grid size, cell size, snake, head (by its eyes), apple and obstacles directly from canvas pixels. |
| 🐍 **Predicts its own tail** | Replays every route with the body *actually moving*, so a cell is only entered after the tail has vacated it. |
| 🧱 **Never walks into a wall** | Walls, the grid border, the neck and non-vacating body cells are hard constraints in the search. |
| 🍎 **Collects wall-row apples** | Wall-adjacent rows are allowed when they lead to the apple; pointless wall-hugging is heavily penalised. |
| ⚡ **Reacts in ~50–150 ms** | Reads the canvas every 2 ms, and re-plans immediately if the cell straight ahead is deadly. |
| 🔁 **Restarts forever** | Finds and clicks the game's Play / Play again button, with keyboard fallbacks. |
| 📊 **Keeps score** | Runs, apples, best, average, last-20 average, apples/min, full clears and a sparkline. |
| 🧪 **Tested** | 34 automated tests: property tests, vision tests, full simulated games, metadata checks. |

### Sample results

Numbers below come from the automated suite in this repository (`npm test`). Every game uses
the real planner and the real movement/eating rules. "Deaths" means walking into a wall, the
border or the snake's own body.

| Scenario | Games | Average apples | Best | Wall / self / out deaths |
|---|---:|---:|---:|---:|
| Classic board (no obstacles) | 10 | 120.9 | 130 | **0** |
| Six scattered obstacles | 6 | 113.0 | 118 | **0** |
| Apples forced onto the outer ring | 6 | 65.5 | 72 | **0** |
| Long run (6 000-step cap) | 1 | 167 | 167 | **0** |

Longer local runs (120 classic games, 5 000-step cap) average ~147 apples with a best of 165 and
no wall/self/out deaths. The only way the bot currently stops is a genuine late-game
**checkmate**: at ~70 % board occupancy all four neighbours can be its own body. See
[limitations](#limitations).

## Installation

The whole bot is one file: [`google_snake_bot_user.js`](google_snake_bot_user.js). There is no
build step, no dependency and no network access.

### Option A — userscript manager (recommended)

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open the raw file:
   `https://raw.githubusercontent.com/KairosMakki/SnakeBot/main/google_snake_bot_user.js`
3. Your manager should offer to install it. If not, create a new script and paste the file in.
4. Go to Google and search **snake game**, then open the playable doodle.
5. Click **START** in the panel (top-right) or press <kbd>Alt</kbd>+<kbd>B</kbd>.

### Option B — browser console (no install)

1. Google **snake game** and start a game.
2. Press <kbd>F12</kbd> → **Console**.
3. Paste the entire contents of `google_snake_bot_user.js` and press <kbd>Enter</kbd>.
4. Click **START** in the panel.

> Some browsers block pasting into the console until you type `allow pasting`. The script only
> needs to run once per page load.

## Quick start

```text
1. Open the Google Snake doodle
2. START  (panel button, or Alt+B)
3. Watch the state line:  SEARCH → READY → PLAY → DEAD → SEARCH ...
4. STOP   (same button, or Alt+B)
```

Useful console commands:

```js
snakeBot.start();                    // start the bot
snakeBot.stop();                     // stop the bot
snakeBot.stats();                    // { runs, apples, best, clears, ... }
snakeBot.config.autoRestart = false; // keep stats but stop auto-clicking Play
snakeBot.config.readIntervalMs = 4;  // halve CPU usage if the page feels sluggish
snakeBot.config.debug = true;        // draw the detected grid / snake / apple / walls
```

## The panel

The panel is injected at the top-right of the page with a fixed position. It shows:

| Element | Meaning |
|---|---|
| **State line** | `OFF`, `SEARCH`, `READY`, `PLAY` or `DEAD`, plus a human-readable message. |
| `score X / Y` | Apples eaten this run / maximum possible on this board. |
| `steps N` | Game ticks seen in the current run. |
| `runs`, `best`, `average` | Lifetime statistics, persisted in `localStorage`. |
| `average (last20)` | Moving average over the last 20 runs. |
| `apples`, `/min` | Total apples and apples per minute of play time. |
| `full clears`, `fastest` | Completed boards and the fastest completion. |
| `last scores` | The six most recent run scores. |
| Sparkline | The last 40 scores; the best run is highlighted in yellow. |
| Info line | Canvas size, detected grid, cell size, obstacle count, measured game tick and reads/s. |

Buttons:

| Button | Action |
|---|---|
| **START / STOP** | Toggle the bot (`Alt+B`). |
| **AUTO-RESTART** | Toggle auto-clicking Play after a death. |
| **DEBUG** | Toggle the overlay: magenta grid, yellow snake cells, cyan apple, red obstacles, white head. |
| **RESET STATS** | Clear all counters (asks for confirmation). |

## How it works

```text
 ┌────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌────────────┐
 │ Canvas     │ → │ Board        │ → │ Snake        │ → │ Planner      │ → │ One key    │
 │ pixels     │   │ detection    │   │ tracking     │   │ (Dijkstra)   │   │ per tick   │
 └────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └────────────┘
   2 ms loop        grid + cells       ordered body       safe route         ArrowUp/…
```

1. **Read.** A self-scheduling loop copies the game canvas into a scratch canvas and calls
   `getImageData`. Full-canvas reads happen only when the board must be (re)detected; normal
   frames read a cropped rectangle around the playfield.
2. **Detect.** `detectBoard()` finds the light-green playfield, estimates the cell size from the
   checkerboard run lengths, and scores candidates (config hint vs measured) by how *square* the
   resulting cells are.
3. **Classify.** `readGrid()` samples three points per cell and classifies it as board, snake,
   apple or dark-green obstacle. The head is the snake cell with the most near-white pixels
   (its eyes).
4. **Track.** `Tracker` keeps an ordered body (head first). When pixels are ambiguous it rebuilds
   the order from the snake's adjacency graph with a bounded DFS.
5. **Plan.** `plan()` returns a direction `0..3` (up/right/down/left) or `-1`. It runs Dijkstra
   over `(cell, heading)` states with safety penalties, then validates the winning route with a
   step-by-step tail simulation.
6. **Act.** One arrow key is dispatched per game tick. Reversals are impossible; repeated
   same-direction keys are skipped.

Read the deep dive in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the full algorithm
description in [`docs/PLANNER.md`](docs/PLANNER.md).

## The safety model

The bot is built around the idea that **an apple is never worth a death**. Every move passes
through several independent guards, so a bug in one layer does not become a death in the game.

| # | Guard | Prevents |
|---|---|---|
| 1 | Grid bounds (`nbr()` returns `-1`) | Leaving the playfield. |
| 2 | Wall array (dark-green pixels, 3-frame hysteresis) | Entering obstacles. |
| 3 | Body-occupancy constraint with *time* (`ns < len - o`) | Entering a body segment before it moves away. |
| 4 | Neck check (no 180° turns) in the search, in the emergency planner and in `sendDir` | Instant self-collision from a stale heading. |
| 5 | `walkSafe()` whole-route replay with a moving body and correct growth on the last step | Entering a cell the tail has not vacated yet. |
| 6 | Immediate-step `distToTail()` + `floodArea()` gate | Stepping into a pocket with no exit. |
| 7 | Reachable-area preservation (`floodArea` vs. current area) | Slowly sealing itself into a checkmate. |
| 8 | Forced-turn / slack penalty | Turning a fraction too late at a wall. |
| 9 | Early reaction (deadly cell ahead) | Waiting for the cell centre and losing the turn. |
| 10 | One key per tick + reverse guard in `sendDir` | Buffered second turns applied on a later tick. |

The exact rules are documented in [`docs/PLANNER.md#6-route-validation-and-safety-gates`](docs/PLANNER.md#6-route-validation-and-safety-gates).

## Configuration

Configuration lives in the `CONFIG` object at the top of the userscript and is also exposed at
runtime as `snakeBot.config`.

| Key | Default | What it does |
|---|---:|---|
| `autoRestart` | `true` | Click Play automatically when the game-over screen appears. |
| `maxRuns` | `0` | Stop after N runs (`0` = unlimited). |
| `readIntervalMs` | `2` | Target delay between canvas reads while playing. Lower = faster reactions, more CPU. |
| `deadTimeoutMs` | `1000` | Upper bound for the "snake stopped moving = dead" timer. Scales with the measured tick. |
| `cols`, `rows` | `17`, `15` | Grid hint. The bot measures the real grid and only trusts the hint if it fits best. |
| `cell` | `null` | Force the cell size in canvas pixels (rarely needed; auto-detected). |
| `debug` | `false` | Draw the debug overlay. |
| `wallThreshold` | `3` | **Legacy / no effect.** Wall hysteresis is currently fixed at 3 frames. |
| `cautionFast` | `true` | **Legacy / no effect.** Safety is always on. |
| `minSlack` | `2` | **Legacy / no effect.** Slack handling is internal to the planner. |

Everything else (penalties, weights, search options) is internal; the tuning guide lives in
[`docs/PLANNER.md#12-tuning-guide`](docs/PLANNER.md#12-tuning-guide). A complete reference, including
recipes for low-CPU and slow-machine setups, is in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Tests and reliability

```bash
npm test          # 34 tests, ~15 s, zero dependencies
npm run check     # node --check on the userscript
npm run bench     # score + planner timing
```

The suite has four layers:

| File | Layer | What it proves |
|---|---|---|
| `tests/planner.test.js` | Unit + property | 800 random board states never produce an illegal move, never return `-1` while a legal move exists, follow a vacating tail, avoid walls, reverse correctly, and handle checkmates. |
| `tests/vision.test.js` | Synthetic pixels | Renders a fake 17×15 Google Snake canvas; `detectBoard` / `readGrid` / `headEntering` read it back exactly, including edge apples and edge-covering snakes. |
| `tests/game.test.js` | Full simulation | Plays complete games (classic, obstacles, edge-apple, long) under real rules and asserts **zero** wall/self/out deaths. |
| `tests/metadata.test.js` | Userscript contract | Metadata block, version sync with `package.json`, no `@require`, Core API surface, browser code skipped under Node. |

CI runs the whole suite on **Node 18, 20 and 22** for every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), benchmarks the planner on Node 22, and
uploads the userscript as a build artifact. Tagging `vX.Y.Z` publishes a GitHub release with
`google_snake_bot_user.js` attached ([`release.yml`](.github/workflows/release.yml)).

Details, coverage gaps and the simulation model: [`docs/TESTING.md`](docs/TESTING.md).

## Development

```bash
git clone https://github.com/KairosMakki/SnakeBot.git
cd SnakeBot
npm test
```

There is **nothing to install** — no npm dependencies, no bundler, no transpiler. The userscript
targets modern evergreen browsers; the tests need Node 18+.

Layout:

```text
SnakeBot/
├── google_snake_bot_user.js     # the whole bot (userscript + exported Core for tests)
├── package.json                 # scripts only, no dependencies
├── tests/
│   ├── helpers/harness.js       # seeded RNG, random boards, full-game simulator
│   ├── helpers/bench.js         # planner benchmark
│   ├── helpers/longrun.js       # longer local experiment runner
│   ├── planner.test.js          # unit + property tests
│   ├── vision.test.js           # synthetic-canvas vision tests
│   ├── game.test.js             # end-to-end simulated games
│   └── metadata.test.js         # userscript metadata / API contract
├── docs/
│   ├── ARCHITECTURE.md          # runtime, vision, tracking, state machine
│   ├── PLANNER.md               # the pathfinding algorithm in detail
│   ├── CONFIGURATION.md         # every option, recipe and console command
│   ├── TESTING.md               # test strategy, harness API, CI
│   ├── TROUBLESHOOTING.md       # what to do when it does not work
│   └── FAQ.md                   # questions people actually ask
├── CHANGELOG.md
└── CONTRIBUTING.md
```

The userscript deliberately stays a single installable file. Tests import it through
`module.exports`, which is why the file has this near the end of `Core`:

```js
if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
```

That line is also what makes the browser half (DOM, canvas, keyboard) unreachable under Node.

## Limitations

- **Late-game checkmates are possible.** At roughly 70 % board occupancy the snake can surround
  its own head — all four neighbours are its own body. No local planner can escape that; it needs
  a board-wide strategy (Hamiltonian path / perfect matching). In the 6 000-step test this happens
  around 167–190 apples. It is *not* a collision: the bot returns `-1` and the game ends normally.
- **The board is 17×15 by default** (255 cells, an odd number, so a clean Hamiltonian *cycle*
  does not exist). The grid is auto-detected, and other board sizes work as long as cells are
  roughly square.
- **Colour thresholds are tuned for the default Google Snake theme.** High-contrast or custom
  skins may need the `isBoardGreen` / `isAppleRed` / `isWallGreen` thresholds adjusted.
- **The bot is only as fast as the browser loop.** Background tabs are throttled; keep the game
  tab focused. Very high game speeds reduce the margin for reading pixels and pressing keys.
- **Only tested in classic mode** (default apple, obstacles/walls on). Portal, speed and other
  modes share the same movement rules but have not been validated.
- **No anti-cheat evasion.** This is a local automation demo; it does not hide itself.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no game canvas` | The doodle is not open / is in an iframe or a different tab | Open the playable snake doodle and focus its tab. |
| `board not detected` | Non-default theme, zoomed canvas, or the board is too small | Click **DEBUG**, check the console, try a different zoom level; see the [troubleshooting guide](docs/TROUBLESHOOTING.md#board-not-detected). |
| Grid size is wrong | The config hint won an ambiguous fit | Set `snakeBot.config.cols` / `rows`, or `snakeBot.config.cell` to the measured cell size. |
| Snake jumps / `lost` state | Very low frame rate, or the head is hidden under a transition | Raise `readIntervalMs` to 4–8 and keep the tab focused. |
| Auto-restart does nothing | The Play button is inside a shadow root or the game uses a different label | Click Play once manually; the watcher will learn `S.playBtn`; see [restart issues](docs/TROUBLESHOOTING.md#it-does-not-restart). |
| High CPU | 2 ms reads are aggressive | `snakeBot.config.readIntervalMs = 6` (still well under one game tick). |
| Keys do nothing | Focus is on the console / an overlay | Click the page (not the panel) once, then restart the bot. |

More: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Documentation

| Document | Contents |
|---|---|
| [**Architecture**](docs/ARCHITECTURE.md) | Runtime loop, canvas discovery, board detection, pixel classification, tracking, state machine, restart logic, stats, performance budget. |
| [**Planner**](docs/PLANNER.md) | The full algorithm: state graph, cost terms, slack, tail prediction, safety gates, fallback scoring, endgame analysis, tuning guide with A/B data. |
| [**Configuration**](docs/CONFIGURATION.md) | Every option, the console API, panel reference, stats schema, recipes. |
| [**Testing**](docs/TESTING.md) | Test philosophy, harness API, deterministic seeds, writing new tests, CI/release pipeline, coverage gaps. |
| [**Troubleshooting**](docs/TROUBLESHOOTING.md) | Symptom → cause → fix, debug overlay, capturing diagnostics. |
| [**FAQ**](docs/FAQ.md) | Is it cheating, why the bot stops at ~170 apples, other game modes, performance, colours. |
| [**Changelog**](CHANGELOG.md) | Version history from 1.0 to 1.4. |
| [**Contributing**](CONTRIBUTING.md) | Setup, style, test requirements, release checklist. |

## Contributing

Issues and PRs are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — the short
version is: keep it dependency-free, keep it a single userscript, and add a test for every
behaviour change.

## License

No license has been chosen yet, which means the default "all rights reserved" applies. Open an
issue if you need a specific license (MIT/Apache-2.0 are easy to add).
