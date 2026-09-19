# jev-lens — build plan

Tasks are ordered so each one is verifiable on its own. Skeleton tasks (S)
are done in this pass. Implementation tasks (T) follow. Every task names its
check.

## Skeleton (this pass)

- **S1 Hook plugin layout** — manifest, marketplace, hooks.json, package.json,
  README. Check: `claude plugin validate .` passes.
- **S2 Borrowed lib** — `lib/jev.mjs` (config renamed to `JEV_LENS_*`),
  `lib/transcript.mjs`, `lib/rules.mjs`. Check: unit tests import them.
- **S3 Repo state and baseline** — `lib/repo.mjs`: root, key, state
  read/write (atomic), snapshot tree, diff between trees, clean check.
  Check: `test/repo.test.mjs` against a temp git repo.
- **S4 Debris candidates** — `lib/debris.mjs`. Check: `test/debris.test.mjs`
  with fixtures in five languages.
- **S5 Redaction and ignore** — `lib/redact.mjs`. Check: unit test.
- **S6 Judge** — `bin/judge.mjs` end to end against the mock API: writes
  `verdict.json` in the agreed shape. Check: `test/judge.test.mjs`.
- **S7 Hooks** — the four hook scripts. Check: `test/hooks.test.mjs` runs each
  over stdin like Claude Code does; Stop spawns the judge and returns under
  200 ms.
- **S8 nvim plugin layout** — `lua/jev-lens/*`, `plugin/jev-lens.lua`,
  `tests/`. Check: `tests/run.sh` green.
- **S9 nvim render and pending** — render lines from a fixture verdict, match
  the mockup; `pending()`; reviewed writes state. Check: `tests/spec.lua`.
- **S10 nvim watcher** — fs_event plus poll; shows once per verdict id.
  Check: spec writes a verdict file and observes the popup buffer.
- **S11 Strip with safety** — refuse on modified buffer; content check; delete
  bottom-up. Check: spec with a temp file.

## Implementation (next pass, in order)

- **T1 Live run in shadow** — install both, `JEV_LENS=shadow` for a week,
  compare `decisions.log` against your own reviews. Output: threshold changes
  in `readConfig` defaults.
- **T2 lazydiff file option** — add `open_float({ file = ... })` to
  lazydiff.nvim so `l` lands on the file. Check: lazydiff spec.
- **T3 Jump to session** — tmux `switch-client` from the verdict's pane;
  sidekick window focus by pid match (reuse claude-sessions `rpc.lua`
  pattern). Check: manual, both paths.
- **T4 Startup show** — pending verdict shown once when nvim opens in the
  repo. Check: spec.
- **T5 Batching over 20 files** — split call A, overall := max. Check: judge
  test with 45 files.
- **T6 Stale detection** — re-snapshot after the request; badge in popup and
  `R` re-judge. Check: judge test that mutates the tree mid-run via the mock's
  request hook.
- **T7 Pending API and integrations** — `pending()` documented; small PRs to
  claude-sessions.nvim (fourth dot state) and a tmux status script.
- **T8 Activate** — flip to `active`, README gif with asciinema like gates.

## v1.5

- Edit log → hunk-level "why": map hunks to prompt uuids through the edit
  log and transcript `promptId`.
- Bash writes through the jev-gates shell detector.
- Key `c`: send a correction into the session pane.

## v2

- Multi-session verdicts per repo and cross-worktree semantic conflict
  checks (pairwise hunk questions, merge-order suggestion).

## Definition of done per task

Tests pass, no regression in the other repo's suite, behavior verified at
runtime once (headless nvim or a real stop), docs updated where the contract
moved.
