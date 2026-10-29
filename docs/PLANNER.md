# The Planner

This is the deep dive into `Core.plan()`, the function that decides the next move. It covers the
state graph, every cost term, the tail-prediction simulation, the safety gates, the greedy
fallback, the endgame problem and the tuning data behind the current constants.

If you only want to use the bot, read [README](../README.md). If you want to change the
behaviour, read this first.

---

## 1. What the planner has to solve

Every game tick the bot knows:

- an ordered `body` array, head first, length `len`,
- the current `heading` (`0..3`, or `-1` when unknown),
- the apple cell (or `-1` if no apple is visible),
- a static obstacle mask (`Uint8Array`, one byte per cell),
- the board dimensions.

It must return **one direction** (`0..3`) or `-1` if there is no survivable move. The constraints
are unforgiving:

| Rule | Consequence |
|---|---|
| The head moves into an adjacent cell each tick | No waiting, no diagonal moves, no staying still. |
| The grid border kills | `nbr()` returning `-1` is death. |
| Obstacles kill | The wall mask is a hard constraint. |
| The body kills | Except the tail cell, which vacates on this very tick. |
| A 180° turn kills | The head enters the neck. |
| Eating grows the snake | After eating, the tail does **not** move on that tick. |

The bot also has a preference hierarchy:

1. Don't die.
2. Don't get trapped later.
3. Eat the apple.
4. Take wall-row apples when they are the actual target.
5. Don't loiter next to walls for no reason.

That ordering is why this is not a shortest-path problem with a few penalties bolted on: a shorter
path that ends in a dead end is worse than a longer safe one, and a wall-hugging path to the apple
is better than a safe route that never arrives.

---

## 2. Why a naive search fails

A plain BFS/Dijkstra over cells treats the snake's body as static. Snake is a *dynamic obstacle*
problem:

```text
tick 0:  . . . . .          the tail cell is occupied
         . H H H T .
         . . . . .

tick 1:  . . . . .          it is now free
         . . H H H .
         . . . . .
```

If the search treats `T` as blocked, it rejects routes that are perfectly legal (`H` may follow its
own tail). If it treats the whole body as free, it drives into its own middle. The planner therefore
carries **time** through the search and validates routes against a simulated moving body.

The second failure mode is late turns. A cell next to a wall is not dangerous *per se*; it becomes
dangerous one tick later, when the only continuation is into the wall. The planner models this with
a **slack** check and a forced-turn penalty.

The third failure mode is the endgame. When the snake fills a large fraction of the board, every
shortest path can look safe while gradually sealing off the remaining space. The planner tracks the
reachable free area and refuses moves that shrink it when the board is crowded.

---

## 3. Pipeline

```text
plan(body, apple, cols, rows, walls, heading, opts)
│
├─ 1. build occupancy index (cell → body index), areaNow = floodArea(body)
│
├─ 2. if apple exists:
│      safePath(apple)   Dijkstra with safety costs (prefers early turns)
│      bfsTimed(apple)   shortest time-respecting path (backup)
│      for each candidate route:
│        ├─ walkSafe(path)            moving-body replay
│        ├─ immediate-step gate       can we still reach our tail? enough room?
│        ├─ full-route gate          tail reachable + area ≥ 50 % of remaining free space
│        └─ endgame shrink rule      in crowded positions, never lose reachable area
│      → return the first direction that passes all gates
│
└─ 3. otherwise score all four legal moves (risk/reward) and return the best,
       or -1 if every move is suicide
```

The two route candidates matter: `safePath` usually wins, but if it is more than `DETOUR = 4`
cells longer than the shortest path, the shortest path is tried first. This prevents a very
cautious route from crawling across the board when a direct route is clearly fine.

---

## 4. The search graph

### 4.1 States

A state is `(cell, heading)`:

- `cell` is the flat index,
- `heading` is `0..3` for the direction the snake is travelling into this cell,
- `4` is a synthetic "unknown heading" start state.

There are `5 × cols × rows` states (1 275 on a 17×15 board). `steps[state]` stores how many moves
have been made to reach it, because body timing depends on elapsed moves.

### 4.2 Transitions

From `(c, a)` the search tries all four directions `d`:

