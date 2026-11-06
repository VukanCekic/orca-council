#!/usr/bin/env node
// council.mjs: three AI CLIs answer the same brief independently, then Claude judges the answers blind.
//
//   node runner/council.mjs decision "Should we move the cache to Redis?" --context docs/cache.md
//   node runner/council.mjs deliverable --brief review.md --project ./site
//   node runner/council.mjs facts --brief claims.md --full
//   node runner/council.mjs decision "Test?" --dry-run          (stand-in engines, no AI usage)
//   node runner/council.mjs doctor                              (which CLIs it can find)
//
// decision | deliverable | facts --full : claude + codex + agy answer, claude chairs blind
// facts (Lite)                          : codex fact-checks, claude triages
// Output: <root>/YYYY-MM-DD-<slug>/ brief.md, member-prompt.md, answers/A-C.md, sealed.json, verdict.md, raw/,
//         council.view (open it in Orca), plus one line in <root>/index.jsonl. <root> defaults to <project>/.council
//         (or COUNCIL_ROOT, or --root); it holds a .gitignore of "*" so git ignores it. The last line of verdict.md is "FAVOURED: A|B|C|none".
// Live:   raw/status.json is rewritten atomically at every step and raw/<engine>.out.txt fills with each CLI's JSON
//         lines; the Council tab in Orca reads both. <root>/live.view always shows the newest council.
// Exit codes: 0 ok (also degraded), 2 no member answered, 3 chair failed, 1 bad input.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { MEMBER_ENGINES, engineModels, resolveEngine, memberSpec, chairSpec, runParallel, killAll, readText, writeText, appendLine, writeJsonAtomic } from './engines.mjs'
import { QUESTION_RE } from '../lib/council-view.mjs'

const G_OK = '✔', G_NO = '✖', G_YOU = '●', G_WARN = '⚠'
const PROMPT_CAP = 25000   // agy takes the prompt as one argument; Windows caps a command line near 32k
const USAGE = `usage: node council.mjs <decision|deliverable|facts> ("question" | --brief <file.md>) [options]
       node council.mjs doctor

  --context <file>    a file to inline for every member (repeatable)
  --project <dir>     folder the members may read (default: current folder)
  --members <list>    comma list of claude,codex,agy (default: all three; facts without --full: codex)
  --full              facts mode with all three members instead of codex alone
  --slug <name>       folder name (default: from the question)
  --timeout <min>     per engine (default 15)
  --root <dir>        councils folder (default: <project>/.council, or $COUNCIL_ROOT)
  --dry-run           stand-in engines, no AI usage
  --pace <n>          with --dry-run: 1 plays the stand-ins at real speed (same as COUNCIL_FAKE_PACE)
  --no-open           do not open the Council tab in Orca`

function fail(msg, code = 1) { process.stderr.write(`council: ${msg}\n`); process.exit(code) }
function log(msg) { process.stdout.write(msg + '\n') }

// Councils live in <project>/.council by default: inside the Orca workspace you run from, so Orca can open the tab and
// the .view files show in its file tree. The folder ignores itself in git (.council/.gitignore holds "*").
function defaultRoot(project = process.cwd()) { return process.env.COUNCIL_ROOT || path.join(project, '.council') }

function doctor() {
  log(`council doctor (${process.platform}, node ${process.version})`)
  let found = 0
  for (const e of MEMBER_ENGINES) {
    try { const r = resolveEngine(e); log(`  ${G_OK} ${e.padEnd(6)} ${[r.exe, ...r.prefix].join(' ')}`); found++ } catch (err) { log(`  ${G_NO} ${e.padEnd(6)} ${err.message}`) }
  }
  const m = engineModels()
  log(`  models: claude=${m.claude} codex=${m.codex} agy=${m.agy} (override with COUNCIL_<ENGINE>_MODEL)`)
  log(`  councils folder: ${defaultRoot()} (the project's .council folder, or COUNCIL_ROOT)`)
  log(found === 3 ? 'Ready.' : found ? `Ready with ${found} of 3 members (missing ones are skipped and the verdict says so).` : 'No member CLI found: install at least one, plus claude for the chair.')
  process.exit(found ? 0 : 1)
}

