#!/usr/bin/env node
// reflect.mjs - zero-dependency toolkit for the /reflect skill.
//
// Node 18+. No install, no network, no model calls, and it never writes anything
// into your project. Windows / macOS / Linux. Any coding agent, any model provider.
//
// Commands:
//   doctor - what it can see: stores, sessions, whether it can actually read them
//   scan   - what happened since the last reflection (coverage, corrections, waste)
//   score  - did past fixes actually stop their mistake? (the point of this kit)
//   prove  - does a new guard actually block something? (negative control)
//   lint   - is the written report honest? (sections, real files, cited sessions)
//   prune  - which old rules are dead weight?

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

// A bad Node gives a stack trace three frames deep into a stream API, which reads
// like the tool is broken rather than the runtime being too old. Say it once, plainly.
// REFLECT_FAKE_NODE exists so the test suite can prove this refuses without
// installing an old Node - it is a test seam, not a feature.
const NODE_VERSION = process.env.REFLECT_FAKE_NODE || process.versions.node;
const NODE_MAJOR = Number(String(NODE_VERSION).split('.')[0]);
if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 18) {
  console.error(`reflect.mjs needs Node 18 or newer. This is Node ${NODE_VERSION}. Nothing else is wrong.`);
  process.exit(2);
}

const HOME = os.homedir();
const DAY = 86400000;
const MAX_WALK = 20000;       // a pathological home directory must not hang the tool
const MAX_MATCH_CHARS = 100000; // bound on text a user-supplied regex is run over
const MAX_PRUNE_LINES = 6000; // the duplicate scan is O(n^2); say so rather than crawl

// ROOT is the project being reflected on. --project lets you run the kit from
// anywhere, which is also how its own tests avoid writing into a real project.
let ROOT = process.cwd();
// Where reports and the watchlist live. Not under .claude/: this kit is not
// Claude-specific. An existing .claude/reflections/ still wins, so an older
// install keeps working without moving a single file.
let STORE = null;
function resolveStore(args) {
  if (typeof args.store === 'string') return path.resolve(ROOT, args.store);
  const legacy = path.join(ROOT, '.claude', 'reflections');
  if (isDir(legacy)) return legacy;
  return path.join(ROOT, '.reflections');
}
const watchlistPath = () => path.join(STORE, 'watchlist.json');

// ------------------------------------------------------------------ filesystem

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }

// Symlinks are skipped outright: a loop in a home directory is a hang, and no
// harness stores its sessions behind one.
function walk(root, depth, keep, out = []) {
  if (depth < 0 || out.length >= MAX_WALK) return out;
  for (const name of safeReaddir(root)) {
    if (out.length >= MAX_WALK) break;
    const full = path.join(root, name);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, depth - 1, keep, out);
    else if (keep(name)) out.push({ file: full, mtime: st.mtimeMs, size: st.size });
  }
  return out;
}

// Read the first few lines of a session file and pull one field out of them.
// Used to answer "which project is this session about?" without parsing 40MB.
function headField(file, pick, maxLines = 40) {
  let head = '';
  // Start small, and grow only while the first line is still not complete. One
  // harness writes its whole system prompt on line 1 (18KB in the wild); truncating
  // it makes the line unparseable, which would silently drop the session instead of
  // failing loudly - the exact shape of bug this kit exists to catch.
  for (const size of [65536, 524288, 4194304]) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      fs.closeSync(fd);
      head = buf.slice(0, n).toString('utf8');
      if (head.includes('\n') || n < size) break;
    } catch { return null; }
  }
  let i = 0;
  for (const line of head.split('\n')) {
    if (++i > maxLines) break;
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const v = pick(j);
    if (v) return v;
  }
  return null;
}

// Windows and macOS treat paths case-insensitively; Linux does not, and folding case
// there would match two genuinely different projects onto each other.
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => { const r = path.resolve(String(p)); return CASELESS ? r.toLowerCase() : r; };
const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);

// ------------------------------------------------------------------ sources
//
// One entry per harness whose on-disk layout is known and TESTED against real
// logs. Anything else goes through --transcripts, which reads the same shapes
// from a folder you name. Adding a harness means adding a row here, nothing else.

function claudeEncoded(p) { return p.replace(/[^A-Za-z0-9]/g, '-'); }

// Gemini CLI keys its folders by a hash, but drops the real path next to them.
function projectRootMarker(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 4; i++) {
    const marker = path.join(dir, '.project_root');
    try { if (fs.statSync(marker).isFile()) return fs.readFileSync(marker, 'utf8').trim(); } catch { /* keep climbing */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const SOURCES = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    root: () => path.join(HOME, '.claude', 'projects'),
    // The folder name is the encoded project path. When it is there, read only it:
    // a working machine has thousands of session files under the other projects.
    files: (root, project) => {
      const fast = path.join(root, claudeEncoded(project));
      return isDir(fast) ? walk(fast, 1, (n) => n.endsWith('.jsonl')) : walk(root, 2, (n) => n.endsWith('.jsonl'));
    },
    // Fast path: the folder name is the encoded cwd. Fallback: the cwd recorded
    // inside the file, because that encoding is theirs to change, not ours.
    cwdOf: (f) => {
      const enc = path.basename(path.dirname(f));
      const inside = headField(f, (j) => (typeof j.cwd === 'string' ? j.cwd : null));
      return inside || (enc.includes('-') ? enc : null);
    },
    encodedHint: (project) => claudeEncoded(project),
  },
  {
    id: 'codex-cli',
    label: 'Codex CLI',
    root: () => path.join(HOME, '.codex', 'sessions'),
    files: (root) => walk(root, 5, (n) => n.endsWith('.jsonl')),
    cwdOf: (f) => headField(f, (j) => {
      if (j && j.type === 'session_meta' && j.payload && typeof j.payload.cwd === 'string') return j.payload.cwd;
      return typeof j.cwd === 'string' ? j.cwd : null;
    }),
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    root: () => path.join(HOME, '.gemini', 'tmp'),
    files: (root) => walk(root, 3, (n) => n.endsWith('.jsonl')),
    cwdOf: (f) => projectRootMarker(f),
  },
];

// A folder you name. Used for a harness with no row above, and by the tests.
function customSource(dir) {
  return {
    id: 'custom', label: `--transcripts ${dir}`, rootPath: dir,
    files: (root) => walk(root, 3, (n) => n.endsWith('.jsonl') || n.endsWith('.json')),
    cwdOf: () => null, // you pointed at it; that is the match
    always: true,
  };
}

