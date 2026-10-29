# Testing

SnakeBot has no dependencies and no build step, but it does have a real test suite: 34 tests
covering the planner, the vision layer, complete simulated games and the userscript contract.

This document explains what is tested, why, how to add tests, and what is *not* covered.

---

## 1. Philosophy

The bot has one job that matters: **never choose a move that kills the snake.** Everything else
(score, apples per minute, wall-row apples) is secondary.

So the tests are written around failure modes, not around functions:

| Failure mode | Test layer |
|---|---|
| Planner returns a wall / border / body cell | Property test over 800 random states |
| Planner returns `-1` although a legal move exists | Same property test |
| Planner reverses into the neck | Unit test + property test |
| Planner enters a cell before the tail vacates it | `walkSafe` + ring test |
| Vision reads the wrong grid / misses an edge apple | Synthetic pixel tests |
| The bot dies during an actual game | Full-game simulations |
| The userscript stops being installable | Metadata tests |
| Version drift between header and package | Metadata test |

Every simulated game is seeded. A CI failure always prints the seed, so it can be replayed locally
with the same board, apples and obstacles.

---

## 2. Running the suite

```bash
npm test            # everything, ~15 s
npm run test:unit   # planner + metadata only
npm run test:games  # simulated games only
npm run check       # node --check on the userscript
npm run bench       # planner timing + score summary
```

Requirements: **Node 18 or newer**. No `npm install` is needed — there are no dependencies and no
lockfile.

Example output:

```text
> snakebot@1.4.0 test
> node --test tests/planner.test.js tests/vision.test.js tests/metadata.test.js tests/game.test.js

  classic: avg 120.9, best 130, checkmates 0/10
  obstacles: avg 113.0, best 118, checkmates 0/6
  edge apples: avg 65.5, best 72
  long game: 167 apples, 171 cells, ended with "no-move"
✔ classic mode: 10 games, zero wall/self/out deaths (5797ms)
✔ obstacle mode: 6 games with scattered walls, zero deaths (3605ms)
✔ edge-apple mode: 6 games, zero deaths, many wall-row apples (3025ms)
✔ long game: survives deep into the late game without dying (1093ms)
...
ℹ tests 34
ℹ pass 34
ℹ fail 0
```

---

## 3. Test files

### `tests/planner.test.js` — unit + property tests

Runs `Core.plan()` directly on hand-built and random states.

| Test | What it asserts |
|---|---|
| `nbr()` | Border moves return `-1`; interior moves map correctly. |
| Straight-line apple | With a clear corridor, the bot moves toward the apple (direction `1`). |
| Adjacent apple | An apple directly above the head is eaten immediately. |
| No reversal | 25 plans never return `heading + 2`. |
| Boxed-in ring | When only the vacating tail is reachable, the planner chooses it. |
| Checkmate | When all four neighbours are permanent body, it returns `-1` instead of a suicidal move. |
| No apple | `apple = -1` still produces a legal move. |
| Determinism | The same inputs produce the same output. |
| **Property (800 states)** | Random snake shapes (3–48 cells), random obstacles, random apples: every returned move is inside the grid, not a wall, not the neck, and only enters the tail (which vacates this tick). `-1` is only allowed when no legal move exists. |
| Wall detour | An apple behind a wall is reached without ever stepping on the wall. |
| Edge apple | An apple on the outer row is collected. |
| Non-17×15 board | `11×21` works (the planner is not hardcoded). |
| `DIRS` | The documented up/right/down/left order is stable. |

The property test is the most valuable one. It builds valid snakes by walking a self-avoiding path,
so every generated state is physically possible. It counts how often the tail-follow path is used
and fails if that path was never exercised — otherwise the test could silently stop covering the
most subtle case.

### `tests/vision.test.js` — synthetic pixels

Renders a complete fake Google Snake canvas into an RGBA buffer:

- black frame,
- light/dark checkerboard,
- snake cells in blue,
- apple in red,
- obstacles in dark green,
- white "eyes" in the head cell.

Then it calls the real `detectBoard()`, `readGrid()` and `headEntering()`.

| Test | What it asserts |
|---|---|
| Board detection | Finds the 17×15 grid, origin, and exact 20 px cell size. |
| Blank canvas | Returns `null` instead of a bogus board. |
| Bogus config hint | The measured cell size wins over a wrong 23×19 hint. |
| Edge-covering snake | A snake covering the top row does not shrink the detected board (`prev` hint). |
| Full read | Snake set, head (by eyes), apple and obstacle list are exact. |
| Corner apple | An apple in the corner is detected and the outer ring is **not** marked as wall. |
| Empty board | No snake, no apple, no head, no crash. |
| `headEntering` | Detects the head crossing the leading edge of its cell; empty cells are `false`. |

