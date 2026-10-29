# FAQ

### What is SnakeBot?

A userscript that plays Google's built-in Snake doodle. It reads the game's canvas pixels, tracks
the snake, plans a safe route to the apple, and presses arrow keys. It also restarts automatically
and keeps score statistics.

### Is this cheating? Will I get banned?

It is a local automation demo for a single-player browser game. It does not touch Google's
servers, has no account integration, sends no network requests and does not attempt to hide
itself. There is nothing to be banned from. Treat it as a computer-vision / pathfinding project,
not a competitive tool.

### Does it use the game's JavaScript state?

No. It only reads the canvas with `getImageData` and dispatches keyboard events. It does not call
game functions, inspect closures, or parse the network. That is why it also works when Google
changes the game's internals — as long as the pixels look the same.

### Where does it get the board size?

It measures it. `detectBoard()` finds the light-green playfield, estimates the cell size from the
checkerboard run lengths, and scores the configured hint (`17×15`) against the measured grid by
how square the cells are. The hint only wins ties. Other board sizes work (the tests include an
11×21 board).

### Why is the default 17×15?

That is the classic Google Snake board (255 cells). 255 is odd, which is why a Hamiltonian **cycle**
covering every cell does not exist — relevant for the endgame discussion below.

### Why does it stop at ~170 apples?

At roughly 70 % occupancy, the snake can surround its own head: all four neighbours are its own
body. There is no legal move, so `plan()` returns `-1`. This is a **checkmate**, not a collision.

Escaping requires a board-wide strategy (Hamiltonian path / perfect matching) rather than a local
planner. It is a known limitation, documented in
[PLANNER.md §9](PLANNER.md#9-why-checkmates-still-happen).

### Can it get a perfect score / full clear?

On 17×15, filling all 255 cells (251 apples after the starting length of 4) requires a Hamiltonian
path and perfect endgame routing. The
current planner is safety-first and local; the automated tests never produce a full clear. The bot
does track `full clears` in the stats in case it ever happens.

### Does it work in other game modes?

Classic and walls/obstacles are tested. Speed mode shares the same movement rules and should work.
Portal modes add teleport edges that the planner does not model, and moving obstacles are not
handled by the temporal wall filter. See [Troubleshooting](TROUBLESHOOTING.md) if the grid or snake
looks wrong in a custom mode.

### Does it work on mobile?

No. It needs a desktop browser with userscripts (or the console), a keyboard, and a canvas it can
read. Mobile browsers also throttle background pages aggressively.

### Why arrow keys and not direct game control?

Because the game only exposes pixels and keyboard input. Simulating keys is the only approach that
does not depend on Google's internal implementation. It also makes the bot robust to game updates.

### How fast does it react?

The loop targets a canvas read every **2 ms** and uses `MessageChannel` to bypass the 4 ms timer
clamp. If the cell straight ahead is deadly, the bot re-plans and presses a key immediately instead
of waiting for the head to reach the cell centre. Typical wall-avoidance reactions are well inside
the 50–150 ms window; the exact time depends on the browser and the game speed.

### Why 2 ms? Isn't that wasteful?

The loop is cheap when nothing changes: a cropped `getImageData` plus a 255-cell scan. The planner
runs once per game tick, not once per read. If CPU matters, set
`snakeBot.config.readIntervalMs = 6`; the bot still reacts within one tick.

### Is the bot deterministic?

The planner is deterministic for identical inputs (tested). Real games are not, because pixel
timing, game speed and frame drops vary. The test simulator is fully deterministic by seed.

### The average score in CI looks lower than the README's long-run numbers. Why?

CI uses a 3 000-step cap and only 10 games; the long-run numbers use 120 games at a 5 000-step cap.
Variance between seeds is large (±10 points over 10 games). Deaths are the metric to trust, and
they are zero in both.

### Why does it allow the snake to travel next to walls now?

Because wall-adjacent apples are real targets. The planner makes wall adjacency **cheap when it
closes the distance to the apple** and **expensive when there is nothing to gain**. Outright banning
wall rows made those apples unreachable.

### Why does it not just follow its tail forever?

Following the tail is safe but does not score. The planner uses it as an escape (when boxed in) and
as a late-game area-preservation tactic, not as the default strategy. A pure tail-chaser never
eats apples.

### Why was the "escape count" heuristic removed?

It was A/B tested over 120 games: counting immediate exits after a move biased the bot toward open
space instead of the apple, and produced *more* late checkmates. The exact numbers are in
[PLANNER.md §10](PLANNER.md#10-what-was-tried-and-rejected).

### Can I use a different theme or a custom board?

The colour thresholds are tuned for the default skin. If your theme differs, adjust the predicates
in `Core` (`isBoardGreen`, `isAppleRed`, `isWallGreen`) and the eye threshold in `readGrid`, then
update `tests/vision.test.js` to match. See
[CONFIGURATION.md](CONFIGURATION.md#8-what-is-not-configurable).

### Do I need to install Node to use the bot?

No. Node is only for running the tests. The userscript itself is a single file with no dependencies
and no build step.

### Does the bot work offline?

Yes, in the sense that it makes no network requests. The game itself still needs Google's page.

### Can I run the tests in CI for my fork?

Yes — `.github/workflows/ci.yml` runs on every push and pull request with Node 18, 20 and 22. No
secrets or install step are required.

### How do I contribute?

Read [CONTRIBUTING.md](../CONTRIBUTING.md). Short version: keep it dependency-free, keep it a single
userscript, add a test for every behaviour change, and never trade safety for score.

### Is there a license?

Not yet; the repository currently falls under default copyright. If you need a permissive license,
open an issue — MIT or Apache-2.0 is easy to add.