function sessionId(file) {
  return path.basename(file)
    .replace(/\.jsonl?$/i, '')
    .replace(/^rollout-\d{4}-\d{2}-\d{2}T[\dT:-]+-/i, '')
    .replace(/^session-[\dT:-]+-/i, '')
    .slice(0, 8) || 'session';
}

// Every store this machine has, with the files that belong to THIS project and
// fall inside the window. The counts are kept so nothing can report a silent zero.
function collect(args, sinceMs) {
  const chosen = args.transcripts
    ? [customSource(path.resolve(String(args.transcripts)))]
    : SOURCES;
  if (args.transcripts && !isDir(path.resolve(String(args.transcripts)))) {
    die(`--transcripts ${args.transcripts} is not a folder.`);
  }
  const report = [];
  for (const src of chosen) {
    const rootPath = src.rootPath || src.root();
    if (!isDir(rootPath)) { report.push({ src, rootPath, installed: false, total: 0, window: 0, mine: [] }); continue; }
    const all = src.files(rootPath, ROOT);
    const inWindow = all.filter((f) => f.size > 0 && f.mtime >= sinceMs);
    const mine = [];
    for (const f of inWindow) {
      if (src.always) { mine.push({ ...f, id: sessionId(f.file), source: src.id }); continue; }
      const cwd = src.cwdOf(f.file);
      const hinted = src.encodedHint && cwd && !path.isAbsolute(cwd) && cwd === src.encodedHint(ROOT);
      if (hinted || samePath(cwd, ROOT)) mine.push({ ...f, id: sessionId(f.file), source: src.id });
    }
    mine.sort((a, b) => a.mtime - b.mtime);
    report.push({ src, rootPath, installed: true, total: all.length, window: inWindow.length, mine });
  }
  return report;
}

// ------------------------------------------------------------------ prompts

// Hook output, skill bodies, subagent briefs, tool results and a harness's own
// preamble all arrive wearing a user's face. Get this wrong and you rank your own
// injected text as if the human had typed it. Every harness does this; the tags
// differ, the problem does not.
const STRIP_TAGS = [
  'system-reminder', 'openviking-context', 'untrusted-source',
  'command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr',
  'user_instructions', 'environment_context', 'recommended_plugins', 'session_context',
  'ide_opened_files', 'editor_context', 'task-notification', 'user-prompt-submit-hook',
];
const OPEN_TAG = new RegExp(`<(?:${STRIP_TAGS.join('|')})\\b`, 'i');

const INJECTED = /^(UserPromptSubmit hook|Stop hook|PreToolUse hook|PostToolUse hook|SessionStart hook|Notification hook|SubagentStop hook|\[[a-z-]+-gate\]|Base directory for this skill:|Caveman gate:|Plain-English check:|Skills gate:|Result of calling|This session is being continued|\[SYSTEM NOTIFICATION|# AGENTS\.md|# CLAUDE\.md|Here is useful information about the environment)/m;

function cleanPrompt(t) {
  let s = String(t || '');
  for (const tag of STRIP_TAGS) {
    s = s.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
  }
  // An unclosed marker means the rest of the message is machine text.
  const open = s.search(OPEN_TAG);
  if (open >= 0) s = s.slice(0, open);
  const cut = s.search(INJECTED);
  if (cut === 0) return '';       // the WHOLE message is machine text
  if (cut > 0) s = s.slice(0, cut);
  return s.trim();
}

// content can be a string, or parts: {type:'text'}, {type:'input_text'}, {text}.
function textOfParts(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

function addUsage(t, u) {
  if (!u || typeof u !== 'object') return false;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const before = t.in + t.out + t.cacheRead + t.cacheWrite;
  t.in += n(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount);
  t.out += n(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount);
  t.cacheRead += n(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cachedContentTokenCount);
  t.cacheWrite += n(u.cache_creation_input_tokens ?? u.cache_write_input_tokens);
  return t.in + t.out + t.cacheRead + t.cacheWrite !== before;
}

const byteLen = (v) => (typeof v === 'string' ? v.length : v == null ? 0 : JSON.stringify(v).length);

// Bookkeeping records a harness writes alongside the conversation. They carry
// nothing to extract, but they ARE understood - without this list a session made
// only of them looks like a format this kit cannot read, which is a false alarm
// in exactly the place the anti-silent-zero check must stay trustworthy.
const KNOWN_NOISE = new Set([
  'system', 'summary', 'attachment', 'progress', 'file-history-snapshot', 'file-history-delta',
  'bridge-session', 'queue-operation', 'last-prompt', 'custom-title', 'agent-name', 'atis-latch',
  'session_meta', 'event_msg', 'world_state', 'compact_boundary',
]);

// One record in, zero or more facts out. Shapes are tried in order and the first
// that fits wins. A record nothing recognises is counted, not silently dropped -
// that count is what turns "no signals" into "I could not read this store".
function ingest(j, out, calls) {
  // --- Claude Code ------------------------------------------------------
  if (j.type === 'user' && j.message) {
    if (j.isMeta || j.sourceToolUseID || j.isSidechain) return true;
    if (j.toolUseResult) { result(j, out, calls); return true; }
    const text = cleanPrompt(textOfParts(j.message.content));
    // origin.kind === 'human' is the only hard proof a person typed it. A headless
    // run (a hook shelling out to the CLI) looks identical without it.
    if (text) out.prompts.push({ ts: stamp(j), text, human: !!(j.origin && j.origin.kind === 'human') });
    return true;
  }
  if (j.type === 'assistant' && j.message) {
    addUsage(out.tokens, j.message.usage);
    if (j.message.model) out.models.add(j.message.model);
    for (const b of Array.isArray(j.message.content) ? j.message.content : []) {
      if (b && b.type === 'tool_use') {
        out.tools[b.name] = (out.tools[b.name] || 0) + 1;
        if (b.id) calls.set(b.id, b.name);
      }
    }
    return true;
  }
  if (j.toolUseResult) { result(j, out, calls); return true; }

  // --- Codex CLI --------------------------------------------------------
  if (j.type === 'response_item' && j.payload) {
    const p = j.payload;
    if (p.type === 'message') {
      // role 'developer' and 'system' are the harness talking to itself.
      if (p.role !== 'user') return true;
      const text = cleanPrompt(textOfParts(p.content));
      if (text) out.prompts.push({ ts: stamp(j), text, human: false });
      return true;
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const name = p.name || 'tool';
      out.tools[name] = (out.tools[name] || 0) + 1;
      if (p.call_id) calls.set(p.call_id, name);
      return true;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      bump(out, calls.get(p.call_id) || 'unattributed', byteLen(p.output));
      return true;
    }
    if (p.type === 'reasoning') return true;
    return true;
  }
  if (j.type === 'token_usage_record' && j.payload) {
    addUsage(out.tokens, j.payload.usage || j.payload.turn_token_usage);
    if (j.payload.model) out.models.add(j.payload.model);
    return true;
  }
  if (j.type === 'turn_context' && j.payload && j.payload.model) { out.models.add(j.payload.model); return true; }
  if (typeof j.type === 'string' && KNOWN_NOISE.has(j.type)) return true;
  // A chat log's own header line (session id, start time, kind) - Gemini CLI writes one.
  if (j.sessionId && (j.startTime || j.lastUpdated) && !j.message) return true;

  // --- Gemini CLI, and any log that carries a messages array ------------
  const msgs = (j.$set && j.$set.messages) || (j.$push && j.$push.messages) || j.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue;
      const role = m.type || m.role;
      if (m.tokens) addUsage(out.tokens, m.tokens);
      if (m.model) out.models.add(m.model);
      if (role !== 'user') continue;
      const text = cleanPrompt(textOfParts(m.content ?? m.text ?? m.parts));
      if (text) out.prompts.push({ ts: m.timestamp ? Date.parse(m.timestamp) : stamp(j), text, human: false });
    }
    return true;
  }

  // --- Generic: anything with a role and some text ----------------------
  const role = j.role || (j.message && j.message.role);
  const body = j.content ?? j.text ?? (j.message && (j.message.content ?? j.message.text));
  if (role && body != null) {
    if (j.usage) addUsage(out.tokens, j.usage);
    if (role === 'user') {
      const text = cleanPrompt(textOfParts(body));
      if (text) out.prompts.push({ ts: stamp(j), text, human: false });
    }
    return true;
  }
  return false;
}

function stamp(j) {
  const t = j.timestamp || j.time || j.created_at || (j.payload && j.payload.timestamp);
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function result(j, out, calls) {
  // Size only, never content: a 45KB read nobody used is money burned every turn after.
  const bytes = byteLen(j.toolUseResult);
  bump(out, resultToolName(j, calls), bytes);
}

function bump(out, name, bytes) {
  const r = out.results[name] || (out.results[name] = { calls: 0, total: 0, max: 0 });
  r.calls++; r.total += bytes; if (bytes > r.max) r.max = bytes;
}

// Attribute a result to the call that produced it. Without the id map every
// result lands in one "unattributed" bucket, which tells you nothing about waste.
function resultToolName(j, calls) {
  const c = j.message && j.message.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      const byId = b.tool_use_id && calls.get(b.tool_use_id);
      if (byId) return byId;
      if (b.toolName) return b.toolName;
    }
  }
  const t = j.toolUseResult;
  if (t && typeof t === 'object' && t.commandName) return `Skill:${t.commandName}`;
  return 'unattributed';
}