// ---------------------------------------------------------------- inputs
const argv = process.argv.slice(2)
if (argv[0] === 'doctor') doctor()
let parsed
try {
  parsed = parseArgs({ args: argv, allowPositionals: true, options: {
    brief: { type: 'string' }, question: { type: 'string' }, context: { type: 'string', multiple: true, default: [] },
    slug: { type: 'string' }, project: { type: 'string' }, timeout: { type: 'string' }, members: { type: 'string' },
    full: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, root: { type: 'string' },
    'no-open': { type: 'boolean', default: false }, pace: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false }
  } })
} catch (e) { fail(`${e.message}\n${USAGE}`) }
const opt = parsed.values
if (opt.help || !parsed.positionals.length) { log(USAGE); process.exit(opt.help ? 0 : 1) }
const mode = parsed.positionals[0]
if (!['decision', 'deliverable', 'facts'].includes(mode)) fail(`unknown mode "${mode}"\n${USAGE}`)
const question = opt.question || parsed.positionals.slice(1).join(' ').trim()
if (!question === !opt.brief) fail('give exactly one of a question or --brief <file>')
if (opt.brief && !fs.existsSync(opt.brief)) fail(`brief not found: ${opt.brief}`)
for (const c of opt.context) if (!fs.existsSync(c) || !fs.statSync(c).isFile()) fail(`context file not found: ${c}`)
const projectDir = path.resolve(opt.project || process.cwd())
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) fail(`project folder not found: ${projectDir}`)
const timeoutMin = opt.timeout ? Number(opt.timeout) : 15
if (!(timeoutMin > 0)) fail('--timeout must be a number of minutes > 0')
const dryRun = opt['dry-run']
if (opt.pace != null) { if (!(Number(opt.pace) >= 0)) fail('--pace must be a number >= 0'); process.env.COUNCIL_FAKE_PACE = String(Number(opt.pace)) }
const councilsRoot = path.resolve(opt.root || defaultRoot(projectDir))
fs.mkdirSync(councilsRoot, { recursive: true })
// Keep councils out of the project's git without touching its own .gitignore.
const selfIgnore = path.join(councilsRoot, '.gitignore')
if (!fs.existsSync(selfIgnore)) writeText(selfIgnore, '# Council runs (runner/council.mjs). Ignored by git on purpose.\n*\n')

let briefText = opt.brief ? readText(path.resolve(opt.brief)) : ''
let slug = opt.slug
if (!slug) {
  slug = question
  if (opt.brief) { const h = /^#\s+(.+)$/m.exec(briefText); slug = h ? h[1] : path.basename(opt.brief, path.extname(opt.brief)) }
}
slug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
if (slug.length > 48) slug = slug.slice(0, 48).replace(/-+$/, '')
if (!slug) slug = 'council'

const lite = mode === 'facts' && !opt.full
let planned = lite ? ['codex'] : [...MEMBER_ENGINES]
if (opt.members) {
  planned = [...new Set(opt.members.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))]
  const bad = planned.filter(e => !MEMBER_ENGINES.includes(e))
  if (bad.length || !planned.length) fail(`--members takes claude, codex and/or agy (got: ${opt.members})`)
}
const timeoutSec = timeoutMin * 60
const warnings = []
const models = engineModels()
const skipped = []
// Engines the user blocked (COUNCIL_BLOCKED, comma list) or whose CLI is missing are skipped, and the verdict says so.
const blocked = new Set(String(process.env.COUNCIL_BLOCKED || '').split(',').map(s => s.trim()).filter(Boolean))
let engines = planned.filter(e => {
  if (blocked.has(e)) { skipped.push(e); warnings.push(`${e} skipped (blocked by COUNCIL_BLOCKED)`); return false }
  if (!dryRun) { try { resolveEngine(e) } catch (err) { skipped.push(e); warnings.push(`${e} skipped: ${err.message}`); return false } }
  return true
})
if (!engines.length) fail(`no member can run: ${warnings.join('; ')}\nRun "node council.mjs doctor" to see what is missing.`)
if (!dryRun) { try { resolveEngine('claude') } catch (err) { fail(`the chair needs claude: ${err.message}`) } }

