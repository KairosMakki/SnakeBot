# Configuration

Everything the bot exposes is intentionally small: a `CONFIG` object at the top of the userscript
and a `window.snakeBot` API for the console. There is no settings file and no server.

---

## 1. Where the config lives

```js
const CONFIG = {
  autoRestart: true,
  maxRuns: 0,
  readIntervalMs: 2,
  deadTimeoutMs: 1000,
  cols: 17,
  rows: 15,
  cell: null,
  debug: false,
  wallThreshold: 3,   // legacy, no effect
  cautionFast: true,  // legacy, no effect
  minSlack: 2,        // legacy, no effect
};
```

Edit the file before installing, or change values live:

```js
snakeBot.config.readIntervalMs = 4;
```

Changes are **not persisted**. Reloading the page or reinstalling the userscript restores the
defaults. Only statistics survive (in `localStorage`).

---

## 2. Options

### `autoRestart`

| | |
|---|---|
| Type | `boolean` |
| Default | `true` |
| Effect | When a run ends, find and click the game's Play / Play again button. Falls back to Space/Enter. Also clicks the initial Play button when the bot starts. |
| Turn off when | You want to inspect a death manually, or the watcher conflicts with another extension. |

### `maxRuns`

| | |
|---|---|
| Type | `number` |
| Default | `0` (unlimited) |
| Effect | After this many completed runs the bot stops itself (`enabled = false`) and shows `reached maxRuns`. |
| Example | `snakeBot.config.maxRuns = 50` for a benchmark batch. |

### `readIntervalMs`

| | |
|---|---|
| Type | `number` (milliseconds) |
| Default | `2` |
| Effect | Target delay between canvas reads while playing. Lower = faster reaction, more CPU. The loop uses `MessageChannel` to bypass the 4 ms `setTimeout` clamp, so values below 4 ms are meaningful. |
| Recommended range | `2` (default) … `8` (low CPU). Values above ~16 ms start to lose the early-reaction advantage at high game speeds. |

### `deadTimeoutMs`

| | |
|---|---|
| Type | `number` (milliseconds) |
| Default | `1000` |
| Effect | Upper bound on the "snake stopped moving = run over" timer. The actual timeout is `max(400, min(deadTimeoutMs, tickMs × 5))`, so it adapts to the game speed. The Play-button signal usually fires much earlier. |
| Raise when | You play at an extremely slow speed and the bot declares death too early. |

### `cols`, `rows`

| | |
|---|---|
| Type | `number` |
| Defaults | `17`, `15` |
| Effect | A **hint** for the grid size. The bot also measures the cell size and scores both candidates by how square the cells are; the hint wins ties. |
| Change when | Auto-detection picks the wrong grid (rare; usually a non-square canvas or a custom board). |
| Notes | Changing these live does not force a re-detect while a game is in progress. Set them before starting, or reload. |

### `cell`

| | |
|---|---|
| Type | `number \| null` |
| Default | `null` |
| Effect | Forces the cell size in canvas pixels and disables the run-length measurement. |
| Use when | The checkerboard is not visible (custom skin) or the measurement is unstable. Use the value printed in the panel info line as `cell XX.Xpx`. |

### `debug`

| | |
|---|---|
| Type | `boolean` |
| Default | `false` |
| Effect | Draws the magenta grid, yellow snake cells, cyan apple, red walls and white head over the game. |

### Legacy options

These keys exist for older configs but are **not read anywhere in v1.4**:

| Key | Default | Status |
|---|---:|---|
| `wallThreshold` | `3` | No effect. Wall hysteresis is fixed at 3 frames in `updateWalls()`. |
| `cautionFast` | `true` | No effect. Safety penalties are always applied. |
| `minSlack` | `2` | No effect. Slack handling uses the planner's internal `win = 5`. |

They are kept so an existing config object does not break; setting them does nothing.

---

## 3. Console API

The userscript exposes one global:

```js
window.snakeBot = {
  start(),      // enable the bot and enter SEARCH
  stop(),       // disable the bot (does not change stats)
  stats(),      // returns the live stats object
  config: CONFIG,
};
```

Examples:

```js
// Basic control
snakeBot.start();
snakeBot.stop();

// Inspect stats
const s = snakeBot.stats();
console.table({
  runs: s.runs,
  apples: s.apples,
  best: s.best,
  average: s.runs ? s.apples / s.runs : 0,
});

// Run 100 games and stop
snakeBot.config.maxRuns = 100;
snakeBot.start();

// Low-CPU mode
snakeBot.config.readIntervalMs = 6;

// Keep playing manually after a death, but keep collecting stats
snakeBot.config.autoRestart = false;

// Visual debugging
snakeBot.config.debug = true;
```

### Duplicate loads

The script sets `window.__snakeBotLoaded`. Loading it twice on the same page prints
`[snakeBot] already running` and does nothing, so pasting it again to "update" requires a page
reload first.