This layer is what makes the vision code testable without a browser. If you change a colour
predicate, update the constants at the top of this file to match.

### `tests/game.test.js` — full games

Uses the harness simulator, which applies the same rules as Google Snake:

- one cell per tick,
- border/obstacle/body = death,
- the tail cell is legal only when not growing,
- eating grows the snake and respawns the apple.

| Test | Games | Assertion |
|---|---:|---|
| Classic | 10 | Zero self/wall/out deaths; average ≥ 90; at most one late checkmate. |
| Obstacles | 6 | Zero deaths; average ≥ 60. |
| Edge apples | 6 | Zero deaths; every game eats ≥ 15 edge apples. |
| Long game | 1 | 6 000-step cap: no death, ≥ 120 apples. |
| Harness sanity | — | Apples never spawn on the snake or on a wall. |

The death assertion is absolute: **one** wall/self/out death fails the build.

### `tests/metadata.test.js` — userscript contract

Parses the `==UserScript==` block as a userscript manager would and checks:

- required fields (`@name`, `@namespace`, `@version`, `@description`, `@run-at`),
- `@match` covers `www.google.com` and regional `www.google.tld`,
- `@grant none` and no remote `@require`,
- `@version` matches `package.json` (normalising `1.4` and `1.4.0`),
- the description still documents tail prediction and the planner,
- `Core` exports the full API the tests rely on,
- the browser half is skipped under CommonJS (requiring the file in Node would throw otherwise),
- no `debugger` statements.

---

## 4. The harness

`tests/helpers/harness.js` is the shared simulator.

```js
const {
  Core, COLS, ROWS, N, DIRS, START, START_HEADING,
  idx, xy, makeRng, headingOf, randomBody, legalMoves, scatterWalls, playGame,
} = require('./helpers/harness');
```

| Export | Description |
|---|---|
| `Core` | The pure module exported by the userscript. |
| `COLS`, `ROWS`, `N` | Default board (17×15, 255). |
| `DIRS` | Direction table. |
| `START`, `START_HEADING` | Standard 4-cell snake in the middle, heading right. |
| `idx(x, y)`, `xy(i)` | Flat-index conversions. |
| `makeRng(seed)` | Deterministic LCG (32-bit). |
| `headingOf(body)` | Derives the heading from `body[1] → body[0]`. |
| `randomBody(rnd, len)` | Valid random snake built as a self-avoiding walk. |
| `legalMoves(body, walls)` | All non-lethal directions for the current tick. |
| `scatterWalls(rnd, count, body)` | Obstacles that never overlap the snake. |
| `playGame(options)` | Plays a complete game and returns `{ score, reason, steps, len, apple, walls, body }`. |

`playGame` options:

```js
playGame({
  seed: 1234,          // deterministic board/apple sequence
  cols: 17, rows: 15,  // board size
  wallCount: 6,        // scattered obstacles
  appleMode: 'free',   // 'free' | 'edge'
  maxSteps: 3000,      // stop after N ticks
  start: START,        // initial body (head first)
  heading: 1,          // initial direction
});
```

`reason` is one of:

| Value | Meaning |
|---|---|
| `cap` | Hit `maxSteps` while still alive. |
| `clear` | Filled the whole board (win). |
| `no-move` | Genuine checkmate — no legal neighbour. **Not** a collision. |
| `self` | Moved into its own body. |
| `wall` | Moved into an obstacle. |
| `out` | Left the grid. |

Tests treat `self`, `wall` and `out` as failures and `no-move` as an acceptable late-game outcome.

---

## 5. Running longer experiments

CI keeps the suite fast (~15 s). For tuning, use the longer runner:

```bash
node tests/helpers/longrun.js 120 5000 0    # 120 classic games, 5 000-step cap
node tests/helpers/longrun.js 60 10000 6    # 60 games with 6 obstacles
```

It prints average, best (with seed), deaths by type, checkmates, clears and elapsed time.

Rules of thumb when comparing two variants:

1. Use the **same seeds** (the runner uses `50 000 + i`).
2. Compare deaths first, then checkmates, then average.
3. A higher average with more deaths is a regression, not an improvement.
4. Re-run at least 100 games: 10-game averages move by ±10 points.
5. Test edge apples separately (`appleMode: 'edge'`), because wall rules change their score.

---

## 6. CI pipeline

### `ci.yml` — every push and pull request

```text
matrix: node 18, 20, 22
 ├─ checkout
 ├─ setup-node
 ├─ node --check google_snake_bot_user.js
 ├─ npm test
 └─ npm run bench (node 22 only)

package job (needs test)
 ├─ verify the metadata block exists
 └─ upload google_snake_bot_user.js as the "snakebot-userscript" artifact
```