// ---------------------------------------------------------------- a. folder
const pad = (n) => String(n).padStart(2, '0')
const d0 = new Date()
const date = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`
let dirName = `${date}-${slug}`
for (let n = 2; fs.existsSync(path.join(councilsRoot, dirName)); n++) dirName = `${date}-${slug}-${n}`
const dir = path.join(councilsRoot, dirName)
const raw = path.join(dir, 'raw')
const answersDir = path.join(dir, 'answers')
for (const d of [dir, raw, answersDir]) fs.mkdirSync(d, { recursive: true })

// ---------------------------------------------------------------- live status (read by the Council tab)
const statusPath = path.join(raw, 'status.json')
const now = () => Date.now()
const S = {
  schema: 1, kind: 'council', slug, dir: dirName, mode, size: lite ? 'Lite' : 'Full', dryRun, pid: process.pid,
  state: 'running', phase: 'setup', startedAt: now(), updatedAt: now(), endedAt: null,
  members: engines.map(e => ({ engine: e, model: models[e], state: 'queued', startedAt: null, endedAt: null, seconds: null, error: null, limitHit: false, tldr: null })),
  skipped, chair: { state: 'queued', startedAt: null, endedAt: null, seconds: null, error: null, tldr: null }, verdict: null, error: null
}
function save() { S.updatedAt = now(); writeJsonAtomic(statusPath, S) }
function tldrOf(text) {
  const m = /^\s*#{1,4}\s*TL;?\s?DR\s*:?\s*\r?\n(?:\s*\r?\n)*\s*(\S[^\r\n]*)/im.exec(text || '')
  if (!m) return null
  let l = m[1].replace(/\*\*/g, '').trim()
  if (l.startsWith('#')) return null
  return l.length > 200 ? l.slice(0, 199) + '…' : l
}
function setMember(r) {
  const m = S.members.find(x => x.engine === r.name)
  if (!m) return
  m.state = r.ok ? 'done' : r.timedOut ? 'timeout' : 'failed'
  m.endedAt = m.endedAt || now(); m.seconds = r.durationSec; m.error = r.error; m.limitHit = !!r.limitHit
  if (r.ok) m.tldr = tldrOf(readText(r.answerFile))
}
// Ctrl+C or a crash after the folder exists: stop the CLIs and mark the run failed instead of leaving it "running".
function abort(msg) {
  killAll()
  if (S.state === 'running') { S.state = 'failed'; S.error = msg; S.endedAt = now(); save() }
}
process.on('SIGINT', () => { abort('stopped (Ctrl+C)'); process.exit(130) })
process.on('SIGTERM', () => { abort('stopped'); process.exit(143) })
process.on('uncaughtException', (e) => { abort(`script error: ${e.message}`); process.stderr.write(String(e.stack || e) + '\n'); process.exit(1) })
process.on('unhandledRejection', (e) => { abort(`script error: ${e && e.message || e}`); process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1) })
save()
writeJsonAtomic(path.join(councilsRoot, 'live.json'), { schema: 1, dir: dirName, slug, pid: process.pid, startedAt: S.startedAt, status: `${dirName}/raw/status.json` })

// The Council view: Orca's Council plugin opens *.view files as a live tab. The tab only gets this file's text,
// never its path, so it names the folder. council.view = this council; <root>/live.view = always the newest.
let viewQuestion = question
if (!viewQuestion) { const qm = QUESTION_RE.exec(briefText); viewQuestion = qm ? qm[1].trim() : slug }
if (viewQuestion.length > 400) viewQuestion = viewQuestion.slice(0, 399) + '…'
const viewNote = 'Open in Orca to watch the Council (Council plugin). It reads raw/status.json and the logs in this folder.'
const viewPath = path.join(dir, 'council.view')
writeJsonAtomic(viewPath, { schema: 1, kind: 'blind-panel', dir, slug, mode, question: viewQuestion, note: viewNote })
const liveView = path.join(councilsRoot, 'live.view')
if (!fs.existsSync(liveView)) writeJsonAtomic(liveView, { schema: 1, kind: 'blind-panel', follow: councilsRoot, note: 'Always shows the newest council. ' + viewNote })

// ---------------------------------------------------------------- b. brief.md
const GOOD = {
  decision: 'One clear recommendation, with the reasons and the risks that would change it.',
  deliverable: 'What must change before this reaches a client, ranked by how much it matters.',
  facts: 'Every checkable claim marked true / false / unclear, with the reason and a source where possible.'
}
if (question) {
  const ctxList = opt.context.length ? opt.context.map(c => `- ${c}`).join('\n') : '(none)'
  briefText = `# Council brief: ${slug}\n\nMode: ${mode}\n\n## Question\n\n${question}\n\n## Context files\n\n${ctxList}\n\n## What good looks like\n\n${GOOD[mode]}`
}
writeText(path.join(dir, 'brief.md'), briefText)

