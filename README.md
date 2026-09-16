# hindsight

### A retro your agent can fail.

Two parts, one idea:

- **`SKILL.md`** - the retro your agent runs. Plain markdown, no skill system required.
- **`scripts/reflect.mjs`** - grades the last one. *Did those fixes actually stop the mistake?*

Most reflection tools find problems. This one checks the fixes you already made, and
throws out any test that could never have failed.

No model calls, no network, no dependencies. It reads your session logs and **writes
nothing**.

> The project is `hindsight`. The skill inside it is `reflect` - that is the word you type.

## Install

```bash
git clone https://github.com/SayHey2daddy/hindsight ~/.claude/skills/reflect
node ~/.claude/skills/reflect/scripts/reflect.mjs doctor
```

`doctor` lists the session logs it found and whether it could read them. Run it first.

Gemini CLI: use `~/.gemini/skills/reflect`. Any other agent: `--transcripts <folder of
.jsonl or .json>`. Node 18+, Windows / macOS / Linux.

Then say **reflect** in a session.

## A round, end to end

1. **Score** last round. Fix still not working? Move it up a rung. Test that never fired even *before* the fix? The test was broken, not the fix.
2. **Scan** the days since - your corrections grouped by shape, plus what cost the most.
3. **Pick one** and choose where it lands: a line in your rules, a skill, or a guard that refuses the action.
4. **Prove** the guard blocks a real bad case and allows a real good one.
5. **Watch it** - save the words you actually used when the mistake happened.
6. **Lint** the report before calling it done.

Your agent writes the report and the watchlist into `.reflections/`. Examples of both are
in `templates/`.

```
$ node scripts/reflect.mjs score

== SCOREBOARD - did past fixes actually stop their mistake?
STILL RECURRING  A-relaunch  gate blocks a session that never relaunched the app
                 since 2026-09-10: 6 before -> 4 after (6 day window each side)
                 recent: 83699c6b "i still dont see it"

UNFALSIFIABLE    B-scope     rule nobody ever tripped
                 these phrases never fired even BEFORE the fix, so a clean
                 result proves nothing. Rewrite the watch.

NOT BUILT        C-verify    hook accepted last time, never written
```

## Commands

| Command | What it answers |
|---|---|
| `doctor` | What it can see, and whether it can read it. Run first |
| `score` | Did last round's fixes work? Exits 1 while anything is unbuilt or still recurring |
| `scan` | What happened since the last retro |
| `prove` | Does this guard refuse the bad case and allow the good one? |
| `lint` | Is the report honest - sections present, promised files real, no "enforced" without proof |
| `prune` | Rules pointing at deleted files, and rules written twice |

`--project <path>` runs any of them against another folder. `node scripts/selftest.mjs`
checks the tool itself after your agent edits it - 64 checks, many of them cases it
must reject.

## Honest limits

- **Correlation, not proof.** Scoring counts your phrases before and after a date. A quiet week can look like a fix.
- **Three agents tested.** Claude Code, Codex CLI, Gemini CLI. Anything else works through `--transcripts`; `doctor` tells you if it understood the records.
- **Token counts are a trend, not a bill.** Every agent counts differently. No dollar figure anywhere.
- **The patterns are English**, tuned for direct speech. Edit `SHAPES` in `scripts/reflect.mjs` to match how you talk.
- **`prove` runs the command you give it**, as you. It is the only part that executes anything.

## Privacy

Session logs hold everything you have ever typed at an agent. So:

- **It writes nothing** - no report, no cache, no state. The test suite fingerprints the whole project, runs every command, and fails if one byte moved.
- **Nothing leaves your machine** - no network, no model, no telemetry.
- **It quotes you back.** Think before pasting a scan into a chat or a screenshot.

## Licence

MIT - see [LICENSE](LICENSE).
