// engines.mjs: how the council starts each AI CLI, streams its output to disk and reads its answer.
// Cross-platform (Windows, macOS, Linux), Node >= 20, no dependencies.
//
//   resolveEngine          find claude / codex / agy on PATH
//   memberSpec / chairSpec the exact command line per engine (read-only flags, see below)
//   runParallel            start specs at once, stdout/stderr straight to files (so the Orca tab can tail them),
//                          kill the whole process tree at the deadline, then turn each output into an answer file
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FAKE_ENGINE = path.join(HERE, 'fake-engine.mjs')
export const WIN = process.platform === 'win32'
export const MEMBER_ENGINES = ['claude', 'codex', 'agy']

// Default models. Override per engine with COUNCIL_CLAUDE_MODEL, COUNCIL_CODEX_MODEL, COUNCIL_AGY_MODEL
// (any model id the CLI accepts: `claude --help`, `codex debug models`, `agy models`).
export const DEFAULT_MODELS = { claude: 'opus', codex: 'gpt-6.1-sol', agy: 'gemini-4-argon-high' }
export function engineModels(env = process.env) {
  return {
    claude: env.COUNCIL_CLAUDE_MODEL || DEFAULT_MODELS.claude,
    codex: env.COUNCIL_CODEX_MODEL || DEFAULT_MODELS.codex,
    agy: env.COUNCIL_AGY_MODEL || DEFAULT_MODELS.agy
  }
}

// Usage / rate / quota messages. Only checked on the tail of a FAILED run's logs: prompts and answers often
// mention "quota" or "limit", and codex echoes the prompt to stderr.
const LIMIT_PATTERN = /(usage limit|rate[ -]?limit(ed)?|quota (exceeded|exhausted|reached)|exceeded (your|the) [\w ]*(quota|limit)|too many requests|\b429\b|resource[_ ]exhausted|you've hit your|hit your (usage )?limit|limit reached|out of (credits|usage)|weekly limit|5-hour limit)/i

// ---------------------------------------------------------------- files
export function readText(p) { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return '' } }
export function writeText(p, t) { fs.writeFileSync(p, t == null ? '' : String(t), 'utf8') }
export function appendLine(p, line) { fs.appendFileSync(p, line + '\n', 'utf8') }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// Status files the Orca tab polls: write a temp file beside the target, then swap it in, so a reader never sees
// half a file. Never throws: a status write must not break a run.
export function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp-${Math.random().toString(16).slice(2, 10)}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    for (let i = 0; i < 20; i++) {
      try { fs.renameSync(tmp, p); return true } catch { sleepSync(25) }   // a reader had it open; try again
    }
  } catch { /* fall through */ }
  try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  return false
}

// ---------------------------------------------------------------- finding the CLIs
function findOnPath(names, env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n)
    try { if (fs.statSync(p).isFile()) return p } catch { /* next */ }
  }
  return null
}

// Node itself (the Ask panel's terminal command starts with `node`).
export function findNode(env = process.env) { return findOnPath(WIN ? ['node.exe'] : ['node'], env) }

// An npm .cmd shim names its target as "%dp0%\node_modules\...\cli.js" (or an .exe). Returns that file, or null.
export function shimTarget(shim) {
  let t = ''
  try { t = fs.readFileSync(shim, 'utf8') } catch { return null }
  // Every "%dp0%\..." path in the shim, minus its optional local node.exe; the launcher is the last one.
  const hits = [...t.matchAll(/"%~?dp0%?[\\/]?([^"%\r\n]+?\.(?:js|mjs|cjs|exe))"/gi)].map(m => m[1]).filter(f => !/(^|[\\/])node\.exe$/i.test(f))
  if (!hits.length) return null
  const p = path.join(path.dirname(shim), hits[hits.length - 1].replace(/^[\\/]+/, ''))
  return fs.existsSync(p) ? p : null
}