function readSession(entry) {
  return new Promise((resolve) => {
    const out = {
      id: entry.id, file: entry.file, source: entry.source, mtime: entry.mtime,
      start: null, end: null, prompts: [], tools: {}, results: {},
      tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, models: new Set(),
      lines: 0, understood: 0,
    };
    const calls = new Map();
    let stream;
    try { stream = fs.createReadStream(entry.file); } catch { return resolve(out); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      out.lines++;
      let j; try { j = JSON.parse(line); } catch { return; }
      if (!j || typeof j !== 'object') return;
      const ts = stamp(j);
      if (ts) { if (!out.start || ts < out.start) out.start = ts; if (!out.end || ts > out.end) out.end = ts; }
      if (ingest(j, out, calls)) out.understood++;
    });
    rl.on('close', () => {
      out.models = [...out.models];
      out.prompts = humanOnly(out.prompts);
      resolve(out);
    });
    rl.on('error', () => resolve(out));
  });
}

// If the harness marks human origin, trust it and drop the rest. If it does not,
// keep everything that survived the filters except briefs that open like a system
// prompt - an older or simpler transcript degrades to a heuristic, not to nothing.
function humanOnly(prompts) {
  if (prompts.some((p) => p.human)) return prompts.filter((p) => p.human);
  return prompts.filter((p) => !/^You are (a|an|the)\b/i.test(p.text));
}

// A whole JSON array in one file (some harnesses write logs.json, not .jsonl).
async function readAny(entry) {
  if (!entry.file.toLowerCase().endsWith('.json')) return readSession(entry);
  const out = {
    id: entry.id, file: entry.file, source: entry.source, mtime: entry.mtime,
    start: null, end: null, prompts: [], tools: {}, results: {},
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, models: new Set(),
    lines: 0, understood: 0,
  };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(entry.file, 'utf8')); } catch { return out; }
  const calls = new Map();
  for (const j of Array.isArray(arr) ? arr : [arr]) {
    if (!j || typeof j !== 'object') continue;
    out.lines++;
    const ts = stamp(j);
    if (ts) { if (!out.start || ts < out.start) out.start = ts; if (!out.end || ts > out.end) out.end = ts; }
    if (ingest(j, out, calls)) out.understood++;
  }
  out.models = [...out.models];
  out.prompts = humanOnly(out.prompts);
  return out;
}

// Load every session in the window, and refuse to pretend an unreadable store is
// a quiet one. This is the whole defence against a silent zero.
async function loadSessions(args, sinceMs, what) {
  const stores = collect(args, sinceMs);
  const mine = stores.flatMap((s) => s.mine);
  if (!mine.length) {
    const lines = stores.map((s) => `  ${s.installed ? 'found' : 'not installed'}  ${s.src.label.padEnd(14)} ${s.rootPath}${s.installed ? `  (${s.total} session file(s), ${s.window} in window, 0 for this project)` : ''}`);
    die([
      `No sessions for ${ROOT} since ${iso(sinceMs)}, so there is nothing to ${what}.`,
      ...lines,
      'Run `doctor` for the full picture, or pass --transcripts <folder> if your harness stores sessions somewhere else.',
    ].join('\n'));
  }
  const sessions = [];
  for (const f of mine) sessions.push(await readAny(f));
  const readable = sessions.filter((s) => s.understood > 0);
  if (!readable.length) {
    die([
      `Found ${sessions.length} session file(s) for this project and understood none of them.`,
      'That is a format this kit cannot read, NOT a quiet window - a clean empty report here would be a lie.',
      `Newest file: ${mine[mine.length - 1].file}`,
      'Run `doctor`, and if your harness is new, add a row to SOURCES in this file.',
    ].join('\n'));
  }
  return { sessions, stores, skipped: sessions.length - readable.length };
}