// ---------------------------------------------------------------- c. member-prompt.md
const TASK = {
  decision: 'This is a DECISION. Recommend one option and defend it. If the options are wrong, say what the better option is.',
  deliverable: 'This is a DELIVERABLE REVIEW, before it reaches a client. Say what is wrong, what is missing and what must change, most important first.',
  facts: 'This is a FACT-CHECK. List each checkable claim as TRUE / FALSE / UNCLEAR with the reason and, where you can, a source. Say which claims you could not check.'
}
const head = `You are one member of a review council. Other reviewers answer the same brief separately; you will not see them, and a judge will compare the answers without knowing who wrote which.

Rules:
- Answer on your own judgement. Do not say which AI model, product or company you are.
- You may read files in your working directory if that helps. Do NOT create, edit or delete any file, and do not run commands that change anything.
- Be direct and concrete. Say plainly if the question itself is wrong.

${TASK[mode]}

=== BRIEF ===
${briefText.trim()}`
const format = `

=== ANSWER FORMAT (use exactly these headings, nothing before the first one) ===
## TL;DR
(one line, at most 20 words: your answer in short)
## Recommendation
(one paragraph)
## Reasons
(up to 5, numbered)
## Risks
## What I'm unsure about
## Confidence
low | medium | high, then one line on why`

const files = opt.context.map(c => { const p = path.resolve(c); return { p, text: readText(p), cap: 0 } })
const ctxHeader = '\n\n=== CONTEXT FILES (inlined; paths are on the machine you run on) ===\n'
let budget = PROMPT_CAP - head.length - format.length - ctxHeader.length - files.length * 160
if (files.length && budget < 1000) { warnings.push('brief alone is near the prompt cap; context files cut hard'); budget = 1000 }
// Water-filling: small files keep everything, the rest share what is left equally.
let left = budget
const order = [...files].sort((a, b) => a.text.length - b.text.length)
order.forEach((f, i) => { const share = Math.floor(left / (order.length - i)); f.cap = Math.min(f.text.length, share); left -= f.cap })
let ctxBlock = ''
if (files.length) {
  ctxBlock = ctxHeader + files.map(f => {
    let t = f.text, note = `${t.length} chars`
    if (t.length > f.cap) {
      t = t.slice(0, f.cap)
      note = `TRUNCATED: first ${f.cap} of ${f.text.length} chars shown; the rest is cut off`
      warnings.push(`context truncated: ${path.basename(f.p)} ${f.cap} of ${f.text.length} chars (prompt cap ${PROMPT_CAP})`)
    }
    return `--- FILE: ${f.p} (${note}) ---\n${t}\n--- END FILE ---`
  }).join('\n\n')
}
const memberPrompt = head + ctxBlock + '\n' + format
writeText(path.join(dir, 'member-prompt.md'), memberPrompt)

// ---------------------------------------------------------------- d. members, in parallel
log(`council: ${mode} (${S.size}) -> ${dir}`)
log(`council: watch it in Orca: orca file open "${viewPath}" --focus`)
log(`council: members ${engines.join(', ')} in parallel, timeout ${timeoutMin} min${dryRun ? ' [DRY RUN: stand-in engines]' : ''}`)
for (const w of warnings) log(`${G_WARN} ${w}`)
if (!opt['no-open'] && process.env.COUNCIL_NO_OPEN !== '1') openInOrca(viewPath)

