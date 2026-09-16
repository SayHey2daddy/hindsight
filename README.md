# hindsight

### A retro your agent can fail.

Every reflection tool ends the same way: a ranked list of findings, a few firm edits to
your rules file, and nobody who ever goes back to look.

hindsight starts at the other end. Before it will rank a single new idea it re-reads every
fix you accepted last time, counts whether that mistake is still happening, and says so out
loud. A fix whose test could never have failed gets no credit at all.

Any agent that keeps a session log on disk, any model provider. It reads Claude Code,
Codex CLI and Gemini CLI where they already store sessions; for anything else you point it
at the folder. Nothing in it calls a model, so whatever is behind your agent is irrelevant
to it.

```
$ node scripts/reflect.mjs score

== SCOREBOARD - did past fixes actually stop their mistake?
STILL RECURRING  A-relaunch  gate blocks a session that never relaunched the app
                 since 2026-09-10: 6 before -> 4 after (6 day window each side)
                 6 -> 4. The fix did not work. Escalate it one rung.
                 recent: 83699c6b "i still dont see it"

UNFALSIFIABLE    B-scope     rule nobody ever tripped
                 these phrases never fired even BEFORE the fix, so a clean
                 result proves nothing. Rewrite the watch.

NOT BUILT        C-verify    hook accepted last time, never written
                 accepted last time, never created. Build it before ranking
                 anything new.
```

## Install

Clone it anywhere, then check it can see your sessions:

```bash
git clone https://github.com/SayHey2daddy/hindsight
node hindsight/scripts/reflect.mjs doctor
```

`doctor` names every session store on the machine, how many of those sessions belong to
the folder you are standing in, and whether it can actually parse them. If your agent is
not one of the three it knows, point it straight at the logs:

```bash
node hindsight/scripts/reflect.mjs doctor --transcripts <folder of .jsonl or .json>
```

To use it as a skill, drop the folder where your agent looks for skills - for example
`~/.claude/skills/reflect` (Claude Code) or `~/.gemini/skills/reflect` (Gemini CLI) - and
say `reflect` in a session. `SKILL.md` is plain markdown; an agent with no skill mechanism
can be handed the same file as instructions.

Node 18+, no dependencies, no network, no model calls, Windows / macOS / Linux. Reports and
`watchlist.json` live in `.reflections/` in your project (an existing `.claude/reflections/`
is used instead if you already have one; `--store <path>` overrides both).

## The six commands

| Command | What it answers |
|---|---|
| `doctor` | What can it see: which stores, how many sessions are this project's, and can it read them. Run this first |
| `score` | Did the last round of fixes stop their mistakes? Exits 1 while anything is unbuilt, unmeasurable or still recurring |
| `scan` | What happened since the last reflection: unreflected days, corrections grouped by shape, spend, and the tool results that cost the most |
| `prove` | Does this new guard actually refuse the bad case and allow the good one? |
| `lint` | Is the report honest: sections present, promised files real, sessions cited, no "enforced" without proof |
| `prune` | Which rules point at deleted files, and which are written twice |

Run any of them against another project with `--project <path>`.

## How it differs from the alternatives