// ------------------------------------------------------------------ corrections

// Each pattern is one SHAPE of friction, not one subsystem. The shape is what
// repeats; the subsystem is what disguises the repeat as ten separate one-offs.
const SHAPES = [
  { id: 'flat-no', label: 'plain no / wrong', re: /^(no|nope|wrong|incorrect)\b|\bthat'?s (wrong|not right|not what)\b|\bthat is wrong\b/i },
  { id: 'still', label: 'still broken after a fix', re: /\bstill (broken|not working|doesn'?t|does not|wrong|failing|there|the same)\b|\bit'?s still\b|\bstill cant?\b/i },
  { id: 'cant-see', label: 'cannot see the change', re: /\b(i )?(can'?t|cannot|dont|don'?t) see\b|\bnothing (changed|happened)\b|\bwhere is it\b/i },
  { id: 'redo', label: 'told again to do the same thing', re: /\b(i (already )?(said|told you|asked)|as i said|like i said|again[,.!])/i },
  // "do not stop" and "keep going" are the opposite instruction and must never
  // count as friction. A pattern that fires on encouragement is worse than none.
  { id: 'stop', label: 'told to stop / undo', re: /\b(stop (doing|touching|editing|that)|don'?t do that|undo that|revert that|put it back)\b/i, not: /\b(do ?n'?t stop|do not stop|never stop|keep going|without stopping)\b/i },
  { id: 'scope', label: 'went outside what was asked', re: /\b(i (didn'?t|did not) ask|who (told|asked) you|why did you (touch|change|edit)|out of scope|unrequested)\b/i },
  { id: 'unverified', label: 'claimed done without proof', re: /\b(did you (test|verify|check)|you didn'?t (test|verify|check)|prove it|show me|screenshot)\b/i },
  { id: 'lie', label: 'report did not match reality', re: /\b(that'?s a lie|you lied|not true|you said it (was|is) (done|fixed|working))\b/i },
  { id: 'slow', label: 'too slow / too long', re: /\b(too (slow|long)|taking forever|why is this taking|hurry)\b/i },
  { id: 'anger', label: 'anger (any cause)', re: /\b(fuck|shit|wtf|christ|bloody hell|god damn|goddamn)/i },
  { id: 'repeat-q', label: 'question asked twice', re: /\b(i asked you|answer the question|you didn'?t answer)\b/i },
  { id: 'cost', label: 'money or tokens wasted', re: /\b(wast(e|ed|ing)|burn(ed|ing)? (through )?(tokens|credits|money)|too expensive)\b/i },
];

function shapesIn(text) {
  const t = text.length > MAX_MATCH_CHARS ? text.slice(0, MAX_MATCH_CHARS) : text;
  const hits = [];
  for (const s of SHAPES) if (s.re.test(t) && !(s.not && s.not.test(t))) hits.push(s);
  return hits;
}

// ------------------------------------------------------------------ dates
//
// Local, not UTC. A session at 11pm belongs to the day the human had, and a UTC
// bucket invents unreflected days that never happened.

const pad = (n) => String(n).padStart(2, '0');
function iso(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : NaN;
}

// ------------------------------------------------------------------ reports

function reportFiles() {
  if (!isDir(STORE)) return [];
  return safeReaddir(STORE).filter((f) => /^REFLECTION-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
}
function lastReportDate() { const f = reportFiles().pop(); return f ? f.slice(11, 21) : null; }

function loadWatchlist() {
  const p = watchlistPath();
  if (!fs.existsSync(p)) return { items: [] };
  let w;
  // A broken file must not read as an empty one, or one typo silently wipes every
  // fix you were tracking and the next run reports nothing to do.
  try { w = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`Watchlist at ${rel(p)} is not valid JSON: ${e.message}`); }
  const items = Array.isArray(w) ? w : (w && Array.isArray(w.items) ? w.items : null);
  if (!items) die(`Watchlist at ${rel(p)} must be an array, or an object with an "items" array.`);
  return { items: items.map((item, i) => validateItem(item, i, p)) };
}

// Every field that could make the scoreboard lie, checked by name. A missing date
// used to become NaN, which quietly matched nothing and scored the fix as clean.
function validateItem(item, i, file) {
  const where = `watchlist item #${i + 1} in ${rel(file)}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) die(`${where} is not an object.`);
  if (typeof item.id !== 'string' || !item.id.trim()) die(`${where} needs an "id" string.`);
  if (!Number.isFinite(parseDay(item.added))) die(`${where} ("${item.id}") needs "added" as YYYY-MM-DD; got ${JSON.stringify(item.added)}. A date this tool cannot read would score the fix as clean.`);
  if (parseDay(item.added) > Date.now() + DAY) die(`${where} ("${item.id}") is dated in the future: ${item.added}.`);
  if (item.watch != null && !Array.isArray(item.watch)) die(`${where} ("${item.id}") needs "watch" to be an array of phrases.`);
  for (const w of item.watch || []) if (typeof w !== 'string' || !w.trim()) die(`${where} ("${item.id}") has a watch phrase that is not a non-empty string.`);
  if (item.artifact != null && typeof item.artifact !== 'string') die(`${where} ("${item.id}") needs "artifact" to be a path string.`);
  return item;
}

function toMatcher(pat) {
  const m = /^\/(.*)\/([a-z]*)$/.exec(pat);
  if (m) { try { return new RegExp(m[1], m[2] || 'i'); } catch { /* not a regex after all */ } }
  return new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

// ------------------------------------------------------------------ doctor

async function cmdDoctor(args) {
  const sinceMs = Date.now() - Number(args.days || 90) * DAY;
  const stores = collect(args, sinceMs);
  const rows = [];
  for (const s of stores) {
    const row = { source: s.src.id, label: s.src.label, root: s.rootPath, installed: s.installed, files: s.total, in_window: s.window, for_this_project: s.mine.length, newest: null, readable: null, note: '' };
    if (s.mine.length) {
      const newest = s.mine[s.mine.length - 1];
      row.newest = iso(newest.mtime);
      const probe = await readAny(newest);
      row.readable = probe.understood > 0;
      row.note = probe.understood > 0
        ? `${probe.understood}/${probe.lines} record(s) understood, ${probe.prompts.length} typed prompt(s) in the newest file`
        : `UNREADABLE - ${probe.lines} record(s), none in a shape this kit knows`;
    } else if (s.installed) row.note = 'installed, but no session in this window belongs to this project';
    else row.note = 'not installed on this machine';
    rows.push(row);
  }
  const wl = fs.existsSync(watchlistPath());
  const usable = rows.filter((r) => r.readable === true);

  if (args.json) {
    console.log(JSON.stringify({ node: NODE_VERSION, platform: process.platform, project: ROOT, store: STORE, watchlist: wl, sources: rows, usable: usable.length }, null, 2));
    if (!usable.length) process.exitCode = 1;
    return;
  }
  head('SETUP');
  line(`node        ${NODE_VERSION} on ${process.platform}`);
  line(`project     ${ROOT}`);
  line(`store       ${STORE}${isDir(STORE) ? '' : '  (does not exist yet - you create it, this tool never writes)'}`);
  line(`reports     ${reportFiles().length}   watchlist: ${wl ? `${loadWatchlist().items.length} item(s)` : 'none yet'}`);
  head(`SESSION STORES (window: last ${Number(args.days || 90)} days)`);
  for (const r of rows) {
    line(`${r.label.padEnd(14)} ${r.installed ? `${String(r.files).padStart(5)} file(s)` : '    -    '}  this project: ${String(r.for_this_project).padStart(4)}${r.newest ? `  newest ${r.newest}` : ''}`);
    line(`${''.padEnd(14)} ${r.root}`);
    line(`${''.padEnd(14)} ${r.note}`);
  }
  head('VERDICT');
  if (usable.length) {
    line(`${usable.length} store(s) readable. scan and score will work.`);
  } else {
    line('Nothing readable for this project.');
    line('Either you are not in the folder you work in, or your harness keeps sessions somewhere this kit has no row for.');
    line('Point it straight at them:  node reflect.mjs scan --transcripts <folder of .jsonl/.json>');
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------ scan

async function cmdScan(args) {
  const last = args.since ? String(args.since) : lastReportDate();
  if (args.since && !Number.isFinite(parseDay(args.since))) die(`--since needs YYYY-MM-DD; got "${args.since}".`);
  let days = 0;
  if (args.days !== undefined) {
    days = Number(args.days);
    if (!Number.isFinite(days) || days <= 0) die(`--days needs a positive number; got "${args.days}".`);
  }
  const sinceMs = days ? Date.now() - days * DAY
    : (last && Number.isFinite(parseDay(last))) ? parseDay(last) : Date.now() - 14 * DAY;

  const { sessions, stores, skipped } = await loadSessions(args, sinceMs, 'reflect on');

  // Coverage: which days had sessions, which of those a report already covers.
  // Bucket by LAST activity: a session resumed today started weeks ago, and dating
  // it by its first line invents unreflected days that never happened.
  const dayset = new Map();
  for (const s of sessions) dayset.set(iso(s.mtime || s.end || s.start || Date.now()), 1);
  const covered = new Set(reportFiles().map((f) => f.slice(11, 21)));
  const uncovered = [...dayset.keys()].filter((d) => !covered.has(d)).sort();

  const byShape = new Map();
  for (const s of sessions) {
    for (const p of s.prompts) {
      if (p.ts && p.ts < sinceMs) continue; // a long session reaches back past the window
      for (const sh of shapesIn(p.text)) {
        const g = byShape.get(sh.id) || { shape: sh, count: 0, sessions: new Set(), quotes: [] };
        g.count++; g.sessions.add(s.id);
        if (g.quotes.length < 3) g.quotes.push({ id: s.id, day: iso(p.ts || s.mtime), text: oneLine(p.text) });
        byShape.set(sh.id, g);
      }
    }
  }
  // Anger says the temperature, never the cause, so it never leads the list.
  const ranked = [...byShape.values()].sort((a, b) => {
    const ax = a.shape.id === 'anger' ? 1 : 0, bx = b.shape.id === 'anger' ? 1 : 0;
    return ax - bx || b.sessions.size - a.sessions.size || b.count - a.count;
  });

  const tot = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const results = new Map();
  let prompts = 0;
  for (const s of sessions) {
    prompts += s.prompts.length;
    for (const k of Object.keys(tot)) tot[k] += s.tokens[k];
    for (const [name, r] of Object.entries(s.results)) {
      const g = results.get(name) || { calls: 0, total: 0, max: 0 };
      g.calls += r.calls; g.total += r.total; if (r.max > g.max) g.max = r.max;
      results.set(name, g);
    }
  }
  const fattest = [...results.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  const read = stores.filter((s) => s.mine.length).map((s) => ({ source: s.src.id, label: s.src.label, sessions: s.mine.length }));

  const data = {
    window: { since: iso(sinceMs), until: iso(Date.now()), sessions: sessions.length, days: dayset.size, prompts },
    read_from: read, unreadable_sessions: skipped,
    never_reflected: uncovered,
    signals: ranked.map((g) => ({ shape: g.shape.id, label: g.shape.label, hits: g.count, sessions: [...g.sessions], quotes: g.quotes })),
    spend: tot,
    biggest_results: fattest.map(([name, r]) => ({ tool: name, calls: r.calls, total_bytes: r.total, max_bytes: r.max })),
    watchlist_items: loadWatchlist().items.length,
  };
  if (args.json) return console.log(JSON.stringify(data, null, 2));

  head('READ FROM');
  for (const r of read) line(`${r.label.padEnd(14)} ${r.sessions} session(s)`);
  if (skipped) line(`NOTE          ${skipped} session file(s) were in a shape this kit could not read and were skipped.`);
  if (!prompts) line('NOTE          0 typed prompts survived the machine-text filters. Check `doctor` before believing a clean scan.');

  head('COVERAGE');
  line(`window        ${data.window.since} -> ${data.window.until}`);
  line(`sessions      ${data.window.sessions} across ${data.window.days} day(s), ${prompts} typed prompt(s)`);
  line(`no report yet ${uncovered.length ? uncovered.join(', ') : 'none - every day in range has a report'}`);
  if (uncovered.length > 2) line(`NOTE          ${uncovered.length} unreflected days usually means the habit lapsed, not that nothing happened.`);

  head('SIGNALS (grouped by shape of mistake, ranked by how many sessions repeat it)');
  if (!ranked.length) line('none matched. Either a clean window, or the patterns miss how you talk - edit SHAPES in this file.');
  for (const g of ranked) {
    line(`x${String(g.count).padEnd(3)} ${g.shape.label.padEnd(34)} ${g.sessions.size} session(s)`);
    for (const q of g.quotes) line(`      ${q.day} ${q.id}  "${q.text}"`);
  }

  head('SPEND');
  line(`tokens  in ${fmt(tot.in)}  out ${fmt(tot.out)}  cache-read ${fmt(tot.cacheRead)}  cache-write ${fmt(tot.cacheWrite)}`);
  line('(no dollar estimate on purpose - prices change and a made-up number is worse than none)');
  line('(harnesses count tokens differently; treat this as a trend, not a bill)');

  head('BIGGEST TOOL RESULTS (read once, paid for every turn after)');
  if (!fattest.length) line('none recorded by this harness.');
  for (const [name, r] of fattest) line(`${name.padEnd(22)} ${r.calls} call(s)  total ${kb(r.total)}  largest ${kb(r.max)}`);

  head('NEXT');
  line('1. Group the signals above into families - same shape, different subsystem.');
  line('2. Pick fixes by: how often it repeats, how much it costs you, how cheap the fix is.');
  line('3. For each accepted fix add a watchlist entry, or `score` can never tell you if it worked.');
}

// ------------------------------------------------------------------ score

// The feature no other reflection tool has: go back and check whether a fix
// actually stopped its mistake, and refuse to credit a fix whose test could
// never have failed in the first place.
async function cmdScore(args) {
  const wl = loadWatchlist();
  if (!wl.items.length) die(`No watchlist at ${rel(watchlistPath())}. Every accepted fix needs an entry, or this tool is just opinions.`);

  const added = wl.items.map((i) => parseDay(i.added));
  const oldest = Math.min(...added);
  const span = Math.max(...added.map((a) => Date.now() - a));
  const { sessions } = await loadSessions(args, oldest - span - DAY, 'score');

  const prompts = [];
  for (const s of sessions) for (const p of s.prompts) prompts.push({ ts: p.ts || s.mtime, text: p.text, id: s.id });

  const rows = [];
  for (const item of wl.items) {
    const at = parseDay(item.added);
    const afterDays = Math.max(1, Math.round((Date.now() - at) / DAY));
    const beforeStart = at - afterDays * DAY;
    const matchers = (item.watch || []).map(toMatcher);
    const hit = (p) => matchers.some((m) => m.test(p.text.length > MAX_MATCH_CHARS ? p.text.slice(0, MAX_MATCH_CHARS) : p.text));

    const before = prompts.filter((p) => p.ts >= beforeStart && p.ts < at && hit(p));
    const after = prompts.filter((p) => p.ts >= at && hit(p));
    const sessionsAfter = new Set(prompts.filter((p) => p.ts >= at).map((p) => p.id)).size;
    const beforeRate = before.length / afterDays;
    const afterRate = after.length / afterDays;
    const artifactOk = !item.artifact || fs.existsSync(path.resolve(ROOT, item.artifact));

    let verdict, advice;
    if (!artifactOk) { verdict = 'NOT BUILT'; advice = 'accepted last time, never created. Build it before ranking anything new.'; }
    else if (!matchers.length) { verdict = 'NO WATCH'; advice = 'no phrases to look for. Add some or delete the entry.'; }
    else if (!sessionsAfter) { verdict = 'NO DATA'; advice = 'no sessions since the fix landed. Come back later.'; }
    else if (before.length === 0) { verdict = 'UNFALSIFIABLE'; advice = 'these phrases never fired even BEFORE the fix, so a clean result proves nothing. Rewrite the watch using the words actually used at the time.'; }
    else if (after.length === 0) { verdict = 'WORKED'; advice = `${before.length} hit(s) before, 0 since.`; }
    else if (afterRate <= beforeRate * 0.5) { verdict = 'IMPROVED'; advice = `${before.length} -> ${after.length} over ${afterDays} day(s). Halved, not gone.`; }
    else { verdict = 'STILL RECURRING'; advice = `${before.length} -> ${after.length}. The fix did not work. Escalate it one rung instead of leaving it on the books.`; }

    rows.push({ id: item.id, fix: item.fix, artifact: item.artifact || null, added: item.added, before: before.length, after: after.length, days: afterDays, verdict, advice, recent: after.slice(-2).map((p) => ({ id: p.id, text: oneLine(p.text) })) });
  }

  if (args.json) {
    console.log(JSON.stringify({ items: rows }, null, 2));
    if (rows.some((r) => r.verdict === 'STILL RECURRING' || r.verdict === 'NOT BUILT' || r.verdict === 'UNFALSIFIABLE')) process.exitCode = 1;
    return;
  }
  head('SCOREBOARD - did past fixes actually stop their mistake?');
  for (const r of rows) {
    line(`${r.verdict.padEnd(16)} ${r.id}  ${r.fix || ''}`);
    line(`${''.padEnd(16)} since ${r.added}: ${r.before} before -> ${r.after} after (${r.days} day window each side)`);
    line(`${''.padEnd(16)} ${r.advice}`);
    for (const q of r.recent) line(`${''.padEnd(16)} recent: ${q.id} "${q.text}"`);
    line('');
  }
  const bad = rows.filter((r) => r.verdict === 'STILL RECURRING' || r.verdict === 'NOT BUILT' || r.verdict === 'UNFALSIFIABLE');
  head('READ THIS');
  line(bad.length
    ? `${bad.length} item(s) need action before you accept anything new. An unbuilt or failed fix outranks every fresh idea - it is already proven to matter.`
    : 'Every tracked fix is holding. New candidates are safe to rank.');
  if (bad.length) process.exitCode = 1;
}

// ------------------------------------------------------------------ prove

// A rule you never watched refuse anything is decoration. Run the guard twice:
// once on input that MUST be refused, once on input that MUST pass.
//
// It runs the command you give it, with your shell, as you. That is the whole
// point of the command, and it is the only thing in this kit that executes anything.
async function cmdProve(args) {
  const cmd = args.cmd;
  if (typeof cmd !== 'string' || !cmd.trim()) die('prove needs --cmd "<command>", plus --deny-input/--deny-file and --allow-input/--allow-file.');
  const denyIn = typeof args['deny-input'] === 'string' ? args['deny-input'] : readMaybe(args['deny-file']);
  const allowIn = typeof args['allow-input'] === 'string' ? args['allow-input'] : readMaybe(args['allow-file']);
  if (denyIn == null || allowIn == null) die('prove needs BOTH sides: the case that must be refused and the case that must pass.');
  let timeout = Number(args.timeout || 30000);
  if (!Number.isFinite(timeout) || timeout <= 0) die(`--timeout needs a positive number of milliseconds; got "${args.timeout}".`);

  let denyMatch = /\b(deny|denied|block|blocked|refus|error|fail)/i;
  if (args['deny-match']) {
    try { denyMatch = new RegExp(String(args['deny-match']), 'i'); }
    catch (e) { die(`--deny-match is not a valid regular expression: ${e.message}`); }
  }
  const d = await runGuard(cmd, denyIn, timeout);
  const a = await runGuard(cmd, allowIn, timeout);

  // A command that cannot start, or one that never finishes, looks exactly like a
  // strict guard: no zero exit, angry text. Catch both first, or a typo and a hang
  // certify themselves as security.
  const CRASH = /Cannot find module|SyntaxError|is not recognized|command not found|No such file|Permission denied|ENOENT/i;
  const broke = [d, a].find((r) => r.spawnError || CRASH.test(r.out));
  if (broke) {
    head('THE COMMAND DID NOT RUN');
    line(`exit ${d.code} / ${a.code}: ${oneLine(broke.out, 200)}`);
    line('Fix the command first. A broken command refuses everything, which is not the same as a working guard.');
    process.exitCode = 1;
    return;
  }
  const hung = [d, a].find((r) => r.timedOut);
  if (hung) {
    head('THE COMMAND DID NOT FINISH');
    line(`killed after ${timeout}ms. A guard that hangs is not a guard that refuses - it is a guard that stops your work.`);
    line(`last output: ${oneLine(hung.out, 200) || '(silent)'}`);
    line('Raise --timeout only if the guard is genuinely slow; otherwise fix the hang.');
    process.exitCode = 1;
    return;
  }

  const deniedBad = d.code !== 0 || denyMatch.test(d.out);
  const allowedGood = a.code === 0 && !denyMatch.test(a.out);

  head('PROOF THAT THE GUARD BITES');
  line(`command       ${cmd}`);
  line(`must refuse   exit ${d.code}  ${deniedBad ? 'REFUSED  ok' : 'LET IT THROUGH  <-- the guard does nothing'}`);
  if (d.out.trim()) line(`              said: ${oneLine(d.out, 150)}`);
  line(`must pass     exit ${a.code}  ${allowedGood ? 'PASSED  ok' : 'ALSO REFUSED  <-- the guard blocks everything, which is the same as broken'}`);
  if (a.out.trim()) line(`              said: ${oneLine(a.out, 150)}`);
  const pass = deniedBad && allowedGood;
  head(pass ? 'PASS - it refused the bad case and allowed the good one.' : 'FAIL - do not report this rule as installed.');
  if (!pass) process.exitCode = 1;
}

// spawnSync's timeout kills the shell but not its children, and then blocks
// forever on a pipe the grandchild still holds. So: async, kill the whole tree,
// and give up on the pipes if they never close.
function runGuard(cmd, input, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, { shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) { return resolve({ code: null, out: String(e && e.message), spawnError: true }); }

    let out = '', done = false, timedOut = false;
    const CAP = 262144; // a chatty guard must not be able to exhaust memory
    const take = (d) => { if (out.length < CAP) out += d.toString(); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.stdin.on('error', () => { /* guard that never reads stdin */ });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(hard); resolve(r); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    // If even the kill leaves a pipe open, stop waiting rather than hang.
    const hard = setTimeout(() => finish({ code: null, out, timedOut: true }), timeoutMs + 5000);
    child.on('error', (e) => finish({ code: null, out: `${out}${e && e.message}`, spawnError: true }));
    child.on('close', (code) => finish({ code, out, timedOut }));
    try { child.stdin.end(input); } catch { /* already gone */ }
  });
}

function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
}

function readMaybe(p) { if (typeof p !== 'string') return null; try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// ------------------------------------------------------------------ lint

const REQUIRED = ['Coverage', 'Carried over', 'Scoreboard', 'Signals', 'Families', 'Verdicts', 'Not proposing', 'State'];

function cmdLint(args) {
  const file = args._[0] ? path.resolve(ROOT, args._[0]) : path.join(STORE, `REFLECTION-${iso(Date.now())}.md`);
  if (!fs.existsSync(file)) die(`No report at ${rel(file)}.`);
  const text = fs.readFileSync(file, 'utf8');
  const required = typeof args.sections === 'string'
    ? args.sections.split(',').map((s) => s.trim()).filter(Boolean)
    : REQUIRED;
  const problems = [];

  for (const h of required) {
    if (!section(text, h, true)) problems.push(`missing section: ${h} (an empty section says "none"; a deleted one hides the question)`);
  }
  if (!/\b[0-9a-f]{8}\b/.test(text)) problems.push('cites no session id - a report with no evidence is a story');

  const verdicts = section(text, 'Verdicts');
  for (const m of verdicts.matchAll(/`([^`\n]+\.(?:mjs|js|cjs|ts|py|sh|ps1|md|json|toml|yaml|yml))`/g)) {
    const p = m[1];
    if (!fs.existsSync(path.resolve(ROOT, p))) problems.push(`promises a file that does not exist: ${p}`);
  }
  const claims = /\b(fixed|installed|enforced|guarded|prevented)\b/i.test(verdicts);
  if (claims && !/prove|refus|denied|blocked|negative control|watched it/i.test(text)) {
    problems.push('claims a rule is enforced but never shows it refusing anything - run `prove` and paste the result');
  }

  if (args.json) {
    console.log(JSON.stringify({ file, ok: !problems.length, problems }, null, 2));
    if (problems.length) process.exitCode = 1;
    return;
  }
  head(`LINT ${rel(file)}`);
  if (!problems.length) return line('clean.');
  for (const p of problems) line(`- ${p}`);
  process.exitCode = 1;
}

// Everything under a heading, up to the next heading or the end of the file.
// This used to be one regex ending in \Z, which JavaScript does not have: the
// LAST section of any report came back empty, so every check that read it - the
// ghost-file check, the unproven-"enforced" check - silently passed.
function section(text, name, existsOnly = false) {
  const re = new RegExp(`^#{1,6}[ \\t]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*$`, 'im');
  const m = re.exec(text);
  if (!m) return '';
  if (existsOnly) return ' ';
  const rest = text.slice(m.index + m[0].length);
  const next = /^#{1,6}[ \t]/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// ------------------------------------------------------------------ prune

// The subtract channel. Rules only ever get added, and a rule file too long to
// read absorbs the next line with no effect at all.
function cmdPrune(args) {
  const files = (args._.length ? args._.map((f) => path.resolve(ROOT, f)) : defaultRuleFiles()).filter((f) => fs.existsSync(f));
  if (!files.length) die(`No rule files found. Pass paths: prune CLAUDE.md AGENTS.md .cursor/rules/*.md`);

  const dead = [], dupes = [], stats = [];
  const all = [];
  let capped = false;
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    stats.push({ file: rel(f), lines: lines.length, words: text.split(/\s+/).filter(Boolean).length });
    // A path inside a fenced example is an example, not a rule pointing at a file.
    let fenced = false;
    lines.forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) { fenced = !fenced; return; }
      if (fenced) return;
      for (const m of ln.matchAll(/[`"']([\w./\\-]+\.(?:mjs|js|cjs|ts|py|sh|ps1|md|json|toml|yaml|yml))[`"']/g)) {
        if (!fs.existsSync(path.resolve(ROOT, m[1])) && !fs.existsSync(path.resolve(path.dirname(f), m[1]))) {
          dead.push({ file: rel(f), line: i + 1, ref: m[1] });
        }
      }
      const norm = ln.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (norm.split(' ').length >= 6) {
        if (all.length < MAX_PRUNE_LINES) all.push({ file: rel(f), line: i + 1, norm, raw: ln.trim() });
        else capped = true;
      }
    });
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (similarity(all[i].norm, all[j].norm) >= 0.8) dupes.push([all[i], all[j]]);
    }
  }

  if (args.json) return console.log(JSON.stringify({ stats, dead, dupes, capped }, null, 2));
  head('RULE FILES');
  for (const s of stats) line(`${s.file.padEnd(46)} ${s.lines} lines, ${s.words} words (paid on every single turn)`);
  head('POINTS AT SOMETHING THAT NO LONGER EXISTS');
  if (!dead.length) line('none.');
  for (const d of dead) line(`${d.file}:${d.line}  ${d.ref}`);
  head('NEAR DUPLICATES (same rule twice = neither gets read)');
  if (capped) line(`NOTE: only the first ${MAX_PRUNE_LINES} substantial lines were compared, to keep this instant.`);
  if (!dupes.length) line('none.');
  for (const [a, b] of dupes.slice(0, 20)) {
    line(`${a.file}:${a.line} ~ ${b.file}:${b.line}`);
    line(`   "${oneLine(a.raw, 90)}"`);
    line(`   "${oneLine(b.raw, 90)}"`);
  }
  head('NEXT');
  line('Delete before adding. Every line above is rent you pay on every turn of every session.');
}

// Every harness keeps its standing instructions in a file like these. Missing
// ones are skipped, so this list costs nothing when your harness is not here.
function defaultRuleFiles() {
  const out = [
    path.join(ROOT, 'CLAUDE.md'), path.join(ROOT, 'AGENTS.md'), path.join(ROOT, 'GEMINI.md'),
    path.join(ROOT, '.cursorrules'), path.join(ROOT, '.windsurfrules'),
    path.join(ROOT, '.github', 'copilot-instructions.md'),
    path.join(HOME, '.claude', 'CLAUDE.md'), path.join(HOME, '.codex', 'AGENTS.md'), path.join(HOME, '.gemini', 'GEMINI.md'),
  ];
  for (const d of [path.join(ROOT, '.claude', 'rules'), path.join(ROOT, '.cursor', 'rules'), path.join(ROOT, '.github', 'instructions')]) {
    if (isDir(d)) for (const f of safeReaddir(d)) if (/\.(md|mdc)$/i.test(f)) out.push(path.join(d, f));
  }
  return out;
}

function similarity(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ------------------------------------------------------------------ shared

const head = (s) => console.log(`\n== ${s}`);
const line = (s) => console.log(s);
const fmt = (n) => n.toLocaleString('en-US');
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const rel = (p) => path.relative(ROOT, p) || p;
const oneLine = (s, n = 110) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}...` : t; };
function die(msg) { console.error(msg); process.exit(2); }

// Flags that take a value ALWAYS consume the next token, even one starting with
// a dash, so --deny-input "--force" is not read as two flags. --key=value works too.
const VALUE_FLAGS = new Set(['project', 'transcripts', 'store', 'days', 'since', 'cmd', 'deny-input', 'allow-input', 'deny-file', 'allow-file', 'deny-match', 'timeout', 'sections']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    if (VALUE_FLAGS.has(k)) {
      if (i + 1 >= argv.length) die(`--${k} needs a value.`);
      out[k] = argv[++i];
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[k] = true;
    else { out[k] = next; i++; }
  }
  return out;
}

const HELP = `reflect.mjs - make a coding agent stop repeating itself, and prove that it did.

Works with any agent that keeps a session log, and any model provider. Reads
Claude Code, Codex CLI and Gemini CLI where they store sessions; for anything
else, point --transcripts at the folder. It never writes to your project and
never touches the network.

  node reflect.mjs doctor [--json]
      What it can see: every session store, how many sessions belong to this
      project, and whether it can actually parse them. Run this first.

  node reflect.mjs scan  [--days N | --since YYYY-MM-DD] [--json]
      What happened since the last reflection: unreflected days, corrections
      grouped by shape, spend, and the tool results that cost the most.

  node reflect.mjs score [--json]
      Go back over every fix in <store>/watchlist.json and count whether its
      mistake still happens. Flags a watch that could never have failed.
      Exits 1 while anything is unbuilt, unfalsifiable or still recurring.

  node reflect.mjs prove --cmd "<command>" --deny-file bad.json --allow-file good.json
      Run a new guard against a case it MUST refuse and one it MUST allow.
      Exits 1 unless both hold. Runs the command you give it, as you.
      No guard counts as installed without this.

  node reflect.mjs lint [report.md] [--sections A,B,C] [--json]
      Every section present, every promised file real, at least one session
      cited, no "enforced" claim without proof. Exits 1 on any failure.

  node reflect.mjs prune [files...] [--json]
      Rules pointing at deleted files, and rules written twice.

  --project <path>      reflect on another project instead of the current folder
  --transcripts <path>  read session files from a folder you name
  --store <path>        where reports and watchlist.json live
                        (default: .reflections/, or .claude/reflections/ if it exists)

Exit codes: 0 fine, 1 the report failed its own check, 2 it could not run.
`;

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
if (typeof args.project === 'string') {
  ROOT = path.resolve(args.project);
  if (!isDir(ROOT)) die(`--project ${args.project} is not a folder.`);
}
STORE = resolveStore(args);
const table = { doctor: cmdDoctor, scan: cmdScan, score: cmdScore, prove: cmdProve, lint: cmdLint, prune: cmdPrune };
if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
if (!table[cmd]) { console.error(`Unknown command: ${cmd}\n`); console.log(HELP); process.exit(2); }
await table[cmd](args);