```js
if (a < 4 && d === ((a + 2) & 3)) continue;       // no U-turn
const m = nb(c, d);                              // wall-aware neighbour
if (m < 0) continue;                             // border / obstacle
if (a === 4 && len > 1 && m === body[1]) continue; // first move must not hit the neck
const ns = st + 1;
const o = occ[m];
if (o >= 0 && ns < len - o) continue;            // body cell that has not vacated yet
```

The body constraint is the time model. Segment `o` (0 = head … `len-1` = tail) disappears after
`len - o` moves:

| Segment | Leaves after | Can the head enter at `ns`? |
|---|---:|---|
| head `o = 0` | `len` | only after the whole snake has moved `len` times |
| middle `o = len/2` | `len/2` | after enough moves |
| tail `o = len-1` | `1` | yes, at `ns = 1` (`1 < 1` is false) |

This is exactly the "tail prediction" at the search level; the route validation later makes it
concrete for the *specific* path.

### 4.3 Cost function

`STEP = 1`, and every edge adds:

| Term | Value | Why |
|---|---:|---|
| `STEP` | `1` | Prefer fewer moves. |
| `TURN` | `15 × CAUTION` (`30`) | Every direction change costs something. |
| Forced-turn penalty | `(200 × CAUTION) >> k` | `k` = free cells straight ahead (0…4). `k=0 → 400`, `1 → 200`, `2 → 100`, `3 → 50`, `4 → 25`, `k≥5 → 0`. Turning with no exit ahead is very expensive. |
| Border cell (`EDGE`) | `0` by default | **Deliberately disabled**: a route to the apple is allowed to hug the wall. |
| Wall straight ahead | `+900` if outside the grid, `+700` if an obstacle | Makes the snake turn **early**, while it still has slack. |
| Self-adjacency | `+80 × CAUTION` (`160`) per adjacent body segment that will not vacate within 2 moves | Keeps breathing room; tail-following does not count. |
| Goal exit | `slackPen()` | When the route reaches the apple, the *exit* from the apple cell must also be safe. |
| Entering a soon-freed body cell | `+200` | Entering the tail is legal but should not be the default. |

The search is a **Dijkstra** (uniform-cost) search over the augmented graph. There is no admissible
heuristic for the state-dependent body timing, so calling it A* would be inaccurate: the priority
queue is ordered purely by accumulated cost. It terminates when any state on the goal cell is
popped.

### 4.4 The priority queue

A binary min-heap is implemented inline with two parallel arrays (`hc` costs, `hn` node ids). On a
255-cell board this is faster than allocating objects and more than fast enough: `plan()` takes
~0.2 ms for a short snake on a desktop CPU.

---

## 5. Slack: the anti-wall mechanism

`calcSlack(c, d, st)` walks straight ahead from `(c, d)` and returns how many free cells it can see:

```js
function calcSlack(c, d, st) {
  let m = c, k = 0;
  for (; k < 5; k++) {
    m = nb(m, d);
    if (m < 0) break;                                  // border
    if (occ[m] >= 0 && st + 1 + k < len - occ[m]) break; // body not yet vacated
  }
  return k;
}
```

If the snake is about to turn and the cell straight ahead has `k < 5` free cells after the turn,
the turn is penalised by `400 >> k`. The effect:

- Turning into a corridor with 4 cells of runway is nearly free.
- Turning into a one-cell pocket costs 400.
- Turning into a wall (`k = 0`) costs 400 **and** the wall-ahead term, so the search strongly
  prefers to turn one cell earlier.

This is the core reason the bot does not die at walls: it does not wait until the cell before the
wall to turn. It turns while the current row still has room.

---

## 6. Route validation and safety gates

A Dijkstra route is a sequence of cells, but the search's body constraint is an approximation
(it uses the *initial* body plus elapsed steps, not the exact body after a detour). Before any
route is returned, three independent validations run.

### 6.1 `walkSafe(path)` — exact moving-body replay

```js
function walkSafe(path) {
  const sim = body.slice();
  const L = sim.length;

  for (let s = 0; s < path.length; s++) {
    const to = path[s];

    if (to < 0 || walls[to]) return false;                    // wall / outside
    if (manhattan(sim[0], to) !== 1) return false;            // path must be contiguous

    const lastStep = s === path.length - 1;                   // ends on the apple
    const limit = lastStep ? L : L - 1;                       // growth: tail stays

    for (let j = 0; j < limit; j++) {
      if (sim[j] === to) return false;                        // still occupied: reject
    }

    sim.unshift(to);
    if (!lastStep) sim.pop();                                 // tail advances
  }
  return true;
}
```