| | this | [claude-reflect](https://github.com/BayramAnnakov/claude-reflect) | [reflectory](https://github.com/ArtemiiF/reflectory) | [agent-retro](https://github.com/giannimassi/agent-retro) | [self-improving-skills](https://github.com/UniM0cha/self-improving-skills) | [self-improving-agent](https://github.com/alirezarezvani/claude-skills) |
|---|---|---|---|---|---|---|
| Captures corrections | yes | yes | yes | yes | - | - |
| Reads past sessions off disk | yes | yes | yes | current only | yes | - |
| Writes rules / skills | yes | yes | yes | proposes | skills | yes |
| Prunes what it added | yes | - | yes | - | archives skills | consolidates |
| Cost + waste per session | yes | - | - | yes | - | - |
| **Scores whether a fix worked** | **yes** | - | - | - | - | - |
| **Rejects a test that cannot fail** | **yes** | - | - | - | - | - |
| **Proves a guard refuses something** | **yes** | - | - | - | - | - |
| Report shape enforced by a check | yes | - | frontmatter only | - | - | - |
| Ships a test suite you can run | yes | - | - | - | - | - |
| Runtime | Node, 0 deps | Node + hooks | Python + hooks | Python | Node + SQLite | Node |

Read as of 2026-09-16, from each project's own skill files. Two fair clarifications:
reflectory does track whether a *rule* is still being used, and self-improving-skills
archives skills nobody uses - both measure the rule's life, not whether the mistake
stopped. reflectory also self-tests a proposed rule for specificity and conflicts before
you approve it, which is a check on the draft, not on the installed guard.

The first six rows are table stakes and several tools do them well. The three in bold are
the reason this exists.

## After your agent updates

```bash
node scripts/selftest.mjs
```

Checks run against synthetic transcripts it writes itself - Claude Code, Codex CLI and
Gemini CLI shapes - plus whatever real stores the machine happens to have. More than half
are cases that MUST be rejected: a headless run, an injected hook message, a subagent
brief, a harness's own preamble wearing a user's face, praise, "do not stop", a guard that
allows everything, a guard that blocks everything, a guard that hangs, a command that never
ran, a watchlist whose date cannot be read, a report promising a file that is not there. A
case that cannot run on your machine prints `skip`, and a skip is never counted as a pass.

Every tool in this space reads an undocumented transcript format. When that format moves,
this suite goes red; without one, a tool just reports "no signals found" forever. The same
principle is wired into the tool itself: if it finds session files and understands none of
them, it exits with an error instead of printing an empty report.

## Why scoring matters more than finding

Ranking a fix is a prediction: *this change will stop this mistake*. Nobody checks the
prediction. So a rule that never worked stays on the books, gets rewritten more firmly
next round, and the file grows until nothing in it is read.

Scoring closes that loop, and the `UNFALSIFIABLE` verdict closes the loop behind it: if a
watch never fired even when the mistake was happening, a clean result proves nothing at
all. Same discipline as a negative control in a lab - a check that cannot fail is not
evidence, however green it looks.

## Honest limits

- **Three agents are tested; the rest need one flag.** It knows where Claude Code
  (`~/.claude/projects`), Codex CLI (`~/.codex/sessions`) and Gemini CLI (`~/.gemini/tmp`)
  keep sessions, and it was tested against real logs from each. Any other agent that writes
  JSON or JSONL works through `--transcripts <folder>`; run `doctor` to see whether it
  understood the records. Adding an agent means adding one row to `SOURCES` in
  `scripts/reflect.mjs` - nothing else in the tool knows which agent it is reading.
- **Token counts are a trend, not a bill.** Every harness counts them differently, some
  record none at all, and none of them is a price. There is deliberately no dollar figure.
- **Correlation, not proof.** `score` counts phrases before and after a date. A quiet week
  can look like a fix. It tells you where to look; it does not tell you why.
- **The patterns are English**, and tuned for direct speech. Edit `SHAPES` in
  `scripts/reflect.mjs` to match how you actually talk - there are twelve, each one shape
  of friction rather than one subsystem.
- **Only typed messages count.** Hook output, skill bodies, subagent briefs and headless
  runs are filtered out. Where the transcript records human origin that filter is exact;
  on older versions it falls back to a heuristic.
- **`prove` runs a command you supply**, with its stdin and your shell. It is the only part
  of the kit that executes anything. Read a guard before you point this at it.

## Privacy, and what it is allowed to do

Your session logs are the most private thing on a developer's machine: they hold pasted
keys, client names, half-finished arguments, everything you have typed at an agent. So the
rules here are deliberately narrow.

- **It writes nothing.** No report, no cache, no state file, no config. Every command only
  reads. The suite proves it: it fingerprints the whole project tree, runs every command,
  and fails if a single byte moved. Reports and `watchlist.json` are written by you.
- **Nothing leaves your machine.** No network calls, no model calls, no telemetry, no
  dependencies that could add any.
- **It prints your own words back at you.** `scan` and `score` quote you verbatim, because
  a fix is only measurable against the words you actually used. That output is yours to
  read - think before pasting a scan into a bug report, a screenshot or a chat.
- **`--project` and `--transcripts` only ever read**, so pointing it at someone else's
  folder shows you their sessions. Do not point it anywhere you would not read by hand.

## Licence

MIT - see [LICENSE](LICENSE).
