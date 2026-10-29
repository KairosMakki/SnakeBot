# Changelog

All notable changes to SnakeBot. The userscript version lives in the metadata block of
`google_snake_bot_user.js`; `package.json` mirrors it (the tests enforce that).

## 1.4 — tail prediction

The "where will my tail be?" release.

### Added

- **Exact tail/body prediction.** Every candidate route to the apple is replayed step by step with
  the body actually moving (`walkSafe`). A cell is only entered once the predicted tail has vacated
  it; a body segment that would still be there rejects the route.
- **Correct growth modelling.** On the final step (eating), the tail does not advance. Routes that
  would eat and immediately be one cell too long are rejected.
- **Immediate-step gate.** Before accepting a route, the bot simulates only the first move and
  requires it to keep the tail reachable and the reachable area healthy.
- **Full-route gate.** The same tail-reachability and area checks run against the body at the end
  of the route.
- **Tail-following in the early-reaction trigger.** The current tail cell is explicitly treated as
  safe (it vacates this tick), so a boxed-in snake can follow it instead of swerving into a wall.

### Changed

- Reachable-area requirements scale with the free space that remains. The previous
  `area >= snake length` check became impossible once the snake was longer than half the board and
  silently disabled apple routing in the late game.
- Crowded endgames refuse routes that shrink the reachable area, which prevents the gradual
  self-sealing that led to many late losses.
- Documentation and tests were added: planner property tests (800 random states), synthetic-canvas
  vision tests, full-game regression tests, metadata checks, CI and this changelog.

### Removed

- An experimental "escape count" scoring term. It was A/B tested over 120 games and increased late
  checkmates; the exact numbers are in [docs/PLANNER.md](docs/PLANNER.md#10-what-was-tried-and-rejected).

### Fixed

- Rare self-collisions caused by entering a body cell before its tail had vacated it.
- Reverse-direction key presses from a stale tracker heading (now blocked in `sendDir` as well as
  in the planner).
- Multiple direction keys pressed within one game tick, which Google Snake can buffer and apply on
  a later tick (a classic source of delayed self-hits).
- `floodArea` scaling in the endgame (see above).

## 1.3 — safety planner

### Added

- Early reaction: if the cell straight ahead is deadly (border, obstacle or body), re-plan and
  press immediately instead of waiting for the head to reach the cell centre.
- Dijkstra search over `(cell, heading)` states with forced-turn, wall-ahead and self-adjacency
  penalties.
- Tail-reachability and reachable-area checks before accepting an apple route.
- Wall-adjacent rows are allowed when they lead to the apple; wandering next to walls without a
  reward is heavily penalised.
- Debug overlay (grid, snake, apple, walls, head) and richer panel statistics.
- Reverse keys blocked in the key dispatcher; one key per game tick.

### Changed

- Canvas reads reduced to a 2 ms target with `MessageChannel` scheduling.
- The outer ring of the board is no longer treated as a wall (the dark frame is outside the grid;
  only real obstacle pixels count), which makes edge apples reachable.
- Adaptive death timers based on the measured game tick.

## 1.2 and earlier — initial versions

- Canvas capture and board detection.
- Snake tracking with an ordered body.
- Greedy/older pathfinding toward the apple.
- Automatic restart via the Play button with keyboard fallbacks.
- Statistics panel with best/average score, sparkline and `localStorage` persistence.
