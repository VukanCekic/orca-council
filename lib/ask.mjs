// ask.mjs: what the Ask panel (panel/) needs from the worker. Four requests:
//   council.workspaces  the local Orca workspaces, which one is focused, which CLIs are on PATH
//   council.ask         writes the brief into <workspace>/.council/briefs/ and asks Orca to open a "Council" terminal
//                       in that workspace running runner/council.mjs, so the person sees it run; the runner then opens
//                       the Council tab itself
//   council.history     the councils in <workspace>/.council, newest first
//   council.open        opens one council's council.view as a tab
// Host calls (and the capability each needs): workspace.readContext + workspace.list (workspace:read),
// terminal.create (terminal:send), editor.open (workspace:write). The worker itself starts no process.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCouncilView } from './council-view.mjs'
import { findNode } from '../runner/engines.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RUNNER = path.join(HERE, '..', 'runner', 'council.mjs')
const MODES = new Set(['decision', 'deliverable', 'facts'])
const SAFE_NAME = /^[\w.-]{1,160}$/
// Characters that could break out of a double-quoted shell argument in PowerShell, cmd, bash, zsh or fish.
// PowerShell also ends a double-quoted string at the typographic quotes “ ” „.
const UNSAFE_PATH = /["`$\r\n%!“”„]/

function err(code, message) { const e = new Error(message); e.code = code; return e }

// The focused workspace from readContext (name + branch only) matched against the list. Several workspaces can share a
// name and branch ("main"); then there is no single match and the panel asks the person to pick.
export function shortBranch(b) { return b ? String(b).replace(/^refs\/heads\//, '') : null }
export function matchFocused(list, ctx) {
  if (!ctx) return null
  const hits = list.filter(w => w.name === ctx.displayName && shortBranch(w.branch) === shortBranch(ctx.branch))
  return hits.length === 1 ? hits[0].id : null
}
// The project a workspace belongs to, for its label: a main checkout is named by its branch ("main") and its folder
// is the repo ("shop"); a child worktree's folder is its own name, inside a folder named for the repo
// (".../workspaces/shop/checkout-v2"); a plain folder workspace is just its name.
export function repoOf(w) {
  if (w.kind === 'folder') return w.name
  const base = path.basename(path.normalize(w.path))
  return base === w.name ? path.basename(path.dirname(path.normalize(w.path))) : base
}
// Orca labels this computer's workspaces with host "local" (an SSH one names its host). A folder that exists on this
// disk is what the worker can write a brief into, so that is the test.
function isLocal(w) {
  if (!w || typeof w.path !== 'string' || !w.path) return false
  if (w.hostId && w.hostId !== 'local') return false
  try { return fs.statSync(w.path).isDirectory() } catch { return false }
}

export async function listWorkspaces(host, which = () => true) {
  const [ctx, all] = await Promise.all([
    host.call('workspace.readContext', {}).catch(() => null),
    host.call('workspace.list', {})
  ])
  const local = (all && all.workspaces || []).filter(isLocal)
  const workspaces = local.map(w => ({ id: w.id, name: w.name, branch: shortBranch(w.branch), kind: w.kind, path: path.normalize(w.path),
    repo: repoOf(w) }))
  return { workspaces, focused: matchFocused(workspaces, ctx), clis: which(), truncated: !!(all && all.truncated) }
}

// One workspace by id. Only that one folder is checked (the panel polls history every few seconds).
async function workspaceById(host, id) {
  if (typeof id !== 'string' || !id) throw err('invalid_params', 'Pick a workspace.')
  const all = await host.call('workspace.list', {})
  const hit = (all && all.workspaces || []).find(x => x && x.id === id)
  if (!hit || !isLocal(hit)) throw err('invalid_params', 'That workspace is gone or not on this computer.')
  const w = { id: hit.id, name: hit.name, branch: shortBranch(hit.branch), kind: hit.kind, path: path.normalize(hit.path), repo: repoOf(hit) }
  if (UNSAFE_PATH.test(w.path)) throw err('invalid_params', 'This workspace path has characters the terminal command cannot quote safely.')
  return w
}

function slugOf(q) { return (q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')) || 'council' }
function ensureCouncilDir(root) {
  fs.mkdirSync(path.join(root, 'briefs'), { recursive: true })
  const gi = path.join(root, '.gitignore')
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Council runs (runner/council.mjs). Ignored by git on purpose.\n*\n', 'utf8')
}

// The terminal command. Every path is double-quoted and checked for characters that could escape the quotes; the
// question never reaches the shell (it goes in the brief file).
export function buildCommand({ runner = RUNNER, mode, brief, project, context = [], dryRun = false }) {
  for (const p of [runner, brief, project, ...context]) if (UNSAFE_PATH.test(p)) throw err('invalid_params', `Cannot quote this path safely: ${p}`)
  const q = (p) => `"${p}"`
  const parts = ['node', q(runner), mode, '--brief', q(brief), '--project', q(project)]
  for (const c of context) parts.push('--context', q(c))
  if (dryRun) parts.push('--dry-run', '--pace', '1')
  return parts.join(' ')
}

export async function ask(host, input, { now = Date.now(), runner = RUNNER, hasNode = () => !!findNode() } = {}) {
  const question = String(input && input.question || '').trim()
  const mode = String(input && input.mode || 'decision')
  if (!question) throw err('invalid_params', 'Type a question first.')
  if (question.length > 4000) throw err('invalid_params', 'Keep the question under 4000 characters; put the rest in a context file.')
  if (!MODES.has(mode)) throw err('invalid_params', 'Mode must be decision, deliverable or facts.')
  // The terminal runs `node`; without it the panel would say "Started" and nothing would happen.
  if (!hasNode()) throw err('node_missing', 'Node.js was not found on Orca’s PATH. Install Node.js 20 or newer, then restart Orca.')
  const w = await workspaceById(host, input.workspaceId)
  const context = []
  for (const raw of (Array.isArray(input.context) ? input.context : []).map(s => String(s).trim()).filter(Boolean).slice(0, 8)) {
    const abs = path.resolve(w.path, raw)
    const rel = path.relative(w.path, abs)
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw err('invalid_params', `Context files must be inside the workspace: ${raw}`)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw err('invalid_params', `Context file not found: ${raw}`)
    context.push(abs)
  }
  const root = path.join(w.path, '.council')
  ensureCouncilDir(root)
  const title = question.split(/\r?\n/)[0].slice(0, 120)
  const brief = path.join(root, 'briefs', `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${slugOf(title)}.md`)
  const good = { decision: 'One clear recommendation, with the reasons and the risks that would change it.',
    deliverable: 'What must change before this ships, ranked by how much it matters.',
    facts: 'Every checkable claim marked true / false / unclear, with the reason and a source where possible.' }[mode]
  const ctxList = context.length ? context.map(c => `- ${path.relative(w.path, c)}`).join('\n') : '(none)'
  fs.writeFileSync(brief, `# ${title}\n\nMode: ${mode}\n\n## Question\n\n${question}\n\n## Context files\n\n${ctxList}\n\n## What good looks like\n\n${good}\n`, 'utf8')
  const command = buildCommand({ runner, mode, brief, project: w.path, context, dryRun: !!input.dryRun })
  const t = await host.call('terminal.create', { workspaceId: w.id, title: input.dryRun ? 'Council (trial)' : 'Council', command })
  return { ok: true, terminalId: t && t.terminalId, workspace: w.name, brief: path.relative(w.path, brief) }
}

// Newest councils first. Each is what the Council tab would show, cut down to a row.
export async function history(host, input, { limit = 20 } = {}) {
  const w = await workspaceById(host, input && input.workspaceId)
  const root = path.join(w.path, '.council')
  let dirs = []
  try { dirs = fs.readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}-/.test(d) && SAFE_NAME.test(d)) } catch { /* none yet */ }
  // Newest first: by the date in the name, then by when the folder was made (names within a day sort by question).
  const made = (d) => { try { const s = fs.statSync(path.join(root, d)); return s.birthtimeMs || s.mtimeMs } catch { return 0 } }
  dirs = dirs.map(d => ({ d, day: d.slice(0, 10), t: made(d) }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.t - a.t)).map(x => x.d)
  const items = []
  for (const d of dirs.slice(0, limit)) {
    const v = readCouncilView({ dir: path.join(root, d) }, w.path, Date.now(), { live: false })
    if (!v.ok) continue
    const vd = v.verdict || {}
    items.push({ dir: d, question: v.question || v.slug, state: v.state, phase: v.phase, dryRun: v.dryRun, startedAt: v.startedAt, endedAt: v.endedAt,
      favouredEngine: vd.favouredEngine || null, confidence: vd.confidence || null, needsYou: (vd.needsYou || []).length, tldr: vd.tldr || null,
      answered: v.members.filter(m => m.state === 'done').length, members: v.members.length })
  }
  items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return { ok: true, workspace: w.name, total: dirs.length, items }
}

export async function openCouncil(host, input) {
  const w = await workspaceById(host, input && input.workspaceId)
  const d = String(input && input.dir || '')
  if (!SAFE_NAME.test(d)) throw err('invalid_params', 'Unknown council.')
  const rel = path.join('.council', d, 'council.view')
  if (!fs.existsSync(path.join(w.path, rel))) throw err('invalid_params', 'That council folder is gone.')
  await host.call('editor.open', { workspaceId: w.id, path: rel.split(path.sep).join('/') })
  return { ok: true }
}
