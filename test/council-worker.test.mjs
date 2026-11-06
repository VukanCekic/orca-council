// Council worker integration and shared readers: temporary files only, no Orca host required.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import activate from '../worker.mjs'
import { readText, readJson, pidAlive } from '../lib/readers.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-worker-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (relative, text) => {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  return { dir, write }
}

test('shared readers accept BOM text and reject oversized, missing, directory or malformed inputs', (t) => {
  const { dir, write } = fixture(t)
  const valid = write('valid.json', '\uFEFF{"state":"done"}')
  assert.equal(readText(valid), '{"state":"done"}')
  assert.deepEqual(readJson(valid), { state: 'done' })
  assert.equal(readText(valid, 2), null)
  assert.equal(readText(dir), null)
  assert.equal(readText(path.join(dir, 'missing')), null)
  assert.equal(readJson(write('invalid.json', '{"state":')), null)
  assert.equal(readJson(path.join(dir, 'missing')), null)
  assert.equal(pidAlive(process.pid), true)
  for (const invalid of [null, 0, -1, 1.5, '123']) assert.equal(pidAlive(invalid), false)
})

test('the tab view and full-answer requests never touch the host API or storage', async (t) => {
  const { dir, write } = fixture(t)
  write('brief.md', '# Council brief: worker\n\n## Question\n\nKeep the Council?\n')
  write('raw/status.json', JSON.stringify({
    kind: 'council', slug: 'worker', state: 'running', phase: 'members', pid: process.pid,
    members: [{ engine: 'claude', state: 'done', tldr: 'Keep it.' }], chair: { state: 'queued' }
  }))
  write('raw/claude.answer.md', '## TL;DR\nKeep it.\n\nThe Council adds a blind review.')

  const handlers = new Map()
  const hostAccess = []
  const orca = { panels: { handle: (name, fn) => handlers.set(name, fn) } }
  for (const domain of ['host', 'storage']) {
    Object.defineProperty(orca, domain, { get() {
      hostAccess.push(domain)
      throw new Error(`Council must not access ${domain}`)
    } })
  }
  activate(orca)
  assert.deepEqual([...handlers.keys()].sort(), ['council.answer', 'council.ask', 'council.history', 'council.open', 'council.view', 'council.workspaces'])

  const doc = JSON.stringify({ schema: 1, kind: 'blind-panel', dir })
  const view = await handlers.get('council.view')({ doc })
  assert.equal(view.ok, true)
  assert.equal(view.question, 'Keep the Council?')
  assert.equal(view.members[0].tldr, 'Keep it.')
  const answer = await handlers.get('council.answer')({ doc, who: 'claude' })
  assert.equal(answer.ok, true)
  assert.match(answer.markdown, /The Council adds a blind review/)
  assert.equal((await handlers.get('council.answer')({ doc, who: '../secret' })).ok, false)
  assert.equal((await handlers.get('council.view')({ doc: 'invalid' })).ok, false)
  assert.equal((await handlers.get('council.answer')({ doc: 'invalid', who: 'claude' })).ok, false)
  assert.deepEqual(hostAccess, [])
})