This is the literal answer to "calculate where the tail is going to be":

- the body array moves one segment per step,
- the tail cell is allowed on a normal step (it has just vacated),
- the tail is **not** allowed on the final step if the snake grows,
- and the loop checks the predicted body, not the current one.

A route that enters a vacating tail cell early, or that would arrive at a body cell one tick too
soon, is rejected here even if Dijkstra thought it was fine.

### 6.2 Immediate-step gate

Before accepting the route, the bot simulates only the first move:

```js
const first = path[0];
const step1 = [first].concat(body.slice(0, len - 1));
const need1 = Math.ceil((n - step1.length) * 0.5);
if (distToTail(step1) < 0 || floodArea(step1) < need1) continue;
```

- `distToTail` must find a path from the new head to its own tail through free cells. If the first
  step boxes the head in, the route is dead regardless of how good the rest looks.
- `floodArea` must reach at least 50 % of the currently free space. This is a cheap "am I walking
  into a pocket?" check.

### 6.3 Full-route gate

The same two checks run against the body at the end of the route:

```js
const nbody = path.slice().reverse().concat(body).slice(0, len + 1);
const need = Math.ceil((n - nbody.length) * 0.5);
if (distToTail(nbody) >= 0 && floodArea(nbody) >= need) { ... }
```

`nbody` is the body after walking the path (with one growth segment for the apple). Note the
"50 % of what is left" scaling:

> An earlier version required `floodArea >= len`. That is **impossible** once the snake is longer
> than half the board, so apple routing silently switched off in the late game. The current
> requirement scales with the free space that still exists.

### 6.4 Endgame area-shrink rule

When the snake is longer than 45 % of the board, a route that reduces the reachable area by more
than one cell is refused:

```js
const crowded = len > n * 0.45;
if (!crowded || floodArea(nbody) >= areaNow - 1) return dirTo(head, first);
```

This is the local equivalent of "follow your tail instead of sealing the box". It is not enough to
solve every checkmate, but it prevents the gradual self-shrinking that causes most late deaths.

### Safety gates summary

| Gate | Question | Failure action |
|---|---|---|
| `walkSafe` | Does the predicted body block any step? | Reject route. |
| Immediate step | Can I still reach my tail after one move, with room? | Reject route. |
| Full route | Same, at the end, with growth? | Reject route. |
| Area shrink | Am I giving away reachable space late in the game? | Reject route. |
| Fallback | Every route rejected: which legal move loses least? | Greedy score. |

---

## 7. Tail mathematics

The body is indexed from the head:

```text
index:   0     1     2    ...   len-2   len-1
        head  neck  ...        ...     tail
```

After `t` normal moves:

- the head has moved `t` cells,
- the tail has moved `t` cells,
- segment `i` is gone once `t >= len - i`.

That is the rule used by both the search (`ns < len - o`) and `walkSafe`.

**Following the tail.** When the tail cell is directly ahead and the snake is not eating, it is
safe *now*:

```text
tick 0:  H . .        H = head, T = tail
         T
tick 1:  H H .        the head took the old tail cell; the tail moved away
         . T
```

The early-reaction code therefore treats the tail as non-deadly:

```js
const tailNow = T.body[T.body.length - 1];
const yBody = T.body.indexOf(Y);
const deadly = Y < 0 || walls[Y] || (yBody >= 0 && Y !== tailNow);
```

`plan()` itself already permits it through `occ[m] === len-1`, and the ring test in
`tests/planner.test.js` proves a fully boxed-in head still escapes through the tail.

**Growth.** Eating happens on the final step of a route, and the tail does not move on that tick.
`walkSafe` models this with `limit = lastStep ? L : L - 1`. Without that detail the bot would
happily eat an apple and then be one cell longer than its simulation expected.

---

## 8. The greedy fallback

If no route survives all gates (apple temporarily boxed in, body in the way, or the apple is
unreachable), the planner still has to move. It scores each legal move:

```text
for each legal direction d:
  m       = neighbour
  grow    = (m === apple)
  nbody   = [m, ...body]                  (with growth, or with the tail popped)
  dt      = distToTail(nbody)
  area    = floodArea(nbody)
  closer  = max(0, manhattan(head, apple) - manhattan(m, apple))

  wallAdj = border sides + obstacle sides around m
  bodyAdj = adjacent body segments with index < len - 2   (will not vacate soon)

  risk   = (closer > 0 || grow) ? wallAdj * 250 : wallAdj * 2500
  risk  += bodyAdj * 700
  risk  += dt < 0 ? 60000 : 0
  risk  += max(0, freeAfter * 0.4 - area) * 400
  risk  += max(0, areaNow - area - 1) * 500
  risk  += (m === tail) ? 120 : 0

  reward = (grow ? 8000 : 0) + closer * 90 + area * 0.5
  base   = dt >= 0 ? 100000 + dt * 10 : 0

  score  = base + reward - risk
```

Key decisions:

- **Wall adjacency is cheap only when it buys something.** Moving closer to the apple (or eating
  it) makes wall sides cost 250 each; otherwise they cost 2 500 each. This is the "you may travel
  on the wall row to get the apple, but do not hug walls for nothing" rule.
- **Being cut off from the tail is close to disqualifying** (`+60 000`) but not an automatic
  rejection, so the bot never freezes while a legal move exists.
- **Reachable area is a resource.** Losing area costs 500 per cell; being below 40 % of the
  remaining free space costs another 400 per missing cell.
- **The tail cell is legal but discouraged** (`+120`), so it is used when needed, not by accident.

The fallback never enters a non-vacating body cell or the neck: those moves are filtered out before
scoring. It can return `-1` only when all four neighbours are lethal.

---

## 9. Why checkmates still happen

A checkmate in Snake is a state where the head has no legal neighbour at all. On a 17×15 board this
typically happens around 70 % occupancy (~175 apples):

```text
. B B .        B = body, H = head, . = free
B H B .        all four neighbours of H are body
. B B .        the tail is somewhere else
```

No local planner can escape this: every escape would require having *not* filled one of those
cells earlier, which is a board-wide decision made hundreds of moves ago. The current design reduces
the probability (area preservation, tail reachability, late-game shrink rule) but does not solve it.

The complete fix is a global strategy:

- a Hamiltonian **path** (not cycle — 255 cells is odd, so a cycle covering every cell does not
  exist on 17×15),
- or a perfect-matching / "follow the longest path" approach,
- or a full-state search with a much larger horizon (expensive in a browser loop).

That is deliberately out of scope for v1.4. The bot is honest about it: it returns `-1`, the game
ends normally, and the tests treat `no-move` as a distinct, non-death outcome.

### Measured behaviour

| Test | Games | Average apples | Self/wall/out deaths | Checkmates |
|---|---:|---:|---:|---:|
| Classic, 3 000-step cap (CI) | 10 | 120.9 | 0 | 0 |
| Obstacles, 3 000-step cap (CI) | 6 | 113.0 | 0 | 0 |
| Edge apples, 1 500-step cap (CI) | 6 | 65.5 | 0 | 0 |
| Classic, 5 000-step cap (local) | 120 | 147.2 | 0 | 2 |
| Classic, 20 000-step cap (local) | 15 | 169.6 | 0 | 8 |

The 20 000-step runs reach the checkmate regime; every termination is `no-move` at roughly 170–195
apples, never a collision.

---

## 10. What was tried and rejected

The constants above are not arbitrary; several alternatives were A/B tested over 120 classic games
with identical seeds.

| Variant | Average | Best | Checkmates |
|---|---:|---:|---:|
| **Current** (`walkSafe`, no escape scoring) | **147.2** | **165** | **2** |
| No `walkSafe`, no escape scoring | 151.2 | 165 | 3 |
| `escapes * 150` scoring | 148.3 | 166 | 7 |
| `escapes * 250` scoring | 149.3 | 162 | 12 |
| No fallback scoring at all | — | — | many |

Two conclusions:

1. **`walkSafe` is worth the small average-score cost.** Removing it raises the average slightly
   because the bot takes riskier shortcuts before eventually trapping itself, but it weakens the
   exact tail guarantee. The current version keeps the guarantee.
2. **An "escape count" heuristic hurts.** Counting immediate exits after a move sounds smart, but
   it biases the bot toward open space instead of toward the apple and leads to *more* late
   checkmates. It was removed.

