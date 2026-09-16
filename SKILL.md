---
name: reflect
description: Use when the user says "reflect", "retro", "improve yourself", "you keep making the same mistake", "why do you keep doing that", at the end of a long or frustrating session, or when the same correction has landed twice. Mines past sessions for repeated friction, turns the worst of it into a rule or a guard, and scores whether the last round of fixes actually worked.
---

# reflect

Most reflection produces a nice document and changes nothing. This one is judged on a
single question, asked next time: **did the mistake stop happening?**

Two rules hold the whole thing up.

1. **Every fix gets a watch.** An accepted fix that nobody can measure later is an
   opinion. It goes in the watchlist with the words the user actually used when the
   mistake happened, or it does not count as accepted.
2. **Nothing is "enforced" until you watch it refuse something.** A rule you wrote and
   never tested is decoration. Run it against a case it must block. If you cannot say
   what would make the check fail, you have not verified anything.

`scripts/reflect.mjs` is plain Node, no install, no network, no model calls, and it writes
nothing. It works for any agent that keeps a session log and any model provider. Run it
with `--project <path>` to reflect on a folder you are not standing in.

## 0. Check it can see the sessions

```bash
node scripts/reflect.mjs doctor
```

It knows where Claude Code, Codex CLI and Gemini CLI keep sessions. For any other agent,
add `--transcripts <folder of .jsonl or .json>`. Do this first: every verdict below is
worth exactly as much as the sessions behind it, and `doctor` is the only command that
tells you whether it could actually read them.

If a store is listed as UNREADABLE, stop and fix that. A reflection built on a store the
tool could not parse is a reflection about nothing.

## 1. Score the last round FIRST

```bash
node scripts/reflect.mjs score
```

Start here, always. It re-reads every fix in `.reflections/watchlist.json`, counts
how often its phrases appeared before the fix landed and how often since, and returns a
verdict per item. It exits 1 while anything is unfinished.

| Verdict | Meaning | What you do |
|---|---|---|
| `NOT BUILT` | accepted last time, file never created | build it now, before ranking anything new |
| `UNFALSIFIABLE` | the phrases never fired even *before* the fix | the watch is broken, not the fix. Rewrite it with the words used at the time |
| `STILL RECURRING` | same rate or worse | the fix failed. Move it one rung up the ladder |
| `IMPROVED` | halved | keep it, watch it |
| `WORKED` | zero since | say so |
| `NO DATA` | no sessions yet | come back later |

An unbuilt or failed item **outranks every new candidate**. It is already proven to matter;
a new idea is a guess.

`UNFALSIFIABLE` is the one that protects you from yourself. A watch that never fires
reports success forever.

## 2. Scan the window

```bash
node scripts/reflect.mjs scan            # since your last report
node scripts/reflect.mjs scan --days 7
```

Read three things in the output.

**Unreflected days.** Days with sessions and no report. A run of them means the habit
lapsed - that is the finding, not a footnote to it.

**Signals, grouped by shape.** The tool groups by the *shape* of the mistake, never by
subsystem. Ten complaints about ten different files are one mistake wearing ten coats,
and each looks like a one-off in its own session. Anger is listed last on purpose: it
tells you the temperature, never the cause.

**Spend and waste.** Which tool results cost the most. A large file read once and never
referenced is paid for on every turn that follows.

Only genuinely typed messages are counted. Hook output, skill bodies, subagent briefs,
headless runs and the harness's own preamble are filtered out - every agent injects text
that arrives wearing a user's face, and counting it means ranking your own words as if the
user had said them.

## 3. Separate their steering from your mistakes

Mark every signal **yours** or **theirs**. A user changing direction is their prerogative,
not a defect. Rank only the ones that are yours. Counting steering as recurrence builds
guards against the person you are working for.

## 4. Rank, then pick a rung

`leverage = how often it repeats x what it costs them / what the fix costs`

Recurrence counts the *family*, not the line.

| Rung | When | Where it lands |
|---|---|---|
| **GUARD** | violated twice, or the mistake is destructive | a hook or script that refuses the action |
| **SKILL** | a repeated ritual with real steps | its own skill file |
| **RULE** | genuinely new, first occurrence | one line in CLAUDE.md or a rules file |
| **NOTHING** | noise | say so, in the report |

**A rule violated twice must move up a rung. No exceptions.** Rewriting a rule that already
failed is how a file grows to a length nobody reads. If the rule needs judgement no script
can make, say plainly that it nudges rather than blocks - do not call it enforcement.

Before adding, subtract:

```bash
node scripts/reflect.mjs prune
```

Dead references and rules written twice. A rules file too long to read absorbs your new
line with no effect at all.

## 5. Build it, then prove it bites

For a GUARD, the proof is not that the suite is green. It is that the guard refuses a real
bad case and lets a real good one through:

```bash
node scripts/reflect.mjs prove --cmd "node hooks/your-guard.mjs" \
  --deny-file fixtures/must-block.json --allow-file fixtures/must-pass.json
```

Exits 1 unless both hold, and tells you when the command never ran at all - a typo refuses
everything, which looks identical to a strict guard.

## 6. Add the watch

Every accepted fix, appended to `.reflections/watchlist.json`:

```json
{ "items": [
  { "id": "2026-09-16-verify",
    "added": "2026-09-16",
    "fix": "guard blocks a claim of done with no test run",
    "artifact": "hooks/verify-gate.mjs",
    "watch": ["/did you (test|verify)/i", "still broken", "it doesn't work"] }
] }
```

`watch` holds the words **the user used when the mistake happened** - copy them from the
scan output. Inventing tidy phrases is how you get `UNFALSIFIABLE` next time.

## 7. Write the report, then check it

`.reflections/REFLECTION-YYYY-MM-DD.md`, every heading present. An empty section
says "none" - a deleted section is indistinguishable from a question you never asked.

```markdown
## Coverage        - window, days with no report, why
## Carried over    - last round's accepted items: built, or missing
## Scoreboard      - did each past fix stop its mistake?
## Signals         - each with a session id, a count, yours or theirs
## Families        - grouped by shape of mistake, not by subsystem
## Verdicts        - rung + what you actually changed
## Not proposing   - what looks like a problem but should not be built, and why
## State           - what you verified, and what you did NOT
```

```bash
node scripts/reflect.mjs lint
```

Fails on a missing section, on a promised file that is not on disk, on a report citing no
session, and on the word "enforced" with no proof anywhere in the report.

## Verification

Before you call the reflection done:

- `doctor` listed the store the sessions came from, and none of it was UNREADABLE
- `score` ran and its verdicts are in the report, including the bad ones
- every GUARD has a `prove` run pasted into the report
- `lint` exits 0
- every accepted fix has a watchlist entry, or it is not accepted
- the State section names what you did **not** check

## Failure modes

| What it looks like | What it is |
|---|---|
| Ten lessons about ten different files | One mistake. Group by shape |
| A rule rewritten more firmly for the third time | Should have become a guard two rounds ago |
| Every score says WORKED | Check for UNFALSIFIABLE before celebrating |
| The report is long and nothing changed | Prose is not the product. The guard is |
| A finding from something the user rejected | Their steering is not your defect |
