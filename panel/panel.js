// Ask panel: type a question, press Ask; the worker opens a "Council" terminal in the chosen workspace running the
// runner, and the runner opens the Council tab. Below: this workspace's past councils (click one to reopen its tab).
// Talks only to its own worker (plugin.request) plus workspace.readContext through workspace.changed.
(function () {
  'use strict'
  var o = window.orca
  var $ = function (id) { return document.getElementById(id) }
  var st = { workspaces: [], ws: null, picked: false, items: [], total: 0, showAll: false, timer: null, busy: false }
  var NAME = { claude: 'Claude', codex: 'GPT', agy: 'Gemini' }
  var HELP = {
    decision: 'One clear recommendation, defended. Where the answers disagree, the chair says who is right.',
    deliverable: 'What must change before this ships, most important first. Not a test: still check it yourself.',
    facts: 'Codex checks each claim and the chair triages its findings.'
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function pad(n) { return (n < 10 ? '0' : '') + n }
  function when(ms) {
    if (!ms) return '—'
    var d = new Date(ms), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1)
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    if (d.toDateString() === now.toDateString()) return hm
    if (d.toDateString() === y.toDateString()) return 'yesterday ' + hm
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  function remember(id) { try { localStorage.setItem('council.ws', id) } catch (e) { /* no storage */ } }
  function remembered() { try { return localStorage.getItem('council.ws') } catch (e) { return null } }
  function request(name, input) { return o.plugin.request(name, input || {}, { timeoutMs: 20000 }) }
  function errText(e) { return (e && (e.message || e.code)) || String(e) }
  function setStatus(text, cls) { var s = $('status'); s.textContent = text || ''; s.className = 'status' + (cls ? ' ' + cls : '') }

  // ---------------------------------------------------------------- workspaces
  function label(w) { return w.repo === w.name ? w.name : w.repo + ' · ' + w.name }
  function loadWorkspaces(keepPick) {
    return request('council.workspaces').then(function (r) {
      st.workspaces = r.workspaces || []
      var sel = $('ws'), note = $('ws-note')
      sel.innerHTML = st.workspaces.map(function (w) { return '<option value="' + esc(w.id) + '">' + esc(label(w)) + (w.branch && w.branch !== w.name ? '  (' + esc(w.branch) + ')' : '') + '</option>' }).join('')
      var ids = st.workspaces.map(function (w) { return w.id })
      var next = (keepPick && st.picked && ids.indexOf(st.ws) >= 0) ? st.ws : (r.focused || (ids.indexOf(remembered()) >= 0 ? remembered() : ids[0]) || null)
      st.ws = next
      if (next) sel.value = next
      note.hidden = !!r.focused || !st.workspaces.length
      note.className = 'note warn'
      note.textContent = st.workspaces.length ? 'Check this is the workspace you mean: several share a name, so it could not be picked for you.' : ''
      if (!st.workspaces.length) { note.hidden = false; note.textContent = 'No local Orca workspace found. Add a project in Orca first.' }
      renderClis(r.clis || {})
      $('go').disabled = !st.ws
      loadHistory()
    }, function (e) { setStatus('Could not list workspaces: ' + errText(e), 's-risk') })
  }
  function renderClis(c) {
    var have = Object.keys(NAME).filter(function (k) { return c[k] })
    $('clis').innerHTML = Object.keys(NAME).map(function (k) {
      return '<span class="' + (c[k] ? 's-ok' : 's-wait') + '"><span class="dot"></span>' + NAME[k] + (c[k] ? '' : ' not found') + '</span>'
    }).join('') + (c.claude ? '' : '<span class="s-risk"><span class="dot"></span>The chair needs Claude Code</span>') +
      (c.node === false ? '<span class="s-risk"><span class="dot"></span>Node.js not found: install Node 20+, restart Orca</span>' : '')
    $('clis').title = have.length + ' of 3 member CLIs found on Orca’s PATH. Missing ones are skipped and the verdict says so.'
  }

  // ---------------------------------------------------------------- history
  function rowState(it) {
    if (it.state === 'running') {
      var word = it.phase === 'chair' ? 'Chair is judging' : it.answered + ' of ' + it.members + ' answered'
      return { mark: '<span class="spin" aria-hidden="true"></span>', cls: 's-work', line: '<b>Running</b> ' + esc(word) }
    }
    if (it.state === 'failed') return { mark: '<span class="dot"></span>', cls: 's-risk', line: '<b>Failed</b>' }
    if (it.state === 'stale') return { mark: '<span class="dot"></span>', cls: 's-soon', line: '<b>Stopped</b> before the verdict' }
    var fav = it.favouredEngine ? esc(NAME[it.favouredEngine] || it.favouredEngine) + ' favoured' : 'no single answer favoured'
    if (it.needsYou) return { mark: '<span class="dot"></span>', cls: 's-now', line: '<span class="pill s-now">Needs you: ' + it.needsYou + '</span>' + fav }
    return { mark: '<span class="dot"></span>', cls: 's-ok', line: '<b>Done</b> ' + fav + (it.confidence ? ' · ' + esc(it.confidence) : '') }
  }
  function renderHistory() {
    var items = st.items, shown = st.showAll ? items : items.slice(0, 4)
    $('past-n').textContent = st.total ? String(st.total) : ''
    $('past').innerHTML = shown.length ? shown.map(function (it) {
      var s = rowState(it)
      return '<li><button class="row ' + s.cls + '" type="button" data-dir="' + esc(it.dir) + '" title="Open this council’s tab">' + s.mark +
        '<span class="rq">' + esc(it.question) + '</span><span class="rt num">' + esc(when(it.startedAt)) + '</span>' +
        '<span class="rs">' + s.line + (it.dryRun ? ' · trial' : '') + '</span></button></li>'
    }).join('') + (st.showAll && st.total > items.length ? '<li class="empty-row">' + (st.total - items.length) +
      ' older ' + (st.total - items.length === 1 ? 'council is' : 'councils are') + ' in the .council folder of this workspace.</li>' : '')
      : '<li class="empty-row">No councils in this workspace yet. Ask one above.</li>'
    var more = $('more'), hidden = items.length - shown.length
    more.hidden = !(hidden > 0 || st.showAll && items.length > 4)
    more.textContent = st.showAll ? 'Show fewer' : 'Show ' + hidden + ' more'
  }
  // One poll loop only: every call gets a number, and a reply that is not the newest call's is dropped (it may be for
  // the workspace the person just left). Only the newest reply schedules the next poll.
  function loadHistory() {
    clearTimeout(st.timer)
    var seq = st.seq = (st.seq || 0) + 1
    if (!st.ws) { st.items = []; st.total = 0; renderHistory(); return }
    request('council.history', { workspaceId: st.ws }).then(function (r) {
      if (seq !== st.seq) return
      st.items = r.items || []; st.total = r.total || 0
      renderHistory()
      var live = st.items.some(function (i) { return i.state === 'running' })
      clearTimeout(st.timer)
      st.timer = setTimeout(loadHistory, live || st.busy ? 2500 : 15000)
    }, function (e) {
      if (seq !== st.seq) return
      $('past').innerHTML = '<li class="empty-row">Could not read past councils: ' + esc(errText(e)) + '</li>'
      clearTimeout(st.timer)
      st.timer = setTimeout(loadHistory, 15000)
    })
  }

  // ---------------------------------------------------------------- ask
  function mode() { var m = document.querySelector('input[name="mode"]:checked'); return m ? m.value : 'decision' }
  $('f').addEventListener('submit', function (ev) {
    ev.preventDefault()
    var q = $('q').value.trim()
    if (!q) { setStatus('Type a question first.', 's-risk'); $('q').focus(); return }
    var ctx = $('ctx').value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    var dry = $('dry').checked
    $('go').disabled = true; st.busy = true
    setStatus('Starting…')
    request('council.ask', { workspaceId: st.ws, question: q, mode: mode(), context: ctx, dryRun: dry }).then(function (r) {
      setStatus((dry ? 'Trial started' : 'Started') + ' in the “Council” terminal of ' + r.workspace + '. The Council tab opens by itself in a few seconds.', 's-ok')
      $('q').value = ''
      setTimeout(loadHistory, 1500)
      setTimeout(function () { st.busy = false }, 20000)
    }, function (e) {
      st.busy = false
      setStatus(errText(e), 's-risk')
    }).then(function () { $('go').disabled = !st.ws })
  })
  $('ws').addEventListener('change', function () { st.ws = this.value; st.picked = true; remember(st.ws); $('ws-note').hidden = true; st.showAll = false; loadHistory() })
  $('more').addEventListener('click', function () { st.showAll = !st.showAll; renderHistory() })
  $('past').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-dir]')
    if (!b) return
    request('council.open', { workspaceId: st.ws, dir: b.getAttribute('data-dir') }).then(null, function (e) { setStatus('Could not open it: ' + errText(e), 's-risk') })
  })
  Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', function () { $('mode-help').textContent = HELP[mode()] })
  })
  $('mode-help').textContent = HELP.decision

  if (!o || !o.plugin) { setStatus('This panel works inside Orca.', 's-risk'); $('go').disabled = true; return }
  loadWorkspaces(false).then(function () { $('app').setAttribute('aria-busy', 'false') })
  // A different focused workspace: suggest it, unless the person picked one by hand.
  try { o.on('workspace.changed', function () { loadWorkspaces(true) }) } catch (e) { /* older Orca */ }
})()
