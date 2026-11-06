// fake-engine.mjs: plays claude / codex / agy / the chair for `council.mjs --dry-run`. Uses no AI quota.
// usage: node fake-engine.mjs <claude|codex|agy|chair> [--out <file>] [--prompt <text>]
// Switches (comma lists of engine names) from the environment:
//   COUNCIL_FAKE_SLOW  these engines hang (to test the timeout kill)
//   COUNCIL_FAKE_FAIL  these engines exit 1 with a rate-limit message on stderr
//   COUNCIL_FAKE_PACE  seconds multiplier for the streams (default 0 = instant). 1 = a demo pace close to real runs
//                      (claude ~18 s, codex ~30 s, agy ~22 s, chair ~14 s), for rehearsing the Orca tab.
// It prints the same JSON-lines shapes the real CLIs print with the council's flags
// (claude stream-json, codex exec --json, agy stream-json).
import fs from 'node:fs'

const engine = process.argv[2]
const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : '' }
const inList = (v) => String(v || '').split(',').map(s => s.trim()).includes(engine)
const pace = Number(process.env.COUNCIL_FAKE_PACE) || 0
const sleep = (sec) => new Promise(r => setTimeout(r, Math.round(sec * pace * 1000)))
const line = (o) => new Promise(r => process.stdout.write(JSON.stringify(o) + '\n', r))

function chunks(t, n) {
  const size = Math.max(1, Math.ceil(t.length / n)), out = []
  let i = 0
  while (i < t.length) {
    let j = Math.min(t.length, i + size)
    if (j < t.length) { const sp = t.indexOf(' ', j); j = sp > 0 ? sp : t.length }
    out.push(t.slice(i, j)); i = j
  }
  return out
}
async function claudeStream(answer, think, write) {
  await line({ type: 'system', subtype: 'init', model: 'claude-opus', fake: true })
  await line({ type: 'stream_event', event: { type: 'message_start' } })
  await line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })
  await sleep(think)
  await line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await line({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } })
  const parts = chunks(answer, 12)
  for (const p of parts) { await line({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } } }); await sleep(write / parts.length) }
  await line({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await line({ type: 'result', subtype: 'success', is_error: false, result: answer, usage: { output_tokens: Math.floor(answer.length / 4) } })
}
async function agyStream(answer, think, write) {
  await line({ event: 'init', init: { model: 'gemini', fake: true } })
  await line({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } })
  await sleep(think)
  const parts = chunks(answer, 6)
  for (const p of parts) { await line({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: p } }); await sleep(write / parts.length) }
  await line({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' } })
  await line({ event: 'result', result: { status: 'SUCCESS', response: answer, duration_seconds: 0.1 } })
}

async function main() {
  if (!['claude', 'codex', 'agy', 'chair'].includes(engine)) { process.stderr.write('fake-engine: unknown engine\n'); process.exit(1) }
  let stdin = ''
  if (engine !== 'agy') { for await (const c of process.stdin) stdin += c }
  if (inList(process.env.COUNCIL_FAKE_SLOW)) await new Promise(r => setTimeout(r, 600000))
  if (inList(process.env.COUNCIL_FAKE_FAIL)) { process.stderr.write('Error: rate limit reached, try again later (fake)\n'); process.exit(1) }

  if (engine === 'chair') {
    const labels = [...stdin.matchAll(/^=== ANSWER ([A-C]) ===/gm)].map(m => m[1])
    const fav = labels[0] || 'none'
    const q = labels.map(l => `- ${l}: fake answer, adequate.`).join('\n')
    const out = `## TL;DR\nGo with ${fav}; the fake answers agree on the basics.\n\n## ✔ Agreed\n- Fake agreement point.\n\n## ✖ Disagreed\n- Fake disagreement; ${fav} is right because it is first.\n\n## ● Needs you\n- Fake decision for the user.\n\n## Verdict\nFake verdict: go with ${fav}.\n\n## Confidence\nmedium: fake run.\n\n## Answer quality\n${q}\n\nFAVOURED: ${fav}\n`
    await claudeStream(out, 6, 8)
    return
  }
  // Each stand-in names itself, so the tests can prove the chair's copy is redacted.
  const self = { claude: 'I am Claude, made by Anthropic (Opus).', codex: 'As Codex from OpenAI (GPT), here is my view.', agy: 'Gemini here, via Google Antigravity.' }
  const tldr = { claude: 'Pick plan X; it ships sooner and the risk is small.', codex: 'Plan Y, because X leaves the migration untested.', agy: 'Plan X, but only after a one-week trial.' }
  const answer = `## TL;DR\n${tldr[engine]}\n\n## Recommendation\n${self[engine]}\n\nFake recommendation from the ${engine} stand-in.\n\n## Reasons\n1. Fake reason.\n\n## Risks\n- Fake risk.\n\n## What I'm unsure about\n- Nothing; this is a dry run.\n\n## Confidence\nlow\n`
  if (engine === 'codex') {
    // Like codex exec --json: start events, a silent stretch, then the whole answer in one item.
    await line({ type: 'thread.started', thread_id: 'fake' })
    await line({ type: 'turn.started' })
    await sleep(30)
    const out = argOf('--out'); if (out) fs.writeFileSync(out, answer, 'utf8')
    await line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer } })
    await line({ type: 'turn.completed', usage: { output_tokens: Math.floor(answer.length / 4) } })
  } else if (engine === 'agy') await agyStream(answer, 18, 4)
  else await claudeStream(answer, 8, 10)
}
main().then(() => process.exit(0), (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1) })
