// ==UserScript==
// @name         Google Snake Bot + Run Counter
// @namespace    local.snake.bot
// @version      1.4
// @description  Plays Google's built-in "snake game" automatically, restarts after every death/clear, and keeps run + score stats. v1.4: predicts the snake's future tail/body positions step-by-step, follows the tail when it vacates, avoids body cells that do not vacate in time, plus 2 ms reactions, early wall turns and A*/Dijkstra routing.
// @match        *://www.google.com/*
// @match        *://www.google.tld/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
  HOW TO USE
  ----------
  Option A (Tampermonkey / Violentmonkey): install this file as a userscript,
           then Google "snake game" and open the game.
  Option B (no install): Google "snake game", press F12 -> Console, paste this
           whole file, press Enter.

  A panel appears top-right.  Click START (or press Alt+B).  The bot presses the
  arrow keys, restarts after each death, and counts runs / scores / best / average.

  v1.4 planner notes
   * Tail prediction: every apple route is replayed step-by-step with the body actually
     moving.  A cell is only used once the predicted tail has vacated it; if a body
     segment would still be there, that route is rejected and another one is chosen.
   * When the tail cell is directly ahead it counts as safe (it leaves exactly one move
     from now), so the snake can keep following its own tail instead of panicking.
   * Reads the canvas every 2 ms; a deadly cell straight ahead triggers an immediate
     re-plan (key sent well inside 50-150 ms).
   * A* / Dijkstra routing over (cell, heading) states.  Forced turns are expensive, so
     the snake turns EARLY along walls instead of at the last moment.
   * Before every apple route is accepted the bot also checks it can still reach its own
     tail and is not walking into a cramped pocket.
   * Wall-adjacent rows are allowed when they lead to the apple; wandering next to
     walls with no reward is punished.
   * Only one direction key is sent per game tick, and reverse keys are blocked.

  Tips
   * Use the game's own settings (gear) to pick the speed.
   * Classic mode (default apple, walls on) is what it understands.
   * If it doesn't see the board, click DEBUG: it draws what it detects
     (grid, snake, apple) on top of the game and prints canvas info in the panel.
   * Console control:  snakeBot.start()  snakeBot.stop()  snakeBot.stats()
                       snakeBot.config.autoRestart = false   (etc.)
*/

