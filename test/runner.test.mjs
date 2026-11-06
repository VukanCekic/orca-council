// The council runner (runner/council.mjs) with stand-in engines: no AI usage. Each run gets its own temp folder.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { completeAnswer } from '../runner/engines.mjs'
import { readCouncilView } from '../lib/council-view.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, '..', 'runner', 'council.mjs')

function council(args, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-test-'))
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--dry-run', '--no-open', '--root', root], {
    encoding: 'utf8', env: { ...process.env, COUNCIL_FAKE_PACE: '', COUNCIL_FAKE_SLOW: '', COUNCIL_FAKE_FAIL: '', COUNCIL_BLOCKED: '', ...env }, timeout: 120000
  })
  const dirs = fs.readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}-/.test(d))
  const dir = dirs.length ? path.join(root, dirs[0]) : null
  const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8')
  const json = (p) => JSON.parse(read(p))
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, root, dir, read, json, seconds: (Date.now() - t0) / 1000 }
}

test('full council: unique labels, sealed mapping never reaches the chair, names redacted in the chair copy only', () => {
  const c = council(['decision', 'Should we cache with Redis?'])
  assert.equal(c.code, 0, c.stderr)
  const sealed = c.json('sealed.json').mapping
  assert.deepEqual(Object.keys(sealed).sort(), ['A', 'B', 'C'])
  assert.deepEqual(Object.values(sealed).sort(), ['agy', 'claude', 'codex'])
  const chairIn = c.read('raw/chair-input.md')
  assert.ok(!chairIn.includes('sealed') && !chairIn.includes('"mapping"'))
  assert.ok(!/Anthropic|OpenAI|Antigravity/.test(chairIn), 'self-identification redacted for the chair')
  assert.ok(/Anthropic|OpenAI|Antigravity/.test(['A', 'B', 'C'].map(l => c.read(`answers/${l}.md`)).join('')), 'answers on disk keep the original text')
  const verdict = c.read('verdict.md')
  assert.match(verdict, /## Unsealed \(after the chair finished\)/)
  assert.match(verdict.trimEnd().split('\n').pop(), /^FAVOURED: (A|B|C|none)$/)
  const line = JSON.parse(fs.readFileSync(path.join(c.root, 'index.jsonl'), 'utf8').trim())
  assert.equal(line.status, 'ok')
  assert.equal(line.members.length, 3)
})

test('live status, view files and live.json end in a clean done state the Council tab can read', () => {
  const c = council(['decision', 'Status test'])
  const s = c.json('raw/status.json')
  assert.equal(s.state, 'done'); assert.equal(s.phase, 'verdict'); assert.equal(s.chair.state, 'done')
  for (const m of s.members) { assert.equal(m.state, 'done'); assert.ok(m.seconds >= 0); assert.ok(m.tldr); assert.ok(m.model) }
  assert.deepEqual(Object.keys(s.verdict.mapping).sort(), ['A', 'B', 'C'])
  for (const e of ['claude', 'codex', 'agy']) assert.ok(c.read(`raw/${e}.out.txt`).trim().startsWith('{'))
  assert.equal(c.json('council.view').dir, c.dir)
  const live = JSON.parse(fs.readFileSync(path.join(c.root, 'live.view'), 'utf8'))
  assert.equal(live.follow, c.root)
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.root, 'live.json'), 'utf8')).dir, path.basename(c.dir))
  const leftovers = fs.readdirSync(c.root, { recursive: true }).filter(f => /\.tmp-/.test(f))
  assert.deepEqual(leftovers, [])
  // The plugin's reader on the runner's real output: what the tab shows.
  const v = readCouncilView({ follow: c.root }, path.dirname(c.root))
  assert.equal(v.ok, true); assert.equal(v.state, 'done'); assert.equal(v.members.length, 3)
  assert.ok(v.verdict && v.verdict.tldr && v.verdict.favouredEngine)
})

test('a member that hangs is killed at the timeout and the council goes on with two answers', () => {
  const c = council(['decision', 'Timeout test', '--timeout', '0.05'], { COUNCIL_FAKE_SLOW: 'agy' })
  assert.equal(c.code, 0, c.stderr)
  assert.ok(c.seconds < 60, `took ${c.seconds}s`)
  const agy = c.json('raw/status.json').members.find(m => m.engine === 'agy')
  assert.equal(agy.state, 'timeout')
  assert.deepEqual(Object.keys(c.json('sealed.json').mapping).sort(), ['A', 'B'])
  assert.match(c.read('verdict.md'), /2 of 3 members answered/)
})

test('facts Lite runs codex alone and asks the chair to triage; --full runs all three', () => {
  const lite = council(['facts', 'The moon is cheese.'])
  assert.equal(lite.code, 0, lite.stderr)
  assert.deepEqual(lite.json('raw/status.json').members.map(m => m.engine), ['codex'])
  assert.match(lite.read('raw/chair-input.md'), /Triage its findings/)
  const full = council(['facts', 'The moon is cheese.', '--full'])
  assert.equal(full.json('raw/status.json').members.length, 3)
})

test('nobody answers: exit 2, failed status, usage limit flagged', () => {
  const c = council(['decision', 'Fail test'], { COUNCIL_FAKE_FAIL: 'claude,codex,agy' })
  assert.equal(c.code, 2)
  const s = c.json('raw/status.json')
  assert.equal(s.state, 'failed'); assert.equal(s.chair.state, 'skipped')
  assert.ok(s.members.every(m => m.state === 'failed' && m.limitHit))
  assert.match(c.read('verdict.md'), /FAVOURED: none/)
})

