# Troubleshooting

Start with the panel's **state line** and **info line**. They tell you which stage of the pipeline
is failing, which is usually enough to pick the right section below.

| State line | Info line | Meaning |
|---|---|---|
| `OFF - stopped` | — | The bot is disabled. Press START. |
| `SEARCH - no game canvas - search "snake game"` | — | No canvas ≥150×150 px on the page. |
| `SEARCH - board not detected (try DEBUG)` | — | A canvas exists, but no playfield was recognised. |
| `SEARCH - looking for the game...` | grid info may appear | The board is detected; the snake has not been found/ordered yet. |
| `READY - ready - sending first key` | grid + cell + obstacles | A run was detected; the first key is about to be sent. |
| `PLAY - playing` | `game tick ~Nms \| reads/s N` | Normal. |
| `PLAY` but frozen | tick keeps changing | The tracker is not seeing movement; usually a focus/throttle issue. |
| `DEAD - died - score N` | — | Waiting for the game-over screen / restart. |
| `OFF - reached maxRuns` | — | `CONFIG.maxRuns` was hit. |
| `OFF` or `PLAY` with `ERROR: …` | — | An exception was caught; the message names the stage. |

---

## The panel does not appear

**Cause:** the script did not execute.

- Check that Tampermonkey shows the script as enabled and that the URL matches `www.google.com`
  (or a regional domain).
- If you pasted it into the console, check for a `[snakeBot] ready` log. No log = a syntax error or
  a CSP block.
- If you see `[snakeBot] already running`, the script is already active on this page. Reload the
  page before pasting a new version.

**Note:** Google sometimes serves the doodle in an iframe or a different document. The script runs
in the top document; if the canvas lives in a cross-origin iframe it cannot read it.

---

## `no game canvas`

**Cause:** `findCanvas()` found no canvas at least 150×150 CSS pixels.

| Check | Fix |
|---|---|
| Is the snake doodle actually open? | Google "snake game" and click the play button. |
| Is the game in another tab/window? | The bot only sees its own document. |
| Is the canvas smaller than 150×150? | Zoom in (Ctrl+`+`) or use a larger window. |
| Is the game inside a cross-origin iframe? | Not supported; the pixels are inaccessible. |
| Is another extension replacing the canvas? | Disable it, reload, try again. |

---

## `board not detected`

**Cause:** `detectBoard()` found a canvas but could not find a light-green playfield ≥100×100, or
the resulting grid was implausible (`err > 0.1`, or a dimension outside 4…80).

Steps:

1. Click **DEBUG**. If no magenta grid appears, detection failed before drawing.
2. Check the actual colours. In the console:

   ```js
   // sample the centre pixel of the largest canvas
   const cv = [...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
   const c = cv.getContext('2d');
   const p = c.getImageData(cv.width/2 | 0, cv.height/2 | 0, 1, 1).data;
   console.log([...p]);
   ```

   Board green must satisfy `g > r + 30 && g > b + 90 && r > 140` (for example
   `[170, 215, 120]`).

