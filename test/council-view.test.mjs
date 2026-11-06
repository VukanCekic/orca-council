// node:test suite for lib/council-view.mjs (the Council tab). Builds throwaway
// council folders in the OS temp dir. Stream lines follow the shapes measured on real CLI runs (Nov 2026).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readTail, parseStream, extractTldr, parseVerdictFull, readCouncilView, readCouncilAnswer, parseViewDoc, resolveCouncilDir
} from '../lib/council-view.mjs'

const J = (o) => JSON.stringify(o)
const cl = {
  init: J({ type: 'system', subtype: 'init' }),
  start: J({ type: 'stream_event', event: { type: 'message_start' } }),
  think: J({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } }),
  text: J({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } }),
  d: (t) => J({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } } }),
  tool: J({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Read' } } }),
  result: (r) => J({ type: 'result', subtype: 'success', is_error: false, result: r })
}

test('claude stream: thinking, then writing; a new turn starts a fresh preview; a torn last line is skipped', () => {
  assert.equal(parseStream('claude', [cl.init, cl.start, cl.think].join('\n')).phase, 'thinking')
  const w = parseStream('claude', [cl.init, cl.start, cl.think, cl.text, cl.d('## TL;DR\nShip'), cl.d(' it.'), '{"type":"stream_ev'].join('\n'))
  assert.equal(w.phase, 'writing')
  assert.equal(w.text, '## TL;DR\nShip it.')
  const turn2 = parseStream('claude', [cl.start, cl.text, cl.d('Let me read X.'), cl.tool, cl.start, cl.text, cl.d('## TL;DR\nNew')].join('\n'))
  assert.equal(turn2.text, '## TL;DR\nNew')
  assert.equal(parseStream('claude', [cl.start, cl.tool].join('\n')).tool, 'Read')
  assert.equal(parseStream('chair', [cl.start, cl.text, cl.d('x'), cl.result('x')].join('\n')).phase, 'finished')
})

test('codex stream: working with no text until the one agent_message', () => {
  const a = parseStream('codex', [J({ type: 'thread.started' }), J({ type: 'turn.started' })].join('\n'))
  assert.equal(a.phase, 'working'); assert.equal(a.text, '')
  const b = parseStream('codex', [J({ type: 'turn.started' }), J({ type: 'item.completed', item: { type: 'agent_message', text: '## TL;DR\nPlan Y.' } })].join('\n'))
  assert.equal(b.phase, 'writing'); assert.equal(extractTldr(b.text), 'Plan Y.')
  assert.equal(parseStream('codex', J({ type: 'item.started', item: { type: 'command_execution', command: 'git log' } })).tool, 'git log')
})

test('agy stream: thinking after the input step, then text deltas', () => {
  const s = (o) => J({ event: 'step_update', step_update: o })
  assert.equal(parseStream('agy', [J({ event: 'init' }), s({ step_type: 'user_input', state: 'DONE' })].join('\n')).phase, 'thinking')
  const w = parseStream('agy', [s({ step_type: 'user_input', state: 'DONE' }), s({ step_type: 'agent_response', state: 'ACTIVE', text_delta: '## TL;DR\nPlan X' }), s({ step_type: 'agent_response', state: 'ACTIVE', text_delta: ', after a trial.' })].join('\n'))
  assert.equal(w.phase, 'writing'); assert.equal(extractTldr(w.text), 'Plan X, after a trial.')
})

test('extractTldr: half-written, bold, missing', () => {
  assert.equal(extractTldr('## TL;DR\n**Pick X** now'), 'Pick X now')
  assert.equal(extractTldr('## TL;DR\n\nHalf a sen'), 'Half a sen')
  assert.equal(extractTldr('## TL;DR\n'), null)
  assert.equal(extractTldr('## Recommendation\nX'), null)
})

const VERDICT = `# Council verdict: x

2026-11-04 | mode **decision** (Full) | answers: 3 of 3 | chair: blind Claude

> ⚠ 2 of 3 members answered

## TL;DR
Go with **B**; it is the only one with a test plan.

## ✔ Agreed
- Orca shows workers live.
- none

## ✖ Disagreed
- Whether to keep the script. B is right.

## ● Needs you
- **Decide** by Friday.

## Verdict
B wins.

## Confidence
high: all three agree on the facts.

## Answer quality
- A: thin.
- B: best.

---

## Unsealed (after the chair finished)

- A = **codex** (gpt-6.1-sol, 30 s)
- B = **claude** (opus, 19 s) <- favoured

FAVOURED: B
`

test('parseVerdictFull: sections, bullets, mapping, warnings', () => {
  const v = parseVerdictFull(VERDICT)
  assert.equal(v.tldr, 'Go with B; it is the only one with a test plan.')
  assert.deepEqual(v.agreed, ['Orca shows workers live.'])
  assert.deepEqual(v.needsYou, ['Decide by Friday.'])
  assert.equal(v.text, 'B wins.')
  assert.equal(v.confidence, 'high'); assert.equal(v.confidenceWhy, 'all three agree on the facts.')
  assert.deepEqual(v.quality, ['A: thin.', 'B: best.'])
  assert.equal(v.favoured, 'B'); assert.deepEqual(v.mapping, { A: 'codex', B: 'claude' })
  assert.deepEqual(v.warnings, ['2 of 3 members answered'])
})

function council(status, files = {}) {
  const croot = fs.mkdtempSync(path.join(os.tmpdir(), 'blindpanel-'))
  const dirName = '2026-11-04-x'
  const dir = path.join(croot, dirName)
  const w = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
  w('brief.md', '# Council brief: x\n\nMode: decision\n\n## Question\n\nRetire codex-task?\n\n## Context files\n\n(none)\n')
  w('raw/status.json', J({ kind: 'council', slug: 'x', mode: 'decision', size: 'Full', pid: process.pid, ...status }))
  for (const [k, v] of Object.entries(files)) w(k, v)
  fs.writeFileSync(path.join(croot, 'live.json'), J({ dir: dirName }))
  return { croot, dir, dirName }
}

test('readCouncilView: live previews, a just-finished member gets its TL;DR from its stream, question from brief.md', () => {
  const now = Date.now()
  const { croot, dir } = council({
    state: 'running', phase: 'members', startedAt: now - 20000,
    members: [
      { engine: 'claude', model: 'opus', state: 'done', startedAt: now - 20000, endedAt: now - 2000, seconds: 18, tldr: null },
      { engine: 'codex', model: 'gpt-6.1-sol', state: 'running', startedAt: now - 20000 },
      { engine: 'agy', state: 'running', startedAt: now - 20000 }
    ],
    chair: { state: 'queued' }
  }, {
    'raw/claude.out.txt': [cl.start, cl.text, cl.d('## TL;DR\nPick X.\n\n## Recommendation\n...'), cl.result('## TL;DR\nPick X.')].join('\n') + '\n',
    'raw/codex.out.txt': J({ type: 'turn.started' }) + '\n',
    'raw/agy.out.txt': J({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Some long text '.repeat(40) } }) + '\n'
  })
  const v = readCouncilView({ dir }, croot, now)
  assert.equal(v.ok, true)
  assert.equal(v.question, 'Retire codex-task?')
  assert.equal(v.state, 'running')
  const [c, x, a] = v.members
  assert.equal(c.tldr, 'Pick X.')
  assert.equal(x.live.phase, 'working'); assert.equal(x.live.chars, 0)
  assert.equal(a.live.phase, 'writing'); assert.ok(a.live.tail.startsWith('…') && a.live.tail.length <= 281)
  assert.equal(v.chair.state, 'queued')
  assert.equal(v.verdict, null)
  // follow mode reads live.json; the same folder name is found when the absolute path moved
  assert.equal(readCouncilView({ follow: croot }, croot, now).follow, true)
  assert.equal(readCouncilView({ dir: path.join('C:\\gone', path.basename(dir)) }, path.dirname(croot), now).ok, false)
  assert.equal(resolveCouncilDir({ dir: 'C:\\gone\\2026-11-04-x' }, path.dirname(croot)).error.startsWith('Council folder not found'), true)
})

test('readCouncilView: done council carries the verdict, the labels and no live previews', () => {
  const now = Date.now()
  const { croot, dir } = council({
    state: 'done', phase: 'verdict', startedAt: now - 60000, endedAt: now - 1000,
    members: [{ engine: 'claude', state: 'done', tldr: 'Pick X.' }, { engine: 'codex', state: 'done', tldr: 'Plan Y.' }],
    chair: { state: 'done', tldr: 'Go with B.' },
    verdict: { favoured: 'B', favouredEngine: 'claude', confidence: 'high', status: 'ok', tldr: 'Go with B.', mapping: { A: 'codex', B: 'claude' } }
  }, { 'verdict.md': VERDICT })
  const v = readCouncilView({ dir }, croot, now)
  assert.equal(v.state, 'done')
  assert.equal(v.members.find(m => m.engine === 'claude').label, 'B')
  assert.equal(v.members.every(m => !m.live), true)
  assert.equal(v.verdict.favouredEngine, 'claude')
  assert.deepEqual(v.verdict.needsYou, ['Decide by Friday.'])
  assert.equal(v.chair.tldr, 'Go with B.')
})

test('readCouncilView: a stale run, a folder without brief.md, a bad view doc', () => {
  const now = Date.now()
  const { croot, dir } = council({ state: 'running', phase: 'members', pid: 2147483000, members: [{ engine: 'claude', state: 'running' }] })
  const v = readCouncilView({ dir }, croot, now)
  assert.equal(v.state, 'stale'); assert.equal(v.members[0].live, undefined)
  fs.rmSync(path.join(dir, 'brief.md'))
  assert.equal(readCouncilView({ dir }, croot, now).ok, false)
  assert.deepEqual(parseViewDoc('{"follow":"C:\\\\x"}'), { follow: 'C:\\x' })
  assert.ok(parseViewDoc('not json').error)
  assert.ok(parseViewDoc('{"schema":1}').error)
})

test('readCouncilAnswer: raw answer, then answers/<label>.md for older councils, unknown names refused', () => {
  const { croot, dir } = council({ state: 'done', members: [] }, { 'raw/claude.answer.md': '## TL;DR\nRaw.', 'answers/A.md': '## TL;DR\nFrom A.', 'verdict.md': VERDICT })
  assert.equal(readCouncilAnswer({ dir }, croot, 'claude').markdown, '## TL;DR\nRaw.')
  assert.equal(readCouncilAnswer({ dir }, croot, 'codex').markdown, '## TL;DR\nFrom A.')
  assert.equal(readCouncilAnswer({ dir }, croot, 'chair').markdown, VERDICT)
  assert.equal(readCouncilAnswer({ dir }, croot, '../secret').ok, false)
})

test('readTail: the byte cap drops a torn first line and keeps the last whole lines', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-tail-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'stream.txt')
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}: `.padEnd(100, String(i)))
  fs.writeFileSync(file, lines.join('\n') + '\n')

  const tail = readTail(file, 350)
  const returned = tail.trimEnd().split('\n')
  assert.ok(Buffer.byteLength(tail) <= 350)
  assert.deepEqual(returned, lines.slice(-3))
  assert.equal(returned.at(-1), lines.at(-1))
})

test('codex stream: a command starts a tool phase and completes back to working', () => {
  const events = [
    J({ type: 'turn.started' }),
    J({ type: 'item.started', item: { type: 'command_execution', command: 'git log' } })
  ]
  const started = parseStream('codex', events.join('\n'))
  assert.equal(started.phase, 'tool')
  assert.equal(started.tool, 'git log')

  events.push(J({ type: 'item.completed', item: { type: 'command_execution', command: 'git log' } }))
  assert.equal(parseStream('codex', events.join('\n')).phase, 'working')
})

test('verdict lists: sub-points stay with their item, so the counts are the real number of points', () => {
  const v = parseVerdictFull([
    '## TL;DR', 'x', '## Disagreed',
    '- **How concrete to be.**', '  - C overclaims.', '  - A hedges.', '- What comes first.', '  - A and C: scale up.',
    '## Needs you', '- Check the links.', '  - Redis page.', '  - AWS page.', '- Decide the term.', '- none',
    '## Verdict', 'ok', '', 'FAVOURED: A'
  ].join('\n'))
  assert.equal(v.disagreed.length, 2)
  assert.equal(v.disagreed[0], 'How concrete to be.\nC overclaims.\nA hedges.')
  assert.deepEqual(v.needsYou, ['Check the links.\nRedis page.\nAWS page.', 'Decide the term.'])
})