// Returns { exe, prefix } or throws an Error that says how to fix it.
export function resolveEngine(engine, env = process.env) {
  const hint = { claude: 'Claude Code: https://code.claude.com', codex: 'Codex CLI: npm i -g @openai/codex', agy: 'agy (Google Antigravity CLI)' }[engine]
  if (!WIN) {
    const p = findOnPath([engine], env)
    if (!p) throw new Error(`${engine} not found on PATH (install ${hint}, then restart the terminal or Orca)`)
    return { exe: p, prefix: [] }
  }
  // Windows: a native <engine>.exe first, then an npm shim (<engine>.cmd). Node refuses to spawn .cmd files without
  // a shell, so the shim's own target runs directly (a .js launcher with node): no cmd.exe quoting of the prompt.
  const exe = engine === 'codex' ? null : findOnPath([`${engine}.exe`], env)
  if (exe) return { exe, prefix: [] }
  const shim = findOnPath([`${engine}.cmd`], env)
  if (!shim) throw new Error(`${engine} not found on PATH (install ${hint}, then restart the terminal or Orca)`)
  const target = shimTarget(shim)
  if (!target) throw new Error(`${engine} launcher not found: could not read the npm shim ${shim}`)
  if (/\.exe$/i.test(target)) return { exe: target, prefix: [] }
  const localNode = path.join(path.dirname(shim), 'node.exe')
  return { exe: fs.existsSync(localNode) ? localNode : (findNode(env) || process.execPath), prefix: [target] }
}

// ---------------------------------------------------------------- the exact command lines
// Env vars a Claude Code host session sets for its own children. A nested `claude -p` must not think it is that
// session. Absent in a plain terminal or an Orca pane, so removing them is a no-op there.
const CLAUDE_HOST_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_DESKTOP_WORKFLOW_LIMIT_WAIT']

