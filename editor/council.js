// Council tab: Orca's custom editor for *.view files (contributes.customEditors in orca-plugin.json).
// A viewer only: it reads the .view document (orca.document.get / onDidChange) and never edits it, so the tab is
// never dirty. The worker does the file reading (handler council.view, lib/council-view.mjs); this frame has no
// path and no network. Polls every second while a council runs, every 15 s after.
(function () {
  'use strict'
  var o = window.orca
  var app = document.getElementById('app')
  var st = { doc: '', view: null, err: null, offset: 0, open: {}, answers: {}, prev: {}, revealed: false, timer: null, html: {} }

  // Each member is named for its model family; the line under the name is the model the run used, then the CLI.
  var ENG = {
    claude: { name: 'Claude', cli: 'Claude Code', maker: 'Anthropic' },
    codex: { name: 'GPT', cli: 'Codex', maker: 'OpenAI' },
    agy: { name: 'Gemini', cli: 'agy', maker: 'Google' }
  }
  var MODEL = { opus: 'Opus', sonnet: 'Sonnet', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gemini-4-argon-high': 'Gemini 4 Argon (high)' }
  function modelLine(engine, slug) {
    var e = ENG[engine]
    if (!e) return slug || ''
    var m = slug ? (MODEL[slug] || slug) : ''
    return m ? m + ' · ' + e.cli : e.cli
  }
  // Each company's mark, to label its model (Lobe Icons, MIT: LICENSE-lobe-icons.txt). Inline SVG paths drawn in
  // currentColor: no image request, so nothing depends on how the frame's scheme handles CORS.
  var LOGO = {
    claude: 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z',
    codex: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z',
    agy: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z'
  }
  function logo(engine, px) {
    var d = LOGO[engine]
    if (!d) return ''
    return '<svg class="logo" viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="' + d + '"/></svg>'
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function nowMs() { return Date.now() + st.offset }
  function clock(sec) {
    if (sec == null || !isFinite(sec)) return '—'
    sec = Math.max(0, Math.round(sec))
    var m = Math.floor(sec / 60), s = sec % 60
    return m >= 60 ? Math.floor(m / 60) + ':' + pad(m % 60) + ':' + pad(s) : m + ':' + pad(s)
  }
  function pad(n) { return (n < 10 ? '0' : '') + n }
  function hhmm(ms) { if (!ms) return ''; var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
  // A timer span: live ones tick from data-since, finished ones show their seconds.
  function timer(p) {
    if (!p) return ''
    if (p.state === 'running' && p.startedAt) return '<span class="t num" data-since="' + p.startedAt + '"></span>'
    if (p.seconds != null) return '<span class="t num">' + clock(p.seconds) + '</span>'
    return ''
  }

  // ---------------------------------------------------------------- tiny, safe Markdown (escape first)
  function inline(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
  }
  function md(src) {
    var out = [], list = null, para = []
    function fp() { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = [] } }
    function fl() { if (list) { out.push('</' + list + '>'); list = null } }
    String(src || '').replace(/\r/g, '').split('\n').forEach(function (line) {
      var m
      if ((m = /^\s*#{1,6}\s+(.*)$/.exec(line))) { fp(); fl(); out.push('<h4>' + inline(m[1]) + '</h4>') }
      else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { fp(); if (list !== 'ul') { fl(); out.push('<ul>'); list = 'ul' } out.push('<li>' + inline(m[1]) + '</li>') }
      else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { fp(); if (list !== 'ol') { fl(); out.push('<ol>'); list = 'ol' } out.push('<li>' + inline(m[1]) + '</li>') }
      else if ((m = /^\s*>\s?(.*)$/.exec(line))) { fp(); fl(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>') }
      else if (/^\s*-{3,}\s*$/.test(line) || !line.trim()) { fp(); fl() }
      else para.push(line.trim())
    })
    fp(); fl()
    return out.join('')
  }

  // ---------------------------------------------------------------- words
  function memberState(p) {
    if (p.state === 'done') return { cls: 's-ok', mark: '<span class="dot"></span>', word: 'Answered' }
    if (p.state === 'failed') return { cls: 's-risk', mark: '<span class="dot"></span>', word: p.limitHit ? 'Hit a usage limit' : 'Failed' }
    if (p.state === 'timeout') return { cls: 's-risk', mark: '<span class="dot"></span>', word: 'Timed out' }
    if (p.state === 'skipped') return { cls: 's-wait', mark: '<span class="dot"></span>', word: 'Skipped' }
    if (p.state === 'queued') return { cls: 's-wait', mark: '<span class="dot"></span>', word: 'Queued' }
    var ph = p.live && p.live.phase
    var word = { thinking: 'Thinking', writing: 'Writing', tool: 'Reading files', working: 'Working', finished: 'Finishing' }[ph] || 'Starting'
    if (ph === 'tool' && p.live.tool) word = (p.engine === 'codex' ? 'Running a command' : 'Using ' + p.live.tool)
    return { cls: 's-work', mark: '<span class="spin" aria-hidden="true"></span>', word: word }
  }
  function liveNote(p) {
    var ph = p.live && p.live.phase
    if (p.engine === 'codex' && ph !== 'writing') return 'Codex sends its whole answer at the end, so there is nothing to preview yet.'
    if (ph === 'thinking') return p.engine === 'agy' ? 'Quiet while it thinks; text appears once it starts writing.' : 'Its reasoning stays private; the answer streams in once it starts writing.'
    if (ph === 'tool') return 'Reading the files the brief points to.'
    if (!ph || ph === 'starting') return 'Starting up.'
    return ''
  }

  // ---------------------------------------------------------------- sections
  function finding(v) {
    var ms = v.members, done = ms.filter(function (m) { return m.state === 'done' }).length
    if (v.state === 'failed') return v.error || 'No member answered.'
    if (v.state === 'stale') return 'The council stopped without finishing (its process is gone).'
    if (v.state === 'running') {
      if (v.phase === 'chair') return 'All answers are in (' + done + ' of ' + ms.length + '). The blind chair is judging them.'
      var busy = ms.filter(function (m) { return m.state === 'running' }).map(function (m) { return ENG[m.engine].name })
      if (!done) return 'The members are answering at the same time, without seeing each other.'
      return done + ' of ' + ms.length + ' have answered. Still working: ' + busy.join(', ') + '.'
    }
    var vd = v.verdict
    if (!vd) return 'Done.'
    var fe = vd.favouredEngine && ENG[vd.favouredEngine] ? ENG[vd.favouredEngine].name : null
    var s = vd.favoured && vd.favoured !== 'none' ? 'The chair favoured ' + vd.favoured + (fe ? ' (' + fe + ')' : '') : 'The chair favoured no single answer'
    if (vd.confidence) s += ', confidence ' + vd.confidence
    var n = (vd.needsYou || []).length
    return s + '.' + (n ? ' ' + n + (n === 1 ? ' thing needs' : ' things need') + ' you.' : '')
  }

  function top(v) {
    var live = v.state === 'running'
    var pills = live ? '<span class="pill s-work"><span class="spin" aria-hidden="true"></span>Live <span class="num" data-since="' + v.startedAt + '"></span></span>'
      : v.state === 'done' ? '<span class="pill s-ok"><span class="dot"></span>Done' + (v.startedAt && v.endedAt ? ' in ' + clock((v.endedAt - v.startedAt) / 1000) : '') + '</span>'
      : v.state === 'failed' ? '<span class="pill s-risk"><span class="dot"></span>Failed</span>'
      : v.state === 'stale' ? '<span class="pill s-soon"><span class="dot"></span>Stopped</span>' : ''
    if (v.dryRun) pills += '<span class="pill s-wait">Dry run: stand-in engines</span>'
    if (v.follow) pills += '<span class="pill s-wait">Following the newest council</span>'
    var meta = [v.mode, v.size, v.members.length ? v.members.length + (v.members.length === 1 ? ' member' : ' members') : null, v.startedAt ? 'started ' + hhmm(v.startedAt) : null]
      .filter(Boolean).map(esc).join(' · ')
    return '<div class="brandrow"><span class="brand">Council</span>' + pills + '</div>' +
      '<h1 class="q" title="' + esc(v.question || v.slug) + '">' + esc(v.question || v.slug) + '</h1>' +
      '<p class="finding">' + esc(finding(v)) + '</p><div class="meta" title="councils/' + esc(v.dir) + '">' + meta + '</div>'
  }

  function steps(v) {
    var ms = v.members, n = ms.length, done = ms.filter(function (m) { return m.state === 'done' }).length
    var fin = ms.filter(function (m) { return m.state !== 'running' && m.state !== 'queued' }).length
    var ph = v.phase, over = v.state !== 'running'
    function step(i, title, sub, cls, p) {
      return '<li class="step ' + cls + '"' + (p != null ? ' style="--p:' + p + '%"' : '') + '><span class="sn">Step ' + i + '</span>' +
        '<span class="st">' + (cls === 'active' ? '<span class="spin" aria-hidden="true"></span>' : cls === 'done' ? '<span class="dot s-ok"></span>' : cls === 'risk' ? '<span class="dot s-risk"></span>' : '<span class="dot"></span>') + esc(title) + '</span>' +
        '<span class="ss">' + esc(sub) + '</span></li>'
    }
    var mCls = ph === 'members' && !over ? 'active' : (ph === 'chair' || ph === 'verdict') ? (done ? 'done' : 'risk') : (ph === 'setup' ? '' : 'done')
    var cState = v.chair && v.chair.state
    var cCls = cState === 'running' && !over ? 'active' : cState === 'done' ? 'done' : (cState === 'failed' || cState === 'timeout') ? 'risk' : ''
    var vCls = v.state === 'done' && v.verdict ? 'done' : v.state === 'failed' ? 'risk' : ''
    return '<ol class="steps">' +
      step(1, 'Brief', 'Same question to all', 'done') +
      step(2, 'Members answer', n ? done + ' of ' + n + ' in, blind' : 'Blind, in parallel', mCls, mCls === 'active' && n ? Math.max(8, Math.round(fin / n * 100)) : null) +
      step(3, 'Chair judges', cState === 'running' ? 'Sees A, B, C only' : cState === 'done' ? 'Done' : 'Waits for the answers', cCls, cCls === 'active' ? 50 : null) +
      step(4, 'Verdict', vCls === 'done' ? 'Labels unsealed' : 'Then the names are revealed', vCls) + '</ol>'
  }

  function hero(v) {
    var vd = v.verdict
    if (!vd) return ''
    var fe = vd.favouredEngine, en = fe && ENG[fe]
    var conf = vd.confidence ? '<span class="pill ' + (vd.confidence === 'high' ? 's-ok' : vd.confidence === 'medium' ? 's-soon' : 's-risk') + '">Confidence ' + esc(vd.confidence) + '</span>' : ''
    var needs = (vd.needsYou || [])
    var head = '<div class="hk"><b>Verdict</b>' + conf + (needs.length ? '<span class="pill s-now"><span class="dot"></span>Needs you: ' + needs.length + '</span>' : '') +
      (vd.status === 'degraded' ? '<span class="pill s-soon">' + esc((vd.answers || '?') + ' of ' + (vd.planned || '?') + ' answered') + '</span>' : '') + '</div>'
    var fav = vd.favoured && vd.favoured !== 'none'
      ? '<div class="fav">Favoured <span class="flip"><span class="lab">' + esc(vd.favoured) + '</span>' +
        (en ? '<span class="who">' + logo(fe, 15) + esc(en.name) + '</span>' : '') +
        '</span><span class="mute">the chair picked answer ' + esc(vd.favoured) + (en ? ' before it knew this was ' + esc(en.name) : '') + '</span></div>'
      : '<div class="fav">No single answer favoured.</div>'
    // One verdict item: its first line, then its sub-points (the worker joins them with newlines) as a nested list.
    function item(x) {
      var parts = String(x).split('\n')
      return '<li>' + inline(parts[0]) + (parts.length > 1 ? '<ul class="sub">' + parts.slice(1).map(function (p) { return '<li>' + inline(p) + '</li>' }).join('') + '</ul>' : '') + '</li>'
    }
    var ny = needs.length ? '<div class="needs"><h3><span class="dot s-now"></span>Needs you</h3><ul>' + needs.map(item).join('') + '</ul></div>' : ''
    function det(title, arr) { return arr && arr.length ? '<details><summary>' + esc(title) + ' <span class="mute">' + arr.length + '</span></summary><ul>' + arr.map(item).join('') + '</ul></details>' : '' }
    var warn = (vd.warnings || []).length ? '<ul class="warn">' + vd.warnings.map(function (w) { return '<li>⚠ ' + esc(w) + '</li>' }).join('') + '</ul>' : ''
    var color = needs.length ? 'var(--on-now)' : 'var(--on-ok)'
    return '<section class="hero' + (st.revealNow ? ' reveal' : '') + '" style="--hero-c:' + color + '" aria-label="Verdict">' + head +
      (vd.tldr ? '<p class="htl">' + inline(vd.tldr) + '</p>' : '') + fav +
      (vd.text ? '<p class="htx">' + inline(vd.text) + '</p>' : '') + warn + ny +
      '<div class="more">' + det('Agreed', vd.agreed) + det('Disagreed', vd.disagreed) + det('Answer quality', vd.quality) + '</div></section>'
  }

  function lane(v, p) {
    var e = ENG[p.engine] || { name: p.engine, cli: '', maker: '' }
    var s = memberState(p)
    var live = p.state === 'running' && v.state === 'running'
    var isFav = v.verdict && v.verdict.favouredEngine === p.engine
    var badge = p.state === 'done' ? '<span class="badge s-ok">✓</span>' : (p.state === 'failed' || p.state === 'timeout') ? '<span class="badge s-risk">!</span>' : ''
    var body = ''
    if (p.state === 'done') {
      body = p.tldr ? '<p class="ltl k">' + inline(p.tldr) + '</p>' : '<p class="lsub">Answered (no TL;DR line in this answer).</p>'
    } else if (live) {
      var L = p.live || {}
      if (L.tldr) body += '<p class="ltl k">' + inline(L.tldr) + '<span class="caret"></span></p>'
      else if (L.tail) body += '<p class="tail">' + esc(L.tail) + '<span class="caret"></span></p>'
      var note = liveNote(p)
      if (note) body += '<p class="lsub">' + esc(note) + '</p>'
      if (L.chars) body += '<p class="lsub num">' + L.chars.toLocaleString('en-GB') + ' characters written</p>'
    } else if (p.error) {
      body = '<p class="lsub">' + esc(p.error) + '</p>'
    } else if (p.state === 'queued') body = '<p class="lsub">Waiting to start.</p>'
    var openBtn = p.state === 'done' ? '<button class="btn" data-ans="' + esc(p.engine) + '">' + (st.open[p.engine] ? 'Hide answer' : 'Read full answer') + '</button>' : '<span></span>'
    var lab = p.label ? '<span class="pill s-wait lab" title="Its blind label: the chair saw this answer as ' + esc(p.label) + '">was ' + esc(p.label) + '</span>' : ''
    var ans = st.open[p.engine] ? '<div class="ans">' + (st.answers[p.engine] != null ? md(st.answers[p.engine]) : '<span class="mute">Loading…</span>') + '</div>' : ''
    return '<article class="lane ' + s.cls + (live ? ' is-live' : '') + (isFav ? ' is-fav' : '') + (st.landed && st.landed[p.engine] ? ' landed' : '') + '" aria-label="' + esc(e.name) + '">' +
      '<div class="lh"><span class="av">' + logo(p.engine, 20) + badge + '</span>' +
      '<div class="who"><b>' + esc(e.name) + '</b><span>' + esc(modelLine(p.engine, p.model)) + '</span></div>' + timer(p) + '</div>' +
      '<div class="lstate">' + s.mark + esc(s.word) + '</div>' + body +
      '<div class="lf">' + openBtn + lab + '</div>' + ans + '</article>'
  }

  function chair(v) {
    var c = v.chair
    if (!c) return ''
    var labels = v.members.filter(function (m) { return m.state === 'done' }).length
    var ls = ['A', 'B', 'C'].slice(0, Math.max(1, labels)).join(', ')
    var on = c.state === 'running' || c.state === 'done'
    var s = c.state === 'running' ? { cls: 's-work', mark: '<span class="spin" aria-hidden="true"></span>', word: 'Judging ' + ls }
      : c.state === 'done' ? { cls: 's-ok', mark: '<span class="dot"></span>', word: 'Judged' }
      : (c.state === 'failed' || c.state === 'timeout') ? { cls: 's-risk', mark: '<span class="dot"></span>', word: c.state === 'timeout' ? 'Timed out' : 'Failed' }
      : c.state === 'skipped' ? { cls: 's-wait', mark: '<span class="dot"></span>', word: 'Skipped: nobody answered' }
      : { cls: 's-wait', mark: '<span class="dot"></span>', word: 'Waiting for the answers' }
    var body = ''
    if (c.state === 'running') {
      var L = c.live || {}
      if (L.tldr) body = '<p class="ltl k">' + inline(L.tldr) + '<span class="caret"></span></p>'
      else body = '<p class="lsub">It reads the answers as ' + esc(ls) + ' in random order, with model names removed.</p>'
    } else if (c.state === 'done') {
      body = c.tldr ? '<p class="ltl k">' + inline(c.tldr) + '</p>' : ''
    } else if (c.state === 'queued') {
      var done = v.members.filter(function (m) { return m.state !== 'running' && m.state !== 'queued' }).length
      body = '<p class="lsub">Starts when every member has finished (' + done + ' of ' + v.members.length + ').</p>'
    } else if (c.error) body = '<p class="lsub">' + esc(c.error) + '</p>'
    var btn = c.state === 'done' ? '<div class="lf"><button class="btn" data-ans="chair">' + (st.open.chair ? 'Hide the chair’s answer' : 'Read the chair’s full answer') + '</button></div>' : ''
    var ans = st.open.chair ? '<div class="ans">' + (st.answers.chair != null ? md(st.answers.chair) : '<span class="mute">Loading…</span>') + '</div>' : ''
    return '<section class="chair ' + s.cls + (on ? ' on' : '') + '" aria-label="Chair">' +
      '<span class="av av-chair"><img src="img/chair.png" alt=""></span>' +
      '<div><div class="who"><b>Chair</b><span>Claude, blind: never told who wrote which answer</span></div>' +
      '<div class="lstate" style="margin:8px 0 0">' + s.mark + esc(s.word) + '</div>' + body + btn + ans + '</div>' + timer(c) + '</section>'
  }

  // ---------------------------------------------------------------- render (patch only what changed)
  function slot(id, html) {
    var el = document.getElementById(id)
    if (!el) return
    if (st.html[id] === html) return
    st.html[id] = html
    el.innerHTML = html
  }
  function layout() {
    if (document.getElementById('s-top')) return
    app.innerHTML = '<header class="top" id="s-top"></header><div id="s-steps"></div><div id="s-hero"></div>' +
      '<div class="lanes" id="s-lanes"></div><div id="s-chair"></div>'
    st.html = {}
  }
  function render() {
    var v = st.view
    if (st.err || !v || !v.ok) {
      st.html = {}
      app.innerHTML = '<div class="err"><b>' + esc(v && !v.ok ? v.error : st.err ? 'Can’t reach the Council worker.' : 'Loading…') + '</b>' +
        '<span class="mute">' + esc(st.err ? String(st.err) : 'This tab shows a Council run and refreshes on its own. Start one in a terminal: node runner/council.mjs decision "your question" (README, step 3).') + '</span></div>'
      return
    }
    layout()
    slot('s-top', top(v))
    slot('s-steps', steps(v))
    slot('s-hero', hero(v))
    // Running: lanes first. Done: the verdict sits above them (tier 1), lanes become the evidence.
    var lanesEl = document.getElementById('s-lanes'), heroEl = document.getElementById('s-hero')
    if (v.verdict && heroEl.nextSibling !== lanesEl) heroEl.parentNode.insertBefore(heroEl, lanesEl)
    slot('s-lanes', v.members.map(function (m) { return lane(v, m) }).join('') || '<p class="empty">No members.</p>')
    slot('s-chair', chair(v))
    tickTimers()
    app.setAttribute('aria-busy', 'false')
    st.revealNow = false
    st.landed = null
  }
  function tickTimers() {
    var els = document.querySelectorAll('[data-since]')
    for (var i = 0; i < els.length; i++) els[i].textContent = clock((nowMs() - Number(els[i].getAttribute('data-since'))) / 1000)
  }

  // ---------------------------------------------------------------- data
  function fetchView() {
    clearTimeout(st.timer)
    if (!st.doc) { st.timer = setTimeout(fetchView, 1000); return }
    o.plugin.request('council.view', { doc: st.doc }, { timeoutMs: 15000 }).then(function (v) {
      st.err = null
      if (v && v.now) st.offset = v.now - Date.now()
      if (v && v.ok) {
        // A member that just finished gets one landing pulse; a verdict that appears while open gets one reveal.
        var landed = {}
        v.members.forEach(function (m) { if (st.prev[m.engine] === 'running' && m.state === 'done') landed[m.engine] = true; st.prev[m.engine] = m.state })
        st.landed = landed
        if (v.verdict && st.view && st.view.ok && !st.view.verdict) st.revealNow = true
      }
      st.view = v
      render()
      st.timer = setTimeout(fetchView, v && v.ok && v.state === 'running' ? 1000 : 15000)
    }, function (e) {
      st.err = (e && (e.code || e.message)) || e
      render()
      st.timer = setTimeout(fetchView, 5000)
    })
  }
  function setDoc(d) {
    var t = d && d.content && typeof d.content.text === 'string' ? d.content.text : ''
    if (t === st.doc) return
    st.doc = t; st.answers = {}; st.open = {}; st.prev = {}
    fetchView()
  }

  app.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-ans]')
    if (!b) return
    var who = b.getAttribute('data-ans')
    st.open[who] = !st.open[who]
    if (st.open[who] && st.answers[who] == null) {
      o.plugin.request('council.answer', { doc: st.doc, who: who }, { timeoutMs: 15000 }).then(function (r) {
        st.answers[who] = r && r.ok ? r.markdown : '*' + ((r && r.error) || 'Not found.') + '*'
        render()
      }, function (e) { st.answers[who] = '*Could not load: ' + ((e && e.message) || e) + '*'; render() })
    }
    render()
  })

  setInterval(tickTimers, 1000)
  if (!o || !o.document) { st.err = 'This file opens as the Council tab inside Orca.'; render(); return }
  o.document.get().then(setDoc, function (e) { st.err = (e && e.message) || e; render() })
  try { o.document.onDidChange(setDoc) } catch (e) { /* older Orca: get() only */ }
})()
