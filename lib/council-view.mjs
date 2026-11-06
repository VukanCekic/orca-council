// council-view.mjs: what the Council tab (editor/) shows. Pure Node, READ-ONLY:
// every function only reads files. Nothing writes, deletes or spawns.
//
// A tab opens a *.view file (written by runner/council.mjs). Orca hands the tab only that file's text, never its
// path, so the file names the council folder ("dir", absolute) or the councils root to follow ("follow").
// The worker then reads, inside that folder only: brief.md, raw/status.json, raw/<member>.out.txt and
// raw/chair.out.txt (JSON lines the CLIs stream while they work), raw/<member>.answer.md, answers/<A-C>.md and
// verdict.md. A folder must contain brief.md to be read at all. What it returns goes to the plugin's own frame,
// which has no network.
//
// What each CLI streams (measured on real runs, Nov 2026), so the live line is honest:
//   claude / chair  stream-json: a thinking block opens (its text is empty: the model keeps it private), then
//                   text deltas as the answer is written.
//   codex           exec --json: start events, then the whole answer in one item at the end. No live text.
//   agy             stream-json: a silent pause (thinking, inferred), then text deltas.
import fs from 'node:fs'
import path from 'node:path'
import { readText, readJson, pidAlive } from './readers.mjs'

const SAFE_NAME = /^[\w.-]{1,160}$/
const MEMBERS = ['claude', 'codex', 'agy']
const STATES = new Set(['queued', 'running', 'done', 'failed', 'timeout', 'skipped'])

function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function str(v, max = 400) { return v == null ? null : String(v).slice(0, max) }

// The last maxBytes of a file (a torn first line is dropped), or '' if it is missing.
export function readTail(p, maxBytes = 4 * 1024 * 1024) {
  let fd = null
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return ''
    if (st.size <= maxBytes) return fs.readFileSync(p, 'utf8')
    fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(maxBytes)
    fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes)
    const t = buf.toString('utf8')
    return t.slice(t.indexOf('\n') + 1)
  } catch { return '' } finally { if (fd != null) try { fs.closeSync(fd) } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- live streams
// engine: 'claude' | 'chair' | 'codex' | 'agy'. Returns { phase, text, tool, events }.
// phase: starting | thinking | working | tool | writing | finished
export function parseStream(engine, text) {
  const out = { phase: 'starting', text: '', tool: null, events: 0 }
  if (!text) return out
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] !== '{') continue
    let o
    try { o = JSON.parse(line) } catch { continue }   // a half-written last line is skipped
    out.events++
    if (engine === 'codex') {
      const it = o.item || {}
      if (o.type === 'thread.started' || o.type === 'turn.started') out.phase = 'working'
      else if (o.type === 'item.started' && it.type === 'command_execution') { out.phase = 'tool'; out.tool = str(it.command, 80) }
      else if (o.type === 'item.completed' && it.type === 'command_execution') out.phase = 'working'
      else if (o.type === 'item.completed' && it.type === 'agent_message') { out.text = String(it.text || ''); out.phase = 'writing' }
      else if (o.type === 'turn.completed') out.phase = 'finished'
    } else if (engine === 'agy') {
      const s = o.step_update
      if (o.event === 'step_update' && s) {
        if (s.step_type === 'user_input' && s.state === 'DONE') out.phase = 'thinking'
        else if (s.step_type === 'agent_response' && typeof s.text_delta === 'string') { out.text += s.text_delta; out.phase = s.state === 'DONE' ? 'finished' : 'writing' }
        else if (s.step_type === 'tool') { out.phase = 'tool'; out.tool = str(s.tool_name || s.name || 'a tool', 80) }
      } else if (o.event === 'result') out.phase = 'finished'
    } else {
      const e = o.event
      if (o.type === 'stream_event' && e) {
        if (e.type === 'message_start') out.text = ''   // a new turn (after a file read): show what it writes now
        else if (e.type === 'content_block_start' && e.content_block) {
          const k = e.content_block.type
          if (k === 'thinking' || k === 'redacted_thinking') out.phase = 'thinking'
          else if (k === 'text') out.phase = 'writing'
          else if (k === 'tool_use') { out.phase = 'tool'; out.tool = str(e.content_block.name, 80) }
        } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') { out.text += e.delta.text || ''; out.phase = 'writing' }
      } else if (o.type === 'result') out.phase = 'finished'
    }
  }
  return out
}