const specs = engines.map(e => memberSpec({ engine: e, prompt: memberPrompt, projectDir, logDir: raw, answerFile: path.join(raw, `${e}.answer.md`), timeoutSec, dryRun, models }))
S.phase = 'members'
const tm = now()
for (const m of S.members) { m.state = 'running'; m.startedAt = tm }
save()
const results = await runParallel(specs, (r) => { setMember(r); save() })
for (const r of results) {
  log(`council:   ${r.name.padEnd(6)} ${String(r.durationSec).padStart(7)} s  ${r.ok ? 'ok' : `FAILED (${r.error})`}${r.limitHit ? ' [LIMIT HIT]' : ''}`)
  if (!r.ok) warnings.push(`${r.name} did not answer: ${r.error}${r.limitHit ? ' (usage/rate limit message in its log)' : ''}`)
}
// agy runs in an empty throwaway folder. Anything in it means agy wrote files despite --mode plan.
const agyWs = path.join(raw, 'agy-ws')
if (fs.existsSync(agyWs)) {
  const stray = fs.readdirSync(agyWs, { recursive: true }).filter(f => { try { return fs.statSync(path.join(agyWs, f)).isFile() } catch { return false } })
  if (stray.length) warnings.push(`SAFETY: agy wrote ${stray.length} file(s) into its throwaway folder raw/agy-ws despite --mode plan. Nothing in the project was reachable.`)
}
const okResults = results.filter(r => r.ok)
const memberLine = (r, label = null) => ({ engine: r.name, label, ok: r.ok, durationSec: r.durationSec, timedOut: r.timedOut, limitHit: r.limitHit })
if (!okResults.length) {
  const msg = `no member answered. Logs: ${raw}`
  writeText(path.join(dir, 'verdict.md'), `# Council FAILED: ${slug}\n\n${G_WARN} ${msg}\n\n${warnings.map(w => `- ${w}`).join('\n')}\n\nFAVOURED: none\n`)
  appendLine(path.join(councilsRoot, 'index.jsonl'), JSON.stringify({ date, slug, dir: dirName, mode, size: S.size, status: 'failed', dryRun,
    members: results.map(r => memberLine(r)), chair: null, confidence: null, favoured: 'none', favouredEngine: null, skipped, warnings }))
  Object.assign(S, { state: 'failed', phase: 'verdict', error: msg, endedAt: now() }); S.chair.state = 'skipped'; save()
  fail(msg, 2)
}
const degraded = !lite && okResults.length < planned.length
if (!lite && okResults.length === 1) warnings.unshift('DEGRADED: only one member answered, so this is a single opinion, not a council')
else if (degraded) warnings.unshift(`${okResults.length} of ${planned.length} members answered`)

// ---------------------------------------------------------------- e. shuffle (crypto, Fisher-Yates)
const labels = ['A', 'B', 'C'].slice(0, okResults.length)
const shuffled = [...okResults]
for (let i = shuffled.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]] }
const mapping = {}
shuffled.forEach((r, i) => { mapping[labels[i]] = r.name; fs.copyFileSync(r.answerFile, path.join(answersDir, `${labels[i]}.md`)) })
writeText(path.join(dir, 'sealed.json'), JSON.stringify({ note: 'Label -> engine. Never shown to the chair.', created: new Date().toISOString(), mapping }, null, 2))