- `fail-fast: false`, so all Node versions report independently.
- Node 18/20/22 cover the oldest supported runtime and current LTS/current.
- No caching is configured because there is nothing to install.
- The benchmark is informational: it never fails the build on timing.

### `release.yml` — tag `vX.Y.Z`

1. Extracts `@version` from the userscript.
2. Compares it with the tag (component-wise, so `v1.4.0` matches `@version 1.4`).
3. Runs the full test suite.
4. Creates a GitHub release with `google_snake_bot_user.js` attached and generated notes.

Release checklist is in [CONTRIBUTING.md](../CONTRIBUTING.md#release-checklist).

---

## 7. Adding a test

### Planner behaviour

```js
test('does not enter a wall when the apple is behind it', () => {
  const walls = new Uint8Array(COLS * ROWS);
  walls[idx(8, 7)] = 1;
  const body = [idx(5, 7), idx(4, 7), idx(3, 7)];
  const d = Core.plan(body, idx(12, 7), COLS, ROWS, walls, 1);

  assert.notEqual(d, 1, 'must not drive into the wall');
  assert.ok(d >= 0, 'must still move');
});
```

### Vision

Add a rendering case to `renderBoard()` and assert the read-back. Keep objects off the histogram
rows (1, 3, 4, 6, 7, 9, 10, 12, 13) when testing board detection, otherwise the cell-size
measurement sees the object's colours instead of the checkerboard.

### Full games

Add a scenario to `tests/game.test.js` with a fixed `seedBase`, and assert at minimum
`DEATHS.size === 0` semantics for the batch. Use `runBatch()` to get the death report for free.

### Metadata

Update `tests/metadata.test.js` if you add a userscript header field that must be present.

---

## 8. Debugging a failure

1. **Read the seed.** The failure message includes it (for example
   `seed 3004: wall at 118 apples`).
2. **Replay it deterministically:**

   ```js
   const { playGame } = require('./tests/helpers/harness');
   const r = playGame({ seed: 3004, wallCount: 6, maxSteps: 3000 });
   console.log(r);
   ```

3. **Instrument.** `playGame` returns the final `body`, `walls` and `apple`; wrap the loop or call
   `Core.plan()` on the state just before the failing move.
4. **Reproduce in the browser.** Set `snakeBot.config.debug = true` and watch the overlay. A
   simulated failure with correct state points at the planner; a browser-only failure points at
   vision or timing.

---

## 9. Coverage gaps

Honest list of what the automated suite does **not** cover:

| Area | Status | Why |
|---|---|---|
| Browser loop (`step`, `loop`, `sendDir`) | Not unit-tested | Requires a DOM, canvas and keyboard; the file is deliberately single-file without a DOM test dependency. |
| Restart / Play-button detection | Not automated | Depends on Google's DOM and button labels; manual verification. |
| Real canvas capture | Not automated | `getImageData` needs a browser; the synthetic tests cover the pure classification. |
| Buffered key presses | Not modelled | The simulator applies one move per tick; the browser code guards against buffered turns with `lastSentHead`. |
| Animations / frame timing | Not modelled | The simulator assumes perfect state every tick. Early reaction is a mitigation, not a proof. |
| Other game modes (portal, speed) | Not tested | Different board semantics; see [FAQ](FAQ.md#does-it-work-in-other-game-modes). |
| Very large boards | Not tested | The planner is generic, but only 17×15 and 11×21 are exercised. |

Manual smoke test after a browser change:

1. Start a classic game, let it eat ~20 apples.
2. Toggle DEBUG and confirm grid/snake/apple alignment.
3. Let it die (or stop it) and confirm auto-restart.
4. Watch one full late game; confirm the state line reaches `no-move` only in the endgame.

---

## 10. Simulation fidelity

The simulator is intentionally simple, but it mirrors the rules that matter:

| Rule | Simulator | Google Snake |
|---|---|---|
| Move one cell per tick | ✅ | ✅ |
| Border/obstacle/body collision | ✅ | ✅ |
| Tail cell legal when not growing | ✅ | ✅ |
| Eating grows by one and respawns the apple | ✅ | ✅ |
| Simultaneous key buffering | ❌ | ✅ (guarded in browser code) |
| Animations / variable tick length | ❌ | ✅ |
| Detection errors | ❌ | ✅ (mitigated by hysteresis and gates) |

That means a green suite is strong evidence that the **planner** is safe, not proof that the
**browser integration** is perfect. When in doubt, watch a real game with DEBUG on.
