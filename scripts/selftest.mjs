#!/usr/bin/env node
// selftest.mjs - proves the kit still works, on synthetic transcripts it writes
// itself, plus whatever real session stores this machine happens to have.
// Run it after any harness update: if a transcript format moves, this goes red
// instead of the tool quietly reporting "no signals found".
//
//   node scripts/selftest.mjs
//
// Every case includes something that MUST be rejected. A suite where nothing can
// fail proves nothing, however green it looks. A case that cannot run on this
// machine prints `skip` and is counted separately - a skip is never a pass.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(HERE);
const CLI = path.join(HERE, 'reflect.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-selftest-'));
const PROJ = path.join(TMP, 'project');
const TRANS = path.join(TMP, 'transcripts');
const FAKEHOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(PROJ, '.reflections'), { recursive: true });
fs.mkdirSync(TRANS, { recursive: true });

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const skip = (name, why) => { skipped++; console.log(`  skip ${name}  (${why})`); };
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
const localDay = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const jline = (o) => `${JSON.stringify(o)}\n`;

const run = (args, env) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const base = ['--project', PROJ, '--transcripts', TRANS];

// ================================================================= fixtures

// --- Claude Code shapes ---------------------------------------------------
function human(text, ageDays) {
  return jline({
    type: 'user', timestamp: day(ageDays), sessionId: 'aaaabbbb', cwd: PROJ,
    origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] },
  });
}
function machine(text, ageDays) {           // headless run: no origin
  return jline({
    type: 'user', timestamp: day(ageDays), sessionId: 'aaaabbbb', cwd: PROJ,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}
function hookEcho(text, ageDays) {          // injected context wearing a user face
  return jline({
    type: 'user', timestamp: day(ageDays), sessionId: 'aaaabbbb', cwd: PROJ, isMeta: true,
    sourceToolUseID: 'toolu_1', message: { role: 'user', content: [{ type: 'text', text }] },
  });
}
function subagent(text, ageDays) {
  return jline({
    type: 'user', timestamp: day(ageDays), sessionId: 'aaaabbbb', cwd: PROJ, isSidechain: true,
    origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] },
  });
}
function toolCall(name, id, bytes, ageDays) {
  return jline({
    type: 'assistant', timestamp: day(ageDays), sessionId: 'aaaabbbb', cwd: PROJ,
    message: { role: 'assistant', model: 'test', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id, name, input: {} }] },
  }) + jline({
    type: 'user', timestamp: day(ageDays), sessionId: 'aaaabbbb', cwd: PROJ,
    toolUseResult: { out: 'x'.repeat(bytes) },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
  });
}

fs.writeFileSync(path.join(TRANS, 'aaaabbbb.jsonl'), [
  human('the sidebar is still broken after your fix', 9),
  human('i cant see the change you made', 8),
  human('do not stop, keep going until it is done', 7),   // must NOT count as "told to stop"
  machine('You are a summarising utility. Return only JSON.', 7),
  hookEcho('UserPromptSubmit hook additional context: you must load the skill', 7),
  subagent('no that is wrong, use the other approach', 7),
  human('i cant see it', 2),
  human('nice work, ship it', 1),
  toolCall('Read', 'toolu_a', 50000, 2),
  toolCall('Bash', 'toolu_b', 200, 2),
].join(''));