(function () {
  'use strict';

  const CONFIG = {
    autoRestart: true,     // auto-click the Play button (or press Space+Enter) whenever it appears
    maxRuns: 0,            // stop automatically after N runs (0 = never)
    readIntervalMs: 2,     // target ms between canvas reads while playing (lower = faster reactions, more CPU)
    deadTimeoutMs: 1000,   // upper limit for the 'no movement = run is over' timer (it adapts to the game speed)
    cols: 17,              // grid-size HINT; the bot auto-detects the real grid and only trusts this if it fits best
    rows: 15,
    cell: null,            // force cell size in canvas pixels (rarely needed)
    debug: false,
    // Wall detection tuning
    wallThreshold: 3,      // frames a cell must be seen as wall to count as permanent obstacle
    cautionFast: true,     // enable forced-turn penalties for safer wall avoidance
    minSlack: 2,           // minimum free cells straight ahead before a turn is considered safe
  };

  // =========================================================================
  //  CORE  (pure logic: board detection, snake tracking, path planning)
  // =========================================================================
  const Core = (function () {
    const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];            // up, right, down, left
    const isBoardGreen = (r, g, b) => g > r + 30 && g > b + 90 && r > 140;
    const isAppleRed = (r, g, b) => r > g + 90 && r > b + 100;
    // dark-green border / obstacle colour (the board itself is the LIGHT green above)
    const isWallGreen = (r, g, b) => g > r + 20 && g > b + 40 && r < 130 && g > 90;

    function nbr(c, d, cols, rows) {
      const x = c % cols, y = (c / cols) | 0;
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return -1;
      return ny * cols + nx;
    }

    // ---- find the playfield inside the canvas -----------------------------
    // `prev` (optional) = previous detection on the same canvas: a snake covering an
    // edge can never shrink the board.  Grid size = whichever candidate (config hint
    // or measured cell size) gives the most SQUARE cells, because Snake cells are square.
    function detectBoard(data, W, H, cfg, prev) {
      let minX = W, minY = H, maxX = -1, maxY = -1;
      for (let y = 0; y < H; y++) {
        let o = y * W * 4;
        for (let x = 0; x < W; x++, o += 4) {
          if (isBoardGreen(data[o], data[o + 1], data[o + 2])) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      if (prev && prev.W === W && prev.H === H) {
        const tol = Math.max(prev.cellX, prev.cellY) * 1.1;
        const pMaxX = prev.minX + prev.cols * prev.cellX - 1, pMaxY = prev.minY + prev.rows * prev.cellY - 1;
        if (minX > prev.minX && minX - prev.minX <= tol) minX = prev.minX;
        if (minY > prev.minY && minY - prev.minY <= tol) minY = prev.minY;
        if (maxX < pMaxX && pMaxX - maxX <= tol) maxX = Math.round(pMaxX);
        if (maxY < pMaxY && pMaxY - maxY <= tol) maxY = Math.round(pMaxY);
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (bw < 100 || bh < 100) return null;

      let cell = cfg && cfg.cell;
      if (!cell) {
        // light/dark checkerboard: the most common run length is the cell size
        const hist = {};
        for (let k = 1; k <= 9; k++) {
          const y = minY + Math.floor(bh * k / 10);
          let prevCls = -1, run = 0;
          for (let x = minX; x <= maxX + 1; x++) {
            let cls = 0;
            if (x <= maxX) {
              const o = (y * W + x) * 4;
              if (isBoardGreen(data[o], data[o + 1], data[o + 2])) cls = data[o] > 166 ? 1 : 2;
            }
            if (cls === prevCls) run++;
            else {
              if (prevCls > 0 && run >= 8) hist[run] = (hist[run] || 0) + 1;
              prevCls = cls; run = 1;
            }
          }
        }
        let bestRun = 0, bestN = 0;
        for (const k in hist) if (hist[k] > bestN) { bestN = hist[k]; bestRun = +k; }
        cell = bestRun || 0;
      }
      const cands = [];
      if (cfg && cfg.cols && cfg.rows) cands.push([cfg.cols, cfg.rows, 0]);
      if (cell) cands.push([Math.round(bw / cell), Math.round(bh / cell), 1]);
      let best = null, bestErr = 1e9;
      for (const c of cands) {
        if (c[0] < 4 || c[1] < 4 || c[0] > 80 || c[1] > 80) continue;
        const err = Math.abs(Math.log((bw / c[0]) / (bh / c[1]))) + (c[2] ? 0.004 : 0);   // config wins ties
        if (err < bestErr) { bestErr = err; best = c; }
      }
      if (!best || bestErr > 0.1) return null;
      const cols = best[0], rows = best[1];
      return { minX, minY, cols, rows, cellX: bw / cols, cellY: bh / rows, W, H };
    }

    // ---- read snake cells + apple from pixels -----------------------------
    function readGrid(data, W, B) {
      const snake = [], walls = [];
      let apple = -1;
      const offs = [-0.12, 0, 0.12];
      for (let r = 0; r < B.rows; r++) {
        const y = Math.floor(B.minY + (r + 0.5) * B.cellY);
        for (let c = 0; c < B.cols; c++) {
          let ap = 0, sn = 0, wl = 0;
          for (let k = 0; k < 3; k++) {
            const x = Math.floor(B.minX + (c + 0.5 + offs[k]) * B.cellX);
            const o = (y * W + x) * 4;
            const R = data[o], G = data[o + 1], Bl = data[o + 2];
            if (isBoardGreen(R, G, Bl)) continue;
            if (isAppleRed(R, G, Bl)) ap++; else if (isWallGreen(R, G, Bl)) wl++; else sn++;
          }
          // NOTE: the outermost ring of the detected board is PLAYABLE in Google Snake; the
          // dark frame is *outside* the grid and the planner can never step outside it anyway
          // (nbr() returns -1).  So we do NOT mark the ring as wall - that would make apples
          // on edge rows unreachable.  Only real obstacle pixels count as walls here.
          const idx = r * B.cols + c;
          if (ap >= 2) apple = idx;
          else if (wl >= 2) walls.push(idx);
          else if (sn >= 2) snake.push(idx);
          else if (ap + sn >= 2) { if (ap >= sn) apple = idx; else snake.push(idx); }
        }
      }
      // head = the snake cell with the most near-white pixels (the eyes)
      let head = -1, bestWhite = 5;
      for (const idx of snake) {
        const x0 = Math.floor(B.minX + (idx % B.cols) * B.cellX), y0 = Math.floor(B.minY + ((idx / B.cols) | 0) * B.cellY);
        const x1 = Math.floor(x0 + B.cellX), y1 = Math.floor(y0 + B.cellY);
        let white = 0;
        for (let y = y0; y < y1; y++) {
          let o = (y * W + x0) * 4;
          for (let x = x0; x < x1; x++, o += 4) if (data[o] > 225 && data[o + 1] > 225 && data[o + 2] > 225) white++;
        }
        if (white > bestWhite) { bestWhite = white; head = idx; }
      }
      return { snake, apple, head, walls };
    }

    // ---- early head detection ---------------------------------------------
    // The snake slides from cell to cell, so its head only covers a cell's CENTRE about half a
    // tick after the game really moved it.  Probing a point just inside the cell's ENTRY edge
    // (22% deep) sees the head that much sooner, which is extra time to press the next key.
    // `cell` = the cell in front of the head, `dir` = heading.
    function headEntering(data, W, B, cell, dir) {
      const cx = cell % B.cols, cy = (cell / B.cols) | 0, T = 0.22;
      let hits = 0;
      for (const o of [-0.12, 0, 0.12]) {
        let fx = 0.5 + o, fy = 0.5 + o;
        if (dir === 1) fx = T; else if (dir === 3) fx = 1 - T; else if (dir === 2) fy = T; else fy = 1 - T;
        const x = Math.floor(B.minX + (cx + fx) * B.cellX), y = Math.floor(B.minY + (cy + fy) * B.cellY);
        const i = (y * W + x) * 4;
        const R = data[i], G = data[i + 1], Bl = data[i + 2];
        if (!isBoardGreen(R, G, Bl) && !isAppleRed(R, G, Bl) && !isWallGreen(R, G, Bl)) hits++;
      }
      return hits >= 2;
    }

    // ---- order an unordered set of snake cells (head first) ---------------
    function orderCells(S, cols, rows, hint, forced) {
      const n = S.length;
      if (n === 0) return null;
      if (n === 1) return [S[0]];
      const inS = new Set(S);
      const adj = new Map();
      for (const c of S) {
        const a = [];
        for (let d = 0; d < 4; d++) { const m = nbr(c, d, cols, rows); if (m >= 0 && inS.has(m)) a.push(m); }
        adj.set(c, a);
      }
      let starts = S.filter(c => adj.get(c).length <= 1);
      if (!starts.length) starts = S.slice();
      if (forced != null && inS.has(forced)) starts = [forced];
      const dist = (a, b) => Math.abs((a % cols) - (b % cols)) + Math.abs(((a / cols) | 0) - ((b / cols) | 0));
      starts.sort((a, b) => hint != null ? dist(a, hint) - dist(b, hint) : (b % cols) - (a % cols));
      let budget = 0;
      function ham(s) {
        const path = [s], vis = new Set([s]);
        budget = 20000;
        function dfs(c) {
          if (path.length === n) return true;
          if (--budget < 0) return false;
          for (const m of adj.get(c)) {
            if (vis.has(m)) continue;
            vis.add(m); path.push(m);
            if (dfs(m)) return true;
            path.pop(); vis.delete(m);
          }
          return false;
        }
        return dfs(s) ? path : null;
      }
      for (const s of starts) { const p = ham(s); if (p) return p; }
      return null;
    }

    // ---- keeps an ordered model of the snake between frames ---------------
    class Tracker {
      constructor(cols, rows) { this.cols = cols; this.rows = rows; this.reset(); }
      reset() { this.body = null; this.startLen = 0; this.maxLen = 0; this.heading = -1; }
      adj(a, b) {
        const c = this.cols;
        return Math.abs((a % c) - (b % c)) + Math.abs(((a / c) | 0) - ((b / c) | 0)) === 1;
      }
      setHeading() {
        if (this.body.length > 1) {
          const h = this.body[0], s = this.body[1];
          for (let d = 0; d < 4; d++) if (nbr(s, d, this.cols, this.rows) === h) { this.heading = d; return; }
        }
      }
      resync(S, headHint) {
        const ord = orderCells(S, this.cols, this.rows, this.body[0], headHint >= 0 ? headHint : null);
        if (!ord) return 'lost';
        this.body = ord;
        this.maxLen = Math.max(this.maxLen, ord.length);
        this.setHeading();
        return 'resync';
      }
      update(S, headHint) {
        if (headHint == null) headHint = -1;
        if (!this.body) {
          const ord = orderCells(S, this.cols, this.rows, null, headHint >= 0 ? headHint : null);
          if (!ord) return 'lost';
          this.body = ord; this.startLen = this.maxLen = ord.length;
          this.setHeading();
          return 'init';
        }
        const body = this.body, len = body.length;
        if (S.length < len) return 'shrunk';
        const sset = new Set(S), bset = new Set(body);
        // the eyes tell us where the head is: try "head advanced one cell" (with or without growth)
        if (headHint >= 0 && headHint !== body[0] && this.adj(body[0], headHint)) {
          for (const keep of [len - 1, len]) {
            const nbody = [headHint].concat(body.slice(0, keep));
            if (nbody.length === S.length && nbody.every(c => sset.has(c)) && new Set(nbody).size === nbody.length) {
              this.body = nbody;
              this.maxLen = Math.max(this.maxLen, nbody.length);
              this.setHeading();
              return 'moved';
            }
          }
        }
        const fresh = S.filter(c => !bset.has(c));
        const gone = body.filter(c => !sset.has(c));
        if (!fresh.length && !gone.length && S.length === len) {
          if (headHint < 0 || headHint === body[0]) return 'same';
          return this.resync(S, headHint);        // e.g. head slid into the cell the tail just left
        }
        if (headHint >= 0 && headHint !== body[0] && !(fresh.length === 1 && fresh[0] === headHint)) return this.resync(S, headHint);
        if (fresh.length === 1 && this.adj(body[0], fresh[0])) {
          if (S.length === len + 1 && !gone.length) this.body = [fresh[0]].concat(body);
          else if (S.length === len && gone.length === 1 && gone[0] === body[len - 1])
            this.body = [fresh[0]].concat(body.slice(0, len - 1));
          else return this.resync(S, headHint);
          this.maxLen = Math.max(this.maxLen, this.body.length);
          this.setHeading();
          return 'moved';
        }
        return this.resync(S, headHint);
      }
    }

    // ---- path planning ----------------------------------------------------
    // Returns direction index 0..3 (up,right,down,left) or -1 if no legal move.
    // walls  = optional Uint8Array of static obstacle cells (treated like the border)
    // heading = direction the snake is currently travelling (-1 unknown)
    //
    // Enhanced A* with Dijkstra routing: searches over (cell, direction) states with
    // thorough safety penalties for walls, forced turns, and near-misses collisions.
    // The bot plans into the future by checking slack (free cells straight ahead) and
    // strongly penalizes paths that get trapped near walls or its own tail.
    // opts (optional): { forced, win, detour, edge, caution } - safety tuning
    function plan(body, apple, cols, rows, walls, heading, opts) {
      const n = cols * rows, len = body.length, head = body[0];
      opts = opts || {};
      if (heading == null) heading = -1;
      const occ = new Int16Array(n).fill(-1);
      for (let i = 0; i < len; i++) occ[body[i]] = i;
      const nb = (c, d) => { const m = nbr(c, d, cols, rows); return (m >= 0 && walls && walls[m]) ? -1 : m; };
      // Current reachable free space (used to stop the snake gradually squeezing itself into
      // a checkmate).  floodArea is hoisted, so this is safe here.
      const areaNow = floodArea(body);
      const FORCED = opts.forced || 100;       // penalty for forced turns (was 80)
      const WIN = opts.win || 5;               // how many cells ahead to check for slack
      const DETOUR = opts.detour != null ? opts.detour : 4; // max detour length to prefer shorter path
      const CAUTION = opts.caution != null ? opts.caution : 2; // safety caution multiplier
      // NOTE: 0 by default - a route that actually reaches the apple IS allowed to travel on
      // wall-adjacent rows/columns (the user wants those apples).  What protects us instead is
      // the forced-turn/slack penalty, which makes the snake leave a wall row early when a
      // corner or a dead end is coming up.  The fallback (no apple route) still punishes
      // wall-hugging hard, because there is no reward there.
      const EDGE = opts.edge != null ? opts.edge : 0;            // extra penalty for border cells

      // plain shortest (timed BFS) path to goal; body segment i frees up after (len - i) moves
      function bfsTimed(goal) {
        const prev = new Int16Array(n).fill(-2), dist = new Int16Array(n).fill(-1);
        const q = [head]; dist[head] = 0; prev[head] = -1;
        for (let qi = 0; qi < q.length; qi++) {
          const c = q[qi];
          if (c === goal) break;
          for (let d = 0; d < 4; d++) {
            // never allow the first move to reverse into our own neck
            if (c === head && heading >= 0 && len > 1 && d === ((heading + 2) & 3)) continue;
            const m = nb(c, d);
            if (m < 0 || dist[m] >= 0) continue;
            const nd = dist[c] + 1, o = occ[m];
            if (o >= 0 && nd < len - o) continue;
            dist[m] = nd; prev[m] = c; q.push(m);
          }
        }
        if (dist[goal] < 0) return null;
        const path = [];
        for (let c = goal; c !== head; c = prev[c]) path.push(c);
        return path.reverse();
      }

      // ---- enhanced slack check: how many free cells straight ahead? ---------
      const calcSlack = (c, d, st) => {
        let m = c, k = 0;
        for (; k < WIN; k++) {
          m = nb(m, d);
          if (m < 0) break;
          if (occ[m] >= 0 && st + 1 + k < len - occ[m]) break;
        }
        return k;
      };

      // ---- enhanced safe path: A* / Dijkstra with strong safety penalties -----
      const SAFE_COST = 1 << 20;                 // infinity approximation
      const STEP = 1, TURN = 15 * CAUTION, FORCED_PENALTY = 200 * CAUTION;
      function safePath(goal) {
        if (goal < 0) return null;
        const N = n * 5;
        const cost = new Int32Array(N).fill(SAFE_COST), steps = new Int16Array(N), prev = new Int32Array(N).fill(-1);
        const hc = [], hn = [];
        const push = (c, v) => {
          let i = hc.length; hc.push(c); hn.push(v);
          while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= c) break; hc[i] = hc[p]; hn[i] = hn[p]; i = p; }
          hc[i] = c; hn[i] = v;
        };
        const pop = () => {
          const tc = hc[0], tn = hn[0], lc = hc.pop(), ln = hn.pop(), sz = hc.length;
          if (sz > 0) {
            let i = 0;
            for (;;) {
              let l = 2 * i + 1; if (l >= sz) break;
              if (l + 1 < sz && hc[l + 1] < hc[l]) l++;
              if (hc[l] >= lc) break;
              hc[i] = hc[l]; hn[i] = hn[l]; i = l;
            }
            hc[i] = lc; hn[i] = ln;
          }
          return [tc, tn];
        };
        const start = head * 5 + (heading >= 0 ? heading : 4);
        cost[start] = 0; push(0, start);
        let goalNode = -1;
        while (hc.length) {
          const [cst, v] = pop();
          if (cst > cost[v]) continue;
          const c = (v / 5) | 0, a = v - c * 5, st = steps[v];
          if (c === goal && v !== start) { goalNode = v; break; }
          for (let d = 0; d < 4; d++) {
            if (a < 4 && d === ((a + 2) & 3)) continue; // no U-turns
            const m = nb(c, d);
            if (m < 0) continue;
            if (a === 4 && len > 1 && m === body[1]) continue;
            const ns = st + 1, o = occ[m];
            if (o >= 0 && ns < len - o) continue;
            let add = STEP;
            // --- border penalty (0 by default; a route to the apple may hug wall rows) ---
            const mx = m % cols, my = (m / cols) | 0;
            if (mx === 0 || my === 0 || mx === cols - 1 || my === rows - 1) add += EDGE;
            // --- Strong wall penalty: don't step on walls ---
            if (walls && walls[m]) { add += 5000; continue; } // instant death penalty
            // --- Wall straight ahead: we will have to turn next tick.  Penalise it so the
            //     snake turns EARLY while it still has slack (this is what stops wall deaths).
            const ahead1 = nbr(m, a, cols, rows);
            if (ahead1 < 0) add += 900;
            else if (walls && walls[ahead1]) add += 700;
            // --- Self-avoidance: keep breathing room from our own body ---
            //     Cells that vacate within the next two moves don't count (tail following is safe).
            let near = 0;
            for (let dd = 0; dd < 4; dd++) {
              const am = nbr(m, dd, cols, rows);
              if (am < 0) continue;
              const oo = occ[am];
              if (oo >= 0 && oo < len - 2) near++;
            }
            add += near * 80 * CAUTION;
            // --- Turning penalty with forced-turn detection ---
            if (a < 4 && d !== a) {
              const slack = calcSlack(c, a, st);
              add += TURN + (slack >= WIN ? 0 : FORCED_PENALTY >> Math.max(0, slack));
            }
            // --- Apple cell must be left safely next step ---
            if (m === goal) add += slackPen(m, d, ns);
            // --- Self-avoidance: penalty for entering a cell the tail will occupy soon ---
            const tailFuture = occ[m];
            if (tailFuture >= 0 && tailFuture < len) {
              // the body segment will move forward; check if we'd trap ourselves
              add += 200; // mild penalty for occupying soon-freed cell
            }
            const nv = m * 5 + d, nc = cst + add;
            if (nc < cost[nv]) { cost[nv] = nc; steps[nv] = ns; prev[nv] = v; push(nc, nv); }
          }
        }
        if (goalNode < 0) return null;
        const path = [];
        for (let v = goalNode; v !== start; v = prev[v]) path.push((v / 5) | 0);
        return path.reverse();
      }

      function slackPen(c, a, st) {
        let m = c, k = 0;
        for (; k < WIN; k++) {
          m = nb(m, a);
          if (m < 0 || (occ[m] >= 0 && st + 1 + k < len - occ[m])) break;
        }
        return k >= WIN ? 0 : (FORCED_PENALTY >> k);
      }

      // ---- distance from newBody's head to its own tail through free cells ----
      function distToTail(nbody) {
        const blocked = new Uint8Array(n);
        for (const c of nbody) blocked[c] = 1;
        const goal = nbody[nbody.length - 1];
        const dist = new Int16Array(n).fill(-1);
        const q = [nbody[0]]; dist[nbody[0]] = 0;
        for (let qi = 0; qi < q.length; qi++) {
          const c = q[qi];
          for (let d = 0; d < 4; d++) {
            const m = nb(c, d);
            if (m < 0 || dist[m] >= 0) continue;
            if (m === goal) return dist[c] + 1;
            if (blocked[m]) continue;
            dist[m] = dist[c] + 1; q.push(m);
          }
        }
        return -1;
      }

      function floodArea(nbody) {
        const blocked = new Uint8Array(n);
        for (const c of nbody) blocked[c] = 1;
        const seen = new Uint8Array(n);
        const q = [nbody[0]]; seen[nbody[0]] = 1;
        let cnt = 0;
        for (let qi = 0; qi < q.length; qi++) {
          const c = q[qi];
          for (let d = 0; d < 4; d++) {
            const m = nb(c, d);
            if (m < 0 || seen[m] || blocked[m]) continue;
            seen[m] = 1; cnt++; q.push(m);
          }
        }
        return cnt;
      }

      const dirTo = (from, to) => { for (let d = 0; d < 4; d++) if (nb(from, d) === to) return d; return -1; };

      // =====================================================================
      //  TAIL PREDICTION
      //  The snake moves like a train: every step the head takes a new cell and the
      //  tail frees one.  The segment currently at body index `o` is gone after
      //  (len - o) moves, so the tail walks along body[len-1], body[len-2], body[len-3]...
      //  These helpers answer "will this cell still be occupied when we arrive?".
      // =====================================================================

      // Whole-route simulation with a REAL moving body.  The tail advances one segment
      // per step, so cells that are body right now are allowed IF the tail has vacated
      // them by the time the head gets there.  Growth happens only on the final step
      // (routes end on the apple), so the tail holds still there.
      function walkSafe(path) {
        const sim = body.slice();
        const L = sim.length;
        if (!L) return false;
        for (let s = 0; s < path.length; s++) {
          const to = path[s];
          if (to < 0 || (walls && walls[to])) return false;
          const h = sim[0];
          if (Math.abs((h % cols) - (to % cols)) + Math.abs(((h / cols) | 0) - ((to / cols) | 0)) !== 1) return false;
          const lastStep = s === path.length - 1;      // eating: tail does not move
          const limit = lastStep ? L : L - 1;          // on normal steps the tail cell is free
          for (let j = 0; j < limit; j++) if (sim[j] === to) return false;
          sim.unshift(to);
          if (!lastStep) sim.pop();
        }
        return true;
      }

      // 1) path to the apple (turn-early version first, plain shortest as backup),
      //    but only if the snake can still reach its tail afterwards
      if (apple >= 0) {
        const sp = safePath(apple), bp = bfsTimed(apple);
        // don't accept a long detour for the sake of safety margin
        const order = (sp && bp && sp.length > bp.length + DETOUR) ? [bp, sp] : [sp, bp];
        for (const path of order) {
          if (path && path.length) {
            // ---- exact tail-prediction route check ----
            // Walk the whole route with the body advancing step by step; reject it if any
            // step would land on a segment that the predicted tail has not vacated yet.
            if (!walkSafe(path)) continue;
            // ---- immediate-step safety (also stops "runs into itself") ----
            // Simulate ONLY the very next move and require that we can still reach our tail
            // and that the region we can reach is not a cramped pocket.
            const first = path[0];
            const step1 = [first].concat(body.slice(0, Math.max(0, len - 1)));
            const need1 = Math.ceil((n - step1.length) * 0.5);
            if (distToTail(step1) < 0 || floodArea(step1) < need1) continue;
            const nbody = path.slice().reverse().concat(body).slice(0, len + 1);
            // Accept only if (a) we can still reach our own tail afterwards and (b) we can
            // reach at least half of the remaining free space (scales with snake length -
            // a fixed "area >= len" check becomes impossible once the snake fills half the
            // board and would silently disable all apple routing in the late game).
            const need = Math.ceil((n - nbody.length) * 0.5);
            if (distToTail(nbody) >= 0 && floodArea(nbody) >= need) {
              // In a crowded endgame, refuse routes that would visibly shrink the reachable
              // area - that is how the snake ends up trapping itself later.
              const crowded = len > n * 0.45;
              if (!crowded || floodArea(nbody) >= areaNow - 1) return dirTo(head, first);
            }
          }
        }
      }

      // 2) No complete route to the apple (body temporarily in the way, or apple boxed in).
      //    Pick the move that keeps the most room and heads toward the apple, and PUNISH any
      //    move that risks death without a reward.  Riding a wall-adjacent row is allowed when
      //    it closes the distance to the apple; wall-hugging with nothing to gain is not.
      const manh = (a, b) => Math.abs((a % cols) - (b % cols)) + Math.abs(((a / cols) | 0) - ((b / cols) | 0));
      const dApple = apple >= 0 ? manh(head, apple) : -1;
      let best = -1, bestScore = -1e9;
      for (let d = 0; d < 4; d++) {
        const m = nb(head, d);
        if (m < 0 || m === body[1]) continue;              // wall/border or neck = instant death
        const o = occ[m];
        if (o >= 0 && o !== len - 1) continue;             // occupied body cell (not the tail) = death
        const grow = m === apple;
        const nbody = [m].concat(grow ? body : body.slice(0, len - 1));
        const dt = distToTail(nbody);
        const area = floodArea(nbody);
        const closer = apple >= 0 ? Math.max(0, dApple - manh(m, apple)) : 0;

        // ---- risk accounting -------------------------------------------------
        // Walls/borders touching the destination cell, and how dangerous that is.
        let wallAdj = 0, bodyAdj = 0;
        for (let dd = 0; dd < 4; dd++) {
          const am = nbr(m, dd, cols, rows);
          if (am < 0) { wallAdj++; continue; }
          if (walls && walls[am]) wallAdj++;
          const ob = occ[am];
          if (ob >= 0 && ob < len - 2) bodyAdj++;          // body that will NOT vacate soon
        }
        // With an apple in reach, hugging a wall row is cheap (that is how those apples are
        // reached).  With no reward it is expensive: punishing pointless risk is the point.
        let risk = (closer > 0 || grow ? wallAdj * 250 : wallAdj * 2500);
        risk += bodyAdj * 700;                             // self-collision danger
        if (dt < 0) risk += 60000;                         // cut off from our own tail
        // cramped pocket: compare against the free space that should still be there
        const freeAfter = n - nbody.length;
        if (area < freeAfter * 0.4) risk += (freeAfter * 0.4 - area) * 400;
        // never trade away reachable space for nothing (this is what eventually checkmates)
        if (area < areaNow - 1) risk += (areaNow - area - 1) * 500;
        if (o >= 0 && o === len - 1) risk += 120;          // tail cell: legal but last-second

        // ---- reward ----------------------------------------------------------
        const reward = (grow ? 8000 : 0) + closer * 90 + area * 0.5;

        const base = dt >= 0 ? 100000 + dt * 10 : 0;
        const score = base + reward - risk;
        if (score > bestScore) { bestScore = score; best = d; }
      }
      return best;
    }

    return { DIRS, nbr, detectBoard, readGrid, headEntering, orderCells, Tracker, plan };
  })();

  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
  if (window.__snakeBotLoaded) { console.log('[snakeBot] already running'); return; }
  window.__snakeBotLoaded = true;

  // =========================================================================
  //  BROWSER PART  (canvas reading, key presses, restart, stats, panel)
  // =========================================================================
  const KEYS = [
    { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ];
  const SPACE = { key: ' ', code: 'Space', keyCode: 32 };
  const ENTER = { key: 'Enter', code: 'Enter', keyCode: 13 };

  function pressKey(spec) {
    const target = document.body;
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, {
        key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode,
        bubbles: true, cancelable: true,
      });
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => spec.keyCode });
        Object.defineProperty(ev, 'which', { get: () => spec.keyCode });
      } catch (e) { /* ignore */ }
      target.dispatchEvent(ev);
    }
  }

  // ---- stats -------------------------------------------------------------
  const STORE = 'gsnakebot.stats.v1';
  function freshStats() {
    return { runs: 0, apples: 0, best: 0, clears: 0, fastestClearMs: null, playMs: 0, scores: [], since: Date.now() };
  }
  function loadStats() {
    try { const s = JSON.parse(localStorage.getItem(STORE)); if (s && typeof s.runs === 'number') return s; } catch (e) { /* ignore */ }
    return freshStats();
  }
  function saveStats() { try { localStorage.setItem(STORE, JSON.stringify(stats)); } catch (e) { /* ignore */ } }
  let stats = loadStats();

  // ---- runtime state -----------------------------------------------------
  const S = {
    enabled: false, mode: 'SEARCH', msg: 'idle', error: '',
    board: null, boardT: 0, tracker: null, canvas: null,
    run: null, deadSet: null, lastMoveT: 0, tickMs: 0, lastKeyT: 0, lastRestartT: 0,
    restartTries: 0, shrunkFrames: 0, lastGrid: null, lastDir: -1, fps: 0, frames: 0, fpsT: performance.now(),
    curScore: 0, info: '',
    canvasT: 0, btnT: 0, playBtn: null, crop: null, cropBoard: null, earlyFrom: -1, earlyHead: -1, earlyDir: -1,
    wallHits: null, walls: null, wallMark: null, wallCount: 0,
    lastSentHead: -1, lastSentT: 0,
  };

  const tmp = document.createElement('canvas');
  const tmpCtx = tmp.getContext('2d', { willReadFrequently: true });

  function findCanvas(now) {
    if (S.canvas && S.canvas.isConnected && now - S.canvasT < 500) return S.canvas;   // no layout work every frame
    S.canvasT = now;
    let best = null, area = 0;
    for (const cv of document.querySelectorAll('canvas')) {
      if (cv === ui.dbg || cv === ui.spark) continue;
      const r = cv.getBoundingClientRect();
      if (r.width < 150 || r.height < 150) continue;
      const a = cv.width * cv.height;
      if (a > area) { area = a; best = cv; }
    }
    return best;
  }

  // Copies only `rect` (default: whole canvas) into a persistent scratch canvas.
  // (The old version resized the scratch canvas every frame, which reallocates it.)
  function readPixels(cv, rect) {
    const x = rect ? rect.x : 0, y = rect ? rect.y : 0;
    const w = rect ? rect.w : cv.width, h = rect ? rect.h : cv.height;
    if (w < 1 || h < 1) return null;
    if (tmp.width !== w || tmp.height !== h) { tmp.width = w; tmp.height = h; }
    tmpCtx.globalCompositeOperation = 'copy';
    tmpCtx.drawImage(cv, x, y, w, h, 0, 0, w, h);
    try { return tmpCtx.getImageData(0, 0, w, h); }
    catch (e) {
      S.error = 'Canvas is cross-origin tainted - pixels cannot be read (' + e.name + ').';
      return null;
    }
  }

  function sameSet(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    const s = new Set(a);
    for (const c of b) if (!s.has(c)) return false;
    return true;
  }

  // static obstacles: a cell counts as wall only after it was seen as wall a few frames in a row
  function updateWalls(list, n) {
    if (!S.wallHits || S.wallHits.length !== n) {
      S.wallHits = new Uint8Array(n); S.walls = new Uint8Array(n); S.wallMark = new Uint8Array(n); S.wallCount = 0;
    }
    const h = S.wallHits, mark = S.wallMark;
    mark.fill(0);
    for (const i of list) mark[i] = 1;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (mark[i]) { if (h[i] < 6) h[i]++; } else if (h[i] > 0) h[i]--;
      S.walls[i] = h[i] >= 3 ? 1 : 0;
      cnt += S.walls[i];
    }
    S.wallCount = cnt;
  }

  function beginRun(now) {
    S.run = { startLen: S.tracker.body.length, t0: 0, steps: 0 };
    S.earlyFrom = -1; S.earlyHead = -1; S.earlyDir = -1;
    S.mode = 'READY';
    S.lastKeyT = 0;
    S.msg = 'ready - sending first key';
  }

  function finishRun(now, why) {
    const body = S.tracker.body;
    const score = body ? body.length - S.run.startLen : 0;
    const dur = S.run.t0 ? Math.max(0, S.lastMoveT - S.run.t0) : 0;
    stats.runs++;
    stats.apples += score;
    stats.playMs += dur;
    if (score > stats.best) stats.best = score;
    stats.scores.push(score);
    if (stats.scores.length > 300) stats.scores.shift();
    if (why === 'clear') {
      stats.clears++;
      if (stats.fastestClearMs == null || dur < stats.fastestClearMs) stats.fastestClearMs = dur;
    }
    saveStats();
    S.deadSet = S.lastGrid ? S.lastGrid.snake.slice() : null;
    S.mode = 'DEAD';
    S.restartTries = 0;
    S.lastRestartT = 0;
    S.msg = (why === 'clear' ? 'FULL CLEAR' : 'died') + ' - score ' + score;
    if (CONFIG.maxRuns && stats.runs >= CONFIG.maxRuns) { S.enabled = false; S.msg = 'reached maxRuns'; }
  }

  // ---- "Play" button detection --------------------------------------------
  const PLAY_RE = /^\s*(play|play again|replay|restart|try again|new game)\s*$/i;

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t;
  }

  // broad=false: only real buttons (cheap, safe to run while playing).
  // broad=true : any element (slow-ish - only used when the game is stopped).
  // Uses textContent (never innerText: that forces a layout and can stall the game).
  function findPlayButton(broad) {
    const nodes = document.querySelectorAll(broad ? 'button,[role="button"],[aria-label],[jsaction],div,span' : 'button,[role="button"]');
    let loose = null;
    for (const el of nodes) {
      const aria = el.getAttribute('aria-label') || '';
      let ok = PLAY_RE.test(aria);
      if (!ok && el.childElementCount <= 3) {
        const t = el.textContent || '';
        if (t.length <= 30) ok = PLAY_RE.test(t) || PLAY_RE.test(ownText(el));
      }
      if (!ok || el.closest('#gsb-panel')) continue;
      const target = el.closest('button,[role="button"]') || el;
      if (!isVisible(target)) continue;
      if (target.matches('button,[role="button"]')) return target;
      if (!loose) loose = target;
    }
    return loose;
  }

  function clickElement(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try {
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
      }
    } catch (e) { /* ignore */ }
    el.click();
  }

  function attemptRestart(now) {
    if (!CONFIG.autoRestart || now - S.lastRestartT < 500) return;
    S.lastRestartT = now;
    S.restartTries++;
    const btn = findPlayButton(true);
    if (btn) clickElement(btn);
    else pressKey(S.restartTries % 2 ? SPACE : ENTER);   // fall back to keyboard
    S.msg = 'restarting (try ' + S.restartTries + (btn ? ', clicked Play' : ', keys') + ')';
    if (S.restartTries > 8) S.msg = 'cannot restart automatically - click Play yourself';
  }

  // Independent watcher: whenever the bot is on and a visible Play button shows up
  // (game-over screen OR start screen), click it.  It never touches the page while
  // the snake is visibly moving, so it cannot cost the bot any frames mid-game.
  let lastPlayClickT = 0, lastBroadT = 0;
  function watchPlayButton() {
    if (!S.enabled || !CONFIG.autoRestart) return;
    const now = performance.now();
    if (now - lastPlayClickT < 400) return;
    if (S.mode === 'PLAY' && now - S.lastMoveT < Math.max(150, (S.tickMs || 120) * 2)) return;
    let btn = S.playBtn && S.playBtn.isConnected ? S.playBtn : findPlayButton(false);
    if (!btn && (S.mode === 'DEAD' || now - S.lastMoveT > 800) && now - lastBroadT > 1000) {
      lastBroadT = now;
      btn = findPlayButton(true);
    }
    if (!btn) return;
    lastPlayClickT = now;
    clickElement(btn);
    S.msg = 'clicked Play';
  }

  // Directions that reverse the snake are lethal in Google Snake: pressing them makes the
  // head turn straight into the neck.  Guard here too (not only in the planner) so a
  // bad/stale tracker heading can never send us into our own body.
  function isReverse(d) {
    const t = S.tracker;
    return !!(t && t.body && t.body.length > 1 && t.heading >= 0 && d === ((t.heading + 2) & 3));
  }

  function sendDir(d, force) {
    if (d < 0) return;
    if (isReverse(d)) return;
    if (!force && d === S.tracker.heading) return;
    pressKey(KEYS[d]);
    S.lastKeyT = performance.now();
    S.lastDir = d;
    S.lastSentDir = d;
    S.lastSentT = S.lastKeyT;
    S.lastSentHead = S.tracker && S.tracker.body ? S.tracker.body[0] : -1;
  }

  function cropFor(b, cv) {
    const x = Math.max(0, Math.floor(b.minX)), y = Math.max(0, Math.floor(b.minY));
    const w = Math.min(cv.width - x, Math.ceil(b.cols * b.cellX) + 1), h = Math.min(cv.height - y, Math.ceil(b.rows * b.cellY) + 1);
    return { x, y, w, h };
  }

  function step() {
    if (!S.enabled) return;
    const now = performance.now();
    S.frames++;
    if (now - S.fpsT > 1000) { S.fps = S.frames; S.frames = 0; S.fpsT = now; }
    S.error = '';
    const cv = findCanvas(now);
    if (!cv) { S.mode = 'SEARCH'; S.msg = 'no game canvas - search "snake game"'; return; }
    S.canvas = cv;
    if (now - S.btnT > 60) { S.btnT = now; S.playBtn = findPlayButton(false); }

    // full-canvas read only to (re)detect the board; normal frames read just the board area
    const needDetect = !S.board || S.board.W !== cv.width || S.board.H !== cv.height ||
      (S.mode !== 'PLAY' && now - S.boardT > 1500);
    let img, BL;
    if (needDetect) {
      img = readPixels(cv, null);
      if (!img) return;
      const b = Core.detectBoard(img.data, img.width, img.height, CONFIG, S.board);
      S.boardT = now;
      if (!b) { S.msg = 'board not detected (try DEBUG)'; return; }
      if (!S.board || b.cols !== S.board.cols || b.rows !== S.board.rows) { S.tracker = new Core.Tracker(b.cols, b.rows); S.wallHits = null; S.walls = null; }
      S.board = b;
      S.crop = cropFor(b, cv);
      S.cropBoard = Object.assign({}, b, { minX: b.minX - S.crop.x, minY: b.minY - S.crop.y, W: S.crop.w, H: S.crop.h });
      BL = b;
    } else {
      img = readPixels(cv, S.crop);
      if (!img) return;
      BL = S.cropBoard;
    }
    const B = S.board;
    const g = Core.readGrid(img.data, img.width, BL);
    S.lastGrid = g;
    updateWalls(g.walls, B.cols * B.rows);
    S.info = 'canvas ' + cv.width + 'x' + cv.height + ' | grid ' + B.cols + 'x' + B.rows +
      ' | cell ' + B.cellX.toFixed(1) + 'px | obstacles ' + S.wallCount;

    // adaptive timers: scale with the measured game speed instead of a fixed 1.1 s
    const stallMs = Math.max(400, Math.min(CONFIG.deadTimeoutMs, (S.tickMs || 120) * 5));

    // fastest death signal: the Play button appeared while the snake stopped moving
    if (S.mode === 'PLAY' && S.run && S.run.steps > 3 && S.playBtn && S.playBtn.isConnected &&
        now - S.lastMoveT > Math.max(120, (S.tickMs || 120) * 1.5)) {
      finishRun(now, 'died');
      return;
    }

    if (!g.snake.length) {
      if (S.mode === 'PLAY' && now - S.lastMoveT > stallMs) finishRun(now, 'died');
      return;
    }
    const T = S.tracker;
    const apple = g.apple >= 0 ? g.apple : (S.lastApple != null ? S.lastApple : -1);
    if (g.apple >= 0) S.lastApple = g.apple;

    if (S.mode === 'DEAD') {
      if (sameSet(g.snake, S.deadSet)) { attemptRestart(now); return; }
      T.reset(); S.mode = 'SEARCH'; S.lastApple = null;
    }
    if (S.mode === 'SEARCH') {
      if (T.update(g.snake, g.head) === 'init') beginRun(now); else return;
    }

    // EARLY REACTION (two triggers, both aim to get the key in within ~50-150 ms):
    //  (a) the cell straight ahead is DEADLY -> plan the turn immediately.  Waiting for the
    //      cell centre here is what used to cause wall/self deaths.
    //  (b) the head is already poking into the next cell -> plan one tick early.
    // Tail prediction: the CURRENT TAIL cell is not deadly - it vacates exactly one move
    // from now, so the snake may keep following it ("if it isn't blocking, keep going").
    // Never early-plan INTO the apple cell: eating changes the board, so that waits for the
    // normal path.  Runs at most once per head cell (S.earlyFrom guard).
    if (S.mode === 'PLAY' && T.body && T.heading >= 0 && S.earlyFrom !== T.body[0]) {
      const Y = Core.nbr(T.body[0], T.heading, B.cols, B.rows);
      const tailNow = T.body[T.body.length - 1];
      const yBody = T.body.indexOf(Y);
      const deadly = Y < 0 || !!(S.walls && S.walls[Y]) || (yBody >= 0 && Y !== tailNow);
      if (deadly || (Y >= 0 && Y !== apple && Core.headEntering(img.data, img.width, BL, Y, T.heading))) {
        const nbody = deadly ? T.body.slice() : [Y].concat(T.body.slice(0, T.body.length - 1));
        const d = Core.plan(nbody, apple, B.cols, B.rows, S.walls, T.heading);
        S.earlyFrom = T.body[0]; S.earlyHead = Y; S.earlyDir = d;
        sendDir(d, false);
      }
    }

    const st = T.update(g.snake, g.head);
    if (st === 'shrunk') {
      if (++S.shrunkFrames >= 4) {                    // a brand-new game appeared
        S.shrunkFrames = 0;
        if (S.mode === 'PLAY') finishRun(now, 'died');
        T.reset(); S.mode = 'SEARCH';
      }
      return;
    }
    S.shrunkFrames = 0;
    S.curScore = T.body.length - S.run.startLen;

    if (st === 'same' || st === 'lost' || st === 'init') {
      if (S.mode === 'READY') {
        if (now - S.lastKeyT > 150) {
          sendDir(Core.plan(T.body, apple, B.cols, B.rows, S.walls, T.heading), true);
        }
      } else if (S.mode === 'PLAY' && now - S.lastMoveT > stallMs) {
        finishRun(now, 'died');
      }
      return;
    }

    // the head moved (or we re-synced after missing frames)
    if (S.mode === 'READY') { S.mode = 'PLAY'; S.run.t0 = now; S.msg = 'playing'; }
    else if (S.lastMoveT) {
      const dt = now - S.lastMoveT;
      if (dt < 1000) S.tickMs = S.tickMs ? S.tickMs * 0.9 + dt * 0.1 : dt;
    }
    S.lastMoveT = now;
    S.run.steps++;
    if (T.body.length >= B.cols * B.rows) { finishRun(now, 'clear'); return; }
    const nd = Core.plan(T.body, apple, B.cols, B.rows, S.walls, T.heading);
    // Only send one key per game tick.  A second turn pressed mid-tick can be buffered by the
    // game and applied on a later tick, which is a classic way to turn into our own body.
    const alreadySent = S.lastSentHead === T.body[0] && S.lastSentT >= S.lastMoveT;
    if (!alreadySent && !(S.earlyHead === T.body[0] && S.earlyDir === nd)) sendDir(nd, false);
    S.earlyHead = -1;
  }

  // =========================================================================
  //  PANEL
  // =========================================================================
  const ui = {};
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function buildPanel() {
    const p = el('div', 'position:fixed;top:10px;right:10px;z-index:2147483647;width:250px;padding:10px 12px;' +
      'background:rgba(18,22,32,.94);color:#e6eaf2;font:12px/1.45 Consolas,Menlo,monospace;border-radius:10px;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.45);user-select:none');
    p.id = 'gsb-panel';
    p.appendChild(el('div', 'font-weight:bold;font-size:14px;color:#6ee7a0;margin-bottom:4px', 'SNAKE BOT'));
    ui.state = el('div', 'color:#ffd166;margin-bottom:4px');
    ui.live = el('div', 'font-size:13px;margin-bottom:6px');
    ui.stats = el('div', 'white-space:pre;margin-bottom:6px');
    ui.spark = document.createElement('canvas');
    ui.spark.width = 226; ui.spark.height = 36;
    ui.spark.style.cssText = 'display:block;width:226px;height:36px;margin-bottom:6px;background:#10131c;border-radius:4px';
    ui.info = el('div', 'color:#8a94a8;font-size:11px;margin-bottom:6px;white-space:pre-wrap');
    const row = el('div', 'display:flex;gap:5px;flex-wrap:wrap');
    const btn = (label, fn) => {
      const b = el('button', 'cursor:pointer;border:0;border-radius:5px;padding:4px 8px;background:#2b3550;color:#e6eaf2;font:inherit', label);
      b.addEventListener('click', fn); row.appendChild(b); return b;
    };
    ui.btnStart = btn('START', () => (S.enabled ? api.stop() : api.start()));
    ui.btnAuto = btn('AUTO-RESTART', () => { CONFIG.autoRestart = !CONFIG.autoRestart; });
    ui.btnDbg = btn('DEBUG', () => { CONFIG.debug = !CONFIG.debug; if (!CONFIG.debug) clearDebug(); });
    btn('RESET STATS', () => { if (confirm('Reset all counters?')) { stats = freshStats(); saveStats(); } });
    [ui.state, ui.live, ui.stats, ui.spark, ui.info, row].forEach(x => p.appendChild(x));
    p.appendChild(el('div', 'color:#6b7488;font-size:10px;margin-top:6px', 'Alt+B start/stop'));
    document.body.appendChild(p);
  }

  function fmtMs(ms) {
    if (ms == null) return '-';
    const s = ms / 1000, m = Math.floor(s / 60);
    return (m ? m + 'm ' : '') + (s - m * 60).toFixed(1) + 's';
  }

  function refreshPanel() {
    ui.btnStart.textContent = S.enabled ? 'STOP' : 'START';
    ui.btnStart.style.background = S.enabled ? '#7a2e3a' : '#2b6a4a';
    ui.btnAuto.style.background = CONFIG.autoRestart ? '#2b6a4a' : '#2b3550';
    ui.btnDbg.style.background = CONFIG.debug ? '#2b6a4a' : '#2b3550';
    ui.state.textContent = (S.enabled ? S.mode : 'OFF') + ' - ' + S.msg;
    const n = S.board ? S.board.cols * S.board.rows : 0;
    ui.live.textContent = 'score ' + (S.mode === 'PLAY' || S.mode === 'READY' ? S.curScore : '-') +
      (n ? ' / ' + (n - (S.run ? S.run.startLen : 0)) : '') + '   steps ' + (S.run ? S.run.steps : 0);
    const sc = stats.scores, last = sc.slice(-20);
    const avg = stats.runs ? stats.apples / stats.runs : 0;
    const avg20 = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0;
    const apm = stats.playMs > 0 ? stats.apples / (stats.playMs / 60000) : 0;
    ui.stats.textContent =
      'runs        ' + stats.runs + '\n' +
      'best        ' + stats.best + '\n' +
      'average     ' + avg.toFixed(1) + '  (last20 ' + avg20.toFixed(1) + ')\n' +
      'apples      ' + stats.apples + '  (' + apm.toFixed(0) + '/min)\n' +
      'full clears ' + stats.clears + '  fastest ' + fmtMs(stats.fastestClearMs) + '\n' +
      'last scores ' + sc.slice(-6).join(' ');
    ui.info.textContent = (S.error ? 'ERROR: ' + S.error + '\n' : '') + S.info +
      (S.tickMs ? '\ngame tick ~' + S.tickMs.toFixed(0) + 'ms | reads/s ' + S.fps : '');
    // sparkline of recent scores
    const c = ui.spark.getContext('2d'), w = ui.spark.width, h = ui.spark.height;
    c.clearRect(0, 0, w, h);
    const arr = sc.slice(-40), mx = Math.max(1, ...arr);
    const bw = w / 40;
    arr.forEach((v, i) => {
      c.fillStyle = v === stats.best ? '#ffd166' : '#6ee7a0';
      const bh = Math.max(1, (v / mx) * (h - 4));
      c.fillRect(i * bw + 1, h - bh - 1, bw - 2, bh);
    });
  }

  // ---- debug overlay -----------------------------------------------------
  function clearDebug() { if (ui.dbg) ui.dbg.style.display = 'none'; }
  function drawDebug() {
    if (!CONFIG.debug || !S.canvas || !S.board || !S.lastGrid) { clearDebug(); return; }
    if (!ui.dbg) {
      ui.dbg = document.createElement('canvas');
      ui.dbg.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646';
      document.body.appendChild(ui.dbg);
    }
    const cv = S.canvas, r = cv.getBoundingClientRect(), B = S.board;
    ui.dbg.style.display = 'block';
    ui.dbg.style.left = r.left + 'px'; ui.dbg.style.top = r.top + 'px';
    ui.dbg.style.width = r.width + 'px'; ui.dbg.style.height = r.height + 'px';
    ui.dbg.width = cv.width; ui.dbg.height = cv.height;
    const c = ui.dbg.getContext('2d');
    c.strokeStyle = 'rgba(255,0,255,.8)'; c.lineWidth = 1;
    for (let i = 0; i <= B.cols; i++) { c.beginPath(); c.moveTo(B.minX + i * B.cellX, B.minY); c.lineTo(B.minX + i * B.cellX, B.minY + B.rows * B.cellY); c.stroke(); }
    for (let j = 0; j <= B.rows; j++) { c.beginPath(); c.moveTo(B.minX, B.minY + j * B.cellY); c.lineTo(B.minX + B.cols * B.cellX, B.minY + j * B.cellY); c.stroke(); }
    const cx = i => B.minX + ((i % B.cols) + 0.5) * B.cellX, cy = i => B.minY + (((i / B.cols) | 0) + 0.5) * B.cellY;
    c.fillStyle = 'rgba(255,255,0,.85)';
    for (const i of S.lastGrid.snake) c.fillRect(cx(i) - 4, cy(i) - 4, 8, 8);
    if (S.walls) { c.fillStyle = 'rgba(255,0,0,.8)'; for (let i = 0; i < S.walls.length; i++) if (S.walls[i]) c.fillRect(cx(i) - 6, cy(i) - 6, 12, 12); }
    if (S.lastGrid.apple >= 0) { c.fillStyle = 'rgba(0,255,255,.9)'; c.beginPath(); c.arc(cx(S.lastGrid.apple), cy(S.lastGrid.apple), 7, 0, 7); c.fill(); }
    if (S.tracker && S.tracker.body) { c.fillStyle = '#fff'; c.beginPath(); c.arc(cx(S.tracker.body[0]), cy(S.tracker.body[0]), 5, 0, 7); c.fill(); }
  }

  // =========================================================================
  //  start-up
  // =========================================================================
  const api = {
    start() { S.enabled = true; S.mode = 'SEARCH'; S.msg = 'looking for the game...'; S.tracker = null; S.board = null; S.lastApple = null; S.wallHits = null; S.walls = null; },
    stop() { S.enabled = false; S.msg = 'stopped'; },
    stats() { return stats; },
    config: CONFIG,
  };
  window.snakeBot = api;

  buildPanel();
  // fast self-scheduling loop: reads as soon as the previous step is done (MessageChannel has no
  // 4 ms timer clamp); idles slowly when the bot is off or the game is not running.
  const chan = new MessageChannel();
  function loop() {
    if (document.hidden) { setTimeout(loop, 250); return; }
    const t0 = performance.now();
    try { step(); } catch (e) { S.error = 'step: ' + (e && e.message); }
    const active = S.enabled && (S.mode === 'PLAY' || S.mode === 'READY');
    const target = !S.enabled ? 150 : active ? CONFIG.readIntervalMs : Math.max(30, CONFIG.readIntervalMs);
    const wait = target - (performance.now() - t0);
    if (wait >= 2) setTimeout(loop, wait); else chan.port2.postMessage(0);
  }
  chan.port1.onmessage = loop;
  loop();
  setInterval(watchPlayButton, 100);
  setInterval(() => { refreshPanel(); drawDebug(); }, 250);
  window.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'b' || e.key === 'B')) { S.enabled ? api.stop() : api.start(); e.preventDefault(); }
  });
  console.log('[snakeBot] ready - click START or press Alt+B');
})();