test('--members and COUNCIL_BLOCKED choose who sits; skipped members are named in the verdict', () => {
  const two = council(['decision', 'Two members', '--members', 'claude,codex'])
  assert.deepEqual(two.json('raw/status.json').members.map(m => m.engine), ['claude', 'codex'])
  const blocked = council(['decision', 'Blocked', '--members', 'claude,codex,agy'], { COUNCIL_BLOCKED: 'agy' })
  assert.match(blocked.read('verdict.md'), /\*\*agy\*\*: skipped/)
  assert.deepEqual(blocked.json('raw/status.json').skipped, ['agy'])
})

test('deliverable mode adds the own-checks warning; bad input exits 1 with a message', () => {
  const c = council(['deliverable', 'Review the landing page copy'])
  assert.match(c.read('verdict.md'), /never proof that a file works/)
  const bad = spawnSync(process.execPath, [RUNNER, 'vote', 'x'], { encoding: 'utf8' })
  assert.equal(bad.status, 1); assert.match(bad.stderr, /unknown mode/)
  const none = spawnSync(process.execPath, [RUNNER, 'decision', '--dry-run'], { encoding: 'utf8' })
  assert.equal(none.status, 1); assert.match(none.stderr, /exactly one of a question or --brief/)
})

test('long context is capped and the truncation is a warning', () => {
  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'council-ctx-')), 'big.md')
  fs.writeFileSync(big, 'x'.repeat(60000))
  const c = council(['decision', 'Cap test', '--context', big])
  assert.ok(c.read('member-prompt.md').length <= 25000)
  assert.match(c.read('verdict.md'), /context truncated: big\.md/)
})

// ---------------------------------------------------------------- answer parsing
function parse(kind, out, extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'council-parse-'))
  const outFile = path.join(d, 'out.txt'), errFile = path.join(d, 'err.txt'), answerFile = path.join(d, 'answer.md')
  fs.writeFileSync(outFile, out); fs.writeFileSync(errFile, '')
  const spec = { kind, answerFile, codexLastFile: path.join(d, 'last.md'), ...extra }
  const r = { ok: true, error: null, outFile, errFile, answerFile }
  completeAnswer(spec, r)
  return { r, answer: fs.existsSync(answerFile) ? fs.readFileSync(answerFile, 'utf8') : null }
}
const J = (o) => JSON.stringify(o)

test('claude stream: the final result record is the answer; a cut-off stream or an error result is a failure', () => {
  const good = parse('claudestream', [J({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } }), J({ type: 'result', subtype: 'success', result: '## TL;DR\nfull answer' })].join('\n'))
  assert.equal(good.r.ok, true); assert.equal(good.answer, '## TL;DR\nfull answer')
  const cut = parse('claudestream', J({ type: 'stream_event', event: { type: 'message_start' } }))
  assert.equal(cut.r.ok, false); assert.equal(cut.r.error, 'claude printed no result record')
  const err = parse('claudestream', J({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }))
  assert.equal(err.r.ok, false); assert.match(err.r.error, /error_max_turns/)
})

test('agy stream: result.response from the last record, and its status is checked', () => {
  const ok = parse('agystream', J({ event: 'result', result: { status: 'SUCCESS', response: 'agy answer' } }))
  assert.equal(ok.answer, 'agy answer')
  const bad = parse('agystream', J({ event: 'result', result: { status: 'CANCELLED', response: 'x' } }))
  assert.equal(bad.r.ok, false); assert.match(bad.r.error, /CANCELLED/)
})

test('codex: falls back to the last agent_message when the -o file is empty', () => {
  const c = parse('codex', [J({ type: 'turn.started' }), J({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } })].join('\n'))
  assert.equal(c.r.ok, true); assert.equal(c.answer, 'codex answer')
})

test('a member whose answer cannot be saved fails on its own; the run never hangs', async () => {
  const { runParallel } = await import('../runner/engines.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-save-'))
  const spec = { name: 'claude', exe: process.execPath, args: ['-e', 'process.stdout.write("hello")'], stdin: '', cwd: dir, kind: 'plain', timeoutSec: 30,
    outFile: path.join(dir, 'o.txt'), errFile: path.join(dir, 'e.txt'), answerFile: path.join(dir, 'missing-folder', 'a.md') }
  const [r] = await Promise.race([runParallel([spec]), new Promise((_, no) => setTimeout(() => no(new Error('hung')), 20000))])
  assert.equal(r.ok, false)
  assert.match(r.error, /could not save the answer/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Windows npm shims: the launcher is read from the .cmd file, a native .exe wins', async (t) => {
  const { shimTarget, resolveEngine, WIN } = await import('../runner/engines.mjs')
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'council-shim-'))
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }))
  const js = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  fs.mkdirSync(path.dirname(js), { recursive: true }); fs.writeFileSync(js, '')
  // the two shim styles npm has written: "%dp0%\..." (cmd-shim 4+) and "%~dp0\..." (older)
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n')
  assert.equal(shimTarget(path.join(bin, 'claude.cmd')), js)
  fs.writeFileSync(path.join(bin, 'old.cmd'), '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)')
  assert.equal(shimTarget(path.join(bin, 'old.cmd')), js)
  assert.equal(shimTarget(path.join(bin, 'nope.cmd')), null)
  if (!WIN) return
  const r = resolveEngine('claude', { PATH: bin })
  assert.deepEqual(r.prefix, [js], 'claude installed with npm on Windows is found through its shim')
  fs.writeFileSync(path.join(bin, 'claude.exe'), '')
  assert.equal(resolveEngine('claude', { PATH: bin }).exe, path.join(bin, 'claude.exe'))
})