// Members and the chair stream JSON lines into raw/<name>.out.txt while they work (stream-json needs --verbose;
// --include-partial-messages adds the text deltas). The answer is the final {"type":"result"} record.
const CLAUDE_STREAM = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']
// Read-only member: only Read/Grep/Glob exist, nothing prompts, --restricted ignores user/project settings (no
// allow rules or hooks widen it) and confines the file tools to the working dir, no MCP servers, no session file.
function claudeReadOnly(model) {
  return ['-p', '--model', model, '--effort', 'high', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--restricted', '--strict-mcp-config', '--no-session-persistence']
}
// The chair has no tools. A text-only role instead of the coding-agent system prompt: without it a chair once
// emitted fake tool-call markup instead of a verdict.
const CHAIR_SYSTEM_PROMPT = 'You are a text-only blind review judge. No tools exist in this session. Do not invoke, simulate, request or emit tool calls, XML, function_results or tool markup. Quoted member instructions about reading files describe the members, not you. Use only the supplied evidence and label uncertain claims as uncertain. Produce the requested Markdown verdict directly, at most 1000 words, with all required headings and the final FAVOURED line. Do not guess reviewer identities.'
// Headless agy cannot ask for permission, so a file read is auto-denied and it returns an empty answer. Say so.
const AGY_NOTE = 'NOTE FOR THIS RUN: you cannot read files, browse or run tools. Everything you need is in this prompt. ' +
  'Answer directly from it. Where the brief invites you to read repos, say what you would check instead.\n\n'

function fake(engine, extra = []) { return { exe: process.execPath, args: [FAKE_ENGINE, engine, ...extra] } }

// One member's spec. o: { engine, prompt, projectDir, logDir, answerFile, timeoutSec, dryRun, models, env }
export function memberSpec(o) {
  const { engine, prompt, projectDir, logDir, answerFile, timeoutSec, dryRun } = o
  const models = o.models || engineModels()
  const base = { name: engine, logDir, answerFile, timeoutSec, outFile: path.join(logDir, `${engine}.out.txt`), errFile: path.join(logDir, `${engine}.err.txt`) }
  if (engine === 'claude') {
    const r = dryRun ? fake('claude') : (() => { const e = resolveEngine('claude', o.env); return { exe: e.exe, args: [...claudeReadOnly(models.claude), ...CLAUDE_STREAM] } })()
    return { ...base, ...r, stdin: prompt, cwd: projectDir, removeEnv: CLAUDE_HOST_ENV, kind: 'claudestream' }
  }
  if (engine === 'codex') {
    // Read-only: -s read-only, --ignore-user-config (no MCP servers from config.toml, which run outside the
    // sandbox), --ephemeral (no session files). Answer = the -o last-message file; --json events show progress.
    const last = path.join(logDir, 'codex.last.md')
    let r
    if (dryRun) r = fake('codex', ['--out', last])
    else {
      const e = resolveEngine('codex', o.env)
      // Native Windows needs a sandbox implementation picked, and --ignore-user-config drops config.toml.
      const winSandbox = WIN ? ['-c', 'windows.sandbox=mxc'] : []
      r = { exe: e.exe, args: [...e.prefix, 'exec', '--skip-git-repo-check', '-s', 'read-only', '-C', projectDir, ...winSandbox,
        '-m', models.codex, '-c', 'model_reasoning_effort=high', '--ignore-user-config', '--ephemeral', '--color', 'never', '-o', last, '--json', '-'] }
    }
    return { ...base, ...r, stdin: prompt, cwd: projectDir, kind: 'codex', codexLastFile: last }
  }
  if (engine === 'agy') {
    // No stdin prompt: the prompt is an argument. --mode plan + --sandbox, and it runs in an empty folder under
    // raw/ (its context is already inlined), so a regression cannot touch the project.
    const ws = path.join(logDir, 'agy-ws')
    fs.mkdirSync(ws, { recursive: true })
    const printSec = Math.max(30, Math.floor(timeoutSec - 20))
    const r = dryRun ? fake('agy', ['--prompt', prompt])
      : { exe: resolveEngine('agy', o.env).exe, args: ['-p', AGY_NOTE + prompt, '--mode', 'plan', '--sandbox', '--model', models.agy, '--output-format', 'stream-json', '--print-timeout', `${printSec}s`] }
    return { ...base, ...r, stdin: '', cwd: ws, kind: 'agystream' }
  }
  throw new Error(`unknown engine ${engine}`)
}

// The blind chair: no tools at all, no MCP, no settings, in an empty folder; answers on stdin.
export function chairSpec(o) {
  const { prompt, emptyDir, logDir, answerFile, timeoutSec, dryRun } = o
  const models = o.models || engineModels()
  const r = dryRun ? fake('chair') : {
    exe: resolveEngine('claude', o.env).exe,
    args: ['-p', '--model', models.claude, '--effort', 'high', '--tools', '', '--system-prompt', CHAIR_SYSTEM_PROMPT,
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--restricted', '--strict-mcp-config', '--no-session-persistence', ...CLAUDE_STREAM]
  }
  return { name: 'chair', ...r, stdin: prompt, cwd: emptyDir, logDir, answerFile, timeoutSec, removeEnv: CLAUDE_HOST_ENV, kind: 'claudestream',
    outFile: path.join(logDir, 'chair.out.txt'), errFile: path.join(logDir, 'chair.err.txt') }
}

// ---------------------------------------------------------------- running
const live = new Set()   // children still running, so Ctrl+C can take them down too

export function killTree(pid) {
  if (!pid) return
  if (WIN) { try { spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }) } catch { /* gone */ } return }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}
export function killAll() { for (const c of live) killTree(c.pid) }

