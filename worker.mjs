// Council worker (trusted-worker `main`).
// The Council tab (editor/) and the Ask panel (panel/) call it with plugin.request; it answers from files and from
// Orca's host API. It starts no process itself: a council runs in a "Council" terminal that Orca opens on request.
//   council.view / council.answer   READ-ONLY: one council's status, streams, answers, verdict (lib/council-view.mjs)
//   council.workspaces / ask / history / open   the Ask panel (lib/ask.mjs)
import os from 'node:os'
import path from 'node:path'
import { readCouncilView, readCouncilAnswer, parseViewDoc } from './lib/council-view.mjs'
import { listWorkspaces, ask, history, openCouncil } from './lib/ask.mjs'
import { MEMBER_ENGINES, resolveEngine, findNode } from './runner/engines.mjs'

// The folder that holds the councils folder. Only used when a .view file names a council folder that has moved:
// the worker then looks for the same folder name under <root>/councils. Councils normally live in the workspace's
// .council folder and their .view files name them by absolute path.
export function resolveRoot(env = process.env) {
  return env.COUNCIL_ROOT ? path.dirname(path.resolve(env.COUNCIL_ROOT)) : path.join(os.homedir(), '.council')
}

// Which member CLIs (and Node, which runs the runner) are on Orca's PATH (the terminal's PATH is usually the same).
export function whichClis() {
  const out = { node: !!findNode() }
  for (const e of MEMBER_ENGINES) { try { resolveEngine(e); out[e] = true } catch { out[e] = false } }
  return out
}

function viewRef(input) {
  return parseViewDoc(input && typeof input.doc === 'string' ? input.doc.slice(0, 64 * 1024) : '')
}

export default function activate(orca) {
  orca.panels.handle('council.view', async (input) => {
    const ref = viewRef(input)
    if (ref.error) return { ok: false, error: ref.error, now: Date.now() }
    return readCouncilView(ref, resolveRoot())
  })
  orca.panels.handle('council.answer', async (input) => {
    const ref = viewRef(input)
    if (ref.error) return { ok: false, error: 'No view document.' }
    return readCouncilAnswer(ref, resolveRoot(), input && String(input.who || ''))
  })
  orca.panels.handle('council.workspaces', async () => listWorkspaces(orca.host, whichClis))
  orca.panels.handle('council.ask', async (input) => ask(orca.host, input || {}))
  orca.panels.handle('council.history', async (input) => history(orca.host, input || {}))
  orca.panels.handle('council.open', async (input) => openCouncil(orca.host, input || {}))
}