### Availability

`window.snakeBot` is created near the end of the file, after the panel is built. If you paste the
script and immediately type `snakeBot`, it exists. If you load it through a userscript manager set
to `document-idle`, it exists by the time the page is interactive.

---

## 4. Panel reference

| Element | Values / action |
|---|---|
| **State line** | `OFF`, `SEARCH`, `READY`, `PLAY`, `DEAD` + a message (`playing`, `died - score N`, `board not detected (try DEBUG)`, …). |
| **START / STOP** | Toggles the bot. Keyboard: <kbd>Alt</kbd>+<kbd>B</kbd>. |
| **AUTO-RESTART** | Green when enabled. Toggles `CONFIG.autoRestart`. |
| **DEBUG** | Green when the overlay is on. Toggles `CONFIG.debug`. |
| **RESET STATS** | Confirms, then clears the `localStorage` stats object. |
| `score X / Y` | Apples this run / maximum possible (`cells − startLength`). |
| `steps N` | Head movements observed this run. |
| `runs` | Completed runs since the last reset. |
| `best` | Best single-run score. |
| `average (last20)` | Lifetime average and a moving average. |
| `apples (/min)` | Lifetime apples and apples per minute of play time. |
| `full clears` | Boards completed (snake filled every cell). |
| `fastest` | Fastest full clear. |
| `last scores` | Six most recent runs. |
| Sparkline | Last 40 scores; the best is yellow. |
| Info line | `canvas WxH | grid CxR | cell XX.Xpx | obstacles N`, then `game tick ~Nms | reads/s N`. |

---

## 5. Stats schema and persistence

Storage key: `localStorage['gsnakebot.stats.v1']`.

```json
{
  "runs": 42,
  "apples": 5120,
  "best": 165,
  "clears": 0,
  "fastestClearMs": null,
  "playMs": 1870000,
  "scores": [151, 162, 148, 165, 159],
  "since": 1730000000000
}
```

- `scores` is capped at the last 300 runs.
- `playMs` is the sum of run durations measured from the first movement to the last.
- `since` is the epoch milliseconds of the first run (not reset by new games, only by RESET STATS).
- Corrupt or missing JSON falls back to a fresh object.
- `localStorage` failures (private browsing, quota) are ignored; stats stay in memory.

Reset from the console:

```js
localStorage.removeItem('gsnakebot.stats.v1');
location.reload();
```

…or use the **RESET STATS** button.

---

## 6. Recipes

### Low CPU / laptop on battery

```js
snakeBot.config.readIntervalMs = 8;
```

Still well below one game tick. Reaction time increases by a few milliseconds; planning quality is
unchanged.

### High-speed games

```js
snakeBot.config.readIntervalMs = 2;
snakeBot.config.deadTimeoutMs = 600;
```

At very high speed the Play-button death signal can fire sooner than the default stall timer; the
bot already clamps `deadTimeoutMs` to 400 ms minimum.

### Benchmark a fixed number of games

```js
snakeBot.config.maxRuns = 200;
snakeBot.start();
// wait...
snakeBot.stats().best;
```

### Stop it touching the page

```js
snakeBot.stop();
```

`stop()` only stops reading/planning. It does not remove the panel or the interval watchers (they
check `S.enabled` first and return immediately).

### Force a grid size

```js
snakeBot.config.cols = 17;
snakeBot.config.rows = 15;
snakeBot.config.cell = 20;   // optional, from the info line
```

### Debug a detection problem

```js
snakeBot.config.debug = true;
```

Then compare the magenta grid with the actual cells. If the grid is shifted, the problem is
`detectBoard`; if the grid is right but cells are missing, it is `readGrid` colour thresholds.
See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 7. Advanced: planner options

`Core.plan()` accepts an optional seventh argument. It is not used by the browser loop (which calls
`plan` with defaults), but tests and experiments can override:

```js
Core.plan(body, apple, cols, rows, walls, heading, {
  forced: 100,   // forced-turn base penalty (multiplied by caution)
  win: 5,        // slack lookahead distance
  detour: 4,     // max extra length before the shortest route wins
  caution: 2,    // turn / adjacency multiplier
  edge: 0,       // border-cell cost (0 keeps wall-row apples reachable)
});
```

Read [PLANNER.md § Tuning guide](PLANNER.md#12-tuning-guide) before changing these: every knob trades
safety against score, and changes must be validated with full games, not single moves.

---

## 8. What is *not* configurable

| Thing | Why |
|---|---|
| Colour thresholds | They are part of the vision contract and are covered by tests; edit the predicates if you use a custom skin. |
| Safety gates | They are the reason the bot does not die; making them optional would silently reintroduce collisions. |
| Key bindings | Google Snake uses the arrow keys; the panel shortcut is `Alt+B`. |
| The 50 % area requirement | It is a scaling rule, not a preference (see PLANNER.md §6.3). |