// --- Codex CLI shapes (field names copied from a real rollout file) --------
const codexItem = (payload, ageDays) => jline({ timestamp: day(ageDays), type: 'response_item', payload });
fs.writeFileSync(path.join(TRANS, 'rollout-2026-01-01T00-00-00-ccccdddd.jsonl'), [
  jline({ timestamp: day(6), type: 'session_meta', payload: { id: 'ccccdddd', cwd: PROJ, cli_version: '0.0.0', model_provider: 'openai' } }),
  codexItem({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex. Collaborate with the user.' }] }, 6),
  codexItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>\nalways run the tests\n</user_instructions>' }] }, 6),
  codexItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no that is wrong, i already told you that' }] }, 6),
  codexItem({ type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{}' }, 6),
  codexItem({ type: 'function_call_output', call_id: 'call_1', output: 'y'.repeat(9000) }, 6),
  jline({ timestamp: day(6), type: 'token_usage_record', payload: { usage: { input_tokens: 700, cached_input_tokens: 100, output_tokens: 70 } } }),
].join(''));

// --- Gemini CLI shapes ----------------------------------------------------
fs.writeFileSync(path.join(TRANS, 'session-2026-01-01T00-00-eeeeffff.jsonl'), [
  jline({ sessionId: 'eeeeffff', startTime: day(4), kind: 'main' }),
  jline({ $set: { messages: [
    { id: 'm1', timestamp: day(4), type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI. Today is Monday.\n</session_context>' }] },
    { id: 'm2', timestamp: day(4), type: 'user', content: [{ text: 'you didnt test it, prove it works' }] },
    { id: 'm3', timestamp: day(4), type: 'gemini', content: [{ text: 'here you go' }], tokens: { promptTokenCount: 40, candidatesTokenCount: 9 } },
  ] } }),
].join(''));

// ================================================================= scan

console.log('\nscan - Claude Code');
const scan = run(['scan', '--days', '30', '--json', ...base]);
let sj; try { sj = JSON.parse(scan.out); } catch { sj = null; }
ok('scan returns JSON at all', !!sj, scan.out.slice(0, 400));
const shapes = sj ? Object.fromEntries(sj.signals.map((s) => [s.shape, s])) : {};
const allQuotes = sj ? sj.signals.flatMap((s) => s.quotes.map((q) => q.text)).join(' | ') : '';

ok('finds the repeated complaint', !!shapes['cant-see'] && shapes['cant-see'].hits >= 2, JSON.stringify(shapes['cant-see'] || null));
ok('finds "still broken"', !!shapes['still']);
ok('REJECTS a headless machine prompt', !/summarising utility/i.test(allQuotes));
ok('REJECTS injected hook text', !/UserPromptSubmit/i.test(allQuotes));
ok('REJECTS a subagent brief', !/the other approach/i.test(allQuotes));
ok('REJECTS "do not stop" as being told to stop', !shapes['stop'], JSON.stringify(shapes['stop'] || null));
ok('attributes tool results to the right tool', !!sj && sj.biggest_results[0] && sj.biggest_results[0].tool === 'Read', JSON.stringify((sj && sj.biggest_results[0]) || null));
ok('counts praise as no signal at all', !/ship it/i.test(allQuotes));

console.log('\nscan - other harnesses');
ok('codex: typed prompt kept, developer and injected blocks rejected',
  /i already told you that/.test(allQuotes) && !/You are Codex/i.test(allQuotes) && !/always run the tests/i.test(allQuotes),
  allQuotes.slice(0, 300));
ok('codex: its tool output and token counts are read',
  !!sj && sj.biggest_results.some((r) => r.tool === 'shell' && r.total_bytes > 8000) && sj.spend.in >= 700 && sj.spend.cacheRead >= 100,
  JSON.stringify(sj && { spend: sj.spend, results: sj.biggest_results }));
ok('gemini: typed prompt kept, session_context rejected',
  /prove it works/.test(allQuotes) && !/This is the Gemini CLI/i.test(allQuotes),
  allQuotes.slice(0, 300));
ok('gemini: its token counts are read', !!sj && sj.spend.out >= 9 + 5, JSON.stringify(sj && sj.spend));
ok('names every store it read from', !!sj && sj.read_from.length >= 1 && sj.window.prompts >= 5, JSON.stringify(sj && sj.read_from));

// ----------------------------------------------------------------- silent zero

console.log('\nsilent zero');
const JUNK = path.join(TMP, 'junk');
fs.mkdirSync(JUNK, { recursive: true });
fs.writeFileSync(path.join(JUNK, 'unknown.jsonl'), Array.from({ length: 30 }, (_, i) => jline({ evt: 'something', n: i })).join(''));
const junk = run(['scan', '--days', '30', '--project', PROJ, '--transcripts', JUNK]);
ok('REJECTS an unparseable store loudly instead of reporting zero',
  junk.code === 2 && /understood none of them/i.test(junk.out), `exit ${junk.code}: ${junk.out.slice(0, 200)}`);
const empty = run(['scan', '--days', '30', '--project', PROJ, '--transcripts', path.join(TMP, 'nothing-here')]);
ok('REJECTS a transcripts folder that does not exist', empty.code === 2 && /not a folder/i.test(empty.out));

// ================================================================= doctor

console.log('\ndoctor');
// A fake home with one readable store per harness, and one that is readable-looking
// but unparseable, so the "UNREADABLE" branch is exercised rather than assumed.
const enc = PROJ.replace(/[^A-Za-z0-9]/g, '-');
fs.mkdirSync(path.join(FAKEHOME, '.claude', 'projects', enc), { recursive: true });
fs.copyFileSync(path.join(TRANS, 'aaaabbbb.jsonl'), path.join(FAKEHOME, '.claude', 'projects', enc, 'aaaabbbb.jsonl'));
fs.mkdirSync(path.join(FAKEHOME, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
fs.copyFileSync(path.join(TRANS, 'rollout-2026-01-01T00-00-00-ccccdddd.jsonl'), path.join(FAKEHOME, '.codex', 'sessions', '2026', '01', '01', 'rollout-2026-01-01T00-00-00-ccccdddd.jsonl'));
fs.mkdirSync(path.join(FAKEHOME, '.gemini', 'tmp', 'proj', 'chats'), { recursive: true });
fs.writeFileSync(path.join(FAKEHOME, '.gemini', 'tmp', 'proj', '.project_root'), PROJ);
fs.writeFileSync(path.join(FAKEHOME, '.gemini', 'tmp', 'proj', 'chats', 'session-2026-01-01T00-00-99999999.jsonl'),
  Array.from({ length: 12 }, (_, i) => jline({ mystery: i })).join(''));
// A harness that writes its whole system prompt on line 1. Real Codex rollouts run to
// ~18KB there; if the project lookup only reads a fixed first chunk, a bigger one is
// unparseable and the session vanishes from the count without a word.
fs.mkdirSync(path.join(FAKEHOME, '.codex', 'sessions', '2026', '01', '02'), { recursive: true });
fs.writeFileSync(path.join(FAKEHOME, '.codex', 'sessions', '2026', '01', '02', 'rollout-2026-01-02T00-00-00-11112222.jsonl'),
  jline({ timestamp: day(3), type: 'session_meta', payload: { id: '11112222', cwd: PROJ, base_instructions: { text: 'z'.repeat(400000) } } })
  + jline({ timestamp: day(3), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'you said it was fixed and it is still broken' }] } }));

const HOMEENV = { HOME: FAKEHOME, USERPROFILE: FAKEHOME };
const doc = run(['doctor', '--json', '--project', PROJ], HOMEENV);
let dj; try { dj = JSON.parse(doc.out); } catch { dj = null; }
const bySource = dj ? Object.fromEntries(dj.sources.map((s) => [s.source, s])) : {};
ok('doctor: names every source and flags the unreadable one',
  !!dj && dj.sources.length === 3
  && bySource['claude-code'].readable === true && bySource['claude-code'].for_this_project === 1
  && bySource['codex-cli'].readable === true
  && bySource['gemini-cli'].readable === false && /UNREADABLE/.test(bySource['gemini-cli'].note),
  JSON.stringify(bySource, null, 1).slice(0, 700));
ok('doctor: finds each store without being told where it is',
  !!dj && dj.sources.every((s) => s.installed === true), JSON.stringify(dj && dj.sources.map((s) => [s.source, s.installed])));
ok('a session whose first line is 400KB is still matched to its project',
  !!dj && bySource['codex-cli'].for_this_project === 2, JSON.stringify(bySource['codex-cli']));
const docBare = run(['doctor', '--json', '--project', PROJ], { HOME: path.join(TMP, 'empty-home'), USERPROFILE: path.join(TMP, 'empty-home') });
ok('doctor: exits 1 and says so when nothing is readable', docBare.code === 1, `exit ${docBare.code}`);
// The same machine's own stores, if it has any. Real data, not a fixture.
for (const [label, probe] of [['claude-code', '.claude/projects'], ['codex-cli', '.codex/sessions'], ['gemini-cli', '.gemini/tmp']]) {
  const dir = path.join(os.homedir(), ...probe.split('/'));
  if (!fs.existsSync(dir)) { skip(`real ${label} store on this machine parses`, 'not installed here'); continue; }
  const real = run(['doctor', '--json', '--days', '3650', '--project', process.cwd()]);
  let rj; try { rj = JSON.parse(real.out); } catch { rj = null; }
  const row = rj && rj.sources.find((s) => s.source === label);
  if (!row || !row.installed) { skip(`real ${label} store on this machine parses`, 'installed but empty'); continue; }
  if (row.for_this_project === 0) { skip(`real ${label} store on this machine parses`, `${row.files} file(s), none for ${process.cwd()}`); continue; }
  ok(`real ${label} store on this machine parses`, row.readable === true, row.note);
}

// ================================================================= score

console.log('\nscore');
fs.mkdirSync(path.join(PROJ, 'real'), { recursive: true });
fs.writeFileSync(path.join(PROJ, 'real', 'guard.mjs'), '');
const watchlist = (items) => fs.writeFileSync(path.join(PROJ, '.reflections', 'watchlist.json'), JSON.stringify({ items }, null, 2));
watchlist([
  { id: 'recurring', added: localDay(5), fix: 'f', artifact: 'real/guard.mjs', watch: ['cant see'] },
  { id: 'cannot-fail', added: localDay(5), fix: 'f', artifact: 'real/guard.mjs', watch: ['phrase-nobody-ever-said-zz9'] },
  { id: 'never-built', added: localDay(5), fix: 'f', artifact: 'real/absent.mjs', watch: ['cant see'] },
  { id: 'worked', added: localDay(5), fix: 'f', artifact: 'real/guard.mjs', watch: ['still broken'] },
]);
const score = run(['score', '--json', ...base]);
let verdicts = {};
try { verdicts = Object.fromEntries(JSON.parse(score.out).items.map((i) => [i.id, i.verdict])); } catch { /* reported below */ }
ok('a mistake that kept happening is STILL RECURRING', verdicts.recurring === 'STILL RECURRING', JSON.stringify(verdicts));
ok('a watch that never fired is UNFALSIFIABLE', verdicts['cannot-fail'] === 'UNFALSIFIABLE');
ok('a missing artifact is NOT BUILT', verdicts['never-built'] === 'NOT BUILT');
ok('a mistake that stopped is WORKED', verdicts.worked === 'WORKED');
ok('score exits 1 while work is outstanding', run(['score', ...base]).code === 1);
ok('score exits 1 in --json mode too', score.code === 1, `exit ${score.code}`);

// A watchlist that cannot be trusted must stop the run, not score everything clean.
watchlist([{ id: 'bad-date', added: 'last tuesday', fix: 'f', watch: ['cant see'] }]);
const badDate = run(['score', '--json', ...base]);
ok('REJECTS a watchlist with a bad date instead of scoring zero',
  badDate.code === 2 && /bad-date/.test(badDate.out) && /YYYY-MM-DD/.test(badDate.out), `exit ${badDate.code}: ${badDate.out.slice(0, 200)}`);
watchlist([{ added: localDay(2), watch: ['x'] }]);
ok('REJECTS a watchlist item with no id', run(['score', ...base]).code === 2);
watchlist([{ id: 'x', added: localDay(2), watch: 'cant see' }]);
ok('REJECTS a watch that is not a list', run(['score', ...base]).code === 2);
fs.writeFileSync(path.join(PROJ, '.reflections', 'watchlist.json'), '{ not json');
ok('REJECTS a corrupt watchlist instead of reading it as empty', run(['score', ...base]).code === 2);
watchlist([{ id: 'recurring', added: localDay(5), fix: 'f', artifact: 'real/guard.mjs', watch: ['cant see'] }]);

// ================================================================= prove

console.log('\nprove');
const guard = path.join(TMP, 'guard.mjs');
fs.writeFileSync(guard, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(/rm -rf/.test(s)){console.error('deny');process.exit(2)}process.exit(0)});`);
fs.writeFileSync(path.join(TMP, 'bad.txt'), 'rm -rf /');
fs.writeFileSync(path.join(TMP, 'good.txt'), 'ls');
const P = (cmd, extra = []) => run(['prove', '--cmd', cmd, '--deny-file', path.join(TMP, 'bad.txt'), '--allow-file', path.join(TMP, 'good.txt'), ...extra]);
ok('a real guard passes', P(`"${process.execPath}" "${guard}"`).code === 0);
ok('REJECTS a guard that allows everything', P(`"${process.execPath}" -e "process.exit(0)"`).code === 1);
ok('REJECTS a guard that blocks everything', P(`"${process.execPath}" -e "process.exit(2)"`).code === 1);
const broken = P(`"${process.execPath}" "${path.join(TMP, 'does-not-exist.mjs')}"`);
ok('REJECTS a command that never ran', broken.code === 1 && /DID NOT RUN/.test(broken.out));

// A guard that hangs used to be reported as a guard that refuses.
const t0 = Date.now();
const hang = P(`"${process.execPath}" -e "setInterval(function(){},1000)"`, ['--timeout', '1500']);
const elapsed = Date.now() - t0;
ok('REJECTS a guard that hangs, and returns inside the timeout',
  hang.code === 1 && /DID NOT FINISH/.test(hang.out) && elapsed < 30000, `exit ${hang.code} after ${elapsed}ms: ${hang.out.slice(0, 160)}`);

// A flag value that starts with a dash must not be swallowed as another flag.
const dashGuard = path.join(TMP, 'dash-guard.mjs');
fs.writeFileSync(dashGuard, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(/--force/.test(s)){console.error('denied');process.exit(2)}process.exit(0)});`);
const dash = run(['prove', '--cmd', `"${process.execPath}" "${dashGuard}"`, '--deny-input=--force', '--allow-input', 'plain']);
ok('a flag value starting with a dash is not read as a flag', dash.code === 0, `exit ${dash.code}: ${dash.out.slice(0, 200)}`);
ok('REJECTS prove with only one side of the proof', run(['prove', '--cmd', 'echo hi', '--deny-input', 'x']).code === 2);
ok('REJECTS a --deny-match that is not a valid regex',
  run(['prove', '--cmd', 'echo hi', '--deny-input', 'a', '--allow-input', 'b', '--deny-match', '([']).code === 2);
ok('REJECTS a --timeout that is not a positive number',
  run(['prove', '--cmd', 'echo hi', '--deny-input', 'a', '--allow-input', 'b', '--timeout', 'soon']).code === 2);

// ================================================================= lint

console.log('\nlint');
const sections = ['Coverage\n1a2b3c4d', 'Carried over\nnone', 'Scoreboard\nnone', 'Signals\nnone',
  'Families\nnone', 'Verdicts\nnone', 'Not proposing\nnone', 'State\nnone'];
const good = sections.map((s) => `## ${s}`).join('\n');
fs.writeFileSync(path.join(PROJ, 'good.md'), good);
fs.writeFileSync(path.join(PROJ, 'nosession.md'), good.replace('1a2b3c4d', 'we looked at some sessions'));
fs.writeFileSync(path.join(PROJ, 'ghost.md'), good.replace('## Verdicts\nnone', '## Verdicts\nGUARD - `ops/ghost.mjs` installed and enforced.'));
const L = (f, extra = []) => run(['lint', path.join(PROJ, f), '--project', PROJ, ...extra]);
ok('a complete report passes', L('good.md').code === 0, L('good.md').out.slice(0, 200));
ok('REJECTS a report citing no session', L('nosession.md').code === 1);
ok('REJECTS a promised file that is not on disk', L('ghost.md').code === 1 && /does not exist/.test(L('ghost.md').out));
ok('REJECTS "enforced" with no proof', /never shows it refusing/.test(L('ghost.md').out));
fs.writeFileSync(path.join(PROJ, 'missing.md'), good.replace('## State\nnone', ''));
const missing = L('missing.md');
ok('REJECTS a report with a section missing', missing.code === 1 && /missing section: State/.test(missing.out), missing.out.slice(0, 200));

// The \Z hole: when the checked section was the LAST heading in the file, the
// section parser returned nothing and every check that read it silently passed.
const tail = [...sections.filter((s) => !s.startsWith('Verdicts')), 'Verdicts\nGUARD - `ops/ghost.mjs` installed and enforced.']
  .map((s) => `## ${s}`).join('\n');
fs.writeFileSync(path.join(PROJ, 'ghost-last.md'), tail);
const ghostLast = L('ghost-last.md');
ok('REJECTS a ghost file when Verdicts is the LAST section',
  ghostLast.code === 1 && /does not exist/.test(ghostLast.out), `exit ${ghostLast.code}: ${ghostLast.out.slice(0, 250)}`);
// Positive control for that same parser: a real file in the last section must pass.
fs.writeFileSync(path.join(PROJ, 'real-last.md'),
  tail.replace('GUARD - `ops/ghost.mjs` installed and enforced.', 'GUARD - `real/guard.mjs` installed; `prove` refused the bad case and allowed the good one.'));
ok('accepts a REAL file in that same last section', L('real-last.md').code === 0, L('real-last.md').out.slice(0, 200));
ok('--sections lets another report shape be checked',
  run(['lint', path.join(PROJ, 'good.md'), '--project', PROJ, '--sections', 'Coverage,Signals']).code === 0
  && run(['lint', path.join(PROJ, 'good.md'), '--project', PROJ, '--sections', 'Nope']).code === 1);

// ================================================================= prune

console.log('\nprune');
fs.writeFileSync(path.join(PROJ, 'CLAUDE.md'), [
  '- run the check at `real/guard.mjs` before claiming done',
  '- the old gate at `ops/deleted.mjs` must stay green',
  '- never edit files outside the request, a related finding is a separate ask',
  '- never edit files outside of the request, a related finding is a separate ask',
  '',
  'Example, not a rule:',
  '```bash',
  'node `ops/in-a-fence.mjs` --check',
  '```',
].join('\n'));
const pr = JSON.parse(run(['prune', path.join(PROJ, 'CLAUDE.md'), '--project', PROJ, '--json']).out);
ok('finds the reference to a deleted file', pr.dead.length === 1 && pr.dead[0].ref === 'ops/deleted.mjs', JSON.stringify(pr.dead));
ok('leaves the live reference alone', !pr.dead.some((d) => d.ref.includes('guard.mjs')));
ok('ignores a dead path inside a fenced code block', !pr.dead.some((d) => d.ref.includes('in-a-fence')), JSON.stringify(pr.dead));
ok('finds the rule written twice', pr.dupes.length === 1, JSON.stringify(pr.dupes.length));
// Positive control: the fence filter must not be swallowing everything.
fs.writeFileSync(path.join(PROJ, 'AGENTS.md'), '- the gate at `ops/also-deleted.mjs` is required');
const pr2 = JSON.parse(run(['prune', path.join(PROJ, 'AGENTS.md'), '--project', PROJ, '--json']).out);
ok('still finds a dead path outside any fence', pr2.dead.length === 1, JSON.stringify(pr2.dead));

// ================================================================= safety

console.log('\nsafety');
function snapshot(dir) {
  const out = [];
  (function w(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n);
      const st = fs.lstatSync(f);
      if (st.isDirectory()) { out.push(`D ${path.relative(dir, f)}`); w(f); }
      else out.push(`F ${path.relative(dir, f)} ${st.size} ${crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex')}`);
    }
  })(dir);
  return out.join('\n');
}
const before = snapshot(PROJ);
run(['doctor', '--project', PROJ], HOMEENV);
run(['scan', '--days', '30', ...base]);
run(['score', ...base]);
run(['lint', path.join(PROJ, 'good.md'), '--project', PROJ]);
run(['prune', path.join(PROJ, 'CLAUDE.md'), '--project', PROJ]);
ok('every command leaves the project tree byte-identical', snapshot(PROJ) === before, 'the tool wrote something into the project');

