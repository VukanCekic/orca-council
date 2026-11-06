// The Ask panel's worker requests (lib/ask.mjs) against a fake Orca host. No terminal is really opened.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { matchFocused, listWorkspaces, ask, history, openCouncil, buildCommand, RUNNER } from '../lib/ask.mjs'

function setup(t, { ctx, extra = [] } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'council-ask-'))
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  const calls = []
  for (const d of ['nope-a', 'nope-b']) fs.mkdirSync(path.join(ws, d))
  const list = [
    { id: 'wt-1', kind: 'worktree', name: 'checkout-v2', path: ws, branch: 'refs/heads/dev/checkout-v2', hostId: 'local' },
    { id: 'wt-2', kind: 'worktree', name: 'main', path: path.join(ws, 'nope-a'), branch: 'refs/heads/main', hostId: 'local' },
    { id: 'wt-3', kind: 'worktree', name: 'main', path: path.join(ws, 'nope-b'), branch: 'main', hostId: null },
    { id: 'wt-4', kind: 'worktree', name: 'remote', path: '/srv/remote', branch: 'main', hostId: 'ssh-1' },
    { id: 'wt-5', kind: 'worktree', name: 'gone', path: path.join(ws, 'deleted'), branch: 'main', hostId: 'local' },
    ...extra
  ]
  const host = {
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'workspace.readContext') return ctx === undefined ? { branch: 'dev/checkout-v2', displayName: 'checkout-v2', terminals: [] } : ctx
      if (method === 'workspace.list') return { workspaces: list, truncated: false }
      if (method === 'terminal.create') return { terminalId: 'term-9' }
      if (method === 'editor.open') return { opened: true }
      throw Object.assign(new Error('unknown_method'), { code: 'unknown_method' })
    }
  }
  return { ws, host, calls }
}

test('the focused workspace is matched by name and branch; a shared name ("main") is left for the person to pick', () => {
  const list = [{ id: 'a', name: 'main', branch: 'main' }, { id: 'b', name: 'main', branch: 'main' }, { id: 'c', name: 'checkout-v2', branch: 'dev/checkout-v2' }]
  assert.equal(matchFocused(list, { displayName: 'checkout-v2', branch: 'dev/checkout-v2' }), 'c')
  assert.equal(matchFocused(list, { displayName: 'main', branch: 'main' }), null)
  assert.equal(matchFocused(list, null), null)
})

test('workspaces: local only, focused one suggested, CLI check passed through', async (t) => {
  const { host } = setup(t)
  const r = await listWorkspaces(host, () => ({ claude: true, codex: false, agy: true }))
  assert.deepEqual(r.workspaces.map(w => w.id), ['wt-1', 'wt-2', 'wt-3'], 'local = host "local" (or none) and the folder exists')
  assert.equal(r.workspaces[0].branch, 'dev/checkout-v2')
  assert.equal(r.focused, 'wt-1')
  assert.deepEqual(r.clis, { claude: true, codex: false, agy: true })
})