// ---------------------------------------------------------------- f. blind chair
const REDACT = /\b(?:chat\s?gpt|gpt|claude|anthropic|codex|openai|gemini|google|antigravity|agy|opus|sonnet|haiku|sol|argon|deepmind)\b(?:[-\s]?\d[\w.]*(?:-[a-z]+)*)?/gi
const protect = (t) => t.replace(REDACT, '[model]')
const CHAIR_TASK = {
  decision: 'Judge which answer gives the best decision and why. Where they disagree, say who is right.',
  deliverable: 'Judge which review catches what matters most before this reaches a client. Where they disagree, say who is right.',
  facts: 'Judge the fact-checks. Where they disagree, say which is right.'
}
const chairMode = lite ? 'Only ONE reviewer answered: it fact-checked the material. Triage its findings: which to act on, which need a human check, and which look wrong. Agreed / Disagreed then mean: claims you agree with / claims where you think the reviewer is wrong.' : CHAIR_TASK[mode]
const ansBlock = labels.map(l => `=== ANSWER ${l} ===\n${protect(readText(path.join(answersDir, `${l}.md`))).trim()}\n=== END ANSWER ${l} ===`).join('\n\n')
const missing = okResults.length < planned.length ? `\nNote: ${planned.length - okResults.length} reviewer(s) did not answer; judge the answers you have.\n` : ''
const labelList = labels.join(', ')
const chairPrompt = `You are the blind chair of a review council. Reviewers answered the brief below independently. Their answers are labelled ${labelList} in random order. You do not know who wrote which, and must not guess: judge only the content. Product and model names inside the answers were replaced with [model]; that marker can also hide a legitimate topic word.

${chairMode}
${missing}
Reply in Markdown with EXACTLY these sections, in this order, and nothing before the first one:

## TL;DR
(one line, at most 20 words: the verdict in short; use the labels, never a guessed name)
## ${G_OK} Agreed
(bullets: what the answers agree on)
## ${G_NO} Disagreed
(bullets: each disagreement, who is right, and why)
## ${G_YOU} Needs you
(bullets: the decisions or checks only the human can make; "none" if none)
## Verdict
(two or three sentences)
## Confidence
low | medium | high, then one line on why
## Answer quality
(one line per label, e.g. "- A: ...")

The very last line must be exactly one of: FAVOURED: A / FAVOURED: B / FAVOURED: C / FAVOURED: none  (only labels that exist: ${labelList})

=== WHAT THE REVIEWERS WERE GIVEN ===
${memberPrompt}
=== END OF WHAT THE REVIEWERS WERE GIVEN ===

${ansBlock}`
writeText(path.join(raw, 'chair-input.md'), chairPrompt)

const chairDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-chair-'))
log('council: chair (claude, blind, no tools)...')
S.phase = 'chair'; S.chair.state = 'running'; S.chair.startedAt = now(); save()
let chair
try {
  [chair] = await runParallel([chairSpec({ prompt: chairPrompt, emptyDir: chairDir, logDir: raw, answerFile: path.join(raw, 'chair.answer.md'), timeoutSec, dryRun, models })])
} finally { try { fs.rmSync(chairDir, { recursive: true, force: true }) } catch { /* ignore */ } }
const cs = S.chair
cs.state = chair.ok ? 'done' : chair.timedOut ? 'timeout' : 'failed'
cs.endedAt = now(); cs.seconds = chair.durationSec; cs.error = chair.error
const chairText = chair.ok ? readText(chair.answerFile) : ''
if (chair.ok) cs.tldr = tldrOf(chairText)
save()
log(`council:   chair  ${String(chair.durationSec).padStart(7)} s  ${chair.ok ? 'ok' : `FAILED (${chair.error})`}`)

const favs = [...chairText.matchAll(/^\s*\**FAVOURED:\s*(A|B|C|none)\**\s*$/gim)]
let fav = favs.length ? favs[favs.length - 1][1].toUpperCase() : 'none'
if (fav === 'NONE') fav = 'none'
if (fav !== 'none' && !mapping[fav]) { warnings.push(`chair favoured ${fav}, which does not exist`); fav = 'none' }
const body = chairText.replace(/^\s*\**FAVOURED:.*$/gim, '').trim()
const cm = /##\s*Confidence\s*\r?\n\s*\**\s*(low|medium|high)/is.exec(body)
const conf = cm ? cm[1].toLowerCase() : null
if (chair.ok && !favs.length) warnings.push('chair gave no FAVOURED line')
if (!chair.ok) warnings.push(`chair failed: ${chair.error}; the answers are in answers/`)