ok('REJECTS --days that is not a positive number',
  run(['scan', '--days', 'lots', ...base]).code === 2 && run(['scan', '--days', '-3', ...base]).code === 2);
ok('REJECTS --since that is not a date', run(['scan', '--since', 'yesterday', ...base]).code === 2);
ok('REJECTS --project that is not a folder', run(['scan', '--project', path.join(TMP, 'no-such-project')]).code === 2);
ok('REJECTS a value flag with nothing after it', run(['scan', ...base, '--days']).code === 2);

// --store must actually move where the watchlist is read from.
const STORE2 = path.join(TMP, 'elsewhere');
fs.mkdirSync(STORE2, { recursive: true });
fs.writeFileSync(path.join(STORE2, 'watchlist.json'), JSON.stringify({ items: [{ id: 'moved', added: localDay(5), fix: 'f', watch: ['cant see'] }] }));
const moved = run(['score', '--json', ...base, '--store', STORE2]);
ok('--store moves the watchlist and the reports', /"id": "moved"/.test(moved.out), moved.out.slice(0, 200));

// prune with no file arguments must find the rule files a project actually has.
const auto = run(['prune', '--project', PROJ, '--json']);
let aj; try { aj = JSON.parse(auto.out); } catch { aj = null; }
ok('prune finds CLAUDE.md and AGENTS.md on its own',
  !!aj && aj.stats.some((s) => /CLAUDE\.md$/.test(s.file)) && aj.stats.some((s) => /AGENTS\.md$/.test(s.file)),
  JSON.stringify(aj && aj.stats));

const oldNode = run(['scan', ...base], { REFLECT_FAKE_NODE: '16.20.2' });
ok('an unsupported Node version is refused with one sentence',
  oldNode.code === 2 && /needs Node 18 or newer/.test(oldNode.out) && !/at .*\n\s+at /.test(oldNode.out), oldNode.out.slice(0, 200));
ok('the current Node is accepted', run(['--help']).code === 0);

const readme = fs.existsSync(path.join(KIT, 'README.md')) ? fs.readFileSync(path.join(KIT, 'README.md'), 'utf8') : '';
ok('ships a LICENSE and a privacy warning in the README',
  fs.existsSync(path.join(KIT, 'LICENSE'))
  && /\bMIT\b/.test(fs.readFileSync(path.join(KIT, 'LICENSE'), 'utf8'))
  && /never writes|writes nothing/i.test(readme) && /privacy|verbatim|private/i.test(readme),
  'LICENSE missing, or README does not state the privacy position');
ok('the help text names the exit codes', /Exit codes/.test(run(['--help']).out));
ok('an unknown command fails instead of doing something else', run(['sccan']).code === 2);

// ================================================================= done

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* leave it */ }
if (!fail) console.log('SELFTEST OK');
process.exit(fail ? 1 : 0);
