# Contributing

Thanks for taking a look. This project is deliberately small and dependency-free; the goal is to
keep it that way.

---

## Ground rules

1. **One file.** The bot must remain a single installable userscript
   (`google_snake_bot_user.js`). No bundler, no modules, no `@require`.
2. **No dependencies.** Runtime and tests use only the browser and the Node standard library.
3. **Safety beats score.** A change that raises the average but introduces a wall/self death is a
   regression. Deaths are absolute in the test suite.
4. **Every behaviour change needs a test.** Planner changes go in `tests/planner.test.js` (and
   ideally a full game in `tests/game.test.js`). Vision changes go in `tests/vision.test.js`.
5. **Keep the browser half out of Node.** `Core` must stay pure and exported; the early
   `module.exports` return must remain before any DOM access.

---

## Setup

```bash
git clone https://github.com/KairosMakki/SnakeBot.git
cd SnakeBot
npm test        # no npm install needed
```

Requirements: Node 18+ and a browser for manual testing. There is nothing else to install.

---

## Project layout

```text
google_snake_bot_user.js   the entire bot (Core + browser half)
tests/                     Node test suite (node:test)
docs/                      architecture, planner, configuration, testing, troubleshooting, FAQ
.github/workflows/         CI and release
```

Read these before changing the planner:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data flow and state machine.
- [docs/PLANNER.md](docs/PLANNER.md) — every cost term and safety gate.
- [docs/TESTING.md](docs/TESTING.md) — harness API and how to run longer experiments.

---

## Style

- **2-space indentation**, semicolons, single quotes in JavaScript.
- ES2019-compatible syntax. No optional chaining/nullish coalescing in the userscript (older
  browser support is cheap to keep).
- Small, named helpers over clever one-liners. The planner is read by humans.
- Comments explain **why**, not what. Every non-obvious constant should have a reason.
- Keep the `Core` section free of DOM, `window`, `document`, `performance` and `localStorage`.
- Prefer `Int16Array`/`Uint8Array` scratch arrays over object maps in hot paths.
- Never silence an error without a comment (there are intentionally empty `catch` blocks for
  storage/security failures).

The test files use `node:test` + `node:assert/strict` and 2-space indentation as well.

---

## Testing your change

```bash
npm test                 # must be green
npm run bench            # sanity-check planner cost and score
node tests/helpers/longrun.js 120 5000 0   # longer comparison, same seeds
```

For a tuning change:

1. Run the long runner on the **current** code and note average, best, deaths, checkmates.
2. Apply the change.
3. Run it again with the same seeds.
4. Compare deaths first, then checkmates, then average. Report the numbers in the PR.

For a vision change:

1. Update the synthetic colours in `tests/vision.test.js` if the palette changed.
2. Add a rendering case for the new situation (edge apple, obstacle, occluded edge, …).
3. Manual smoke test with `snakeBot.config.debug = true`.

For a browser-loop change (keys, restart, stats):

1. Test in Chrome and Firefox if possible.
2. Confirm one key per tick still holds (`lastSentHead`/`lastSentT`).
3. Confirm reverse keys are still blocked.
4. Watch a real game for at least 20 apples and one death/restart cycle.

---

## Commit messages

Short imperative subject, optionally a body explaining the trade-off:

```text
planner: reject routes that shrink the reachable area

Late games were sealing themselves off one cell at a time. Compare floodArea
before/after the route and refuse area loss above 45% occupancy.

120-game A/B: avg 147.2 -> 151.0, checkmates 2 -> 3, deaths 0 -> 0.
```

Reference an issue when relevant (`Fixes #12`).

---

## Pull request checklist

- [ ] `npm test` passes on Node 18+.
- [ ] `node --check google_snake_bot_user.js` passes.
- [ ] New behaviour has a test (planner/vision/game).
- [ ] `@version` and `package.json` version are in sync.
- [ ] `CHANGELOG.md` updated for user-visible changes.
- [ ] Docs updated if config, behaviour or limitations changed.
- [ ] No new dependency, no `@require`, no network call.
- [ ] No `debugger`, no leftover `console.log` noise.
- [ ] Manual browser check done (describe what you saw).

---

## Release checklist

1. Update the version in **both** places:
   - `// @version` in `google_snake_bot_user.js`
   - `"version"` in `package.json`
2. Update `CHANGELOG.md`.
3. `npm test`.
4. Commit: `release: vX.Y.Z`.
5. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

6. The `Release` workflow verifies the tag matches the userscript version, runs the tests and
   publishes a GitHub release with `google_snake_bot_user.js` attached.

The version comparison normalises missing components, so `v1.4.0` matches `@version 1.4`.

---

## Reporting bugs

Open an issue with:

- the panel's state line + info line,
- browser and OS,
- game mode/speed/skin,
- whether the DEBUG overlay aligned with the board,
- a screen recording for timing issues,
- for planner bugs, the failing seed printed by `npm test`.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#reporting-a-bug) for the full list.

---

## Ideas that are welcome

- A board-wide endgame strategy (Hamiltonian path / perfect matching) to remove the last checkmates.
- Portal-mode support (teleport edges in the planner).
- A DOM/browser integration test harness.
- Better handling of non-default skins (colour calibration).
- A benchmark page that reports score distributions across many seeds.

Please open an issue before starting a large change so the approach can be discussed.