// The line under "## TL;DR" (members and the chair open with it). Works on a half-written answer too.
export function extractTldr(text) {
  if (typeof text !== 'string') return null
  const m = /^\s*#{1,4}\s*TL;?\s?DR\s*:?\s*\r?\n(?:\s*\r?\n)*[ \t]*([^\r\n]*)/im.exec(text)
  if (!m) return null
  const l = m[1].replace(/\*\*/g, '').trim()
  return l && !l.startsWith('#') ? l.slice(0, 240) : null
}

function liveOf(engine, outFile) {
  const p = parseStream(engine, readTail(outFile))
  const flat = p.text.replace(/\s+/g, ' ').trim()
  return { phase: p.phase, chars: p.text.length, tldr: extractTldr(p.text), tail: flat.length > 280 ? '…' + flat.slice(-280) : flat, tool: p.tool }
}

// ---------------------------------------------------------------- verdict.md
function sections(text) {
  const out = {}
  const marks = [...text.matchAll(/^##\s+(.+)$/gm)]
  marks.forEach((m, i) => {
    const key = m[1].replace(/[^\p{L}\p{N}; ]/gu, '').trim().toLowerCase()
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length
    out[key] = text.slice(m.index + m[0].length, end).replace(/\n-{3,}\s*$/, '').trim()
  })
  return out
}
// Top-level bullets only. An indented bullet under one belongs to it: it is kept on the item after a newline, so
// "4 disagreements, each with 3 sub-points" counts as 4, not 16.
const BULLET = /^(\s*)([-*]|\d+[.)])\s+(.*)$/
function bullets(s) {
  if (!s) return []
  const rows = s.split(/\r?\n/).map(l => BULLET.exec(l.replace(/\t/g, '    '))).filter(Boolean)
    .map(m => ({ depth: m[1].length, text: m[3].replace(/\*\*/g, '').replace(/`/g, '').trim() })).filter(r => r.text)
  if (!rows.length) return []
  const top = Math.min(...rows.map(r => r.depth))
  const out = []
  for (const r of rows) {
    if (r.depth >= top + 2 && out.length) out[out.length - 1].push(r.text.slice(0, 600))
    else out.push([r.text.slice(0, 600)])
  }
  return out.filter(item => !/^none\.?$/i.test(item[0])).map(item => item.slice(0, 12).join('\n'))
}
export function parseVerdictFull(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const s = sections(text)
  const fav = [...text.matchAll(/^\s*\**FAVOURED:\s*(A|B|C|none)\**\s*$/gim)].pop()
  const conf = /^\s*\**\s*(low|medium|high)\b[*:\s-]*(.*)$/im.exec(s.confidence || '')
  const mapping = {}
  for (const m of text.matchAll(/^-\s+([ABC])\s*=\s*\*\*(\w+)\*\*/gm)) mapping[m[1]] = m[2]
  const warnings = [...text.matchAll(/^>\s*⚠️?\s*(.+)$/gm)].map(m => m[1].trim().slice(0, 300))
  return {
    tldr: s['tl;dr'] ? s['tl;dr'].split(/\r?\n/).map(l => l.replace(/\*\*/g, '').trim()).filter(Boolean)[0] || null : null,
    agreed: bullets(s.agreed), disagreed: bullets(s.disagreed), needsYou: bullets(s['needs you']),
    text: s.verdict ? s.verdict.replace(/\*\*/g, '').slice(0, 2000) : null,
    confidence: conf ? conf[1].toLowerCase() : null, confidenceWhy: conf && conf[2] ? conf[2].trim().slice(0, 300) : null,
    quality: bullets(s['answer quality']),
    favoured: fav ? (fav[1].toLowerCase() === 'none' ? 'none' : fav[1].toUpperCase()) : null,
    mapping, warnings
  }
}

// ---------------------------------------------------------------- which council
export function resolveCouncilDir(ref, root) {
  const fallback = path.join(root, 'councils')
  if (ref && typeof ref.follow === 'string') {
    const croot = isDir(ref.follow) ? ref.follow : fallback
    const live = readJson(path.join(croot, 'live.json'))
    if (!live || typeof live.dir !== 'string' || !SAFE_NAME.test(live.dir)) return { error: 'No council has run yet.' }
    const d = path.join(croot, live.dir)
    return isDir(d) ? { dir: d, follow: true } : { error: 'The newest council folder is gone.' }
  }
  if (ref && typeof ref.dir === 'string' && ref.dir) {
    let d = ref.dir
    if (!path.isAbsolute(d) || !isDir(d)) {
      const b = path.basename(d.replace(/[\\/]+$/, ''))
      if (SAFE_NAME.test(b)) d = path.join(fallback, b)   // the repo moved: same folder name under councils/
    }
    if (!isDir(d) || !fs.existsSync(path.join(d, 'brief.md'))) return { error: `Council folder not found: ${ref.dir}` }
    return { dir: d }
  }
  return { error: 'This .view file names no council.' }
}

// Parses the .view file's text into a ref. Never throws.
export function parseViewDoc(text) {
  try {
    const j = JSON.parse(String(text || ''))
    if (!j || typeof j !== 'object') return { error: 'The .view file is not a Council view.' }
    if (typeof j.follow === 'string') return { follow: j.follow }
    if (typeof j.dir === 'string') return { dir: j.dir, question: typeof j.question === 'string' ? j.question : null }
    return { error: 'This .view file names no council.' }
  } catch { return { error: 'The .view file is not valid JSON.' } }
}

// The whole "## Question" section of a brief, every line of it, up to the next "## " heading. (No m flag: with it,
// $ would stop at the first line end and a question typed on several lines would lose all but its first line.)
export const QUESTION_RE = /(?:^|\n)##[ \t]*Question[ \t]*\r?\n+([\s\S]+?)(?=\r?\n##?[ \t]|$)/i
function questionOf(dir) {
  const b = readText(path.join(dir, 'brief.md')) || ''
  const q = QUESTION_RE.exec(b)
  if (q) { const t = q[1].trim(); return t.length > 400 ? t.slice(0, 399).trimEnd() + '…' : t }
  const h = /^#\s+(.+)$/m.exec(b)
  return h ? h[1].replace(/^Council brief:\s*/i, '').trim().slice(0, 400) : null
}

function cleanPart(m, name) {
  return {
    engine: name, model: str(m.model, 40), state: STATES.has(m.state) ? m.state : 'running',
    startedAt: num(m.startedAt), endedAt: num(m.endedAt), seconds: num(m.seconds),
    error: str(m.error, 200), limitHit: !!m.limitHit, tldr: str(m.tldr, 240)
  }
}

// ---------------------------------------------------------------- the whole view
// opts.live = false skips reading the members' stream logs (the Ask panel's history only needs states).
export function readCouncilView(ref, root, now = Date.now(), { live = true } = {}) {
  const where = resolveCouncilDir(ref, root)
  if (where.error) return { ok: false, error: where.error, now }
  const dir = where.dir
  const raw = path.join(dir, 'raw')
  const s = readJson(path.join(raw, 'status.json'))
  const verdictText = readText(path.join(dir, 'verdict.md'))
  const v = parseVerdictFull(verdictText)
  const question = (ref && ref.question) || questionOf(dir)
  const name = path.basename(dir)

  if (!s || s.kind !== 'council') {
    // An older council (before status.json): verdict.md only.
    if (!v) return { ok: false, error: 'This council has no status file or verdict yet.', now }
    return {
      ok: true, follow: !!where.follow, dir: name, slug: name.replace(/^\d{4}-\d{2}-\d{2}-/, ''), question, mode: null, size: null,
      dryRun: false, state: 'done', phase: 'verdict', startedAt: null, endedAt: null, now, members: [], chair: null, skipped: [],
      verdict: { ...v, favouredEngine: v.favoured && v.mapping[v.favoured] || null, status: null }, error: null
    }
  }

  const running = s.state === 'running'
  const stale = running && !pidAlive(s.pid)
  const mapping = (s.verdict && s.verdict.mapping && typeof s.verdict.mapping === 'object') ? s.verdict.mapping : (v ? v.mapping : {})
  const labelOf = {}
  for (const [k, e] of Object.entries(mapping || {})) if (/^[ABC]$/.test(k)) labelOf[String(e)] = k

  const members = (Array.isArray(s.members) ? s.members : []).filter(m => MEMBERS.includes(m.engine)).map(m => {
    const p = cleanPart(m, m.engine)
    p.label = labelOf[p.engine] || null
    if (live && p.state === 'running' && !stale) p.live = liveOf(p.engine, path.join(raw, `${p.engine}.out.txt`))
    // An older runner wrote the answer files (and the status tldr) only once EVERY member had finished, so a
    // member that is done without a tldr gets it from its answer file or its own stream log.
    if (p.state === 'done' && !p.tldr) p.tldr = extractTldr(readText(path.join(raw, `${p.engine}.answer.md`))) || liveOf(p.engine, path.join(raw, `${p.engine}.out.txt`)).tldr
    return p
  })
  let chair = s.chair ? cleanPart(s.chair, 'chair') : null
  if (chair) {
    if (live && chair.state === 'running' && !stale) chair.live = liveOf('chair', path.join(raw, 'chair.out.txt'))
    if (chair.state === 'done' && !chair.tldr) chair.tldr = (v && v.tldr) || null
  }

  let verdict = null
  if (s.verdict || (v && s.state === 'done')) {
    const sv = s.verdict || {}
    verdict = {
      favoured: sv.favoured || (v && v.favoured) || null, favouredEngine: sv.favouredEngine || null,
      confidence: sv.confidence || (v && v.confidence) || null, confidenceWhy: v ? v.confidenceWhy : null,
      status: sv.status || null, answers: num(sv.answers), planned: num(sv.planned),
      tldr: sv.tldr || (v && v.tldr) || null, text: v ? v.text : null, mapping,
      agreed: v ? v.agreed : [], disagreed: v ? v.disagreed : [], needsYou: v ? v.needsYou : [], quality: v ? v.quality : [],
      warnings: v ? v.warnings : []
    }
  }

  return {
    ok: true, follow: !!where.follow, dir: name, slug: str(s.slug || name, 120), question, mode: str(s.mode, 20), size: str(s.size, 10),
    dryRun: !!s.dryRun, state: stale ? 'stale' : (s.state === 'done' || s.state === 'failed' ? s.state : 'running'),
    phase: str(s.phase, 20), startedAt: num(s.startedAt), endedAt: num(s.endedAt), now,
    members, chair, skipped: Array.isArray(s.skipped) ? s.skipped.map(String) : [], verdict, error: str(s.error, 300)
  }
}

// One answer's full Markdown: who = claude | codex | agy | chair.
export function readCouncilAnswer(ref, root, who) {
  if (!['claude', 'codex', 'agy', 'chair'].includes(who)) return { ok: false, error: 'unknown answer' }
  const where = resolveCouncilDir(ref, root)
  if (where.error) return { ok: false, error: where.error }
  let t = readText(path.join(where.dir, 'raw', `${who}.answer.md`), 512 * 1024)
  if (t == null && who !== 'chair') {
    // raw/ is gitignored, so an older council keeps only answers/<label>.md: find the label in verdict.md.
    const v = parseVerdictFull(readText(path.join(where.dir, 'verdict.md')))
    const label = v && Object.keys(v.mapping).find(k => v.mapping[k] === who)
    if (label) t = readText(path.join(where.dir, 'answers', `${label}.md`), 512 * 1024)
  }
  if (t == null && who === 'chair') t = readText(path.join(where.dir, 'verdict.md'), 512 * 1024)
  return t == null ? { ok: false, error: 'This answer is not on disk.' } : { ok: true, who, markdown: t }
}