Any future change should be measured the same way: fixed seeds, full games, deaths **and**
checkmates, not just average score.

---

## 11. Complexity and performance

Let `N = cols × rows` (255) and `L = body length`.

| Step | Complexity | Notes |
|---|---|---|
| Build `occ` | O(N + L) | `Int16Array` |
| `floodArea` | O(N) | BFS |
| `safePath` (Dijkstra) | O(N log N) states × 4 edges | 5N states, binary heap |
| `bfsTimed` | O(N) | plain BFS |
| `walkSafe` | O(path × L) | path is usually short; worst case O(N·L) |
| `distToTail` | O(N) | BFS |
| Fallback | O(4 × N) | 4 BFS calls |

Measured on a desktop CPU (`npm run bench`): **≈0.2 ms per `plan()` call** for a short snake, and a
few milliseconds for a very long snake. This is far below one game tick (~90–150 ms), even with the
early-reaction call.

The browser loop calls `plan()` once per game tick, plus at most one early-reaction call when the
head approaches a cell edge. It never re-plans on every 2 ms read.

---

## 12. Tuning guide

All internal constants live inside `plan()`. `opts` exposes a few of them for experiments:

```js
Core.plan(body, apple, cols, rows, walls, heading, {
  forced: 100,   // base forced-turn penalty (before the 2× caution multiplier)
  win: 5,        // how far ahead to measure slack
  detour: 4,     // max extra length before the shortest path is preferred
  caution: 2,    // multiplier for turn/adjacency penalties
  edge: 0,       // extra cost for border cells (0 = wall rows allowed)
});
```

| Knob | Raise it when… | Lower it when… |
|---|---|---|
| `caution` | The snake dies at corners or hugs walls | It refuses good apples near walls |
| `forced` | It turns too late at dead ends | It takes long detours to avoid a turn |
| `win` | You want earlier turns (costs search accuracy) | You want shorter, more direct routes |
| `detour` | You trust the safe route more | The safe route is too slow |
| `edge` | You want it away from the border (loses edge apples) | You want more edge apples (default) |

Fallback weights are not exposed because they interact: changing `wallAdj` without the area terms
can produce loops or corner-camping. If you change them, run `npm test` **and** a longer local
batch (see [TESTING.md](TESTING.md#5-running-longer-experiments)).

---

## 13. Worked examples

### Example A — boxed in, tail is the only exit

```text
. B .
B H B        H = head, B = body, . = free
. T .
```

The head's up/left/right neighbours are permanent body; the down neighbour is the tail, which
vacates this tick. The search rejects the three body cells and accepts the tail (`o = len-1`,
`ns = 1`, `1 < 1` is false). `walkSafe` confirms the tail has moved by the time the head arrives.
Result: move down. Tested in `tests/planner.test.js`.

### Example B — apple on the outer ring

```text
row 0:   🍎 . . H . . .
```

The apple is on the border. `EDGE` is 0, so the border cell is not penalised per se. The route is
accepted if the gates pass; the fallback would charge `wallAdj × 250` (cheap) because `closer > 0`.
If the bot were merely wandering along the wall with no apple, the same adjacency would cost
`wallAdj × 2 500`. Tested with `appleMode: 'edge'` games.

### Example C — wall ahead, turn early

```text
row 2:  . . H . . #
row 3:  . . . . . .
```

If the snake continues right, the next cell has a wall ahead (`+700`) and no slack (`k = 1` after
turning down, `+200`). Turning down now costs `TURN = 30` and leaves a long corridor (`k ≥ 5`,
`+0`). The search turns one cell earlier than a greedy bot would. This is the wall-death fix.

### Example D — genuine checkmate

```text
. B B .
B H B .        the tail is elsewhere (not adjacent)
. B B .
```

All four neighbours are body segments that do not vacate this tick. `plan()` returns `-1`; the
game loop does not press a key. This is a loss, but not a collision, and the auto-restart handles
it. Tested in `tests/planner.test.js`.

---

## 14. Where to go next

- [ARCHITECTURE.md](ARCHITECTURE.md) — how pixels become a body and a body becomes a key press.
- [TESTING.md](TESTING.md) — how to verify a change and reproduce a failure by seed.
- [CONFIGURATION.md](CONFIGURATION.md) — user-facing options and recipes.