// ---------------------------------------------------------------- verdict.md, then g. unseal
const resultOf = (e) => results.find(r => r.name === e)
const out = [`# Council verdict: ${slug}`, '', `${date} | mode **${mode}** (${S.size}) | answers: ${okResults.length} of ${planned.length} | chair: blind Claude${dryRun ? ' | DRY RUN (stand-in engines)' : ''}`]
if (mode === 'deliverable') out.push('', `> ${G_WARN} Your own checks are still required. A council verdict is never proof that a file works.`)
if (warnings.length) { out.push(''); for (const w of warnings) out.push(`> ${G_WARN} ${w}`) }
out.push('', chair.ok ? body : `Chair failed: ${chair.error}. Read answers/ yourself.`)
out.push('', '---', '', '## Unsealed (after the chair finished)', '')
for (const k of Object.keys(mapping)) out.push(`- ${k} = **${mapping[k]}** (${models[mapping[k]]}, ${resultOf(mapping[k]).durationSec} s)${k === fav ? ' <- favoured' : ''}`)
for (const r of results.filter(x => !x.ok)) out.push(`- (no label) = **${r.name}**: did not answer, ${r.error}`)
for (const e of skipped) out.push(`- (no label) = **${e}**: skipped`)
out.push('', `FAVOURED: ${fav}`)
const verdictPath = path.join(dir, 'verdict.md')
writeText(verdictPath, out.join('\n') + '\n')

const favEngine = fav !== 'none' ? mapping[fav] : null
const labelOf = Object.fromEntries(Object.entries(mapping).map(([k, e]) => [e, k]))
const status = !chair.ok ? 'chair-failed' : degraded ? 'degraded' : 'ok'
appendLine(path.join(councilsRoot, 'index.jsonl'), JSON.stringify({ date, slug, dir: dirName, mode, size: S.size, status, dryRun,
  members: results.map(r => memberLine(r, labelOf[r.name] || null)),
  chair: { ok: chair.ok, durationSec: chair.durationSec, timedOut: chair.timedOut, limitHit: chair.limitHit },
  confidence: conf, favoured: fav, favouredEngine: favEngine, skipped, warnings }))
// The label -> engine mapping goes into the live status only now, after the chair finished.
S.verdict = { favoured: fav, favouredEngine: favEngine, confidence: conf, status, answers: okResults.length, planned: planned.length,
  warnings: warnings.length, file: 'verdict.md', tldr: cs.tldr, mapping }
Object.assign(S, { state: 'done', phase: 'verdict', endedAt: now() })
save()

// ---------------------------------------------------------------- h. print
log('')
log(`Verdict: ${verdictPath}`)
const ny = new RegExp(`##\\s*${G_YOU}\\s*Needs you\\s*([\\s\\S]*?)(?=\\r?\\n##\\s|$)`).exec(body)
log(`${G_YOU} Needs you:`)
log(ny ? ny[1].trim() : '(chair gave no Needs you section; read the verdict)')
for (const w of warnings) log(`${G_WARN} ${w}`)
process.exit(chair.ok ? 0 : 3)

// Opens the Council tab when the orca CLI is on PATH (it is inside Orca's terminals) and says plainly when it could
// not. Orca opens only files inside one of its workspaces, which is why councils live in <project>/.council by
// default. Never fails the run.
function openInOrca(file) {
  const hint = `council: open it yourself: click ${path.relative(projectDir, file) || file} in Orca's file tree (it must be inside an Orca workspace)`
  try {
    const exe = process.platform === 'win32' ? 'orca.exe' : 'orca'
    const found = String(process.env.PATH || process.env.Path || '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, exe)))
    if (!found) { log(hint); return }
    const r = spawnSync(exe, ['file', 'open', file, '--focus', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    let ok = r.status === 0
    try { ok = ok && JSON.parse(r.stdout).ok !== false } catch { /* plain output */ }
    if (ok) log('council: opened the Council tab in Orca')
    else {
      let why = ''
      try { why = JSON.parse(r.stdout).error.message } catch { why = (r.stderr || r.stdout || '').trim().split('\n')[0] }
      log(`council: Orca could not open the tab${why ? ` (${why})` : ''}`)
      log(hint)
    }
  } catch { log(hint) }
}