function runOne(spec, onDone) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const env = { ...process.env }
    for (const k of spec.removeEnv || []) delete env[k]
    const out = fs.createWriteStream(spec.outFile)
    const err = fs.createWriteStream(spec.errFile)
    let timedOut = false, startError = null, settled = false
    let child
    try {
      // POSIX: own process group, so the timeout kill takes the agent's children too.
      child = spawn(spec.exe, spec.args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !WIN })
    } catch (e) { startError = e.message }
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child) live.delete(child)
      Promise.all([new Promise(r => out.end(r)), new Promise(r => err.end(r))]).then(() => {
        const ok = !timedOut && !startError && code === 0
        const result = { name: spec.name, ok, exitCode: code, durationSec: Math.round((Date.now() - t0) / 100) / 10, timedOut, limitHit: false,
          outFile: spec.outFile, errFile: spec.errFile, answerFile: spec.answerFile, error: startError }
        if (startError) writeText(spec.errFile, `[council] could not start ${spec.exe}: ${startError}`)
        if (timedOut) result.error = `timed out after ${Math.round(spec.timeoutSec)} s, process tree killed`
        else if (!ok && !result.error) result.error = `exit code ${code}`
        // A failed answer write (file locked, disk full) makes this one member fail; it must never hang the run.
        try { completeAnswer(spec, result) } catch (e) { result.ok = false; result.error = `could not save the answer: ${e.message}` }
        try { onDone && onDone(result) } catch { /* a status write must not break a run */ }
        resolve(result)
      }, (e) => resolve({ name: spec.name, ok: false, exitCode: code, durationSec: Math.round((Date.now() - t0) / 100) / 10, timedOut, limitHit: false,
        outFile: spec.outFile, errFile: spec.errFile, answerFile: spec.answerFile, error: `log write failed: ${e && e.message}` }))
    }
    const timer = setTimeout(() => { timedOut = true; if (child) killTree(child.pid); setTimeout(() => finish(-1), 5000) }, spec.timeoutSec * 1000)
    if (!child) { finish(-1); return }
    live.add(child)
    child.stdout.pipe(out, { end: false })
    child.stderr.pipe(err, { end: false })
    child.on('error', (e) => { startError = e.message; finish(-1) })
    child.on('close', (code) => finish(code == null ? -1 : code))
    child.stdin.on('error', () => { /* the CLI exited before reading all of stdin */ })
    child.stdin.end(spec.stdin ? Buffer.from(spec.stdin, 'utf8') : undefined)
  })
}

// Runs the specs at once. onDone(result) fires as each finishes (the live status file).
export function runParallel(specs, onDone) { return Promise.all(specs.map(s => runOne(s, onDone))) }

// ---------------------------------------------------------------- output -> answer file
function tail(p, n = 3000) { const t = readText(p); return t.length > n ? t.slice(-n) : t }
function limitHit(r) { return !r.ok && LIMIT_PATTERN.test(tail(r.outFile) + '\n' + tail(r.errFile)) }

// The last JSON line that passes match(o). hint: a substring the line must contain (skip parsing big lines).
export function lastJsonRecord(text, match, hint = '') {
  const lines = String(text || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.startsWith('{') || (hint && !l.includes(hint))) continue
    let o; try { o = JSON.parse(l) } catch { continue }
    if (match(o)) return o
  }
  return null
}

// Writes the answer file for a finished run; a run with no usable answer becomes ok=false.
export function completeAnswer(spec, r) {
  let text = ''
  if (spec.kind === 'codex') {
    text = readText(spec.codexLastFile)
    if (!text.trim() && r.ok) {
      const raw = readText(r.outFile)
      const rec = lastJsonRecord(raw, o => o.type === 'item.completed' && o.item && o.item.type === 'agent_message', 'agent_message')
      if (rec) text = String(rec.item.text || '')
      else if (!raw.trimStart().startsWith('{')) text = raw
    }
  } else if (spec.kind === 'claudestream') {
    const rec = lastJsonRecord(readText(r.outFile), o => o.type === 'result', '"result"')
    if (rec) {
      text = String(rec.result == null ? '' : rec.result)
      if ((rec.is_error || (rec.subtype && rec.subtype !== 'success')) && r.ok) { r.ok = false; r.error = `claude result: ${rec.subtype}` }
    } else if (r.ok) { r.ok = false; r.error = 'claude printed no result record' }
  } else if (spec.kind === 'agystream') {
    const rec = lastJsonRecord(readText(r.outFile), o => o.event === 'result' && o.result, '"result"')
    if (rec) {
      if (rec.result.response) text = String(rec.result.response)
      if (rec.result.status && rec.result.status !== 'SUCCESS' && r.ok) { r.ok = false; r.error = `agy status ${rec.result.status}` }
    } else if (r.ok) { r.ok = false; r.error = 'agy printed no result record' }
  } else text = readText(r.outFile)
  if (r.ok && !text.trim()) { r.ok = false; r.error = 'empty answer' }
  r.limitHit = limitHit(r)
  if (r.ok && spec.answerFile) writeText(spec.answerFile, text.trim())
}