test('ask writes the brief into .council/briefs, keeps the question out of the shell, and opens a Council terminal', async (t) => {
  const { ws, host, calls } = setup(t)
  fs.writeFileSync(path.join(ws, 'notes.md'), 'context')
  const q = 'Should checkout-v2 get a "second" payment step? $(rm -rf /) `x`'
  const r = await ask(host, { workspaceId: 'wt-1', question: q, mode: 'decision', context: ['notes.md'], dryRun: true }, { now: Date.UTC(2026, 10, 6, 11) })
  assert.equal(r.ok, true); assert.equal(r.terminalId, 'term-9')
  const brief = fs.readFileSync(path.join(ws, r.brief), 'utf8')
  assert.match(brief, /## Question\n\nShould checkout-v2 get a "second" payment step\?/)
  assert.equal(fs.readFileSync(path.join(ws, '.council', '.gitignore'), 'utf8').trim().split('\n').pop(), '*')
  const term = calls.find(c => c.method === 'terminal.create').params
  assert.equal(term.workspaceId, 'wt-1'); assert.equal(term.title, 'Council (trial)')
  assert.ok(!/rm -rf|\$\(|`|"second"/.test(term.command), 'the question never reaches the shell (only a safe [a-z0-9-] slug in the file name)')
  assert.match(term.command, /^node ".+council\.mjs" decision --brief ".+\.md" --project ".+" --context ".+notes\.md" --dry-run --pace 1$/)
})

test('ask refuses an empty question, a bad mode, a remote workspace, and context outside the workspace', async (t) => {
  const { host } = setup(t)
  await assert.rejects(ask(host, { workspaceId: 'wt-1', question: '  ' }), /Type a question/)
  await assert.rejects(ask(host, { workspaceId: 'wt-1', question: 'x', mode: 'vote' }), /Mode must be/)
  await assert.rejects(ask(host, { workspaceId: 'wt-4', question: 'x' }), /gone or not on this computer/)
  await assert.rejects(ask(host, { workspaceId: 'wt-1', question: 'x', context: ['../../etc/passwd'] }), /inside the workspace/)
  await assert.rejects(ask(host, { workspaceId: 'wt-1', question: 'x', context: ['missing.md'] }), /not found/)
})

test('buildCommand refuses paths that could escape their quotes', () => {
  assert.throws(() => buildCommand({ mode: 'decision', brief: 'C:\\a"b.md', project: 'C:\\p' }), /quote this path/)
  assert.throws(() => buildCommand({ mode: 'decision', brief: '/tmp/a.md', project: '/home/$USER' }), /quote this path/)
  assert.equal(buildCommand({ runner: '/r/council.mjs', mode: 'facts', brief: '/b.md', project: '/p q' }), 'node "/r/council.mjs" facts --brief "/b.md" --project "/p q"')
})

test('history lists the workspace\'s councils newest first, and open asks Orca for the tab', async (t) => {
  const { ws, host, calls } = setup(t)
  assert.deepEqual((await history(host, { workspaceId: 'wt-1' })).items, [])
  for (const q of ['First question', 'Second question']) {
    const r = spawnSync(process.execPath, [RUNNER, 'decision', q, '--dry-run', '--no-open', '--project', ws], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  const h = await history(host, { workspaceId: 'wt-1' })
  assert.equal(h.items.length, 2)
  assert.equal(h.items[0].question, 'Second question')
  assert.equal(h.items[0].state, 'done'); assert.equal(h.items[0].needsYou, 1); assert.ok(h.items[0].favouredEngine)
  await openCouncil(host, { workspaceId: 'wt-1', dir: h.items[0].dir })
  const open = calls.find(c => c.method === 'editor.open').params
  assert.deepEqual(open, { workspaceId: 'wt-1', path: `.council/${h.items[0].dir}/council.view` })
  await assert.rejects(openCouncil(host, { workspaceId: 'wt-1', dir: '../x' }), /Unknown council/)
})

test('workspace labels name the project: main checkouts by folder, child worktrees by their parent, folders by name', async () => {
  const { repoOf } = await import('../lib/ask.mjs')
  assert.equal(repoOf({ kind: 'worktree', name: 'main', path: 'D:/code/my projects/shop' }), 'shop')
  assert.equal(repoOf({ kind: 'worktree', name: 'checkout-v2', path: '/home/x/orca/workspaces/shop/checkout-v2' }), 'shop')
  assert.equal(repoOf({ kind: 'folder', name: 'council-smoke', path: 'C:/tmp/abc/council-smoke' }), 'council-smoke')
})

test('edge cases: typographic quotes, a file named "..notes.md", Node missing, a question over several lines', async (t) => {
  assert.throws(() => buildCommand({ mode: 'decision', brief: '/b.md', project: 'D:/x\u201D ; calc ; \u201Cy' }), /quote this path/, 'PowerShell ends a string at \u201D')
  const { ws, host } = setup(t)
  fs.writeFileSync(path.join(ws, '..notes.md'), 'dots in the name, still inside')
  const r = await ask(host, { workspaceId: 'wt-1', question: 'Q', context: ['..notes.md'], dryRun: true })
  assert.ok(r.ok)
  await assert.rejects(ask(host, { workspaceId: 'wt-1', question: 'Q' }, { hasNode: () => false }), /Node\.js was not found/)
  const q = 'Should we move to Redis?\nWe have 3 services and 2 people.\n\n- budget: none'
  const run = spawnSync(process.execPath, [RUNNER, 'decision', q, '--dry-run', '--no-open', '--project', ws], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const h = await history(host, { workspaceId: 'wt-1' })
  assert.equal(h.items[0].question, q, 'every line of the question survives into the tab and the history')
})

test('history: newest first within one day too, whatever the questions are called', async (t) => {
  const { ws, host } = setup(t)
  for (const q of ['zebra first', 'apple second', 'mango third']) {
    const r = spawnSync(process.execPath, [RUNNER, 'decision', q, '--dry-run', '--no-open', '--project', ws], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  const h = await history(host, { workspaceId: 'wt-1' }, { limit: 2 })
  assert.equal(h.total, 3)
  assert.deepEqual(h.items.map(i => i.question), ['mango third', 'apple second'])
})
