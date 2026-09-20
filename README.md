# jev-lens

You ask Claude Code for a feature. It edits eight files and says done. Now
what? You either read every line, or you skim and hope.

jev-lens answers the question you actually have: **do I need to look at
this, and where?** When a session stops, it diffs what the agent did against
the last thing you reviewed, asks [TypeSafe Jev](https://docs.typesafe.ai) a
handful of yes/no questions, and writes a verdict. Something like:

- Nothing needs you. Skip it.
- `src/auth/session.ts` changes behavior, have a look.
- `src/app.ts` has four leftover comments and a `console.log`. Want them
  stripped?

It never blocks Claude, never edits your files, and never says green unless
it is sure. Pair it with [jev-lens.nvim](https://github.com/rashedInt32/jev-lens.nvim)
to see the verdict as a popup in Neovim.

![jev-lens popup](docs/screenshot.png)

## Install

One line, from a terminal:

```bash
claude plugin marketplace add rashedInt32/jev-lens && claude plugin install jev-lens@jev-lens
```

Or from inside Claude Code:

```
/plugin marketplace add rashedInt32/jev-lens
/plugin install jev-lens@jev-lens
```

Then give it a TypeSafe key from [console.typesafe.ai](https://console.typesafe.ai/settings/keys).
Hooks do not see your shell profile, so put it in a file:

```bash
mkdir -p ~/.config/typesafe && printf '%s' "ts_..." > ~/.config/typesafe/key && chmod 600 ~/.config/typesafe/key
```

Restart Claude Code. That is it. Needs Node 20.12 or newer.

## How it works

Four hooks, none of them slow, none of them talk to the API:

- **SessionStart** takes a snapshot of your repo. That is the baseline,
  the last state you are assumed to have reviewed.
- **UserPromptSubmit** remembers what you asked for.
- **PostToolUse** remembers which files the agent touched, including
  through shell commands.
- **Stop** kicks off the judge in the background and returns at once.

The judge diffs the baseline against now, drops lockfiles and secrets, and
asks Jev per file: does this need a look, what kind of look, and which of
your prompts asked for it. Comments, debug prints, TODOs, lint suppressions
and `any` casts get one more question each: would a careful developer
delete this? Everything comes back as a number, and thresholds decide what
you see.

If [jev-gates](https://github.com/rashedInt32/jev-gates) is installed, its
proof gate leaves a result for the same repo at the same stop: which changes
could alter behaviour and had nothing run, tested, or checked after the edit.
The judge waits a moment for that file and lists those changes in the verdict
as `unverified`. The lens then shows not just which files to look at, but
which specific changes nobody has exercised yet. `JEV_LENS_PROOF=0` turns the
lookup off.

The result lands in `~/.claude/jev-lens/repos/<repo>/verdict.json`. Anything
can read it. jev-lens.nvim is the first thing that does.

## When it stays quiet

Most stops should end in silence or one line, not a popup. So before
spending a request, the judge skips:

- formatter runs, where nothing changed once whitespace is ignored
- diffs that only deleted comment lines
- diffs with no agent edit on record, which means it was your own typing

Diffs of three lines or fewer get judged for the log but are marked as not
worth a popup. Generated output like coverage and `.turbo` is ignored along
with lockfiles.

## When the baseline moves

"Since you last reviewed" is the unit of review, however many stops it took.
The baseline moves when you mark a verdict reviewed in nvim, or when a commit
leaves the working tree clean. A commit is a review.

## Trust it slowly

Start in shadow mode for a week. It judges and logs but nvim stays silent.
Compare `~/.claude/jev-lens/decisions.log` with what you would have said.

```json
{ "env": { "JEV_LENS": "shadow" } }
```

Flip to `active` when the numbers agree with you.

## Settings

All environment variables, all optional:

| Var | Default | What it does |
|-----|---------|--------------|
| `JEV_LENS` | `active` | `off`, `shadow`, or `active` |
| `JEV_LENS_GREEN` | 0.9 | how sure "nothing needs you" has to be |
| `JEV_LENS_UNSURE` | 0.6 | below this the overall verdict is "look" |
| `JEV_LENS_FILE_THRESHOLD` | 0.6 | a file at or above this is flagged |
| `JEV_LENS_KIND_CONFIDENCE` | 0.7 | below this the category shows as a guess |
| `JEV_LENS_DEBRIS_THRESHOLD` | 0.7 | at or above this a comment or log is strippable |
| `JEV_LENS_TINY_LINES` | 3 | at or under this many changed lines, never a popup |
| `JEV_LENS_REQUIRE_EDITS` | 1 | `0` judges diffs even with no agent edit on record |
| `JEV_LENS_MAX_FILES` | 40 | files judged per verdict; the rest are listed as not judged |
| `JEV_LENS_MAX_CHARS` | 40000 | state cap per request |
| `JEV_LENS_IGNORE` | | colon-separated globs added to the ignore list |
| `JEV_LENS_DIR` | `~/.claude/jev-lens` | where verdicts live |
| `JEV_LENS_MODEL` | `jev-latest` | |

## What leaves your machine

The diff, your recent prompts, and the rules from your CLAUDE.md. Lockfiles,
build output, `.env` files, keys and credential stores are never sent, and
anything key-shaped inside a patch is redacted first.

## Judge by hand

```bash
node bin/judge.mjs --cwd .                   # judge now
node bin/judge.mjs --cwd . --reviewed        # move the baseline to now
JEV_LENS_VERBOSE=1 node bin/judge.mjs --cwd . # print the result
```

## Tests

```bash
npm test
```

Runs against a local stand-in API, no key needed.

## Related

- [jev-lens.nvim](https://github.com/rashedInt32/jev-lens.nvim) shows the verdict in Neovim.
- [jev-gates](https://github.com/rashedInt32/jev-gates) stops bad writes before they land. jev-lens ranks what did land. They work alone; together, the gates' proof result shows up in the lens as unverified changes.
- [docs/SPEC.md](docs/SPEC.md) has every design decision and the file formats.

## License

MIT