3. If the canvas is tainted, the console reports a `SecurityError`; see
   [cross-origin taint](#canvas-is-cross-origin-tainted).
4. If you use a custom skin, adjust the predicates in `Core` (`isBoardGreen`, `isAppleRed`,
   `isWallGreen`) and reload.

**Why the grid is rejected:** the bot requires roughly square cells. If the detected bounding box
is much wider than tall (or vice versa), it refuses the candidate rather than plan on a wrong
board. Try forcing `CONFIG.cols` / `CONFIG.rows` or `CONFIG.cell`.

---

## The grid size is wrong

Symptoms: the debug grid does not line up with the game's cells; the snake appears shifted; the
planner wanders.

1. Open DEBUG and compare the magenta lines with the checkerboard.
2. Read the info line: `grid CxR | cell XX.Xpx`.
3. Set the correct values manually:

   ```js
   snakeBot.config.cols = 17;
   snakeBot.config.rows = 15;
   snakeBot.config.cell = 20;   // optional, in canvas pixels
   ```

4. Reload and start again. Changing `cols`/`rows` while a game is running does not immediately
   re-detect the board.

The config hint only wins **ties**; if the measurement is clearly wrong (for example because the
snake covers a column), the hint might be ignored. In that case force `cell`.

---

## The snake is not detected / the bot does not start

The board is drawn but the state stays `SEARCH - looking for the game...`.

**Cause:** `readGrid()` found no snake cells, or `orderCells()` could not build a path.

- The snake colour must be "not board, not apple, not dark green". Very unusual skins (for example
  a green snake on a green board) break this.
- A snake hidden by the start animation or the "ready" overlay is not readable for a few frames.
  Wait a second.
- If the snake is split visually (eyes/highlights), the 2-of-3 sampling should still work; if not,
  lower the vote threshold in `readGrid` (requires a reload and new tests).

Diagnostic: with DEBUG on, yellow squares should cover the snake. No yellow = classification
problem, not tracking.

---

## The bot "jumps" or loses the snake mid-game

Symptoms: the body model suddenly changes length, the bot turns oddly, the state flips to
`SEARCH`/`READY`.

Causes and fixes:

| Cause | Fix |
|---|---|
| Frame rate too low (background tab, heavy page) | Focus the tab; raise `readIntervalMs` to 4–8. |
| Canvas animation over the snake (portal, speed effects) | Only classic mode is validated. |
| Resizing/zooming mid-game | The board is re-detected; wait a moment, or restart the bot. |
| Another overlay covering the board | Disable it; the bot reads what is painted. |
| A very long snake with self-touching cells | Ordering is a Hamiltonian DFS; ambiguous frames trigger a resync next frame. |

`Tracker` returns `lost` for a corrupt frame rather than guessing; the next frame usually recovers.
If it persists, the vision layer is misreading colours.

---

## It stops at a high score (`no-move`)

**This is expected.** Around 70 % board occupancy the snake can surround its own head. The bot
returns `-1` because there is genuinely no legal move; it does **not** drive into itself. The panel
shows `died - score N` (or the run simply ends), and auto-restart continues.

This is a checkmate, not a bug. A fix requires a board-wide Hamiltonian strategy; see
[PLANNER.md § Why checkmates still happen](PLANNER.md#9-why-checkmates-still-happen).

If it stops much earlier (for example under 50 apples), that is a bug: please report it with the
seed and board state (see [Reporting a bug](#reporting-a-bug)).

---

## It died at a wall or into itself

That should be impossible in the current version: walls, borders, the neck and non-vacating body
cells are hard constraints, and the browser layer refuses reversals.

Before reporting, check:

1. **Was it actually a collision?** The state line may say `died - score N` for a checkmate. Look
   at the final position: if all four neighbours were body, it was a checkmate.
2. **Was the wall detected?** Debug overlay red squares = stabilised walls. A wall that appears for
   only one frame may not be stabilised yet (3-frame hysteresis).
3. **Was the snake model correct?** With DEBUG on, yellow squares must match the snake exactly.
4. **Did the page lag?** If the tab was backgrounded, the bot may read an old frame. Restore focus.

If you can reproduce it, capture:

```js
// just before the death
snakeBot.config.debug = true;
console.log(snakeBot.stats());
```

…and open an issue with the browser, game speed, board type, and (if possible) a screen recording.
The simulated suite cannot reproduce browser-timing bugs, so the recording matters.

---

## It does not restart

| Check | Fix |
|---|---|
| Is **AUTO-RESTART** green? | Click it, or `snakeBot.config.autoRestart = true`. |
| Does the game show a visible Play button? | Click it once manually; the bot caches the element. |
| Is the button text unusual (icon-only)? | The watcher matches `play`, `play again`, `replay`, `restart`, `try again`, `new game`. Icon-only buttons need the keyboard fallback (Space/Enter). |
| Is the button inside a shadow root? | `querySelectorAll` does not cross shadow boundaries; click manually. |
| Did it try 8 times? | The panel tells you to click Play yourself; do that, then the bot resumes. |
| Is the game paused by the browser? | Focus the tab. |

The fallback alternates Space and Enter every 500 ms. Some game versions require a click on the
canvas first; the bot clicks the detected button when it can.

---

## Restart loop / it keeps clicking Play

**Cause:** the pixels still show the old snake after a restart, or another element matches the
Play regex.

- Set `autoRestart = false` and restart manually once.
- Check that the watcher is not finding a "Play" button elsewhere on the page (`findPlayButton`
  requires visibility and an exact label match).
- If the new game starts with the same snake cells as the dead one, the bot waits in `DEAD` until
  the pixels differ. A very fast restart can look identical for a frame; it resolves.

---

## Keys do nothing

| Cause | Fix |
|---|---|
| Focus is in the console or the panel | Click the game area, then restart the bot. |
| Another extension captures arrow keys | Disable it for google.com. |
| The game uses WASD in your version | Not supported; the bot presses arrow keys. |
| The page lost focus after DEBUG | Click the canvas. |
| `sendDir` refuses reverses | That is intentional. A 180° turn is death. |

---

## High CPU / the page feels sluggish

The default read interval is 2 ms. That is aggressive by design.

```js
snakeBot.config.readIntervalMs = 6;   // 3× less work, still < 1 game tick
```

Other tips:

- Keep the panel visible (it is cheap) but avoid other heavy extensions on the page.
- Close other tabs with canvases; `findCanvas` scans all of them.
- `snakeBot.stop()` when you are not playing.

The planner runs once per game tick, not once per read, so lowering the read rate does not reduce
planning quality — only reaction latency.

---

## Canvas is cross-origin tainted

`getImageData` throws `SecurityError` when the canvas contains images from another origin without
CORS headers. The panel shows:

```text
ERROR: Canvas is cross-origin tainted - pixels cannot be read (SecurityError).
```

This cannot be fixed from a userscript (it is a browser security boundary). Workarounds:

- Use the standard Google Snake page, not an embedded copy on a third-party site.
- Disable extensions that inject cross-origin images into the canvas.

---

## Stats are not saved

- Private/incognito mode may block `localStorage`.
- The key is `gsnakebot.stats.v1`; check it in DevTools → Application → Local Storage.
- Quota errors are swallowed; the bot keeps in-memory stats for the session.
- RESET STATS clears it intentionally.

---

## The panel covers the game

The panel is fixed at `top: 10px; right: 10px` and 250 px wide. Options:

- Zoom out slightly (the board scales, the panel does not).
- Use a wider window.
- Hide it with CSS via the console:

  ```js
  document.getElementById('gsb-panel').style.display = 'none';
  ```

The bot keeps working; you lose the live stats.

---

## The bot starts but never sends a key (`READY` forever)

- The tracker found the snake but no movement is observed (`same` frames). The game may be paused
  on a "click to start" overlay.
- A new game can take a moment to animate in. Wait 2 seconds.
- Check `lastKeyT`: `READY` sends one forced key after 150 ms. If the game ignores synthetic keys,
  focus the canvas and restart the bot.
- If `tickMs` stays 0 and the state stays `READY`, the head is not moving at all — the game is
  paused, not the bot.

---

## Reporting a bug

Include:

1. The panel state line and info line (canvas size, grid, cell, obstacles, tick).
2. Browser + OS.
3. Game mode/speed and board skin.
4. Whether DEBUG grid/snake/apple alignment was correct.
5. A screen recording if the failure is timing-related.
6. For planner failures: the seed from a failing test (`npm test` prints it).

Open an issue at <https://github.com/KairosMakki/SnakeBot/issues>.
