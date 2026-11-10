// Cycle UI: router, screens, sheets and event handling.
//
// Rendering model: every screen is a pure function of (store state + `ui` view state) that
// returns an HTML string; render() swaps it into #app. Input text lives in `ui.d` (updated on
// every keystroke) so a re-render never loses what was typed. Store changes re-render, except
// while a text field has focus (that would drop the caret and close the keyboard); the
// re-render is deferred to blur instead.
//
// All clicks go through one delegated listener keyed on data-a="name:arg" (see ACT). Markup and
// class names come from the approved mockups; nothing here invents visual styling.
(function () {
'use strict';
var C = CycleCore, St = CycleStore, S = St.S, M = Motion;
var app = document.getElementById('app');

// ---- view state --------------------------------------------------------------------------
var ui = {
  route: 'home', stack: [], sheet: null, d: {}, err: null, errTimer: 0,
  dirty: false, ready: false, cyc: null,
  mode: 'create', code: null,
  // todoSeg: the To-dos tab's segment ('todo' | 'rem'); remView: which Reminders list shows; fz: the Fights chart's zoomed day range
  // {a, b} (null = everything); fpick: the day whose tooltip shows; notesOpen: the fight id whose collapsed notes list is open.
  // doneOpen: the To-dos Done section is expanded. Starts false on every launch so Open is all the tab shows; kept in memory only,
  // since remembering an open Done would bring back the long list this exists to hide.
  todoSeg: 'todo', remView: 'lib', fz: null, fpick: null, notesOpen: null, doneOpen: false,
  ntier: 'esme', tip: false, nid: null, nedit: null, nfor: 'esme', sendId: null
};
// Minutes after submitting during which the author can still fix a to-do or a delivered ask, (the owner still sees Edited on the row).
// 15 is a guessed starting value (no measurement of how long typos take to notice); change it here only.
var EDIT_WINDOW_MIN = 15;

// ---- small helpers -----------------------------------------------------------------------
// Rows scheduled for a future time are invisible to every reader until then (C.isScheduled). Only these two tables
// carry scheduled rows; the sender's own view of them goes through scheduledRows().
var SCHED_TABLES = { items: 1, todos: 1 };
// Soft-deleted rows of these tables (an approved fight delete, an undone to-do event, an undone tapped break) are
// invisible everywhere through L(), so no screen, chart or count has to remember to skip them. fight_notes and
// the comment tables are NOT here: they keep a "Deleted" marker, so their screens read deleted rows on purpose.
var SOFT_TABLES = { fight_markers: 1, todo_events: 1, challenge_breaks: 1 };
function L(t) {
  var r = St.list(t);
  if (SOFT_TABLES[t]) r = r.filter(function (x) { return !x.deleted_at; });
  return SCHED_TABLES[t] ? r.filter(function (x) { return !C.isScheduled(x, now()); }) : r;
}
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var KIND = { focus: 'Focus', kudos: 'Kudos', truth: 'Truth', ask: 'Ask' };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
// ---- challenge-day notes (the Esmeworld exercise log) --------------------------------------------------------------
// A note is plain text. Optional structure: first line = short summary; "## X" = section (Mental Health Exercise, Research
// notes, Check In, anything else); "### X" = one exercise card; a line that is wholly **bold** = a question, and the lines
// under it (until the next question or heading) = the answer; "• " / "- " = list item. Anything else is a plain line.
// Every shape degrades to plain paragraphs, so an old note or a hand-typed one still reads. All text is escaped here.
function noteInline(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }
// "Fake book · Day 6 · Some title": the old format listed exercise titles as plain lines; shown as small headings.
function noteTitleLine(s) { return s.indexOf(' · ') > 0 && s.length <= 90 && !/[.?!:]$/.test(s); }
function parseNote(note) {
  var lines = String(note == null ? '' : note).replace(/\r/g, '').split('\n');
  var structured = lines.some(function (l) { return /^##\s/.test(l.trim()); });
  var m = { summary: '', pre: [], sections: [], structured: structured };
  var sec = null, card = null, q = null, ex = null;
  function exHost() {
    if (ex) return ex;
    ex = { title: 'Mental Health Exercise', kind: 'ex', items: [], cards: [], research: null };
    m.sections.push(ex); return ex;
  }
  function target() { return card ? card.items : sec ? sec.items : m.pre; }
  lines.forEach(function (raw, i) {
    var l = raw.trim(), h;
    if (structured && !m.summary && i === 0 && l && !/^#/.test(l)) { m.summary = l; return; }
    if ((h = /^#{3,}\s+(.*)$/.exec(l))) {
      // A card always belongs to the exercise section, even when it follows "## Research notes".
      var host = sec && sec.kind !== 'research' ? sec : exHost();
      card = { title: h[1], items: [] }; host.cards.push(card); q = null; return;
    }
    if ((h = /^##\s+(.*)$/.exec(l))) {
      var t = h[1], kind = /research/i.test(t) ? 'research' : /check.?in/i.test(t) ? 'checkin' : /exercise/i.test(t) ? 'ex' : 'other';
      card = null; q = null;
      if (kind === 'research') { var e = exHost(); e.research = e.research || []; sec = { kind: 'research', items: e.research, cards: [] }; return; }
      if (kind === 'ex' && ex && !ex.cards.length && !ex.items.length) { sec = ex; ex.title = t; return; }
      sec = { title: t, kind: kind, items: [], cards: [] }; m.sections.push(sec);
      if (kind === 'ex' && !ex) ex = sec;
      return;
    }
    var qm = /^\*\*(.+)\*\*:?$/.exec(l);
    if (qm && qm[1].indexOf('**') < 0) {
      // Questions under "## Research notes" are the exercise's own questions (older notes put them there).
      if (sec && sec.kind === 'research' && !card) { sec = exHost(); }
      q = { q: qm[1], a: [] }; target().push(q); return;
    }
    if (!l) return;
    var li = /^(?:•|-)\s+(.*)$/.exec(l), it = li ? { li: li[1] } : { p: l };
    if (q) q.a.push(it); else target().push(it);
  });
  return m;
}
// Every question in the note and how many have an answer.
function noteQs(m) {
  var all = [];
  function walk(items) { items.forEach(function (x) { if (x.q != null) all.push(x); }); }
  walk(m.pre); m.sections.forEach(function (s) { walk(s.items); s.cards.forEach(function (c) { walk(c.items); }); });
  return { total: all.length, answered: all.filter(function (x) { return x.a.length; }).length };
}
function noteCards(m) { return m.sections.reduce(function (n, s) { return n + s.cards.length; }, 0); }
// One-line summary for the day list: counted from the cards when there are any, else the note's own first line.
function noteSummary(note) {
  var m = parseNote(note), n = noteCards(m), ck = m.sections.some(function (s) { return s.kind === 'checkin'; });
  if (n) return n + (n === 1 ? ' exercise' : ' exercises') + (ck ? ' · Check In' : '');
  return m.summary || String(note || '').split('\n')[0];
}
// '' (no questions), 'in' (every question answered) or 'pend'.
function noteState(m) { var c = noteQs(m); return !c.total ? '' : c.answered === c.total ? 'in' : 'pend'; }
function rdItems(items) {
  var out = [], ul = false;
  function close() { if (ul) { out.push('</ul>'); ul = false; } }
  items.forEach(function (x) {
    if (x.li != null) { if (!ul) { out.push('<ul class="rdul">'); ul = true; } out.push('<li>' + noteInline(x.li) + '</li>'); return; }
    close();
    if (x.p != null) { out.push(noteTitleLine(x.p) ? '<p class="rdh">' + noteInline(x.p) + '</p>' : '<p class="rdp">' + noteInline(x.p) + '</p>'); return; }
    out.push('<div class="rdqa"><p class="rdq">' + esc(x.q) + '</p>' + (x.a.length
      ? '<div class="rda">' + rdItems(x.a) + '</div>'
      : '<p class="rdpend">' + ic('hg') + 'Answer arrives later</p>') + '</div>');
  });
  close();
  return out.join('');
}
function rdCard(title, items, k, n, shut) {
  var qs = items.filter(function (x) { return x.q != null; }), done = qs.filter(function (x) { return x.a.length; }).length;
  var hd = title == null ? '' : '<div class="rdch" data-a="rdcard:' + k + '">' + (n ? '<span class="rdn">' + n + '</span>' : '') + '<p class="rdt">' + noteInline(title) + '</p>' + ic('down', 'rdcv') + '</div>';
  var sub = shut && qs.length ? '<p class="rdcs">' + (done === qs.length ? qs.length + (qs.length === 1 ? ' answer' : ' answers') : done + ' of ' + qs.length + ' answered') + '</p>' : '';
  return '<div class="rdcard' + (shut ? ' shut' : '') + '">' + hd + sub + (shut ? '' : '<div class="rdcb">' + rdItems(items) + '</div>') + '</div>';
}
// The day sheet's reading page. ui.rdShut holds the cards folded on this open (keys from rdCard).
function noteReader(note) {
  var m = parseNote(note), shut = ui.rdShut || {}, out = [];
  if (!m.structured) return '<div class="rdcard"><div class="rdcb">' + (rdItems(m.pre) || '<p class="rdp">' + esc(note) + '</p>') + '</div></div>';
  if (m.pre.length) out.push('<div class="rdcard"><div class="rdcb">' + rdItems(m.pre) + '</div></div>');
  m.sections.forEach(function (s, si) {
    var body = [];
    if (s.kind === 'ex') {
      var r = s.research || [];
      body.push('<div class="rdres"><p class="lab">Research notes</p>' + (r.length ? rdItems(r) : '<p class="rdnone">No research notes this day</p>') + '</div>');
      var items = s.items, title = null;
      // Old single-exercise notes: "Day 1 · Topic" then its questions, with no ### card. Give it the card look.
      if (!s.cards.length && items.length && items[0].p != null && items.some(function (x) { return x.q != null; })) { title = items[0].p; items = items.slice(1); }
      if (items.length) body.push(rdCard(title, items, si + '-0', 0, title != null && shut[si + '-0']));
      var total = s.cards.length;
      s.cards.forEach(function (c, ci) { var k = si + '-' + (ci + 1); body.push(rdCard(c.title, c.items, k, total > 1 ? (ci + 1) + '/' + total : 0, shut[k])); });
    } else if (s.items.length || s.cards.length) {
      if (s.items.length) body.push(rdCard(null, s.items, si + '-0', 0, false));
      s.cards.forEach(function (c, ci) { var k = si + '-' + (ci + 1); body.push(rdCard(c.title, c.items, k, 0, shut[k])); });
    } else body.push('<p class="rdnone">Nothing here this day</p>');
    out.push('<section class="rdsec"><p class="lab">' + esc(s.title) + '</p>' + body.join('') + '</section>');
  });
  return out.join('');
}
function ic(id, cls) { return '<svg class="ic ' + (cls || '') + '"><use href="#' + id + '"/></svg>'; }
function now() { return Date.now(); }
function tz() { return S.couple.tz; }
function today() { return C.localDay(now(), tz()); }
function dayName(day) { return WD[C.dow(day)]; }
function fmtDay(day) { var p = day.split('-'); return dayName(day) + ' ' + (+p[2]) + ' ' + MON[+p[1] - 1]; }
function dueOf(day) { return C.dueInfo(day, today(), function (d) { return d <= C.addDays(today(), 6) ? dayName(d) : fmtDay(d); }); }
// A row whose insert was dead-lettered exists only on this phone; say so wherever it shows (its text is kept).
function ns(t, id) { return St.notSent(t, id) ? '<span class="ns">Not sent</span>' : ''; }
function dueTag(x) { if (!x.due_date) return ''; var d = dueOf(x.due_date); return '<small><span class="due ' + d.state + '">' + d.text + '</span></small>'; }
// Late and due-today to dos go first, oldest first; the rest keep their order. Without this a late one can sit under next week's.
// "Hot" = late or due today (tomorrow, which dueTag also colours, is not): the one rule for ordering, and for the Actions Today section.
function isHot(x) { return !!x.due_date && x.due_date <= today(); }
function urgentFirst(list) { var hot = isHot; return list.filter(hot).sort(function (a, b) { return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0; }).concat(list.filter(function (x) { return !hot(x); })); }
function fmtTime(ms) { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz() }).toLowerCase(); }
function dispPick(type, v) {
  if (!v) return 'Pick';
  if (type !== 'time') return fmtDay(v);
  var h = +v.slice(0, 2); return (h % 12 || 12) + ':' + v.slice(3, 5) + (h < 12 ? ' am' : ' pm');
}
// Date fields are a pill showing the formatted value with the native input transparent over it,
// so the shown text never carries seconds or the platform's own layout.
function dpick(type, k, v, cls) {
  return '<label class="pick dp ' + (cls || '') + '"><span class="pv">' + esc(dispPick(type, v)) + '</span><input type="' + type + '"' + ' data-d="' + k + '" data-pt="' + type + '" value="' + esc(v) + '"></label>';
}
function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }
function sg(n) { return n > 0 ? '+' + n : n < 0 ? '−' + (-n) : '0'; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function pName() { var p = St.partner(); return p ? p.name : 'Partner'; }
// A name that may be long renders as one ellipsized run so it can never wrap a pill, segment or row.
function pnx(n) { return '<span class="pn">' + esc(n) + '</span>'; }
function pn() { return pnx(pName()); }
// Labelled list section. labelHtml is trusted markup. The label's spacing under the header comes from one rule in cycle.css (`.hd + section`).
function section(labelHtml, bodyHtml, cls) { return '<section class="list' + (cls ? ' ' + cls : '') + '"><p class="lab">' + labelHtml + '</p>' + bodyHtml + '</section>'; }
function nameOf(uid) { var m = S.members.filter(function (x) { return x.user_id === uid; })[0]; return m ? m.name : ''; }
function nowIso() { return new Date().toISOString(); }
// When something happened: a date and a time in the couple's zone, both defaulting to now. A pick in the future clamps to now.
function nowHm() { return new Date(now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz() }); }
// `def` (ms) replaces now as the unpicked default: a note added to an old fight defaults to the fight's own time, since
// "now" filed late versions days after the fight they describe (Oliver, 2026-11-08). whenRow and whenMs must get the same `def`.
function hmAt(ms) { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz() }); }
function whenRow(k, def) {
  return '<div class="frow wh"><span class="lab0">When</span>' + dpick('date', k + 'D', val(k + 'D', def == null ? today() : C.localDay(def, tz()))) + dpick('time', k + 'T', val(k + 'T', def == null ? nowHm() : hmAt(def))) + '</div>';
}
function whenMs(k, def) {
  var hm = val(k + 'T', def == null ? nowHm() : hmAt(def)).split(':');
  return Math.min(now(), C.zonedMs(val(k + 'D', def == null ? today() : C.localDay(def, tz())), +hm[0], +hm[1], tz()));
}
// The Add more / Add your version box: a Note defaults to one minute after the fight's latest live note (the fight's own
// time when it has none), so it files on the fight's day yet still lists below what is already there (notes sort by
// created_at; the fight time itself put a new version above hers). The extra minute is load-bearing: whenMs drops seconds.
// An Analysis is reflection written afterwards, so it keeps now. Capped at now by whenMs.
function noteDef(mk, kind) {
  if (kind === 'analysis') return null;
  return fightNotes(mk.id).reduce(function (m, n) { return n.deleted_at ? m : Math.max(m, C.ms(n.created_at) + 60000); }, C.ms(mk.at));
}
// "Fri 9:00am" within the coming week, else "Fri 30 Oct 9:00am".
function fmtWhen(at) {
  var d = C.localDay(at, tz()), t = fmtTime(at).replace(' ', '');
  return (C.dayDiff(today(), d) < 7 ? dayName(d) : fmtDay(d)) + ' ' + t;
}
// The sender's own scheduled rows: to dos they created (for me or for the partner).
function scheduledTodos() { return St.list('todos').filter(function (t) { return !t.deleted_at && t.created_by === St.me() && C.isScheduled(t, now()); }).sort(function (a, b) { return C.ms(a.created_at) - C.ms(b.created_at); }); }
// "When" for a new to do: Now, or Later with a date and time (default tomorrow 9:00). Returns ms, or null for Now.
function laterRow(on, act) {
  return '<div class="frow"><span class="lab0">When</span>' + seg([['now', 'Now'], ['later', 'Later']], on ? 'later' : 'now', act) + '</div>' +
    (on ? '<div class="frow wh"><span class="lab0">At</span>' + dpick('date', 'schD', val('schD', C.addDays(today(), 1))) + dpick('time', 'schT', val('schT', '09:00')) + '</div>' : '');
}
function laterMs() {
  var hm = val('schT', '09:00').split(':');
  return C.zonedMs(val('schD', C.addDays(today(), 1)), +hm[0], +hm[1], tz());
}
function prefs() { return S.priv.prefs; }
function byDelivered(a, b) { return C.ms(b.delivered_at || b.created_at) - C.ms(a.delivered_at || a.created_at); }

function myItems() { return L('items').filter(function (i) { return i.sender_id === St.me() && !i.deleted_at; }); }
function heldItems() { return myItems().filter(function (i) { return i.status === 'held'; }).sort(function (a, b) { return C.ms(a.held_until) - C.ms(b.held_until); }); }
function myTodos() { return L('todos').filter(function (t) { return t.owner_id === St.me() && !t.deleted_at; }); }
// Declined closes a to-do like done does, but is not done: no points, no repair, no done_at.
function closed(t) { return !!(t.done_at || t.declined_at); }
// Swipe-to-ignore is held back for a few seconds (the undo toast): until it fades the row is only hidden here, nothing is written.
var pendIgnore = null;
// A response to-do is declined; every other type is ignored. One helper so no render says the wrong word.
function declWord(t) { return t.type === 'response' ? 'Declined' : 'Ignored'; }
function declUndoWord(t) { return t.type === 'response' ? 'Undo decline' : 'Undo ignore'; }
function openTodos(list) { return list.filter(function (t) { return !closed(t) && !(pendIgnore && pendIgnore.id === t.id); }); }
function theirTodos() { return openTodos(L('todos').filter(function (x) { return x.owner_id !== St.me() && !x.deleted_at; })); }
// Both lists' open counts, so an empty "For you" doesn't read as nothing to do; queued asks sit in the partner's list.
function todoCount() { return 'You ' + openTodos(myTodos()).length + ' &middot; ' + esc(pName()) + ' ' + (theirTodos().length + S.priv.queued.length); }
function ledger() {
  return C.computeLedger({ members: S.members, items: L('items'), todos: L('todos'), todo_events: L('todo_events'), fight_markers: L('fight_markers'), redemptions: L('redemptions'), nudge_sends: L('nudge_sends'), nudge_awards: L('nudge_awards'), challenges: L('challenges'), challenge_breaks: L('challenge_breaks'), challenge_days: L('challenge_days') },
    { tz: tz(), now: now(), since: C.localDay(C.ms(S.couple.created_at), tz()) });
}
// Only the old fight truths hide their text behind a label; a fight ask carries its own title.
function fightTruth(i) { return i.origin === 'fight' && i.kind === 'truth'; }
function itemLabel(i) { return fightTruth(i) && i.response_type ? cap(i.response_type) : KIND[i.kind]; }
function itemTitle(i) { return fightTruth(i) ? itemLabel(i) : i.body; }

// ---- errors ---------------------------------------------------------------------------------
// Failures surface as a short pink line (and the console); a guarded action never leaves a rejected promise behind.
// Backend text is mapped to a plain label; anything unmapped shows by status class, never raw JSON.
var PLAIN = [
  [/invalid login credentials/i, 'Wrong email or password'],
  [/already registered|already been registered/i, 'Email already used'],
  [/password should be at least|weak password/i, 'Password too short'],
  [/unable to validate email|invalid format|valid email/i, 'Check the email'],
  [/email not confirmed/i, 'Confirm email first'],
  [/rate limit|too many/i, 'Wait a minute'],
  [/mic off/i, 'Mic off'],
  [/join_couple/, 'Wrong code'],
  [/unexpected reply/i, 'Unexpected reply'], // a 2xx that was not PostgREST's (captive portal, proxy): the write was NOT delivered
  [/failed to fetch|load failed|networkerror|internet connection|network request failed/i, 'No connection']
];
function plain(e, what) {
  var m = String((e && e.message) || e);
  for (var i = 0; i < PLAIN.length; i++) if (PLAIN[i][0].test(m)) return PLAIN[i][1];
  if (e && e.status >= 500) return 'Server error';
  if (e && (e.status === 401 || e.status === 403)) return 'Sign in again';
  if (e && e.status) return 'Couldn\'t ' + (what || 'save');
  return m.length <= 28 ? m : 'Couldn\'t ' + (what || 'save');
}
function showErr(msg) {
  ui.err = msg; render();
  clearTimeout(ui.errTimer); ui.errTimer = setTimeout(function () { ui.err = null; render(); }, 5000);
}
function guard(fn) {
  return function () {
    var args = arguments;
    return Promise.resolve().then(function () { return fn.apply(null, args); }).catch(function (e) { console.error('cycle action failed:', e); St.logErr('action', e); showErr(plain(e)); });
  };
}
// Last line of defence: anything that escapes a guard still reaches the person instead of vanishing into the console.
// Logged too: these had no record at all, so a bar that kept coming back could not be traced from the phone.
window.addEventListener('error', function (e) { St.logErr('uncaught', e.error || e.message); showErr(plain(e.error || e.message)); });
window.addEventListener('unhandledrejection', function (e) { St.logErr('uncaught', e.reason); showErr(plain(e.reason)); });
// Shown when boot or a screen throws. Nothing here touches storage, so the person's data stays exactly as it was.
// A failed boot (home=false) means the stored data itself may be what will not load, so Retry alone would reload the same
// blob forever: Export hands the raw stored text out, and Sign out clears only the session (the data stays on disk, a
// later sign-in reads it again). Nothing on this screen ever wipes.
function errScreen(home) {
  return '<div class="phone p2"><div class="scr"><main class="errscreen"><h2>Something went wrong</h2><p>Your data is safe.</p>' +
    '<div class="save" data-a="retry">Retry</div>' + (home ? '<p class="ghost" data-a="gohome">Home</p>' : '<p class="ghost" data-a="bootexport">Export</p><p class="ghost" data-a="bootsignout">Sign out</p>') + '</main></div></div>';
}

// ---- layout pieces -------------------------------------------------------------------------------
// opts.band=false for screens whose mockup has no pink band (Log fight, Settings).
// Every screen gets the tab bar, active tab from the route; opts.tab=false only for modal flows (auth, editors, Week).
function phone(cls, inner, o) {
  o = o || {};
  var band = o.band === false ? '' : '<div class="band" aria-hidden="true"></div>';
  var dl = S.deadLetters.length, shown = ui.err || S.persistError || (S.syncError && plain({ message: S.syncError, status: S.syncErrorStatus }, 'sync'));
  // Refused writes sit in S.deadLetters until the person reads/exports them; the bar opens that list when nothing more urgent shows.
  var err = shown || (dl ? dl + (dl === 1 ? ' change' : ' changes') + ' not sent' : null), dlBar = !shown && dl;
  var off = !navigator.onLine || (S.outbox && S.outbox.length) ? '<span class="off' + (o.band === false ? ' nb' : '') + '">Offline</span>' : '';
  return '<div class="phone ' + cls + (o.tab === false ? ' nt' : '') + '"><div class="scr">' + band + off + '<div class="status"></div><main>' + inner + '</main></div>' + (o.pin || '') +
    (o.tab === false ? '' : tabbar(tabFor(ui.route))) + (o.sheet || '') + (ui.upd ? '<div class="updbar" data-a="upd"><span>New version</span><span class="ubtn">Install</span></div>' : '') + (err ? '<div class="errbar' + (o.sheet ? ' top' : '') + '" role="alert"' + (dlBar ? ' data-a="deadletters"' : '') + '>' + esc(err) + '</div>' : '') + '</div>';
}
function tabbar(active) {
  // Badge: open to-dos the partner created for me (what an Ask turns into).
  var n = openTodos(myTodos()).filter(function (t) { return t.created_by !== St.me() && t.type !== 'response'; }).length;
  function tab(id, icon, label, badge) {
    return '<span class="tab' + (active === id ? ' on' : '') + '" data-a="tab:' + id + '">' + ic(icon) + '<b>' + label + '</b>' + (badge ? '<i class="bdg">' + badge + '</i>' : '') + '</span>';
  }
  return '<nav class="tabbar">' + tab('home', 'moon', 'Home') + tab('todo', 'circ', 'To-dos', n) + tab('fights', 'i-fight', 'Fights') + tab('progress', 'bolt', 'Progress') + '</nav>';
}
// Which tab lights up for a route. Sub-screens light the tab they were reached from; More and its children belong to Home (gear).
var TAB_OF = { todo: 'todo', tododetail: 'todo', nudge: 'todo', nudgein: 'todo', fights: 'fights', fightdetail: 'fights', progress: 'progress', points: 'progress', shop: 'progress', challenge: 'progress', newch: 'progress' };
function tabFor(r) { return TAB_OF[r] || 'home'; }
var BACK = { home: 'Home', todo: 'To-dos', fights: 'Fights', progress: 'Progress', more: 'More', cycle: 'Cycle', points: 'Points', shop: 'Shop', settings: 'Settings', nudge: 'Reminder', nudgedone: 'Done', issues: 'Raise issue', issuenew: 'Raise issue', dropped: 'Dropped' };
function backLabel() { var p = ui.stack[ui.stack.length - 1]; return BACK[p && p.route] || 'Home'; }
function back() { var p = ui.stack.pop(); ui.route = p ? p.route : 'home'; ui.d = {}; ui.sheet = null; ui.shopEdit = false; render(); }
// A detail screen whose row is gone (deleted from the other phone, stale link) must not throw: land on its parent tab.
function bounce(route) { ui.stack = []; ui.route = route; ui.sheet = null; ui.d = {}; return SCREEN[route](); }
function go(route, extra) {
  ui.stack.push({ route: ui.route });
  ui.route = route; ui.d = {}; ui.sheet = null; ui.shopEdit = false;
  if (extra) Object.assign(ui, extra);
  render(); var sc = document.querySelector('.scr'); if (sc) sc.scrollTop = 0;
}
function tab(id) { ui.stack = []; ui.route = id; ui.d = {}; ui.sheet = null; ui.shopEdit = false; render(); }
function hdBack(label) { return '<p class="txtbtn back" data-a="back">' + ic('chev', 'sm') + label + '</p>'; }
function ptsBack(label) { return '<p class="back" data-a="back"><svg><use href="#chev"/></svg>' + label + '</p>'; }
function val(k, def) { return ui.d[k] == null ? (def == null ? '' : def) : ui.d[k]; }
function inp(k, ph, extra) { return '<input class="inp" data-d="' + k + '" value="' + esc(val(k)) + '" placeholder="' + esc(ph || '') + '" ' + (extra || '') + '>'; }
function seg(items, cur, act, cls) {
  return '<div class="seg ' + (cls || '') + '">' + items.map(function (x) { return '<span class="' + (String(x[0]) === String(cur) ? 'on' : '') + '" data-a="' + act + ':' + x[0] + '">' + x[1] + '</span>'; }).join('') + '</div>';
}
// ---- voice input (bridge speech.start records; speech.stop hands back the clip and St.transcribe sends it to the box) ----
// A single-line field with a mic at its right end (only where a native shell can listen).
function micField(k, ph) {
  var f = inp(k, ph).replace('class="inp"', 'class="inp fill"');
  if (!St.hasNative) return f;
  return '<div class="micw">' + f + micBtn(k) + '</div>';
}
function micBtn(k) {
  var on = ui.rec && ui.rec.field === k, busy = ui.busy === k;
  if (busy) return '<span class="mic busy" data-a="mic:' + k + '" role="progressbar" aria-label="Transcribing"><span class="spin"></span></span>';
  return '<span class="mic' + (on ? ' rec' : '') + '" data-a="mic:' + k + '" role="button" aria-label="' + (on ? 'Stop' : 'Voice') + '">' + ic('mic') + '</span>';
}
// A multi-line field (textarea in its .ta box) with a mic: for every place a lot of text could be dictated. `cls` is the box's own classes.
function micTa(k, cls, ph) {
  var ta = '<textarea data-d="' + k + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>' + esc(val(k)) + '</textarea>';
  return '<div class="ta ' + cls + (St.hasNative ? ' micta' : '') + '">' + ta + (St.hasNative ? micBtn(k) : '') + '</div>';
}
// The fight detail's Save shows only while its note box has text (see fightDetail). Typing and dictation update the box without a
// re-render (that would drop the keyboard), so they call this to flip Save's `hidden` in place.
function noteSaveSync() {
  var ns = document.querySelector('[data-a="notesave"]');
  if (ns) ns.hidden = !val('more').trim();
  var qs = document.querySelector('[data-a="qsave"]');
  if (qs) qs.hidden = !val('qans').trim();
}
// Drops the recording unsent: the field is going away, the person started typing, or a Save is already underway.
function stopRec() {
  if (!ui.rec) return Promise.resolve();
  ui.rec = null;
  return St.native.speechCancel();
}
// Ends a field's recording and appends the transcript to it (the mic tap, VoiceHold Insert, backgrounding). The mic shows .busy
// meanwhile. Appends to what the field holds NOW, so anything typed while the clip uploaded is kept; if the field left the
// screen in the meantime there is nowhere to put the words and they are dropped.
async function finishRec() {
  var rec = ui.rec;
  if (!rec) return;
  var f = rec.field;
  ui.rec = null; ui.busy = f; render();
  var text;
  try { text = await St.transcribe(); } finally { ui.busy = null; render(); }
  var el = document.querySelector('[data-d="' + f + '"]');
  if (!text || !el) return;
  ui.d[f] = C.appendSpeech(ui.d[f] || '', text); el.value = ui.d[f];
  saveDraft(draftKey()); if (f === 'more' || f === 'qans') noteSaveSync(); render();
}
function sheet(cls, inner, closeA) {
  return '<div class="sheetlayer"><div class="dim" data-a="' + (closeA || 'sheet:close') + '"></div><div class="bs ' + (cls || '') + '"><div class="grab"></div>' + inner + '</div></div>';
}

// ---- screens -------------------------------------------------------------------------------------
var SCREEN = {};

SCREEN.auth = function () {
  return phone('p2 au', '<header class="hd"><div><h2>Together</h2></div></header>' +
    '<section><p class="lab">Email</p><input class="inp" type="email" autocomplete="email" autocapitalize="none" data-d="email" value="' + esc(val('email')) + '"></section>' +
    '<section><p class="lab">Password</p><input class="inp" type="password" autocomplete="current-password" data-d="password" value="' + esc(val('password')) + '"></section>' +
    '<div class="pair"><span class="save" data-a="signin">Sign in</span><span class="ghost" data-a="signup">Create account</span></div>', { tab: false });
};

SCREEN.setup = function () {
  if (ui.code) {
    return phone('p2 au', '<header class="hd"><div><h2>Invite code</h2></div></header>' +
      '<section><p class="lab">Code</p><p class="code" id="invite-code" style="--n:' + ui.code.length + '">' + esc(ui.code) + '</p>' +
      '<div class="pair two"><span class="ghost" id="copy-code" data-a="copycode">' + (ui.copied ? 'Copied' : 'Copy') + '</span><span class="ghost" data-a="sharecode">Share</span></div></section>' +
      '<div class="save" data-a="codedone">Continue</div>', { tab: false });
  }
  var c = ui.mode === 'create';
  return phone('p2 au', '<header class="hd"><div><h2>Couple</h2></div></header>' +
    seg([['create', 'Create'], ['join', 'Join']], ui.mode, 'mode') +
    '<section><p class="lab">Your name</p>' + inp('name') + '</section>' +
    (c ? '' : '<section><p class="lab">Code</p>' + inp('code', '', 'autocapitalize="characters" maxlength="12"') + '</section>') +
    '<div class="save" data-a="' + (c ? 'create' : 'join') + '">' + (c ? 'Create couple' : 'Join couple') + '</div>' +
    '<span class="ghost out" data-a="signout">Sign out</span>', { tab: false });
};

// Calm days in a row, from the shared fight markers (either partner's). Named on Home and Progress so the number is never bare.
// A level-1 fight (by my rating, else my partner's) does not end it; see C.breaksStreak.
function calm() {
  var me = St.me(), ratings = L('fight_ratings');
  var days = L('fight_markers').filter(function (m) { return C.breaksStreak(m.id, me, ratings); }).map(function (m) { return C.localDay(C.ms(m.at), tz()); });
  return C.calmStats(days, today(), C.localDay(C.ms(S.couple.created_at), tz()));
}
function addRow(label, a) { return '<div class="row r2" data-a="' + a + '"><p class="lb">' + label + '</p><p class="mt">' + ic('plus', 'sm') + '</p></div>'; }

function needCard(n) {
    if (n.type === 'ready') {
      return '<div class="nc pk" data-a="still:' + n.item.id + '"><div class="mid"><p class="s">Still send? &middot; ' + n.count + ' ready</p><p class="x">' + esc(itemTitle(n.item)) + '</p></div><span class="go">Send</span></div>';
    }
    if (n.type === 'approve') {
      var rw = S.rows.rewards[n.redemption.reward_id];
      return '<div class="nc pk tall"><div class="mid"><p class="s">' + pnx(nameOf(n.redemption.requested_by)) + '</p><p class="x">' + esc(rw ? rw.name : '') + ' &middot; ' + n.redemption.price + '</p></div><div class="two"><span class="go" data-a="approve:' + n.redemption.id + '">Approve</span><span class="go o" data-a="decline:' + n.redemption.id + '">Decline</span></div></div>';
    }
    if (n.type === 'fight') {
      return '<div class="nc" data-a="openfight:' + n.marker.id + '"><div class="mid"><p class="s">Fight &middot; ' + fmtWhen(C.ms(n.marker.at)) + ' &middot; ' + pnx(nameOf(n.marker.logged_by)) + '</p><p class="x">Add your version</p></div>' + ic('chevr', 'chv') + '</div>';
    }
    if (n.type === 'fightdel') {
      var fd = C.localDay(C.ms(n.marker.at), tz());
      return '<div class="nc pk tall" data-a="openfight:' + n.marker.id + '"><div class="mid"><p class="s">' + pnx(nameOf(n.marker.logged_by)) + '</p><p class="x">Delete fight &middot; ' + dayName(fd) + ' ' + (+fd.slice(8)) + ' ' + MON[+fd.slice(5, 7) - 1] + '</p></div><div class="two"><span class="go" data-a="fightdelok:' + n.marker.id + '">Approve</span><span class="go o" data-a="fightdeldecl:' + n.marker.id + '">Decline</span></div></div>';
    }
    if (n.type === 'ownup') {
      return '<div class="nc" data-a="tview:' + n.todo.id + '"><div class="mid"><p class="s">From ' + pnx(nameOf(n.todo.owner_id)) + '</p><p class="x">' + esc(n.todo.title) + '</p></div>' + ic('chevr', 'chv') + '</div>';
    }
    if (n.type === 'nudge') {
      return '<div class="nc" data-a="nudgein:' + n.send.id + '"><div class="mid"><p class="s">From ' + pnx(nameOf(n.send.sender_id)) + '</p><p class="x">' + esc(n.send.body) + '</p></div>' + ic('chevr', 'chv') + '</div>';
    }
    if (n.type === 'week') return '<div class="nc" data-a="go:week"><div class="mid"><p class="x">Week</p><p class="s">' + sg(n.net) + '</p></div>' + ic('chevr', 'chv') + '</div>';
    // n.type === 'reply': a reply from the other person on one of the nudge threads.
    return '<div class="nc" data-a="replyopen:' + n.reply.send_id + '"><div class="mid"><p class="s">Reply from ' + pnx(nameOf(n.reply.author_id)) + '</p><p class="x">' + esc(n.reply.body) + '</p></div>' + ic('chevr', 'chv') + '</div>';
}

SCREEN.home = function () {
  var t = today();
  var cards = C.needsYou({ me: St.me(), now: now(), tz: tz(), items: L('items'), redemptions: L('redemptions'), members: S.members,
    nudge_sends: L('nudge_sends'), nudge_replies: L('nudge_replies'), fight_markers: L('fight_markers'), fight_notes: L('fight_notes'), todos: L('todos'), seen: S.priv.ownupSeen, since: S.priv.ownupSince });
  // Week close appears from Sunday until acknowledged.
  var led = ledger(), week = null;
  if (C.dow(t) === 6 && prefs().weekSeen !== led.current.start) week = { type: 'week', net: led.current.net };
  // A to-do swiped away and still inside its Undo window is hidden here too (it is only written once the toast fades).
  var list = C.homeList({ me: St.me(), now: now(), today: t, todos: L('todos'), cards: cards, week: week }).filter(function (e) { return !(e.kind === 'todo' && pendIgnore && pendIgnore.id === e.todo.id); });
  var html = list.map(function (e) {
    if (e.kind === 'card') return needCard(e.card);
    var x = e.todo, d = x.due_date ? dueOf(x.due_date) : null, mk = x.fight_marker_id && S.rows.fight_markers[x.fight_marker_id];
    // A to do a fight produced names that fight, so two of them ("Apologize", "Reflect") say which fight they belong to.
    var sub = mk ? 'Fight &middot; ' + fmtWhen(C.ms(mk.at)) + (d ? ' &middot; ' + d.text : '') : d ? d.text : 'To-do';
    // data-sw/data-todo: swipe left to ignore, the same gesture as on the To-dos tab (homeList only holds my own open to-dos).
    return '<div class="nc' + (d && d.state ? ' dc' : '') + '" data-sw="1" data-todo="' + x.id + '" data-a="tview:' + x.id + '"><div class="mid"><p class="s ' + (d ? d.state : '') + '">' + sub + '</p><p class="x">' + esc(x.title) + '</p></div>' + ic('chevr', 'chv') + '</div>';
  }).join('');
  var k = calm(), fr = fightRecs(), ph = C.phase(fr, now(), tz(), 14);
  var tiles = '<div class="tiles"><div class="tile2 big" data-a="tab:fights"><p class="s">Calm streak</p><span class="v">' + k.streak + ' <span class="u">' + (k.streak === 1 ? 'day' : 'days') + '</span></span></div>' +
    '<div class="tile2" data-a="tab:fights"><p class="s">Phase</p>' + (ph ? '<p class="v">' + ph.name + '</p><p class="u mu">' + C.phaseLabel(ph) + '</p><div class="bar"><i style="width:' + Math.min(100, Math.round(100 * ph.day / ph.len)) + '%"></i></div>' : '<p class="v">None</p>') + '</div>' +
    '<div class="tile2" data-a="tab:progress"><p class="s">This week</p><p class="v">' + sg(led.current.net) + '</p><p class="u mu">Balance ' + led.balance + '</p></div></div>';
  return phone('pts', '<header class="hd"><div class="ttl"><span class="mark"><svg><use href="#arwh"/></svg></span><div><h2>Home</h2><p class="dl">' + fmtDay(t) + '</p></div></div><span class="gear" data-a="go:more">' + ic('cog') + '</span></header>' + tiles +
    '<div class="nd"><p class="lab">To do' + (list.length ? ' <em>&middot; ' + list.length + '</em>' : '') + '</p>' + (html || '<p class="empty">None</p>') + '</div>',
    // How to add must be obvious on opening, so the three adders sit outside the scroller, pinned above the tab bar at any list length.
    { pin: '<div class="rows pin">' + addRow('Log fight', 'go:fight') + addRow('To-do', 'newtodo:task') + addRow('Reminder', 'nudgenew') + '</div>' });
};

function stepper(k) {
  return '<div class="stp"><span data-a="stp:' + k + ':-1"><svg class="ic sm"><path d="M6 12h12"/></svg></span><b>' + ui.sheet[k] + '</b><span data-a="stp:' + k + ':1">' + ic('plus', 'sm') + '</span></div>';
}

// A "Still send?" notification or card can outlive its item: the hold may have been delivered or dropped
// on another phone, or by this one. Only a still-held item may offer Send / Edit / Drop.
function stillHeld(id) { return C.isStillHeld(S.rows.items[id]); }
function stillSheet() {
  var i = L('items').filter(function (x) { return x.id === ui.sheet.id; })[0];
  if (!C.isStillHeld(i)) return '';
  var e = ui.sheet.edit;
  return sheet('cf', '<div class="bsh"><h3>Still send?</h3><span class="x" data-a="sheet:close">&#x2715;</span></div>' +
    (i.origin === 'fight' ? '<p class="fm"><svg><use href="#fa"/></svg>Fight</p>' : '') +
    (e ? micTa('edit', '') : '<p class="ask">' + esc(i.body) + '</p>') +
    '<p class="to">To ' + esc(nameOf(i.recipient_id)) + '</p>' +
    '<div class="acts"><div class="save' + (!e && i.origin === 'issue' && C.ms(i.held_until) > now() ? ' dis' : '') + '" data-a="' + (e ? 'editsave' : 'deliver') + ':' + i.id + '">' + (e ? 'Save' : 'Send') + '</div>' + (e ? '' : '<div class="ghost" data-a="edit:' + i.id + '">Edit</div>') + '<div class="tdrop" data-a="drop:' + i.id + '">Drop</div></div>');
}

// May the signed-in person still change this to do? Their own (owner = me) always, as before. A delivered ask they sent
// (owner = partner) only inside EDIT_WINDOW_MIN of delivery, so a typo can be fixed but a request cannot be quietly rewritten
// after the partner has read it. A response to do is made by the system from a fight and is never editable.
function canEditTodo(t) {
  return t.created_by === St.me() && t.type !== 'response' && (t.owner_id === St.me() || C.inEditWindow(C.ms(t.created_at), now(), EDIT_WINDOW_MIN));
}
function tdDesc(x) { return x.description ? '<p class="tdd">' + esc(x.description) + '</p>' : ''; }
function lastNote(x) { var e = L('todo_events').filter(function (v) { return v.todo_id === x.id && v.note; }).sort(function (a, b) { return C.ms(b.at) - C.ms(a.at); })[0]; return e ? '<p class="tdd">' + esc(e.note) + '</p>' : ''; }
// Habit progress in its current day / week / month, goal-tracker style: dots for a small target, a bar for a big one.
function hprog(x) {
  if (!x.period || !x.target) return { bar: '', hv: x.tally };
  var n = C.habitCount(x, L('todo_events'), C.periodOf(x.period, today()), tz()), N = x.target;
  var dots = Array(Math.min(N, 12) + 1).join('x').split('').map(function (_, i) { return '<i' + (i < n ? '' : ' class="o"') + '></i>'; }).join('');
  return { bar: N <= 12 ? '<small>' + { day: 'Today', week: 'This week', month: 'This month' }[x.period] + '<span class="dt">' + dots + '</span></small>' : '<div class="pb"><i style="width:' + Math.min(100, Math.round(100 * n / N)) + '%"></i></div>', hv: n + '/' + N };
}
// Small pills under a to do's title: whose it is, and its kind when not a plain task.
var TYPE_TAG = { habit: 'Habit', ownup: 'Own up', response: 'Response' };
function edited(x) { return C.isEdited(x, L('todo_events'), St.me()) ? '<small class="ed">Edited</small>' : ''; }
function tags(x, noType) {
  return '<span class="tts"><span class="tt">' + (x.owner_id === St.me() ? 'You' : pnx(nameOf(x.owner_id))) + '</span>' + (!noType && TYPE_TAG[x.type] ? '<span class="tt">' + TYPE_TAG[x.type] + '</span>' : '') + '</span>';
}
// The live fight a to do belongs to, or null (no link, or the fight was deleted).
function todoFight(x) { var mk = x.fight_marker_id && S.rows.fight_markers[x.fight_marker_id]; return mk && !mk.deleted_at ? mk : null; }
var DONE_SHOWN = 10; // Done rows shown before "All": a guess at a few days' worth, short enough that Open stays the first thing seen.
SCREEN.todo = function () {
  var rem = ui.todoSeg === 'rem';
  var sh = ui.sheet && ui.sheet.type === 'newtodo' ? newTodoSheet() : ui.sheet && ui.sheet.type === 'note' ? noteSheet() : ui.sheet && ui.sheet.type === 'decline' ? declineSheet() : ui.sheet && ui.sheet.type === 'still' ? stillSheet() : ui.sheet && ui.sheet.type === 'addpick' ? addPick() : '';
  var seg2 = seg([['todo', 'To-dos'], ['rem', 'Reminders']], ui.todoSeg, 'todoseg');
  if (rem) {
    return phone('p2 nd', '<header class="hd"><div><h2>To-dos</h2></div><span class="plus" data-a="nudgenew">' + ic('plus') + '</span></header>' + seg2 + remBody(), { sheet: sh });
  }
  var held = heldItems(), sched = scheduledTodos();
  // One list: mine first (late and due-today at the top), then the partner's; the tag says whose.
  var mineL = urgentFirst(openTodos(myTodos())), theirs = urgentFirst(theirTodos());
  // Every row opens its view page (the Edit pill there is the author's only way into the edit sheet); the Done / +1
  // buttons inside a row carry their own data-a, and the click handler takes the closest one, so they never open it.
  // sub: the row sits under its fight's parent row, so the fight arrow and the Response tag would only repeat it.
  function row(x, sub) {
    var mine = x.owner_id === St.me(), habit = x.type === 'habit', h = habit && hprog(x), resp = x.type === 'response' && !sub;
    var btn = !mine ? '' : habit ? '<span class="p1b" data-a="tally:' + x.id + '">+1</span>' : (x.type === 'response' ? '<span class="done o" data-a="tdecline:' + x.id + '">Decline</span>' : '') + '<span class="done" data-a="done:' + x.id + '">Done</span>';
    return '<div class="td-row' + (sub ? ' sub' : '') + '"' + (mine && !closed(x) ? ' data-sw="1"' : '') + ' data-todo="' + x.id + '" data-a="tview:' + x.id + '"><span class="om">' + (resp ? '<svg><use href="#fa"/></svg>' : '') + '</span><div class="tx"><p>' + esc(x.title) + '</p>' + tdDesc(x) + (habit ? lastNote(x) + h.bar : dueTag(x)) + edited(x) + ns('todos', x.id) + tags(x, sub) + '</div>' + (habit ? '<span class="hv">' + h.hv + '</span>' : '') + btn + '</div>';
  }
  // A fight's open to dos (both people's) sit under one parent row naming the fight, at the place its first to do would take.
  var all = mineL.concat(theirs), shownFight = {};
  function rows(list) {
    return list.map(function (x) {
      var mk = todoFight(x);
      if (!mk) return row(x);
      if (shownFight[mk.id]) return '';
      shownFight[mk.id] = true;
      var d = C.localDay(C.ms(mk.at), tz()), text = fightSummary(mk);
      return '<div class="td-fg"><div class="td-row fgp" data-a="openfight:' + mk.id + '"><span class="om">' + ic('i-fight') + '</span><div class="tx">' + (text ? '<p>' + esc(text) + '</p>' : '') +
        '<small>Fight &middot; ' + dayName(d) + ' ' + (+d.slice(8)) + ' ' + MON[+d.slice(5, 7) - 1] + '</small></div>' + ic('chevr', 'chv') + '</div>' +
        all.filter(function (t) { return t.fight_marker_id === mk.id; }).map(function (t) { return row(t, true); }).join('') + '</div>';
    }).join('');
  }
  var heldHtml = held.length ? section('Held', held.map(function (i) {
    var rd = C.ms(i.held_until) <= now();
    return '<div class="td-row hrow2"><span class="om"><svg class="hold-ic"><use href="#hg"/></svg></span><p class="ht">' + esc(itemTitle(i)) + '</p><p class="hm2">To ' + pn() + '</p><div class="hact"><span class="cd">' + C.countdown(C.ms(i.held_until), now()) + '</span><span class="elink" data-a="still:' + i.id + '">' + (rd ? 'Send' : 'Edit') + '</span></div></div>';
  }).join(''), 'held') : '';
  // A scheduled row has no view page (the partner cannot see it yet), so Edit sits on the row itself. canEditTodo
  // allows it: the edit window runs from created_at, which for a scheduled to do is its future delivery time.
  var schedHtml = sched.length ? section('Scheduled', sched.map(function (t) {
    return '<div class="td-row hrow2"><span class="om"></span><p class="ht">' + esc(t.title) + '</p><p class="hm2">' + fmtWhen(C.ms(t.created_at)) + ' &middot; ' + (t.owner_id === St.me() ? 'You' : pn()) + '</p><div class="hact"><span class="elink" data-a="etodo:' + t.id + '">Edit</span><span class="elink" data-a="schedcancel:' + t.id + '">Cancel</span></div></div>';
  }).join(''), 'held') : '';
  var open = rows(mineL) + S.priv.queued.map(function (q) {
    return '<div class="td-row"><span class="om"></span><div class="tx"><p>' + esc(q.body) + '</p>' + tdDesc(q) + '<small>Queued</small><span class="tts"><span class="tt">' + pn() + '</span></span></div></div>';
  }).join('') + rows(theirs);
  var done = L('todos').filter(function (x) { return !x.deleted_at && closed(x); }).sort(function (a, b) { return C.ms(b.done_at || b.declined_at) - C.ms(a.done_at || a.declined_at); });
  // Done is collapsed by default: only its label and count show, and tapping the label toggles the rows (and the
  // All / Fewer row past DONE_SHOWN). The chevron points right when closed, down when open.
  var doneRows = !ui.doneOpen ? '' : done.slice(0, ui.doneAll ? done.length : DONE_SHOWN).map(function (x) {
    return '<div class="td-row dn" data-a="tview:' + x.id + '"><span class="om"></span><div class="tx"><p>' + esc(x.title) + '</p>' + tags(x) + '</div><span class="hv">' + (x.declined_at ? declWord(x) : fmtShort(C.localDay(C.ms(x.done_at), tz()))) + '</span></div>';
  }).join('') + (done.length > DONE_SHOWN ? '<p class="empty" data-a="doneall">' + (ui.doneAll ? 'Fewer' : 'All') + '</p>' : '');
  var doneHtml = done.length ? section('<span class="dtg' + (ui.doneOpen ? ' on' : '') + '" data-a="doneopen">Done &middot; ' + done.length + ic('chevr') + '</span>', doneRows, 'ro2') : '';
  return phone('p2 td' + (held.length || sched.length ? ' hl' : ''), '<header class="hd"><div><h2>To-dos</h2><p class="dl">' + todoCount() + '</p></div><span class="fight" data-a="addpick">Add</span></header>' + seg2 + heldHtml + schedHtml +
    section('Open', open || '<p class="empty">None</p>') + doneHtml, { sheet: sh });
};
// The Add picker: Task, Habit and Owning up open the new-to-do sheet on that type (a challenge is created from Progress).
function addPick() {
  return sheet('ap', '<div class="bsh"><h3>New</h3><span class="x" data-a="sheet:close">&#x2715;</span></div>' +
    [['newtodo:task', 'Task'], ['newtodo:habit', 'Habit'], ['newtodo:ownup', 'Owning up']].map(function (o) { return '<div class="opt" data-a="' + o[0] + '">' + o[1] + ic('chevr', 'chv') + '</div>'; }).join(''));
}
function monDay(d) { return MON[+d.split('-')[1] - 1] + ' ' + +d.split('-')[2]; }
// Big status of a challenge, shared by the Actions cards: Day N, count/goal, Not started, Done or Failed.
function chStatus(c) { return c.breaks_on === 'goal' ? (!c.accepted ? 'Not started' : c.status === 'done' ? 'Done' : c.status === 'failed' ? 'Failed' : c.count + '/' + c.goal_days) : c.accepted ? 'Day ' + c.day : 'Not started'; }
function chCard(c) {
  var goal = c.breaks_on === 'goal', big = chStatus(c), me = c.for_user === St.me();
  var cap = goal ? '<div class="pb"><i style="width:' + Math.min(100, Math.round(100 * c.count / c.goal_days)) + '%"></i></div><div class="bt">To ' + monDay(c.deadline) + '</div>' : '<div class="bt">' + (me ? 'You' : pnx(nameOf(c.for_user))) + '</div>';
  return '<div class="ach' + (big === 'Not started' ? ' n' : '') + (me ? '' : ' o') + '" data-a="challenge:' + esc(c.id) + '"><p class="nm">' + esc(c.name) + '</p><p class="big">' + big + '</p>' + cap + '</div>';
}
function newTodoSheet() {
  var s = ui.sheet, t = s.edit && S.rows.todos[s.edit], tgl = function (k, a) { return '<span class="tg' + (s[k] ? ' on' : '') + '" data-a="' + a + '"><i></i></span>'; };
  var notes = t ? L('todo_events').filter(function (e) { return e.todo_id === t.id && e.note; }).sort(function (a, b) { return C.ms(b.at) - C.ms(a.at); }).slice(0, 5) : [];
  return sheet('', '<div class="bsh"><h3>' + (t ? 'Edit to do' : 'New to do') + '</h3><span class="x" data-a="sheet:close">&#x2715;</span></div>' +
    inp('title', 'Title').replace('class="inp"', 'class="inp fill"') +
    micTa('desc', 'msg', 'Description (optional)') +
    (t ? '' : '<div class="frow"><span class="lab0">For</span>' + seg([['me', 'You'], ['them', pn()]], s.who, 'nfor') + '</div>') +
    '<div class="frow"><span class="lab0">Type</span>' + seg([['task', 'Task'], ['habit', 'Habit'], ['ownup', 'Owning up']], s.kind, 'nkind') + '</div>' +
    (s.kind !== 'habit' ? '<div class="frow"><span class="lab0">Due</span><span class="chip' + (val('due') ? '' : ' on') + '" data-a="nodue">None</span>' + dpick('date', 'due', val('due')) + '</div>' : '') +
    (s.kind === 'habit' ? '<div class="frow"><span class="lab0">Per</span>' + seg([['day', 'Day'], ['week', 'Week'], ['month', 'Month']], s.period, 'nper', 'hs') + '</div><div class="frow"><span class="lab0">Times</span>' + stepper('tgt') + '</div>' : '') +
    // Points are opt-in: a new to do has none, and Earn/Lose only show once the Points toggle is on (savetodo writes 0/0 while it is off).
    '<div class="frow"><span class="lab0">Points</span>' + tgl('pts', 'npts') + '</div>' +
    (s.pts ? '<div class="frow"><span class="lab0">Earn</span>' + stepper('pe') + '</div><div class="frow"><span class="lab0">Lose</span>' + stepper('pm') + '</div>' : '') +
    // An owning-up is its note, so the toggle is hidden and savetodo forces needs_note on.
    (s.kind === 'ownup' ? '' : '<div class="frow"><span class="lab0">Needs a note</span>' + tgl('nn', 'nnote') + '</div>') +
    (t ? '' : laterRow(s.when === 'later', 'nwhen')) +
    (notes.length ? '<p class="lab">Log</p>' + notes.map(function (e) { return '<p class="tdd">' + esc(fmtDay(C.localDay(C.ms(e.at), tz()))) + ' &middot; ' + esc(e.note) + '</p>'; }).join('') : '') +
    (t ? '<div class="acts"><div class="save" data-a="savetodo">Save</div><div class="tdrop" data-a="tododel:' + t.id + '">Delete</div></div>' : '<div class="save" data-a="savetodo">Save</div>'));
}
// The view page of one to do: everything about it, the log, a Ping when it is the partner's, and a comment thread.
// Edit is the existing edit sheet, offered only to the creator (and never for a response to do), as before.
function todoComments(id) { return L('todo_comments').filter(function (c) { return c.todo_id === id; }).sort(function (a, b) { return C.ms(a.created_at) - C.ms(b.created_at); }); }
// One nudge per to do per sender per local day (the database cannot know the couple's day boundary, so the app checks).
function nudgedToday(id) {
  return L('todo_nudges').some(function (n) { return n.todo_id === id && n.sender_id === St.me() && !n.deleted_at && C.localDay(C.ms(n.created_at), tz()) === today(); });
}
// Same rule for a challenge ping: one per challenge per sender per local day.
function pingedToday(id) {
  return L('challenge_nudges').some(function (n) { return n.challenge_id === id && n.sender_id === St.me() && !n.deleted_at && C.localDay(C.ms(n.created_at), tz()) === today(); });
}
SCREEN.tododetail = function () {
  var t = S.rows.todos[ui.todoId];
  // The partner can delete it while this page is open (the 5s sync lands in the 15s repaint): fall back to the list.
  if (!t || t.deleted_at) return bounce('todo');
  var mineOwn = t.owner_id === St.me(), habit = t.type === 'habit', h = habit && hprog(t);
  var notes = L('todo_events').filter(function (e) { return e.todo_id === t.id && e.note; }).sort(function (a, b) { return C.ms(b.at) - C.ms(a.at); });
  function fr(l, v) { return '<div class="frow"><span class="lab0">' + l + '</span><span>' + v + '</span></div>'; }
  function dueFact(x) { var d = dueOf(x.due_date), hot = !closed(x) && d.state; return fmtDay(x.due_date) + (hot ? ' <span class="due ' + d.state + '">' + d.text + '</span>' : ''); }
  var facts = fr('For', mineOwn ? 'You' : pnx(nameOf(t.owner_id))) + fr('From', t.created_by === St.me() ? 'You' : pnx(nameOf(t.created_by))) +
    (habit ? fr('Progress', h.hv + (t.period ? ' ' + { day: 'today', week: 'this week', month: 'this month' }[t.period] : '')) : t.due_date ? fr('Due', dueFact(t)) : '') +
    (t.type === 'response' || (!C.earnPts(t) && !C.missPts(t)) ? '' : fr('Earn', C.earnPts(t)) + fr('Lose', C.missPts(t))) + (t.done_at ? fr('Done', fmtDay(C.localDay(C.ms(t.done_at), tz()))) : '') + (t.declined_at ? fr(declWord(t), fmtDay(C.localDay(C.ms(t.declined_at), tz()))) + (t.decline_note ? fr('Note', esc(t.decline_note)) : '') : '');
  var undo = mineOwn && habit && t.tally > 0 ? '<div class="ghost" data-a="tundo:' + t.id + '">Undo tally</div>' : mineOwn && !habit && t.done_at ? '<div class="ghost" data-a="tundo:' + t.id + '">Undo done</div>' : mineOwn && t.declined_at ? '<div class="ghost" data-a="tundecline:' + t.id + '">' + declUndoWord(t) + '</div>' : '';
  var decline = mineOwn && t.type === 'response' && !closed(t) ? '<div class="ghost" data-a="tdecline:' + t.id + '">Decline</div>' : '';
  var canNudge = !mineOwn && !closed(t), nudged = nudgedToday(t.id);
  var nudge = canNudge ? '<div class="ghost' + (nudged ? ' dis' : '') + '"' + (nudged ? '' : ' data-a="tnudge:' + t.id + '"') + '>' + (nudged ? 'Pinged' : 'Ping') + '</div>' : '';
  var cm = todoComments(t.id);
  // A deleted comment stays as a marker, so a reply under it never reads as answering nothing.
  var thread = cm.map(function (c) {
    var del = c.author_id === St.me() && !c.deleted_at ? ' <span class="lnk" data-a="cmtdel:' + c.id + '">Delete</span>' : '';
    return '<div class="fn' + (c.deleted_at ? ' gone' : '') + '"><p class="meta">' + pnx(nameOf(c.author_id)) + ' &middot; ' + noteStamp(C.ms(c.created_at)) + ns('todo_comments', c.id).replace('<span', ' <span') + del + '</p><p>' + (c.deleted_at ? 'Deleted' : esc(c.body)) + '</p></div>';
  }).join('');
  var edit = canEditTodo(t) ? '<span class="fight" data-a="etodo:' + t.id + '">Edit</span>' : '';
  var sh = ui.sheet && ui.sheet.type === 'newtodo' ? newTodoSheet() : ui.sheet && ui.sheet.type === 'decline' ? declineSheet() : '';
  return phone('p2 tdd2', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>' + esc(t.title) + '</h2></div>' + edit + '</header>' +
    (t.description ? '<section><p class="tdd">' + esc(t.description) + '</p></section>' : '') +
    '<section class="list">' + facts + (habit ? h.bar : '') + '</section>' +
    (notes.length ? section('Log', notes.map(function (e) { return '<p class="tdd">' + esc(fmtDay(C.localDay(C.ms(e.at), tz()))) + ' &middot; ' + esc(e.note) + '</p>'; }).join('')) : '') +
    (nudge ? '<section>' + nudge + '</section>' : '') + (undo || decline ? '<section>' + undo + decline + '</section>' : '') +
    section('Comments', (thread ? '<div class="fns">' + thread + '</div>' : '') + micTa('cmt', 'nt', 'Comment') + '<div class="save" data-a="tcomment:' + t.id + '">Send</div>'),
    { sheet: sh });
};
function noteSheet() {
  var t = S.rows.todos[ui.sheet.id];
  if (!t || t.deleted_at) return '';
  return sheet('', '<div class="bsh"><h3>' + esc(clip(t.title, 28)) + '</h3><span class="x" data-a="sheet:close">&#x2715;</span></div>' +
    '<p class="lab">What did you do</p>' + micTa('note', 'msg') + '<div class="save" data-a="lognote">Log</div>');
}

function declineSheet() {
  var t = S.rows.todos[ui.sheet.id];
  if (!t || t.deleted_at) return '';
  return sheet('', '<div class="bsh"><h3>' + esc(clip(t.title, 28)) + '</h3><span class="x" data-a="sheet:close">&#x2715;</span></div>' +
    '<p class="lab">Note</p>' + micTa('dnote', 'msg') + '<div class="save" data-a="tdeclinego">Decline</div>');
}

// Single-choice Yes/No chips for a Log fight question; tapping the selected chip clears it.
function yn(k) {
  return '<div class="tdc">' + [['yes', 'Yes'], ['no', 'No']].map(function (c) { return '<span class="chip' + (ui.d[k] === c[0] ? ' on' : '') + '" data-a="yn:' + k + ':' + c[0] + '">' + c[1] + '</span>'; }).join('') + '</div>';
}
function ynVal(v) { return v === 'yes' ? true : v === 'no' ? false : null; }
function intensityArrows(i, action) {
  return [1, 2, 3, 4, 5].map(function (n) {
    return '<span' + (n === i ? ' class="sel"' : ' style="color:#5e5e5e"') + ' data-a="' + (action || 'int') + ':' + n + '"><svg><use href="#' + (n === i ? 'arwh' : 'arw') + '"/></svg><b>' + n + '</b></span>';
  }).join('');
}
function intensityPicker(i, action) {
  return '<section><p class="lab">Intensity</p><div class="arrows">' + intensityArrows(i, action) + '</div><div class="ends"><span>Low</span><span>High</span></div></section>';
}
// The shared hit questions, used by Log a fight and by editing one; both read the same ui.d keys (hit, hitN, hitNot).
// Esme is the one who may hit herself, so her questions are in the first person; the flag lives on her member row.
function hitFields(d, esme) {
  return '<p class="lab">' + (esme ? 'Did you hit yourself?' : 'Did she hit herself?') + '</p>' + yn('hit') +
    (d.hit === 'yes' ? '<div class="frow"><span class="lab0">How many times?</span><div class="stp"><span data-a="hitn:-1"><svg class="ic sm"><path d="M6 12h12"/></svg></span><b>' + (d.hitN === 0.5 ? '.5' : d.hitN || 1) + '</b><span data-a="hitn:1">' + ic('plus', 'sm') + '</span></div></div>' : '') +
    (d.hit === 'yes' ? '<div class="ck' + (d.hitNot ? ' on' : '') + '" data-a="hitnot"><i></i><span>Click here if it was not related to ' + (esme ? pn() : 'you') + '</span></div>' : '');
}
// "Also over text": the box summarizer reads the couple's WhatsApp around the fight; the optional note says which chats and what matters.
// Shared by Log a fight and the edit sheet (ui.d.textOn, ui.d.tnote).
function textFields(d) {
  return '<section><div class="ck' + (d.textOn ? ' on' : '') + '" data-a="texton"><i></i><span>Also over text</span></div>' +
    (d.textOn ? '<p class="lab">About the texts <span class="opt">Optional</span></p>' + micTa('tnote', 'nt') : '') + '</section>';
}
SCREEN.fight = function () {
  var d = ui.d, i = d.int || 3, chips = d.chips || {}, esme = St.myMember().hits_self;
  return phone('p2 s2', '<header class="hd"><div><h2>Log a fight</h2></div><span class="txtbtn" data-a="back">Cancel</span></header>' +
    intensityPicker(i, 'int') +
    // Esme is the one who may hit herself, so her questions are in the first person; the flag lives on her member row.
    '<section>' + hitFields(d, esme) + '</section>' +
    '<section><p class="lab">What happened' + talkLink('note') + '</p>' + micTa('note', 'nt') + whenRow('when') + '</section>' +
    textFields(d) +
    '<section><p class="lab">Ask ' + pn() + ' to</p><div class="tdc">' + [['apologize', 'Apologize'], ['reflect', 'Reflect'], ['custom', 'Custom']].map(function (c) { return '<span class="chip' + (chips[c[0]] ? ' on' : '') + '" data-a="chip:' + c[0] + '">' + c[1] + '</span>'; }).join('') + '</div>' +
    (chips.custom ? '<p class="lab">Title</p>' + inp('customTitle') : '') + '</section>' +
    '<div class="save" data-a="fightsave">Save</div>', { band: false });
};

// Notes are append-only and shared: both people read the same time-ordered list and can only add.
// The Talk entry beside a note's label; only where a box url is configured. Analysis is shown verbatim as authored, so it has none.
function talkLink(field) { return St.canTalk ? ' <span class="lnk" data-a="talk:' + field + '">Talk</span>' : ''; }
function fightNotes(id) { return L('fight_notes').filter(function (n) { return n.fight_marker_id === id; }).sort(function (a, b) { return C.ms(a.created_at) - C.ms(b.created_at); }); }
function noteStamp(ms) { return fmtDay(C.localDay(ms, tz())) + ' &middot; ' + fmtTime(ms); }
// Writes the server refused, shown as plain text (never deleted here) with an export control.
SCREEN.deadletters = function () {
  return phone('p2 dl', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Not sent</h2></div></header>' +
    '<div class="dlist">' + S.deadLetters.map(function (d) {
      return '<div class="card"><p class="meta">' + esc(d.entry.table) + ' &middot; ' + esc(d.entry.op) + ' &middot; ' + esc(fmtStamp(d.at)) + '</p><p class="meta">' + esc(d.error) + '</p><pre>' + esc(JSON.stringify(d.entry.row || d.entry.patch, null, 1)) + '</pre></div>';
    }).join('') + '</div><div class="save" data-a="dlexport">Export</div>');
};
function fmtStamp(iso) { return new Date(iso).toLocaleString(); }
// A fight's shared facts as chips: what the logger answered about a hit, and whether it was repaired.
function fightChips(mk) {
  var hit = C.hitText(mk, mk.logged_by === St.me() ? 'me' : nameOf(mk.logged_by));
  return (hit ? '<span class="rc">' + esc(hit) + '</span>' : '') + (mk.text_on ? '<span class="rc">Over text</span>' : '') + (mk.repaired_at ? '<span class="rc d">Repaired</span>' : '') +
    (mk.delete_requested_at ? '<span class="rc">Delete requested</span>' : mk.delete_declined_at ? '<span class="rc">Delete declined</span>' : '');
}
// The viewer's own intensity for a fight: their fight_ratings row, else (a fight rated before ratings were shared and not yet
// uploaded) the on-device record. null = I have not rated it.
function myRating(mk) {
  var r = S.rows.fight_ratings[mk.id + ':' + St.me()], rec = ownFight(mk);
  return r ? r.intensity : rec ? rec.intensity : null;
}
// Writes my rating through the offline outbox; the chart counts it for both of us.
function setRating(fightId, n) {
  var me = St.me();
  St.upsert('fight_ratings', { id: fightId + ':' + me, fight_marker_id: fightId, user_id: me, intensity: n, updated_at: nowIso() }, 'fight_marker_id,user_id');
}
// The logger's on-device record of the fight (its text and intensity predate shared ratings); the partner's fight has none.
function ownFight(mk) { return mk.logged_by === St.me() ? S.priv.fights.filter(function (f) { return f.id === mk.id; })[0] : null; }
// The logger can edit their own fight (time and hit answers) at any time while no delete is requested or done. There is
// no time window: a 15-minute one hid Edit, the only place the hit question lives, so a hit noticed hours later could
// not be recorded (2026-11-05). The server guard (cycle-tracker 20261105000001) enforces the same rules.
function fightEditable(mk) {
  return mk.logged_by === St.me() && !mk.deleted_at && !mk.delete_requested_at;
}
function hmOf(ms) { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz() }); }
// A person's analysis shown word for word: author, paragraphs, then chips that open the earlier fights it points at.
// Pencil and trash at the right end of a note's meta line; the glyphs stay small, the 32px hit area is padding.
function noteActs(id) {
  return '<span class="ibs"><span class="ib" role="button" aria-label="Edit note" data-a="notedit:' + id + '">' + ic('pen') + '</span><span class="ib" role="button" aria-label="Delete note" data-a="notedel:' + id + '">' + ic('trash') + '</span></span>';
}
function analysisCard(n) {
  var del = n.author_id === St.me() ? noteActs(n.id) : '';
  var links = (n.linked_fight_ids || []).map(function (id) { return S.rows.fight_markers[id]; }).filter(function (m) { return m && !m.deleted_at; })
    .sort(function (x, y) { return C.ms(x.at) - C.ms(y.at); }).map(function (m) {
      var d = C.localDay(C.ms(m.at), tz());
      return '<span class="lk" data-a="openfight:' + m.id + '">Also ' + dayName(d) + ' ' + (+d.slice(8)) + ' ' + MON[+d.slice(5, 7) - 1] + ic('chevr', 'sm') + '</span>';
    }).join('');
  return '<div class="pcard"><p class="who nm"><span>' + pnx(nameOf(n.author_id)) + (n.edited_at ? ' &middot; Edited' : '') + '</span>' + del + '</p>' + n.body.split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') +
    (links ? '<div class="chips">' + links + '</div>' : '') + '</div>';
}
// The story beats with each analysis card after the beat the summarizer placed it by; analysis it did not place (written since,
// or deleted placement) goes after the last beat. Deleted analysis never shows.
function beatsHtml(mk, notes) {
  var an = {}; notes.filter(function (n) { return n.kind === 'analysis' && !n.deleted_at; }).forEach(function (n) { an[n.id] = n; });
  var placed = {};
  var out = mk.summary_beats.map(function (b) {
    var cards = (b.after || []).filter(function (id) { return an[id]; }).map(function (id) { placed[id] = 1; return analysisCard(an[id]); }).join('');
    return '<p class="bt"><b>' + esc(b.lead) + '.</b> ' + esc(b.text) + '</p>' + cards;
  }).join('');
  return out + Object.keys(an).filter(function (id) { return !placed[id]; }).map(function (id) { return analysisCard(an[id]); }).join('');
}
// Earlier fights an analysis can point at, newest first.
function linkChoices(mk) {
  return L('fight_markers').filter(function (m) { return m.id !== mk.id && C.ms(m.at) < C.ms(mk.at); }).sort(function (x, y) { return C.ms(y.at) - C.ms(x.at); });
}
SCREEN.fightdetail = function () {
  var mk = S.rows.fight_markers[ui.fightId];
  // An approved delete (possibly from the other phone while this page is open) takes the fight off every screen.
  if (!mk || mk.deleted_at) return bounce('fights');
  var me = mk.logged_by === St.me(), notes = fightNotes(mk.id), mine = notes.some(function (n) { return n.author_id === St.me() && !n.deleted_at && n.kind !== 'analysis'; });
  var old = ownFight(mk);
  var oldNote = old && old.about ? '<div class="fn"><p class="meta">' + pnx(nameOf(mk.logged_by)) + ' &middot; ' + noteStamp(C.ms(mk.at)) + '</p><p>' + esc(old.about) + '</p></div>' : '';
  // A deleted note stays as a marker, so a reply under it never reads as answering nothing.
  var list = oldNote + notes.map(function (n) {
    var del = n.author_id === St.me() && !n.deleted_at ? noteActs(n.id) : '';
    return '<div class="fn' + (n.deleted_at ? ' gone' : '') + '"><p class="meta nm"><span>' + pnx(nameOf(n.author_id)) + ' &middot; ' + noteStamp(C.ms(n.created_at)) + (n.kind === 'analysis' && !n.deleted_at ? ' &middot; Analysis' : '') + (n.edited_at && !n.deleted_at ? ' &middot; Edited' : '') + ns('fight_notes', n.id).replace('<span', ' <span') + '</span>' + del + '</p><p>' + (n.deleted_at ? 'Deleted' : esc(n.body)) + '</p></div>';
  }).join('');
  var chips = fightChips(mk), gap = C.fightGap({ me: St.me(), marker: mk, notes: notes.filter(function (n) { return !n.deleted_at; }) });
  var hasBeats = !!(mk.summary_beats && mk.summary_beats.length), hidden = !!mk.summary_hidden_at;
  var live = notes.filter(function (n) { return !n.deleted_at; }).length + (oldNote ? 1 : 0);
  // The summary and its collapsed notes row; with no summary yet, or it hidden, the raw notes are the page.
  var story = '';
  if (hasBeats && !hidden) {
    story = '<section><p class="lab" style="margin-bottom:12px">Summary <span class="lnk" data-a="sumhide">Hide</span></p>' + beatsHtml(mk, notes) + '</section>';
  } else if (hasBeats) {
    story = '<section><p class="lab">Summary <span class="lnk" data-a="sumshow">Show</span></p></section>';
  }
  // The box's clarifying question goes to the logger only; once its answer is in text_note the question is spent.
  var asked = mk.text_on && mk.text_question && me && fightEditable(mk) && (mk.text_note || '').indexOf('Q: ' + mk.text_question + '\nA: ') < 0;
  var qHtml = asked ? '<section><p class="lab">Question</p><p style="margin-bottom:12px">' + esc(mk.text_question) + '</p>' + micTa('qans', 'nt') + '<div class="save" data-a="qsave"' + (val('qans').trim() ? '' : ' hidden') + '>Save</div></section>' : '';
  var gapHtml = gap ? '<section class="fgap"><p class="lab">Missing</p><p>' + esc(gap) + '</p></section>' : '';
  var collapsed = hasBeats && !hidden, open = ui.notesOpen === mk.id;
  var notesHtml = !list ? '' : collapsed
    ? '<div class="srow" data-a="notestoggle"><span>' + live + (live === 1 ? ' note' : ' notes') + '</span>' + ic('chevr', 'sm chv' + (open ? ' up' : '')) + '</div>' + (open ? '<section class="fns">' + list + '</section>' : '')
    : '<section class="fns">' + list + '</section>';
  var nkind = ui.d.fnkind === 'analysis' ? 'analysis' : 'note';
  var picks = nkind === 'analysis' ? linkChoices(mk) : [];
  var linkRow = picks.length ? '<p class="lab" style="margin-top:14px">Link earlier fights</p><div class="chips">' + picks.map(function (m) {
    var d = C.localDay(C.ms(m.at), tz());
    return '<span class="lk' + ((ui.d.nlinks || {})[m.id] ? ' on' : '') + '" data-a="nlink:' + m.id + '">' + dayName(d) + ' ' + (+d.slice(8)) + ' ' + MON[+d.slice(5, 7) - 1] + '</span>';
  }).join('') + '</div>' : '';
  var sh = '';
  if (ui.sheet && ui.sheet.type === 'fightedit' && fightEditable(mk)) {
    sh = sheet('t3', '<div class="bsh"><h3>Edit</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Intensity</p><div class="arrows">' + intensityArrows(ui.d.int || 3) + '</div><div class="ends"><span>Low</span><span>High</span></div>' +
      hitFields(ui.d, St.myMember().hits_self) + whenRow('ew') + textFields(ui.d) + '<div class="acts"><div class="save" data-a="fighteditsave">Save</div></div>');
  } else if (ui.sheet && ui.sheet.type === 'notedit' && S.rows.fight_notes[ui.sheet.id] && !S.rows.fight_notes[ui.sheet.id].deleted_at) {
    sh = sheet('t3', '<div class="bsh"><h3>Edit note</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div>' + micTa('nedit', 'nt') + '<div class="acts"><div class="save" data-a="noteditsave">Save</div></div>');
  } else if (ui.sheet && ui.sheet.type === 'notedel' && S.rows.fight_notes[ui.sheet.id] && !S.rows.fight_notes[ui.sheet.id].deleted_at) {
    sh = sheet('t3 nf dq', '<div class="bsh"><h3>Delete note?</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><div class="acts"><div class="save" data-a="notedelok">Delete</div><div class="tdrop" data-a="sheet:close">Cancel</div></div>');
  } else if (ui.sheet && ui.sheet.type === 'fightdel' && me && !mk.delete_requested_at) {
    sh = sheet('t3 nf dq', '<div class="bsh"><h3>Delete?</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="ask">Ask ' + pn() + '</p><div class="acts"><div class="save" data-a="fightdelreq">Ask</div><div class="tdrop" data-a="sheet:close">Cancel</div></div>');
  }
  var pending = mk.delete_requested_at && !me ? '<div class="pair"><span class="save" data-a="fightdelok:' + mk.id + '">Approve</span><span class="ghost" data-a="fightdeldecl:' + mk.id + '">Decline</span></div>' : '';
  var del = me && !mk.delete_requested_at ? '<div class="ghost" data-a="fightdelq">Delete</div>' : '';
  var edit = fightEditable(mk) ? '<span class="fight" data-a="fightedit">Edit</span>' : '';
  return phone('p2 fd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Fight</h2><p class="dl">' + noteStamp(C.ms(mk.at)) + '</p></div>' + edit + '</header>' +
    intensityPicker(myRating(mk), 'fightint') +
    (chips ? '<section class="meta2"><div class="rcs">' + chips + '</div></section>' : '') +
    story + gapHtml + qHtml + notesHtml +
    '<section><p class="lab">' + (!me && !mine ? 'Add your version' : 'Add more') + (nkind === 'note' ? talkLink('more') : '') + '</p>' + seg([['note', 'Note'], ['analysis', 'Analysis']], nkind, 'fnkind', 'ty') + micTa('more', 'nt') + linkRow + whenRow('mw', noteDef(mk, nkind)) + '</section>' +
    // Save shows only once the note box has text: pinned to the screen bottom, it covered the summary while Oliver read it
    // (2026-11-03), and with no text it only went back. The input handler toggles `hidden` as he types (a re-render would drop the keyboard).
    '<div class="save" data-a="notesave"' + (val('more').trim() ? '' : ' hidden') + '>Save</div>' + pending + del, { sheet: sh });
};

// ---- Fights tab ---------------------------------------------------------------------------------------------
// One dot per day that had fights, at the day's total intensity (each fight counts as my rating, else my partner's, else 1,
// shown as Unrated), and a thick line for the 7-day average. Dragging 3+ days zooms in and filters the list to that range;
// a shorter drag or a tap shows that day's tooltip. The chart never says whose rating a number is.
var FW = 342, FCL = 26, FCR = 8, FT1 = 28, FPH = 124, FH = 186; // viewBox width, left/right margin, top, plot height, total height
function fightDomain(totals) {
  var first = Object.keys(totals).sort()[0], end = today(), start = first && first < C.addDays(end, -13) ? first : C.addDays(end, -13), out = [];
  for (var d = start; d <= end; d = C.addDays(d, 1)) out.push(d);
  return out;
}
// The days the chart is showing: the zoomed range, else the whole domain.
function fightView(totals) {
  var all = fightDomain(totals);
  return ui.fz ? all.filter(function (d) { return d >= ui.fz.a && d <= ui.fz.b; }) : all;
}
function fightLabel(d) { return MON[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8)); }
// The SVG for `days` (oldest first), with the drag selection {a, b} (indexes into days) or the tapped day's tooltip drawn on top.
function fightChartSvg(totals, days, drag, pick) {
  var n = days.length, pw = FW - FCL - FCR, cw = pw / n, o = '', mx = 0, i, v;
  var CX = function (k) { return FCL + (k + 0.5) * cw; };
  var sum = function (d) { return totals[d] ? totals[d].sum : 0; };
  days.forEach(function (d) { mx = Math.max(mx, sum(d), C.rollingAvg(totals, d)); });
  var ax = C.niceAxis(mx), Y = function (x) { return FT1 + (ax.top - x) / ax.top * FPH; };
  days.forEach(function (d, k) { if (C.dow(d) === 0) o += '<line class="wk" x1="' + CX(k) + '" x2="' + CX(k) + '" y1="' + (FT1 - 4) + '" y2="' + Y(0) + '"/>'; });
  for (v = 0; v <= ax.top; v += ax.step) o += '<line class="' + ((v / ax.step) % 2 ? 'gd' : 'gl') + '" x1="' + FCL + '" x2="' + (FW - FCR) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="ax" x="' + (FCL - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '</text>';
  var pts = []; days.forEach(function (d, k) { if (sum(d) > 0) pts.push(k); });
  // A thin dashed line joins the days that have fights; days without get no mark, so the baseline stays clean.
  pts.slice(1).forEach(function (k2, j) { var k1 = pts[j]; o += '<line class="ln" x1="' + CX(k1) + '" y1="' + Y(sum(days[k1])) + '" x2="' + CX(k2) + '" y2="' + Y(sum(days[k2])) + '" stroke-dasharray="2 3" opacity=".6"/>'; });
  var r = Math.max(2, Math.min(4.6, cw * 0.42));
  pts.forEach(function (k) { o += '<circle class="dot c" cx="' + CX(k) + '" cy="' + Y(sum(days[k])) + '" r="' + r + '"/>'; });
  o += '<path class="avg" d="' + days.map(function (d, k) { return (k ? 'L' : 'M') + CX(k) + ' ' + Y(C.rollingAvg(totals, d)); }).join('') + '"/>';
  var step = n <= 10 ? 2 : n <= 16 ? 3 : n <= 35 ? 7 : 14;
  for (i = 0; i < n; i += step) o += '<text class="ax" x="' + CX(i) + '" y="' + (Y(0) + 26) + '" text-anchor="' + (i === 0 ? 'start' : 'middle') + '" dx="' + (i === 0 ? -4 : 0) + '">' + fightLabel(days[i]) + '</text>';
  if (drag) {
    var lo = Math.min(drag.a, drag.b), hi = Math.max(drag.a, drag.b), t = fightLabel(days[lo]) + ' \u2192 ' + fightLabel(days[hi]) + ' \u00b7 ' + (hi - lo + 1) + 'd';
    var w = 16 + t.length * 6.3, x = Math.max(2, Math.min(FCL + (lo + hi + 1) / 2 * cw - w / 2, FW - w - 2));
    o += '<rect class="sel" x="' + (FCL + lo * cw) + '" y="' + FT1 + '" width="' + ((hi - lo + 1) * cw) + '" height="' + (Y(0) - FT1 + 2) + '"/><rect class="chip" x="' + x + '" y="2" width="' + w + '" height="22" rx="6"/><text class="chipt" x="' + (x + w / 2) + '" y="17" text-anchor="middle">' + t + '</text>';
  } else if (pick != null && days[pick]) {
    var td = totals[days[pick]], tx = fightLabel(days[pick]) + (td ? ' \u00b7 ' + td.n + (td.n > 1 ? ' fights' : ' fight') + ' \u00b7 Total ' + td.sum + (td.unrated ? (td.unrated === td.n ? ' \u00b7 Unrated' : ' \u00b7 ' + td.unrated + ' unrated') : '') : ' \u00b7 No fights');
    var w2 = 16 + tx.length * 6.3, x2 = Math.max(2, Math.min(FCL + (pick + 0.5) * cw - w2 / 2, FW - w2 - 2));
    o += '<rect class="tip" x="' + x2 + '" y="2" width="' + w2 + '" height="22" rx="6"/><text class="tipt" x="' + (x2 + w2 / 2) + '" y="17" text-anchor="middle">' + tx + '</text>';
  }
  return '<svg class="zoomchart" viewBox="0 0 ' + FW + ' ' + FH + '" role="img" aria-label="Daily fight intensity total and 7-day average">' + o + '</svg>';
}
function fightTotals() { return C.dailyTotals(L('fight_markers'), St.me(), L('fight_ratings'), tz()); }
// The partner's member row, or null while the couple has only one member.
function partnerMember() { return S.members.filter(function (x) { return x.user_id !== St.me(); })[0] || null; }
// Per-viewer action chips: to-dos and "Add your side" ask for action (.rc.a), "Waiting" is passive.
function fightActionChips(mk) {
  var p = partnerMember();
  if (!p) return '';
  return C.fightActions({ me: St.me(), partner: p, marker: mk, notes: fightNotes(mk.id).filter(function (n) { return !n.deleted_at; }), todos: L('todos') }).map(function (a) {
    return a.kind === 'todo' ? '<span class="rc a" data-a="tview:' + a.id + '">' + esc(a.title) + '</span>'
      : a.kind === 'add' ? '<span class="rc a">Add your side</span>' : a.kind === 'details' ? '<span class="rc a">Add details</span>' : '<span class="rc">Waiting on ' + esc(a.name) + '</span>';
  }).join('');
}
// A fight's one-line gist: the shared summary, else the logger's own on-device text, else the first shared note.
function fightSummary(mk) {
  var rec = ownFight(mk), first = fightNotes(mk.id).filter(function (n) { return !n.deleted_at; })[0];
  return mk.summary || (rec && rec.about ? rec.about : first ? first.body : '');
}
function fightRow(mk) {
  var own = mk.logged_by === St.me(), rec = ownFight(mk), text = fightSummary(mk);
  var d = C.localDay(C.ms(mk.at), tz()), chips = fightActionChips(mk);
  return '<div class="rf" data-a="openfight:' + mk.id + '"><div class="meta"><span>' + (own ? 'You' : pnx(nameOf(mk.logged_by))) + ' &middot; ' + dayName(d) + ' ' + (+d.slice(8)) + ' ' + MON[+d.slice(5, 7) - 1] + ' &middot; ' + fmtTime(C.ms(mk.at)) + '</span>' + (rec ? ix(rec.intensity) : '') + ns('fight_markers', mk.id) + '</div>' +
    (text ? '<p class="sm">' + esc(text) + '</p>' : '') + (chips ? '<div class="rcs">' + chips + '</div>' : '') + '</div>';
}
SCREEN.fights = function () {
  var all = L('fight_markers').slice().sort(function (a, b) { return C.ms(b.at) - C.ms(a.at); }), totals = fightTotals(), days = fightView(totals);
  var shown = ui.fz ? all.filter(function (m) { var d = C.localDay(C.ms(m.at), tz()); return d >= ui.fz.a && d <= ui.fz.b; }) : all;
  var pick = ui.fpick ? days.indexOf(ui.fpick) : -1;
  return phone('p2 fl', '<header class="hd"><div><h2>Fights</h2><p class="dl">' + all.length + '</p></div><span class="plus" data-a="go:fight" role="button" aria-label="Log fight">' + ic('plus') + '</span></header>' +
    '<div class="zrow"' + (ui.fz ? '' : ' style="display:none"') + '>' + (ui.fz ? '<span class="zc" data-a="fzreset">' + fightLabel(ui.fz.a) + ' &ndash; ' + fightLabel(ui.fz.b) + ' &#x2715;</span>' : '') + '</div>' +
    '<section class="cv fcv">' + fightChartSvg(totals, days, null, pick < 0 ? null : pick) + '</section>' +
    '<div class="leg"><span><i class="f1"></i>Daily total</span><span><i class="av"></i>7-day avg</span></div>' +
    (shown.length ? '<section><div class="list">' + shown.map(fightRow).join('') + '</div></section>' : '<p class="empty">None</p>'));
};
// Drag on the chart: the selection redraws only the SVG (a full render would drop the pointer capture); letting go commits it.
(function () {
  var drag = null;
  function idx(e, host, n) {
    var r = host.querySelector('svg').getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * FW;
    return Math.max(0, Math.min(n - 1, Math.floor((vx - FCL) / (FW - FCL - FCR) * n)));
  }
  function ctx(e) { var host = e.target.closest && e.target.closest('.fcv'); if (!host || !host.querySelector('svg')) return null; var t = fightTotals(), days = fightView(t); return { host: host, t: t, days: days, n: days.length }; }
  // pointerdown only records where the touch started. Replacing the SVG under the finger at pointerdown (the old code) stopped
  // iOS from scrolling the page on a vertical swipe that began on the chart (real iPhone, 2026-11-03). The chart redraws only
  // once the move is clearly sideways; a mostly-vertical first move hands the gesture to the page scroll (touch-action:pan-y).
  app.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var c = ctx(e); if (!c) return;
    var i = idx(e, c.host, c.n); drag = { a: i, b: i, moved: false, live: false, x: e.clientX, y: e.clientY };
  });
  app.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var c = ctx(e); if (!c) return;
    if (!drag.live) {
      // 8px: below that a finger is still a tap (guessed, matches the usual touch slop).
      var dx = Math.abs(e.clientX - drag.x), dy = Math.abs(e.clientY - drag.y);
      if (dx < 8 && dy < 8) return;
      if (dy > dx) { drag = null; return; }
      drag.live = true; ui.fpick = null; c.host.setPointerCapture(e.pointerId);
    }
    var i = idx(e, c.host, c.n); if (i === drag.b) return;
    if (i !== drag.a) drag.moved = true; drag.b = i;
    c.host.innerHTML = fightChartSvg(c.t, c.days, drag, null);
  });
  app.addEventListener('pointerup', function (e) {
    if (!drag) return;
    var c = ctx(e), d = drag; drag = null; if (!c) return;
    if (!d.live) { ui.fpick = c.days[idx(e, c.host, c.n)]; render(); return; } // never moved past the slop: a tap on a day
    var lo = Math.min(d.a, d.b), hi = Math.max(d.a, d.b);
    // 3+ days zooms; anything shorter is a tap on a day and shows its tooltip.
    if (d.moved && hi - lo >= 2) { ui.fz = { a: c.days[lo], b: c.days[hi] }; ui.fpick = null; }
    else ui.fpick = c.days[idx(e, c.host, c.n)];
    render();
  });
  app.addEventListener('pointercancel', function () { if (drag) { drag = null; render(); } });
})();

// ---- Progress tab: points, the shop, challenges and the calm streak ------------------------------------------------
SCREEN.progress = function () {
  var led = ledger(), k = calm(), chs = led.challenges.filter(function (c) { return !c.archived; }), arch = led.challenges.filter(function (c) { return c.archived; });
  function fr(l, v) { return '<div class="frow"><span class="lab0">' + l + '</span><span>' + v + '</span></div>'; }
  return phone('p2 td s4 ur', '<header class="hd"><div><h2>Progress</h2></div></header>' +
    '<div class="sum" data-a="go:points"><div><p class="lab">Balance</p><p class="big">' + led.balance + '</p></div><div class="r"><p class="lab">This week</p><p class="big">' + sg(led.current.net) + '</p></div>' + ic('chevr', 'chv') + '</div>' +
    '<div class="srow" data-a="go:shop"><span>Shop</span>' + ic('chevr', 'sm') + '</div>' +
    section('Calm streak', fr('Now', k.streak + (k.streak === 1 ? ' day' : ' days')) + fr('Best', k.best + (k.best === 1 ? ' day' : ' days')) + fr('Last 28 days', k.last28 + ' calm'), 'ro2') +
    section('Challenges', chs.length ? '<div class="deck">' + chs.map(chCard).join('') + '</div>' : '<p class="empty">None</p>') +
    '<div class="srow" data-a="newch"><span>New challenge</span>' + ic('plus', 'sm') + '</div>' +
    (arch.length ? section('Archived', '<div class="deck">' + arch.map(chCard).join('') + '</div>') : ''));
};

// ---- More: what has no tab ---------------------------------------------------------------------------------------
SCREEN.more = function () {
  var truths = L('items').filter(function (i) { return i.kind === 'truth' && i.recipient_id === St.me() && i.status === 'delivered' && !i.deleted_at; }).sort(byDelivered).slice(0, 3);
  var tr = truths.length ? truths.map(function (i) {
    var hl = C.heldLabel(i);
    return '<div class="tru"><p>' + esc(i.body) + '</p><p class="hm">' + (hl ? '<svg><use href="#hg"/></svg>' + hl + ' &middot; ' : '') + pnx(nameOf(i.sender_id)) + ' &middot; ' + dayName(C.localDay(C.ms(i.delivered_at), tz())) + '</p></div>';
  }).join('') : '<p class="empty">None</p>';
  function row(label, a) { return '<div class="srow" data-a="' + a + '"><span>' + label + '</span>' + ic('chevr', 'sm') + '</div>'; }
  return phone('p2 s4 ur', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>More</h2></div></header>' +
    '<section><p class="lab">Truths</p>' + tr + '</section>' +
    row('Cycle', 'go:cycle') + row('Raise issue', 'go:issues') + row('Dropped', 'go:dropped') + row('Settings', 'go:settings') + (S.deadLetters.length ? row('Not sent', 'go:deadletters') : ''));
};

// Asks I dropped before they went out. Restore puts one back on hold, where it shows as "Still send?" again.
SCREEN.dropped = function () {
  var list = myItems().filter(function (i) { return i.status === 'dropped'; }).sort(function (a, b) { return C.ms(b.created_at) - C.ms(a.created_at); });
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Dropped</h2></div></header>' +
    (list.length ? '<div class="lst">' + list.map(function (i) {
      return '<div class="rem c"><div><p>' + esc(itemTitle(i)) + '</p><small>To ' + pn() + ' &middot; ' + fmtDay(C.localDay(C.ms(i.created_at), tz())) + '</small></div><div class="rt"><span class="lnk" data-a="restore:' + i.id + '">Restore</span></div></div>';
    }).join('') + '</div>' : '<p class="empty">None</p>'));
};

SCREEN.settings = function () {
  var hrs = [[0, 'None'], [60, '1h'], [120, '2h'], [720, '12h'], [1440, '24h']];
  function hold(kind) { return '<div class="hrw2"><span class="hl0">' + KIND[kind] + '</span>' + seg(hrs, C.holdMinutes(S.couple, kind), 'hold' + kind, 'h5') + '</div>'; }
  return phone('p2 s5 st', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Settings</h2></div></header>' +
    '<section class="grp"><p class="lab">Holds<span class="tag">Shared</span></p>' + hold('truth') + hold('ask') + '</section>' +
    (St.hasNative ? '<div class="srow" data-a="facelock"><span>Face ID</span><span class="val">' + (ui.lockOn ? 'On' : 'Off') + '</span></div>' : '') +
    '<div class="srow" data-a="export"><span>Export</span>' + ic('chevr', 'sm') + '</div>' +
    '<div class="srow" data-a="errlog"><span>Errors</span><span class="val">' + S.errLog.length + '</span></div>' +
    (ui.errOpen ? '<pre class="errlog" data-a="errcopy">' + (esc(St.errLogText()) || 'None') + '</pre>' : '') +
    '<span class="ghost out" data-a="signout">Sign out</span>');
};

// ---- points family --------------------------------------------------------------------------------
SCREEN.points = function () {
  var led = ledger(), days = {};
  Object.keys(led.weeks).forEach(function (w) { Object.keys(led.weeks[w].days).forEach(function (d) { days[d] = days[d] || []; days[d] = days[d].concat(led.weeks[w].days[d].lines); }); });
  led.spends.forEach(function (s) { var rw = S.rows.rewards[s.reward_id]; (days[s.day] = days[s.day] || []).push({ pts: s.pts, label: 'Redeemed', who: rw ? rw.name : '' }); });
  // Same-day lines arrive in member-iteration order, which differs per phone; sort so both
  // partners read an identical ledger.
  Object.keys(days).forEach(function (d) { days[d].sort(function (a, b) { return b.pts - a.pts || a.label.localeCompare(b.label) || String(a.who).localeCompare(String(b.who)); }); });
  var html = Object.keys(days).sort().reverse().map(function (d) {
    var net = days[d].reduce(function (a, l) { return a + l.pts; }, 0);
    return '<div class="day"><div class="dh"><p class="lab">' + fmtDay(d) + '</p><p class="s">' + sg(net) + '</p></div>' + days[d].map(function (l) {
      return '<div class="ln' + (l.pts < 0 ? ' ls' : '') + '"' + (l.fight ? ' data-a="openfight:' + l.fight + '"' : '') + '><span class="am">' + sg(l.pts) + '</span><p class="t">' + esc(l.label) + (l.who ? ' <span>&middot; ' + esc(l.who) + '</span>' : '') + '</p>' + (l.fight ? ic('chevr', 'chv') : '') + '</div>';
    }).join('') + '</div>';
  }).join('');
  return phone('pts', '<header class="hd"><div>' + ptsBack(backLabel()) + '<h2>Points</h2></div><span class="pillb" data-a="go:shop">Shop</span></header>' +
    '<div class="sum"><div><p class="lab">Balance</p><p class="big" id="balance">' + led.balance + '</p></div><div class="r"><p class="lab">This week</p><p class="big">' + sg(led.current.net) + '</p></div></div>' + '<div class="ledger">' + (html || '<p class="empty">None</p>') + '</div>');
};

// Mon-first weeks from the challenge's start week, at most the last five. A streak is one connected band: .s / .e round a run's ends within its row (so also at row wraps);
// a hit day is an empty dim cell; days before the start or after today are dots.
function challengeCal(c, today) {
  var byDay = {}; c.days.forEach(function (x) { byDay[x.d] = x; });
  var last = C.weekStart(today), first = C.addDays(last, -28), html = '<span></span>' + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function (w) { return '<span class="wk">' + w + '</span>'; }).join('');
  if (C.weekStart(c.start) > first) first = C.weekStart(c.start);
  for (var w = 0; w <= C.dayDiff(first, last) / 7; w++) {
    var ws = C.addDays(first, w * 7), run = [];
    for (var i = 0; i < 7; i++) run.push(byDay[C.addDays(ws, i)]);
    html += '<span class="wl">' + fmtShort(ws) + '</span>' + run.map(function (x, i) {
      var d = C.addDays(ws, i), t = d === today ? ' t' : '';
      if (!x) return '<span class="cx n' + t + '">&middot;</span>';
      if (!x.n) return '<span class="cx g k' + t + '"></span>';
      var s = i === 0 || !run[i - 1] || !run[i - 1].n, e = i === 6 || !run[i + 1] || !run[i + 1].n;
      return '<span class="cx b' + (s ? ' s' : '') + (e ? ' e' : '') + (x.bonus ? ' bn' : '') + t + '">' + x.n + '</span>';
    }).join('');
  }
  var m0 = MON[+first.split('-')[1] - 1], m1 = MON[+today.split('-')[1] - 1];
  return '<div><p class="lab">' + (m0 === m1 ? m0 : m0 + ' &ndash; ' + m1) + '</p><div class="ccal">' + html + '</div></div>';
}

SCREEN.newch = function () {
  var me = St.myMember(), pa = St.partner(), forId = val('chfor', pa.user_id), br = val('chbr', 'tap');
  function tile(m) { return '<div class="tile' + (forId === m.user_id ? ' on' : '') + '" data-a="chfor:' + m.user_id + '"><i>' + esc(m.name.charAt(0).toUpperCase()) + '</i>' + (m.user_id === me.user_id ? 'Me' : esc(m.name)) + '</div>'; }
  function row(k, l) { return '<div class="orow' + (br === k ? ' on' : '') + '" data-a="chbr:' + k + '"><span class="rd"></span><span class="t">' + l + '</span></div>'; }
  return phone('pts cdet', '<header class="hd"><div>' + ptsBack(backLabel()) + '<h2>New</h2></div></header>' +
    '<div><p class="lab">Name</p>' + inp('chname').replace('class="inp"', 'class="inp fill"') + '</div>' +
    '<div><p class="lab">For</p><div class="tiles">' + tile(pa) + tile(me) + '</div></div>' +
    '<div><p class="lab">Breaks on</p><div class="opt3">' + row('hit', 'Hit') + row('tap', 'Tap') + '</div></div>' +
    '<div class="pin"><div class="save' + (val('chname').trim() ? '' : ' dis') + '" id="chnew" data-a="chnew">Save</div></div>');
};

// A challenge's break row for today, live or (with live=true) only when live and mine. All rows incl. soft-deleted ones
// are read from S.rows so a deleted one can be revived in place: (challenge, day) is unique on the server.
function todayBreakRow(chId) {
  return Object.keys(S.rows.challenge_breaks).map(function (k) { return S.rows.challenge_breaks[k]; }).filter(function (b) { return b.challenge_id === chId && b.day === today(); })[0] || null;
}
function todayBreak(chId, mineOnly) {
  var b = todayBreakRow(chId);
  return b && !b.deleted_at && (!mineOnly || b.by === St.me()) ? b : null;
}
// A logged day in the goal challenge's list: date and the one-line summary, with whether the answers are in yet.
function logRowHtml(x) {
  var st = noteState(parseNote(x.note));
  return '<div class="rdrow" data-a="chlogview:' + esc(x.id) + '"><div class="mid"><p class="rdl1"><b>' + dayName(x.day) + ' ' + fmtShort(x.day) + '</b><span>' + esc(noteSummary(x.note)) + '</span></p>' +
    (st ? '<p class="s rdst' + (st === 'pend' ? ' pend' : '') + '">' + (st === 'in' ? 'Answers in' : 'Answers pending') + '</p>' : '') + '</div>' + ic('chevr', 'chv') + '</div>';
}
function logViewHead(row) {
  var m = parseNote(row.note), st = noteState(m), sum = m.structured ? noteSummary(row.note) : '';
  return '<div class="bsh"><div class="rdhd"><h3>' + dayName(row.day) + ' ' + fmtShort(row.day) + '</h3>' + (sum || st ? '<p class="rdmeta">' + (sum ? '<span>' + esc(sum) + '</span>' : '') + (st ? '<span class="rdst' + (st === 'pend' ? ' pend' : '') + '">' + (st === 'in' ? 'Answers in' : 'Answers pending') + '</span>' : '') + '</p>' : '') + '</div><span class="xb" data-a="sheet:close">&#x2715;</span></div>';
}
SCREEN.challenge = function () {
  var c = ledger().challenges.filter(function (x) { return x.id === ui.chId; })[0];
  if (!c) return bounce('progress');
  var tap = c.breaks_on === 'tap', goal = c.breaks_on === 'goal';
  var logRow = ui.sheet && ui.sheet.id ? S.rows.challenge_days[ui.sheet.id] : null;
  var sh = ui.sheet && ui.sheet.type === 'chlog' ? sheet('t3', '<div class="bsh"><h3>Log today</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Note</p>' + micField('chlognote', 'What did you do?') + '<div class="acts" style="margin-top:44px"><div class="save" data-a="chlogsave">Save</div></div>')
    : ui.sheet && ui.sheet.type === 'chlogview' && logRow ? sheet('t3 nlogview', logViewHead(logRow) + '<div class="rdbody" data-k="' + esc(logRow.id) + '">' + noteReader(logRow.note) + '</div><div class="acts"><div class="save" data-a="chlogedit:' + esc(logRow.id) + '">Edit</div></div>')
    : ui.sheet && ui.sheet.type === 'chlogedit' && logRow ? sheet('t3', '<div class="bsh"><h3>' + fmtShort(logRow.day) + '</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Note</p>' + micField('chlognote', 'What did you do?') + '<div class="acts" style="margin-top:44px"><div class="save" data-a="chlogeditsave">Save</div><div class="tdrop" data-a="chlogdelq">Delete</div></div>')
    : ui.sheet && ui.sheet.type === 'chlogdel' && logRow ? sheet('t3', '<div class="bsh"><h3>Delete ' + fmtShort(logRow.day) + '?</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><div class="acts" style="margin-top:44px"><div class="save" data-a="chlogdel">Delete</div><div class="tdrop" data-a="sheet:close">Cancel</div></div>')
    : ui.sheet && ui.sheet.type === 'broke' ? sheet('t3', '<div class="bsh"><h3>Broke it</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Note</p>' + inp('brnote', 'Optional').replace('class="inp"', 'class="inp fill"') + '<div class="acts" style="margin-top:44px"><div class="save" data-a="brsave">Save</div></div>')
    : ui.sheet && ui.sheet.type === 'chedit' ? sheet('', '<div class="bsh"><h3>Edit</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Name</p>' + inp('chname').replace('class="inp"', 'class="inp fill"') + '<div class="acts"><div class="save" data-a="chsave">Save</div><div class="tdrop" data-a="charch">' + (c.archived ? 'Unarchive' : 'Archive') + '</div></div>') : '';
  function stat(l, v) { return '<div><p class="lab">' + l + '</p><p class="big">' + v + '</p></div>'; }
  var rules = '<div class="rules"><p class="rule">+1, +2, +3&hellip; up to +10 a day, plus +10 every week and +100 every month!</p>' + (tap ? '' : '<p class="rule">A hit: &minus;10, then &minus;5 for each more that day. A .5 is half.</p>') + '</div>';
  var notes = L('challenge_days').filter(function (x) { return x.challenge_id === c.id && !x.deleted_at; }).sort(function (a, b) { return a.day < b.day ? 1 : -1; });
  function goalBody() { var open = c.opens <= today(); return '<p class="rule">' + esc(c.rule || '') + '</p>' + (c.accepted && open
    ? '<div class="four g">' + stat('Days', c.count + '/' + c.goal_days) + stat('Due', monDay(c.deadline)) + stat('Reward', sg(c.goal_earn)) + stat('Miss', sg(-c.goal_miss)) + '</div>' + challengeCal(c, today()) +
      (notes.length ? '<div class="rdlist">' + notes.map(logRowHtml).join('') + '</div>' : '') +
      (c.for_user === St.me() && c.status === 'active' && !c.logged_today ? '<div class="pin"><div class="save" data-a="chlog">Log today</div></div>' : '')
    : '<div class="four g">' + stat(open ? 'Days' : 'Starts', open ? '0/' + c.goal_days : monDay(c.opens)) + stat('Due', monDay(c.deadline)) + stat('Reward', sg(c.goal_earn)) + stat('Miss', sg(-c.goal_miss)) + '</div>' + (c.accepted ? '' : c.for_user === St.me() ? '<div class="save" data-a="chaccept">Accept</div>' : '<p class="lab">Waiting for ' + esc(nameOf(c.for_user)) + '</p>')); }
  // Ping: only on the partner's challenge, until it is done or failed (not started counts). Pinned with Broke it when both show.
  // Today's break, if I tapped it: the one a mis-tap can be taken back from.
  var myBreak = todayBreak(c.id, true);
  var pinged = pingedToday(c.id), canPing = c.for_user !== St.me() && c.status !== 'done' && c.status !== 'failed';
  var pingBtn = canPing ? '<div class="ghost' + (pinged ? ' dis' : '') + '"' + (pinged ? '' : ' data-a="chping:' + c.id + '"') + '>' + (pinged ? 'Pinged' : 'Ping') + '</div>' : '';
  var pinger = pingBtn ? '<div class="pin">' + pingBtn + '</div>' : '';
  var body = goal ? goalBody() + pinger : c.accepted
    ? '<div class="four">' + stat('Day', c.day) + stat('Tonight', sg(c.tonight)) + stat('Best', c.best) + stat('Earned', c.earned) + '</div>' + challengeCal(c, today()) + rules + (tap && !c.broken_today ? '<div class="pin"><div class="ghost" data-a="broke">Broke it</div>' + pingBtn + '</div>' : tap && myBreak ? '<div class="pin"><div class="ghost" data-a="brundo">Undo break</div>' + pingBtn + '</div>' : pinger)
    : rules + (c.for_user === St.me() ? '<div class="save" data-a="chaccept">Accept</div>' : '<p class="lab">Waiting for ' + esc(nameOf(c.for_user)) + '</p>') + pinger;
  return phone('pts cdet', '<header class="hd"><div>' + ptsBack(backLabel()) + '<h2>' + esc(c.name) + '</h2></div><span class="pillb" data-a="chedit">Edit</span></header>' + body, { sheet: sh });
};

SCREEN.shop = function () {
  var led = ledger(), pend = L('redemptions').filter(function (r) { return r.status === 'pending'; });
  var items = L('rewards').filter(function (r) { return !r.archived; }).sort(function (a, b) { return a.price - b.price; }).map(function (r) {
    var isP = pend.some(function (p) { return p.reward_id === r.id; });
    return '<div class="it' + (r.price > led.balance ? ' no' : '') + (ui.shopEdit ? ' ed' : '') + '" data-a="reward:' + r.id + '"><span class="rthumb">' + artSvg(r.art, 'row') + '</span><span class="nm">' + esc(r.name) + '</span><span class="pr">' + (isP ? 'Pending' : r.price) + '</span></div>';
  }).join('');
  var sh = '', rr = ui.sheet && S.rows.rewards[ui.sheet.id];
  if (ui.sheet && ui.sheet.type === 'redeem' && rr && !rr.archived) {
    var r = rr;
    sh = sheet('', '<div class="bsh"><h3>' + esc(r.name) + '</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div>' + '<div class="rart">' + artSvg(r.art, 'big') + '</div>' + '<p class="ask">Spend ' + r.price + '?</p><p class="to">' + led.balance + ' &rarr; ' + (led.balance - r.price) + '</p><div class="acts"><div class="save" data-a="redeem:' + r.id + '">Ask ' + pn() + '</div><div class="tdrop" data-a="sheet:close">Cancel</div></div>');
  } else if (ui.sheet && ui.sheet.type === 'editreward' && rr && !rr.archived) {
    sh = sheet('', '<div class="bsh"><h3>Edit</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div>' + '<p class="lab">Reward</p>' + inp('rname').replace('class="inp"', 'class="inp fill"') + '<div class="frow"><span class="lab0">Price</span><input class="inp" type="number" inputmode="numeric" min="0" data-d="rprice" value="' + esc(val('rprice')) + '"></div><div class="acts"><div class="save" data-a="savereward">Save</div><div class="tdrop" data-a="rewardarch:' + rr.id + '">Archive</div></div>');
  } else if (ui.sheet && ui.sheet.type === 'redcancel' && S.rows.redemptions[ui.sheet.id] && S.rows.redemptions[ui.sheet.id].status === 'pending') {
    var cr = S.rows.rewards[S.rows.redemptions[ui.sheet.id].reward_id];
    sh = sheet('t3', '<div class="bsh"><h3>' + esc(cr ? cr.name : '') + '</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="ask">Cancel the ask?</p><div class="acts" style="margin-top:44px"><div class="save" data-a="redcancel:' + ui.sheet.id + '">Cancel ask</div><div class="tdrop" data-a="sheet:close">Keep</div></div>');
  } else if (ui.sheet && ui.sheet.type === 'addreward') {
    sh = sheet('', '<div class="bsh"><h3>Add</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div>' + '<p class="lab">Reward</p>' + inp('rname').replace('class="inp"', 'class="inp fill"') + '<div class="frow"><span class="lab0">Price</span><input class="inp" type="number" inputmode="numeric" min="0" data-d="rprice" value="' + esc(val('rprice')) + '"></div><div class="save" data-a="savereward">Save</div>');
  }
  return phone('pts', '<header class="hd"><div>' + ptsBack(backLabel()) + '<h2>Shop</h2></div><span class="bal" style="transform:translateY(-8px)">' + led.balance + '</span></header><div class="shop">' + items + '<div class="it add" data-a="addreward"><span class="nm">Add</span></div><div class="it add" data-a="shopedit"><span class="nm">' + (ui.shopEdit ? 'Done' : 'Edit') + '</span></div></div>', { sheet: sh });
};

SCREEN.week = function () {
  var led = ledger(), w = led.current, g = C.groupWeek(w);
  function lines(a) { return a.map(function (x) { return '<div class="cl"><span class="am">' + sg(x.pts) + '</span><span class="t">' + esc(x.label) + '</span></div>'; }).join(''); }
  return phone('pts wc k4', '<header class="hd"><div><h2>Week</h2><p class="dl">' + fmtDay(today()) + '</p></div><span class="gear" data-a="weekdone">&#x2715;</span></header>' +
    '<div class="card in"><p class="q">Week &middot; ' + sg(w.net) + '</p>' + (g.earned.length ? '<div class="grp"><p class="lab">Earned</p>' + lines(g.earned) + '</div>' : '') + (g.lost.length ? '<div class="grp"><p class="lab">Lost</p>' + lines(g.lost) + '</div>' : '') +
    '<div class="nb"><p class="lab">Balance</p><b>' + led.balance + '</b></div></div><div class="pair"><span class="save" data-a="weekshop">Shop</span><span class="ghost" data-a="weekdone">Done</span></div>', { tab: false });
};

// ---- Nudges ---------------------------------------------------------------------------------------------------
// Two tiers share one code path. 'esme' = the synced tables (author-only library, one send row per
// delivery, replies on a send). 'me' = the same row shapes held in S.priv, which never reaches Supabase:
// a Me send has recipient = me and no replies. Every helper takes the tier so no screen forks on it.
var TIP_TEXT = 'After 8 pm, it goes out tomorrow at 8 am.';
function live(n) { return !n.deleted_at && !n.archived_at; }
function isQueued(s) { return !s.deleted_at && C.ms(s.deliver_at) > now(); }
function nudgeTier(tier) {
  if (tier === 'me') return { nudges: S.priv.nudges, sends: S.priv.nudge_sends.filter(function (s) { return !s.deleted_at; }) };
  return { nudges: L('nudges').filter(function (n) { return n.author_id === St.me(); }), sends: L('nudge_sends').filter(function (s) { return s.sender_id === St.me() && !s.deleted_at; }) };
}
function nudgeRow(tier, id) { return tier === 'me' ? S.priv.nudges.filter(function (x) { return x.id === id; })[0] : S.rows.nudges[id]; }
function nPatch(tier, id, f) {
  if (tier === 'me') { Object.assign(nudgeRow('me', id), f, { updated_at: nowIso() }); St.savePriv(); } else St.patch('nudges', id, f);
}
function findSend(id) { return S.rows.nudge_sends[id] || S.priv.nudge_sends.filter(function (s) { return s.id === id; })[0]; }
function myTz() { return St.myMember().tz || S.couple.tz; }
// The recipient's clock decides what "8 am" means, so a partner in another zone still gets it at 8 am their time.
function recipientTz(tier) { var p = tier === 'me' ? null : St.partner(); return (p && p.tz) || myTz(); }
// True when sending right now would be deferred to tomorrow morning (the 8 pm rule).
function isLate(tier) { var n = now(); return C.deliverAt(n, myTz(), recipientTz(tier)) > n; }
// Writes the send row for a nudge. The body is a snapshot so a later library edit never rewrites what was sent.
// performance.now(), not Date: immune to a frozen/adjusted clock.
var SEND_LOCK_MS = 1000, sendAt = -SEND_LOCK_MS;
function sendLocked() { return performance.now() - sendAt < SEND_LOCK_MS; }
// Stamped only when a send really goes out, so opening the "Already sent" sheet never blocks tapping its confirm.
function lockSend() { sendAt = performance.now(); }
// Library card Send. The animation reads the button's rect, so it must start BEFORE the store write: St.insert re-renders
// synchronously, detaching the button, and a detached node's rect is 0,0 (the arrow was drawn in the top-left corner).
function sendNudge() {
  lockSend();
  var el = document.querySelector('.card .btn.f') || document.querySelector('.card .btn.o');
  M.play('send', el);
  doSend(ui.ntier, nudgeRow(ui.ntier, ui.nid)); ui.tip = false; render();
}
function doSend(tier, nudge) {
  var n = now(), at = C.deliverAt(n, myTz(), recipientTz(tier));
  var row = { id: St.uuid(), nudge_id: nudge.id, sender_id: St.me(), recipient_id: tier === 'me' ? St.me() : St.partner().user_id, body: nudge.body,
    deliver_at: new Date(at).toISOString(), opened_at: null, created_at: nowIso(), updated_at: nowIso(), deleted_at: null };
  if (tier === 'me') { S.priv.nudge_sends.push(row); St.savePriv(); St.reschedule(); }
  else { row.couple_id = S.couple.id; St.insert('nudge_sends', row); }
  return row;
}
function ago(ms) {
  var d = C.dayDiff(C.localDay(ms, tz()), today());
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
}
// withDeleted: the thread keeps a "Deleted" marker for a reply its author removed; counts and unread checks never see one.
function repliesFor(sendIds, withDeleted) {
  return L('nudge_replies').filter(function (r) { return sendIds[r.send_id] && (withDeleted || !r.deleted_at); }).sort(function (a, b) { return C.ms(a.created_at) - C.ms(b.created_at); });
}
function idSet(sends) { var o = {}; sends.forEach(function (s) { o[s.id] = true; }); return o; }
// Everything that was sent from one nudge, as the current user sees it: the sender's own sends, or for the
// recipient only the delivered ones (the server hides the rest anyway).
function sendsOfNudge(nudgeId) {
  return L('nudge_sends').filter(function (s) { return s.nudge_id === nudgeId && !s.deleted_at && (s.sender_id === St.me() || C.ms(s.deliver_at) <= now()); });
}
function markRead(sendIds) {
  repliesFor(sendIds).filter(function (r) { return r.author_id !== St.me() && !r.read_at; }).forEach(function (r) { St.patch('nudge_replies', r.id, { read_at: nowIso() }); });
}
// The award behind a done nudge (one per nudge: Done is offered once, and a done nudge leaves the library).
function awardOf(nudgeId) { return L('nudge_awards').filter(function (a) { return a.nudge_id === nudgeId && !a.deleted_at; })[0]; }
function fmtShort(day) { var p = day.split('-'); return (+p[2]) + ' ' + MON[+p[1] - 1]; }
// "10 of 30 paid . next 26 Nov" while paying out, "30 paid . 3 Sep" when complete, "10 of 30 paid . stopped" when cut.
function paidText(a) {
  var st = C.awardStatus(a, today(), tz());
  return (st.complete ? st.total + ' paid' : st.paid + ' of ' + st.total + ' paid') + (st.stopped ? ' \u00b7 stopped' : st.complete ? ' \u00b7 ' + fmtShort(st.last) : ' \u00b7 next ' + fmtShort(st.next));
}
// Row meta: sent/added/queued · reply count with a pink dot while any reply is unread.
function nudgeMeta(tier, n) {
  if (n.done_at) return paidText(awardOf(n.id));
  var ss = nudgeTier(tier).sends.filter(function (s) { return s.nudge_id === n.id; });
  var last = ss.filter(function (s) { return !isQueued(s); }).sort(function (a, b) { return C.ms(b.created_at) - C.ms(a.created_at); })[0];
  var what = ss.some(isQueued) ? 'queued' : last ? 'sent ' + ago(C.ms(last.created_at)) : 'added ' + ago(C.ms(n.created_at));
  var html = esc(what);
  if (tier === 'me') return html;
  var reps = repliesFor(idSet(ss));
  if (!reps.length) return html;
  var unread = reps.some(function (r) { return r.author_id !== St.me() && !r.read_at; });
  return html + ' · <span class="rcn">' + reps.length + (reps.length === 1 ? ' reply' : ' replies') + (unread ? '<i class="dotn"></i>' : '') + '</span>';
}

// The Reminders segment of the To-dos tab: saved library, what I sent, what I received, and archived ones.
var REM_VIEWS = [['lib', 'Saved'], ['sent', 'Sent'], ['recv', 'Received'], ['arch', 'Archived']];
function remBody() {
  var v = ui.remView, tabs = seg(REM_VIEWS, v, 'remview', 'h4');
  if (v === 'sent') {
    var sent = nudgeTier('esme').sends.map(function (s) { return { s: s, tier: 'esme' }; }).concat(nudgeTier('me').sends.map(function (s) { return { s: s, tier: 'me' }; }))
      .sort(function (a, b) { return C.ms(b.s.deliver_at) - C.ms(a.s.deliver_at); });
    return tabs + (sent.length ? '<div class="lst">' + sent.map(function (e) {
      var s = e.s, q = isQueued(s), reps = e.tier === 'esme' ? repliesFor(idSet([s])).length : 0;
      var meta = (e.tier === 'me' ? 'Me' : 'To ' + pn()) + ' &middot; ' + (q ? 'Queued ' : '') + fmtWhen(C.ms(s.deliver_at)) + (!q && s.opened_at ? ' &middot; Read' : '') + (reps ? ' &middot; ' + reps + (reps === 1 ? ' reply' : ' replies') : '');
      return '<div class="rem c' + (q ? ' t' : '') + '"' + (!q && nudgeRow(e.tier, s.nudge_id) ? ' data-a="sentopen:' + e.tier + ':' + s.nudge_id + '"' : '') + '><div><p>' + esc(s.body) + '</p><small>' + meta + '</small></div>' +
        (q ? '<div class="rt"><span class="lnk" data-a="sendcancel:' + e.tier + ':' + s.id + '">Cancel</span></div>' : '') + '</div>';
    }).join('') + '</div>' : '<p class="empty">None</p>');
  }
  if (v === 'recv') {
    var got = L('nudge_sends').filter(function (s) { return s.recipient_id === St.me() && s.sender_id !== St.me() && !s.deleted_at && C.ms(s.deliver_at) <= now(); })
      .sort(function (a, b) { return C.ms(b.deliver_at) - C.ms(a.deliver_at); });
    return tabs + (got.length ? '<div class="lst">' + got.map(function (s) {
      return '<div class="rem c" data-a="nudgein:' + s.id + '"><div><p>' + esc(s.body) + '</p><small>From ' + pnx(nameOf(s.sender_id)) + ' &middot; ' + fmtWhen(C.ms(s.deliver_at)) + (s.opened_at ? '' : ' &middot; New') + '</small></div></div>';
    }).join('') + '</div>' : '<p class="empty">None</p>');
  }
  if (v === 'arch') {
    var arch = [];
    ['esme', 'me'].forEach(function (t) { nudgeTier(t).nudges.filter(function (n) { return !n.deleted_at && n.archived_at; }).forEach(function (n) { arch.push({ n: n, tier: t }); }); });
    arch.sort(function (a, b) { return C.ms(b.n.archived_at) - C.ms(a.n.archived_at); });
    return tabs + (arch.length ? '<div class="lst">' + arch.map(function (e) {
      return '<div class="rem c"><div><p>' + esc(e.n.body) + '</p><small>' + (e.tier === 'me' ? 'Me' : pn()) + ' &middot; ' + ago(C.ms(e.n.archived_at)) + '</small></div><div class="rt"><span class="lnk" data-a="nudgerestore:' + e.tier + ':' + e.n.id + '">Restore</span></div></div>';
    }).join('') + '</div>' : '<p class="empty">None</p>');
  }
  var tier = ui.ntier, T = nudgeTier(tier), sec = C.sectionNudges(T.nudges, T.sends);
  function row(n, grip) {
    var q = T.sends.some(function (s) { return s.nudge_id === n.id && isQueued(s); });
    var right = (q ? '<span class="tmr">' + ic('moon', 'moon') + 'Tmrw</span>' : '') + (grip ? '<svg class="ic gr" data-a="noop" data-grip="1"><use href="#grip"/></svg>' : '');
    return '<div class="rem c' + (q ? ' t' : '') + '" data-nid="' + n.id + '" data-a="nudge:' + n.id + '"><div><p>' + esc(n.body) + '</p><small>' + nudgeMeta(tier, n) + '</small></div>' + (right ? '<div class="rt">' + right + '</div>' : '') + '</div>';
  }
  function group(label, list, key, grip) {
    return list.length ? '<div class="lst" data-sec="' + key + '"><p class="lab">' + label + '</p>' + list.map(function (n) { return row(n, grip); }).join('') + '</div>' : '';
  }
  var total = sec.pinned.length + sec.recent.length + sec.all.length + sec.done.length;
  return tabs + seg([['esme', pn()], ['me', 'Me']], tier, 'ntier') +
    (total ? group('Pinned', sec.pinned, 'pinned', true) + group('Recent', sec.recent, 'recent', false) + group('All', sec.all, 'all', true) + group('Done', sec.done, 'done', false) : '<p class="empty">None</p>');
}

function thread(sends) {
  // Replies grouped under the date their nudge went out; sends without replies are skipped.
  return sends.slice().sort(function (a, b) { return C.ms(a.deliver_at) - C.ms(b.deliver_at); }).map(function (s) {
    var reps = repliesFor(idSet([s]), true);
    if (!reps.length) return '';
    var p = C.localDay(C.ms(s.deliver_at), tz()).split('-');
    return '<p class="when">' + (+p[2]) + ' ' + MON[+p[1] - 1] + '</p>' + reps.map(function (r) {
      var mine = r.author_id === St.me();
      return '<div class="bub ' + (mine ? 'me' : 'her') + (r.deleted_at ? ' gone' : '') + '">' + (r.deleted_at ? 'Deleted' : esc(r.body)) + '<small>' + esc(mine ? 'You' : nameOf(r.author_id)) + ' · ' + fmtTime(C.ms(r.created_at)) + ns('nudge_replies', r.id).replace('<span', ' &middot; <span') + (mine && !r.deleted_at ? ' · <span class="lnk" data-a="repdel:' + r.id + '">Delete</span>' : '') + '</small></div>';
    }).join('');
  }).join('');
}
function replyBox() {
  return '<div class="cmp"><input class="in" data-d="reply" value="' + esc(val('reply')) + '" placeholder="Reply"><span class="go2" data-a="nreply">' + ic('up') + '</span></div>';
}
// Where a reply typed on the current screen goes: the opened send, or the latest delivered send of the open nudge.
function replyTarget() {
  if (ui.route === 'nudgein') return findSend(ui.sendId);
  return sendsOfNudge(ui.nid).filter(function (s) { return !isQueued(s); }).sort(function (a, b) { return C.ms(b.deliver_at) - C.ms(a.deliver_at); })[0];
}

// Library row opened: its actions (Send / Pin / Edit / Archive) above the reply thread and a reply box.
// Every live send of the open reminder, newest first: when it went out, and whether it is still queued or was opened.
function history(sends) {
  if (!sends.length) return '';
  return '<div><p class="lab">History</p><div class="lst dsch hist" style="gap:0">' + sends.slice().sort(function (a, b) { return C.ms(b.created_at) - C.ms(a.created_at); }).map(function (s) {
    var t = C.ms(s.created_at), st = isQueued(s) ? 'queued' : s.opened_at ? 'opened' : 'sent';
    return '<div class="rem c"><p>' + fmtShort(C.localDay(t, tz())) + ' \u00b7 ' + fmtTime(t) + '</p><p class="mu">' + st + '</p></div>';
  }).join('') + '</div></div>';
}
// The "Already sent" confirm guards a same-day double send only; a send from an earlier day goes straight out.
function sentToday(sends) { return sends.some(function (s) { return C.localDay(C.ms(s.created_at), tz()) === today(); }); }
SCREEN.nudge = function () {
  var tier = ui.ntier, n = nudgeRow(tier, ui.nid);
  if (!n) { ui.todoSeg = 'rem'; return bounce('todo'); }
  var sends = nudgeTier(tier).sends.filter(function (s) { return s.nudge_id === n.id; });
  var late = isLate(tier), shared = tier === 'esme', aw = n.done_at && awardOf(n.id);
  var thr = history(sends) + (shared ? '<div class="th">' + thread(sends) + '</div>' + (replyTarget() ? replyBox() : '') : '');
  var sh = ui.sheet && ui.sheet.type === 'resend' ? sheet('t3 nf dq', '<div class="bsh"><h3>Already sent</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="ask">Send again?</p><div class="acts"><div class="save" data-a="nudgeresend">Send again</div><div class="tdrop" data-a="sheet:close">Cancel</div></div>') : '';
  if (aw) {
    // Done card: Send again is a normal send (8 pm rule applies) and the nudge stays in Done.
    var st = C.awardStatus(aw, today(), tz());
    return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Reminders</h2><p class="dl">' + (sends.length ? 'Sent ' + sends.length + (sends.length === 1 ? ' time' : ' times') : 'Not sent') + '</p></div></header>' +
      '<div class="card dn"><p class="q2">' + esc(n.body) + '</p><p class="meta">Done ' + fmtShort(C.localDay(C.ms(n.done_at), tz())) + ' \u00b7 ' + (st.complete ? st.total + ' paid' : st.paid + ' of ' + st.total + ' paid') + '</p>' +
      (late && ui.tip ? '<div class="tip">' + TIP_TEXT + '</div>' : '') +
      '<div class="row3"><span class="btn o" data-a="nudgesend">Send again' + (late ? '<span class="qm" data-a="tip">?</span>' : '') + '</span>' +
      (st.complete || st.stopped ? '' : '<span class="btn g bd" data-a="nudgestop">Stop the rest</span>') + '</div></div>' + thr, { sheet: sh });
  }
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Reminders</h2><p class="dl">' + (sends.length ? 'Sent ' + sends.length + (sends.length === 1 ? ' time' : ' times') : 'Not sent') + '</p></div></header>' +
    '<div class="card"><p class="q2">' + esc(n.body) + '</p>' + (n.pinned ? '<p class="meta">pinned</p>' : '') +
    (late && ui.tip ? '<div class="tip">' + TIP_TEXT + '</div>' : '') +
    '<span class="btn f" data-a="nudgesend">' + (late ? 'Send tomorrow<span class="qm" data-a="tip">?</span>' : 'Send') + '</span>' +
    '<div class="row3"><span class="btn o" data-a="nudgepin">' + (n.pinned ? 'Unpin' : 'Pin') + '</span><span class="btn o" data-a="nudgeedit">Edit</span></div>' +
    // Points only exist between the two of us: a Me nudge can be archived but never marked done.
    (shared ? '<div class="row3"><span class="btn o" data-a="nudgedone">Done</span><span class="btn g bd" data-a="nudgearchive">Archive</span></div>' : '<span class="btn g" data-a="nudgearchive">Archive</span>') + '</div>' + thr, { sheet: sh });
};

// ---- Done, with points ------------------------------------------------------------------------------
var PTS = [10, 20, 30, 50];
// Chosen points: a chip, or the Other input (positive integer only; anything else is null and blocks Mark done).
function donePts() { return ui.dother ? (/^[1-9]\d*$/.test((ui.d.dotherv || '').trim()) ? +ui.d.dotherv.trim() : null) : ui.dpts; }
function doneSched() {
  var pts = donePts();
  if (pts === null) return '';
  return C.splitPayout(pts, ui.dpay, today()).map(function (x, i, a) {
    return '<div class="rem c"><p>' + (x.day === today() ? 'Now' : fmtShort(x.day)) + '</p><p class="' + (i === 0 ? 'pk' : 'mu') + '">+' + x.points + '</p></div>';
  }).join('');
}
function doneBtn() { var p = donePts(); return '<span class="btn f' + (p === null ? ' dis' : '') + '" data-a="donemark">Mark done' + (p === null ? '' : ' \u00b7 ' + p) + '</span>'; }
SCREEN.nudgedone = function () {
  var n = nudgeRow('esme', ui.nid);
  if (!n) { ui.todoSeg = 'rem'; return bounce('todo'); }
  return phone('p2 nd', '<header class="hd"><div><h2>Done</h2></div><span class="txtbtn" data-a="back">Cancel</span></header>' +
    '<div class="card"><p class="q2">' + esc(n.body) + '</p></div>' +
    '<div><p class="lab">Points</p><div class="pchips">' + PTS.map(function (v) { return '<span class="pch' + (!ui.dother && ui.dpts === v ? ' on' : '') + '" data-a="donepts:' + v + '">' + v + '</span>'; }).join('') +
    '<span class="pch' + (ui.dother ? ' on' : '') + '" data-a="donepts:other">+ Other</span></div>' +
    (ui.dother ? '<input class="inp" inputmode="numeric" data-d="dotherv" value="' + esc(val('dotherv')) + '" placeholder="Points">' : '') + '</div>' +
    '<div><p class="lab">Pay out</p>' + seg([['now', 'All now'], ['3mo', 'Over 3 months']], ui.dpay, 'donepay') + '</div>' +
    '<div class="lst dsch" style="gap:0">' + doneSched() + '</div><div style="flex:1"></div><div class="dbtn">' + doneBtn() + '</div>', { tab: false });
};
// Typing in Other must not re-render (it would drop focus), so refresh just the schedule and button.
function doneRefresh() {
  var a = document.querySelector('.dsch'), b = document.querySelector('.dbtn');
  if (a) a.innerHTML = doneSched();
  if (b) b.innerHTML = doneBtn();
}

// A delivered nudge as its recipient sees it: the nudge, replies so far on every send of it, a reply box.
SCREEN.nudgein = function () {
  var s = findSend(ui.sendId), priv = !S.rows.nudge_sends[ui.sendId];
  if (!s) return bounce('home');
  var name = priv ? '' : nameOf(s.sender_id);
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>' + (priv ? 'Reminder' : 'From ' + pnx(name)) + '</h2><p class="dl">' + fmtDay(C.localDay(C.ms(s.deliver_at), tz())) + '</p></div></header>' +
    '<div class="card"><p class="quote">' + esc(s.body) + '</p></div>' +
    (priv ? '' : '<div class="th">' + thread(sendsOfNudge(s.nudge_id)) + '</div>' + replyBox()));
};

// Add / edit. Edit keeps the nudge in its tier, so For is only offered when creating.
SCREEN.nudgenew = function () {
  var edit = ui.nedit ? nudgeRow(ui.nfor, ui.nedit) : null;
  if (ui.nedit && !edit) { ui.todoSeg = 'rem'; return bounce('todo'); }
  if (edit && ui.d.nbody == null) ui.d.nbody = edit.body;
  var late = isLate(ui.nfor);
  return phone('p2 nd', '<header class="hd"><div><h2>' + (edit ? 'Edit' : 'New') + '</h2><p class="dl">&nbsp;</p></div><span class="txtbtn" data-a="back">Cancel</span></header>' +
    micTa('nbody', 'msg') +
    (edit ? '' : '<section><p class="lab">For</p>' + seg([['esme', pn()], ['me', 'Me']], ui.nfor, 'nudgefor') + '</section>') +
    (late && ui.tip && !edit ? '<div class="tip">' + TIP_TEXT + '</div>' : '') +
    // A new reminder has only Send. A separate Save-to-library button sat beside it and got tapped by mistake
    // (2026-11-06: Oliver's reminder to Esme was saved, never sent, and she never saw it). Editing keeps Save,
    // since an edit only changes the library text and never sends.
    (edit ? '<div class="save" data-a="nudgesave">Save</div>' :
      '<div class="save" data-a="nudgenewsend">' + (late ? 'Send tomorrow<span class="qm" data-a="tip">?</span>' : 'Send') + '</div>'), { tab: false });
};

// ---- Raise issue ----------------------------------------------------------------------------------------------------
// An issue is an ask item (origin 'issue') held until 08:00 the next day and sent only when its sender confirms the
// "Still send?" card. Delivery turns it into an ownup (Apologize) or task (Change) to do for the partner, linked by item_id.
var ISSUE_TYPE = { apologize: 'Apologize', change: 'Change' };
function issueEntries() {
  var me = St.me();
  return L('items').filter(function (i) { return i.origin === 'issue' && !i.deleted_at && i.status !== 'dropped' && (i.sender_id === me || i.status === 'delivered'); })
    .map(function (i) {
      var t = L('todos').filter(function (x) { return x.item_id === i.id && !x.deleted_at; })[0];
      return { item: i, todo: t, mine: i.sender_id === me, open: i.status === 'held' || !!(t && !closed(t)) };
    });
}
SCREEN.issues = function () {
  var es = issueEntries();
  var held = es.filter(function (e) { return e.item.status === 'held'; }).sort(function (a, b) { return C.ms(a.item.held_until) - C.ms(b.item.held_until); });
  function sent(list, who) {
    list.sort(function (a, b) { return byDelivered(a.item, b.item); });
    return list.length ? list.map(function (e) {
      var d = C.localDay(C.ms(e.item.delivered_at), tz());
      return '<div class="td-row"' + (e.todo ? ' data-a="tview:' + e.todo.id + '"' : '') + '><span class="om"></span><div class="tx"><p>' + esc(e.item.body) + '</p><small>' + ISSUE_TYPE[e.item.response_type] + ' &middot; ' + who + ' &middot; ' + fmtDay(d) + ' &middot; ' + (e.todo && e.todo.declined_at ? declWord(e.todo) : e.todo && e.todo.done_at ? 'Done' : 'Open') + '</small></div></div>';
    }).join('') : '<p class="empty">None</p>';
  }
  var yours = es.filter(function (e) { return e.mine && e.item.status === 'delivered'; }), theirs = es.filter(function (e) { return !e.mine; });
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Raise issue</h2></div><span class="plus" data-a="issuenew">' + ic('plus') + '</span></header>' +
    section('Held', held.length ? held.map(function (e) {
      var i = e.item;
      return '<div class="td-row hrow2" data-a="still:' + i.id + '"><span class="om"><svg class="hold-ic"><use href="#hg"/></svg></span><p class="ht">' + esc(i.body) + '</p><p class="hm2">' + ISSUE_TYPE[i.response_type] + ' &middot; To ' + pn() + '</p><div class="hact"><span class="cd">' + C.countdown(C.ms(i.held_until), now()) + '</span></div></div>';
    }).join('') : '<p class="empty">None</p>', 'held') +
    section('Yours', sent(yours, 'To ' + pn()), 'ro2') + section('From ' + pnx(pName()), sent(theirs, 'From ' + pn()), 'ro2')); // the Still send? sheet is appended by render() (sheetFor)
};
SCREEN.issuenew = function () {
  return phone('p2 nd', '<header class="hd"><div><h2>Raise issue</h2><p class="dl">&nbsp;</p></div><span class="txtbtn" data-a="back">Cancel</span></header>' +
    micTa('ibody', 'msg', 'What happened') +
    '<section>' + seg([['apologize', 'Apologize'], ['change', 'Change']], ui.itype, 'itype') + '</section>' +
    '<div class="save" data-a="issuesave">Hold until tomorrow</div>', { tab: false });
};

// Creates (or, when editing, updates) the nudge from the form. Returns the row so Send can follow.
function saveNudge() {
  var body = (ui.d.nbody || '').trim();
  if (!body) { M.play('jiggle', document.querySelector('.ta')); throw new Error('Message needed'); }
  if (ui.nedit) { nPatch(ui.nfor, ui.nedit, { body: body }); return nudgeRow(ui.nfor, ui.nedit); }
  var T = nudgeTier(ui.nfor);
  var row = { id: St.uuid(), body: body, pinned: false, sort_order: T.nudges.reduce(function (m, n) { return Math.max(m, n.sort_order); }, -1) + 1,
    archived_at: null, created_at: nowIso(), updated_at: nowIso(), deleted_at: null };
  if (ui.nfor === 'me') { S.priv.nudges.push(row); St.savePriv(); }
  else { row.couple_id = S.couple.id; row.author_id = St.me(); St.insert('nudges', row); }
  return row;
}
// Opening a delivered nudge stamps opened_at (recipient only; the DB guard enforces it) and marks the
// other person's replies on that nudge read, which clears the sender's Needs-you card and the dot.
function openSend(id) {
  var s = findSend(id), priv = !S.rows.nudge_sends[id];
  if (s.recipient_id === St.me() && !s.opened_at) {
    if (priv) { s.opened_at = nowIso(); St.savePriv(); } else St.patch('nudge_sends', id, { opened_at: nowIso() });
  }
  if (!priv) markRead(idSet(sendsOfNudge(s.nudge_id)));
}

// ---- Cycle (private) screen -----------------------------------------------------------------------------
// Ring geometry and per-phase angles are measured from the approved mockup (degrees clockwise from top).
var SEG = { Fight: [4.3, 31.7], Cool: [40.3, 146.9], Warm: [155.5, 283.7], Delicate: [292.3, 355.7] };
function pt(r, a) { var t = a * Math.PI / 180; return [173 + r * Math.sin(t), 143 - r * Math.cos(t)]; }
function ring(ph) {
  var out = '';
  Object.keys(SEG).forEach(function (n) {
    var a = SEG[n], p0 = pt(96, a[0]), p1 = pt(96, a[1]), mid = (a[0] + a[1]) / 2, lp = pt(122, mid), on = ph && ph.name === n;
    out += '<path d="M' + p0[0].toFixed(1) + ' ' + p0[1].toFixed(1) + 'A96 96 0 0 1 ' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1) + '" fill="none" stroke="' + (on ? '#ff2e88' : '#3a3a3a') + '" stroke-width="20"/>' +
      '<text x="' + lp[0].toFixed(1) + '" y="' + lp[1].toFixed(1) + '" font-size="13" fill="' + (on ? '#ff2e88' : '#bdbdbd') + '"' + (lp[0] > 173 ? '' : ' text-anchor="end"') + ' dominant-baseline="middle" letter-spacing="1.3">' + n.toUpperCase() + '</text>';
  });
  var mk = '', mid = 'NONE', sub = '';
  if (ph) {
    var a = SEG[ph.name], since = ph.day - 1, f;
    f = ph.name === 'Fight' ? .5 : ph.name === 'Cool' ? (since - 1) / 2 + .25 : ph.name === 'Warm' ? (since - 3) / Math.max(1, ph.warmEnd - 3) : (since - ph.warmEnd) / Math.max(1, ph.len - ph.warmEnd);
    var m = pt(96, a[0] + (a[1] - a[0]) * Math.max(0, Math.min(1, f)));
    mk = '<circle cx="' + m[0].toFixed(1) + '" cy="' + m[1].toFixed(1) + '" r="15" fill="#fff" stroke="#0a0a0a" stroke-width="4"/>';
    mid = ph.name.toUpperCase(); sub = 'DAY ' + ph.day;
  }
  return '<svg class="chart" viewBox="2 14 342 248" width="342" height="248">' + out + mk + '<text class="ab" x="173" y="139" font-size="26" fill="#fff" text-anchor="middle">' + mid + '</text>' +
    '<text x="173" y="167" font-size="16" fill="#bdbdbd" text-anchor="middle" letter-spacing="1">' + sub + '</text></svg>';
}
function fightRecs() {
  return S.priv.fights.filter(function (f) { var mk = S.rows.fight_markers[f.id]; return mk && !mk.deleted_at; }).sort(function (a, b) { return b.at - a.at; });
}
// The logger's own words: the pre-sharing on-device text, else their first shared note.
function fightText(f) { var n = fightNotes(f.id).filter(function (x) { return x.author_id === St.me(); })[0]; return f.about || (n ? n.body : ''); }
function chipsFor(f) {
  var tds = L('todos').filter(function (t) { return t.fight_marker_id === f.id; }), out = '';
  var chk = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  tds.forEach(function (t) { out += '<span class="rc' + (t.done_at ? ' d' : '') + '">' + (t.done_at ? chk : '') + esc(t.title) + (t.declined_at ? ' &middot; ' + declWord(t) : '') + '</span>'; });
  var mk = S.rows.fight_markers[f.id], hit = mk && C.hitText(mk, 'me');
  if (hit) out += '<span class="rc">' + esc(hit) + '</span>';
  return out;
}
function ix(n) { var s = ''; for (var i = 1; i <= 5; i++) s += '<i' + (i <= n ? ' class="f"' : '') + '></i>'; return '<span class="ixw"><span class="ixl">Intensity</span><span class="ix">' + s + '</span></span>'; }
SCREEN.cycle = function () {
  var fights = fightRecs(), n = now(), t = today();
  var ph = C.phase(fights, n, tz(), 14);
  if (!ui.cyc) { var p = t.split('-'); ui.cyc = { y: +p[0], m: +p[1], sel: fights[0] ? C.localDay(fights[0].at, tz()) : null }; }
  var cy = ui.cyc, grid = C.monthGrid(cy.y, cy.m), byDay = {};
  fights.forEach(function (f) { var d = C.localDay(f.at, tz()); byDay[d] = Math.max(byDay[d] || 0, f.intensity); });
  var cells = '';
  for (var b = 0; b < grid.blanks; b++) cells += '<i></i>';
  grid.days.forEach(function (d) {
    var inten = byDay[d], h = inten ? 14 + 5 * inten : 0;
    cells += '<div class="d' + (inten ? ' f' : '') + (d === cy.sel ? ' sel' : '') + (d === t ? ' now' : '') + '" data-a="day:' + d + '"><span class="num">' + (+d.slice(8)) + '</span>' + (inten ? '<svg width="' + (h * 40 / 56).toFixed(1) + '" height="' + h + '" viewBox="0 0 40 56"><use href="#arw"/></svg>' : '') + '</div>';
  });
  // Every fight on the picked day, newest first (a day can hold several; showing one hid the rest).
  var det = fights.filter(function (f) { return C.localDay(f.at, tz()) === cy.sel; }).map(function (selF) {
    return '<section class="det" data-a="openfight:' + selF.id + '"><div class="meta"><span>' + dayName(cy.sel) + ' ' + (+cy.sel.slice(8)) + ' &middot; ' + fmtTime(selF.at) + '</span>' + ix(selF.intensity) + '</div><p>' + esc(fightText(selF)) + '</p><div class="rcs">' + chipsFor(selF) + '</div></section>';
  }).join('');
  var recent = fights.slice(0, 4).map(function (f) {
    var d = C.localDay(f.at, tz());
    return '<div class="rf" data-a="openfight:' + f.id + '"><div class="meta"><span>' + dayName(d) + ' ' + (+d.slice(8)) + ' &middot; ' + fmtTime(f.at) + '</span>' + ix(f.intensity) + '</div><p>' + esc(fightText(f)) + '</p><div class="rcs">' + chipsFor(f) + '</div></div>';
  }).join('');
  var last = fights[0];
  return phone('p2 cyc', '<header class="hd"><div>' + hdBack(backLabel()) + '<div class="hrow"><h2>Cycle</h2><span class="tag">Only you</span></div><p class="dl">' + fmtDay(t) + '</p></div></header>' +
    '<section class="ring">' + ring(ph) + '</section>' +
    '<section class="stats"><div><b>' + (ph && ph.avg != null ? ph.avg.toFixed(1) + ' d' : '—') + '</b><span>Avg cycle</span></div><div><b>' + (last ? dayName(C.localDay(last.at, tz())) + ' ' + fmtTime(last.at) : '—') + '</b><span>Last fight</span></div></section>' +
    '<section><div class="mon"><b>' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][cy.m - 1] + '</b><div class="nav"><span data-a="mon:-1">' + ic('chev') + '</span><span data-a="mon:1">' + ic('chevr') + '</span></div></div><div class="cal"><span class="wd">M</span><span class="wd">T</span><span class="wd">W</span><span class="wd">T</span><span class="wd">F</span><span class="wd">S</span><span class="wd">S</span>' + cells + '</div></section>' +
    det + (recent ? '<section><p class="lab h">Recent</p><div class="list">' + recent + '</div></section>' : '') + '<div class="endpad"></div>');
};

// ---- render ------------------------------------------------------------------------------------------------
function currentScreen() {
  if (!S.session) return 'auth';
  if (!S.couple || ui.code) return 'setup';
  return ui.route;
}
function sheetHtml() { return ''; }
var lastKey = '';
// Note boxes grow to fit their text instead of scrolling inside.
function fitNote(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
// ---- Drafts ------------------------------------------------------------------------------------------------------
// Navigating wipes ui.d in dozens of places (go, back, tab, sheet openers), so instead of guarding each one, typed text
// is copied here on every keystroke and render() restores it when its surface is next shown. Lives in S.priv: on-device,
// per-account, survives a kill, and never syncs to the partner, so half-written messages stay unseen until really sent.
// Only a successful save clears a draft (draftSent); closing with X keeps it, emptying the fields discards it.
// Auth and setup return null on purpose: a password must never be written to disk.
function draftKey() {
  var s = ui.sheet, name = currentScreen();
  if (name === 'auth' || name === 'setup') return null;
  if (ui.gripe) return 'gripe'; // the complaint sheet covers whatever screen is under it
  if (s) {
    if (s.type === 'newtodo') return 'todo:' + (s.edit || 'new');
    if (s.type === 'still') return s.edit ? 'still:' + s.id : null;
    if (s.type === 'note' || s.type === 'decline' || s.type === 'chlogedit' || s.type === 'chlogview') return s.type + ':' + s.id;
    if (s.type === 'chlog' || s.type === 'broke' || s.type === 'chedit') return s.type + ':' + ui.chId;
    if (s.type === 'editreward') return s.type + ':' + s.id;
    return s.type === 'addreward' ? 'addreward' : null; // the rest (pickers, confirms) have no text field
  }
  if (name === 'fight' || name === 'issuenew' || name === 'newch') return name;
  if (name === 'fightdetail') return name + ':' + ui.fightId;
  if (name === 'tododetail') return name + ':' + ui.todoId;
  if (name === 'nudge') return name + ':' + ui.nid;
  if (name === 'nudgein') return name + ':' + ui.sendId;
  if (name === 'nudgenew') return name + ':' + (ui.nedit || 'new');
  return null;
}
// Choices held outside ui.d. Without them a restored ask to the partner would come back as a note to self.
var DRAFT_UI = { 'nudgenew': ['nfor'], 'issuenew': ['itype'] };
function saveDraft(k) {
  if (!k) return;
  var all = S.priv.drafts, had = all[k];
  // Only strings count: a fight's default intensity or an untouched chip is not something typed.
  var has = Object.keys(ui.d).some(function (f) { return typeof ui.d[f] === 'string' && ui.d[f].trim(); });
  if (!has) { if (had) { delete all[k]; St.persist(); } return; }
  var name = currentScreen(), dr = { d: ui.d, ui: {} };
  (DRAFT_UI[name] || []).forEach(function (f) { dr.ui[f] = ui[f]; });
  if (ui.sheet && ui.sheet.type === 'newtodo') dr.sheet = ui.sheet;
  var json = JSON.stringify(dr);
  if (had && JSON.stringify(had) === json) return; // render() calls this often; a write per repaint would be wasted
  all[k] = JSON.parse(json); // a copy: ui.d keeps changing, and aliasing it would make the comparison above always equal
  St.persist(); // not savePriv: its emit() re-renders, and this runs inside render()
}
// A save worked: the draft is spent. Call after validation, while ui.route / ui.sheet still name the surface.
function draftSent(k) { k = k || draftKey(); if (k && S.priv.drafts[k]) { delete S.priv.drafts[k]; St.persist(); } }
// Runs at the top of render(). Same surface: keep an existing draft current (chips, steppers change without an input
// event). New surface: seed over whatever the opener put in ui.d, so an unsaved edit beats the row's stored text.
function syncDraft() {
  var k = draftKey();
  if (k === ui.dkey) { if (k && S.priv.drafts[k]) saveDraft(k); return; }
  ui.dkey = k;
  var dr = k && S.priv.drafts[k];
  if (!dr) return;
  dr = JSON.parse(JSON.stringify(dr));
  ui.d = Object.assign({}, ui.d, dr.d);
  Object.assign(ui, dr.ui);
  if (dr.sheet) {
    // Keep the kind just tapped: Habit on the picker must not reopen as the drafted Task.
    var kind = ui.sheet.kind;
    Object.assign(ui.sheet, dr.sheet);
    setTodoKind(ui.sheet, kind);
  }
}
function setTodoKind(s, v) { if (s.kind !== v) { s.kind = v; if (!s.pt) { s.pe = v === 'habit' ? 1 : 3; s.pm = v === 'habit' ? 0 : 3; } } }

function render() {
  if (!ui.ready) return;
  if (pendIgnore && ui.route !== 'todo' && ui.route !== 'home') commitIgnore(true); // left the screens that swipe: never lose it
  syncDraft();
  var sc = document.querySelector('.scr'), top = sc ? sc.scrollTop : 0, name = currentScreen(), key = name + (ui.sheet ? 's' : '');
  // A tapped control must not close the keyboard: hand focus to the field's twin after the swap (else .scr grows and clamps scrollTop).
  var fa = document.activeElement, fk = typing() && (fa.getAttribute('data-d') || fa.getAttribute('data-t')), fs = fk && fa.selectionStart, fe = fk && fa.selectionEnd;
  var html;
  try {
    if (ui.talk && (ui.talk.route !== ui.route || ui.talk.fid !== talkFid())) { var gone = ui.talk; ui.talk = null; guard(talkHalt)(gone); } // a push moved the app elsewhere: keep the words, leave Talk
    html = ui.talk ? talkScreen() : SCREEN[name]();
    // Sheets are rendered inside the owning screen (so they inherit its family CSS); screens that
    // host sheets read ui.sheet themselves. Everything else shows the sheet via the shared hook below.
    if (ui.notif && S.session) html = html.replace(/<\/div>$/, notifSheet() + '</div>');
    if (ui.gripe) html = html.replace(/<\/div>$/, gripeSheet() + '</div>');
    if (!ui.talk && ui.sheet && name !== 'todo' && name !== 'tododetail' && name !== 'shop' && name !== 'challenge') html = html.replace(/<\/div>$/, sheetFor() + '</div>');
  } catch (e) {
    // A screen that cannot draw (e.g. a row it expects is missing) must not blank the app or poison every later render.
    console.error('cycle screen failed:', name, e);
    html = errScreen(true);
  }
  var rb = document.querySelector('.rdbody'), rbk = rb && rb.getAttribute('data-k'), rbt = rb ? rb.scrollTop : 0;
  app.innerHTML = html;
  // The day reading sheet scrolls inside .rdbody; a sync or the 15s repaint must not throw the reader back to the top.
  var nrb = rbk && document.querySelector('.rdbody'); if (nrb && nrb.getAttribute('data-k') === rbk) nrb.scrollTop = rbt;
  // The mic only lives while its field is on screen; with the field gone there is nowhere to put the words, so the recording is dropped.
  if (ui.rec && ui.rec.field !== 'talk' && !app.querySelector('[data-d="' + ui.rec.field + '"]')) guard(stopRec)();
  // Before scrollTop is restored below: a box still at its min height would make .scr too short and clamp it.
  app.querySelectorAll('.ta.nt textarea').forEach(fitNote);
  var ns = document.querySelector('.scr');
  var nf = fk && lastKey.split('|')[0] === name && document.querySelector('[data-d="' + fk + '"],[data-t="' + fk + '"]');
  if (nf) { nf.focus({ preventScroll: true }); if (fs != null) nf.setSelectionRange(fs, fe); } // email inputs have no selection
  if (ns && lastKey.split('|')[0] === name) ns.scrollTop = top;
  if (ui.talk && ns && ui.talk.resetScroll) { ns.scrollTop = 0; ui.talk.resetScroll = false; } // a new reply starts at its top
  markScrolled();
  lastKey = name + '|' + (ui.sheet ? 1 : 0);
}
// Once content scrolls, a solid strip covers the status area so nothing slides under the clock.
function markScrolled() { var sc = document.querySelector('.scr'), ph = document.querySelector('.phone'); if (sc && ph) ph.classList.toggle('sc', sc.scrollTop > 8); }
app.addEventListener('scroll', markScrolled, true);
// Keyboard: the page itself never scrolls; the app column shrinks to the visual viewport so the pinned primary pill stays above the keys.
if (window.visualViewport) {
  var vv = window.visualViewport;
  // scroll only pins (iOS fires it while revealing the caret; reacting there made a feedback loop). resize reveals via .scr.scrollTop alone, since element.scrollIntoView also scrolls the window.
  var pin = function () { if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0); };
  var fit = function () {
    document.documentElement.style.setProperty('--vvh', vv.height + 'px'); pin();
    var a = document.activeElement, sc = document.querySelector('.scr');
    if (!typing() || !sc || !sc.contains(a)) return;
    var r = a.getBoundingClientRect(), v = sc.getBoundingClientRect();
    if (r.top < v.top) sc.scrollTop -= v.top - r.top + 12; else if (r.bottom > v.bottom) sc.scrollTop += r.bottom - v.bottom + 12;
  };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', pin);
}
// Notifications denied in iOS: shown on cold launch and on every foreground (never in the browser build).
function notifSheet() {
  return sheet('nf', '<div class="bsh"><h3>Notifications are off</h3><span class="xb" data-a="notifx">&#x2715;</span></div>' +
    '<div class="acts"><div class="save" data-a="notifset">Turn on</div><div class="tdrop" data-a="notifoff">Don&rsquo;t remind me</div></div>', 'notifx');
}
// ---- Complain (shake) ----------------------------------------------------------------------------------------------
// Esme shakes the phone: the shell snapshots the screen and calls cycleNative.shake(png). This sheet then takes her words
// (typed or dictated) and St.complain queues them with the screenshot and where she was; the box starts a Claude session
// for Oliver, which proposes a fix and waits for his OK. Esme only: Oliver files his own issues straight with Claude.
// Gated on the member name because the page has no other notion of who is who (the box knows Oliver's id; the page doesn't).
function canComplain() { return !!S.session && !!S.couple && firstName(nameOf(St.me())) === 'Esme'; }
function gripeSheet() {
  return sheet('t3 gp', '<div class="bsh"><h3>Complain</h3><span class="xb" data-a="gripex">&#x2715;</span></div>' +
    (ui.gripe.shot ? '<img class="gshot" alt="" src="' + ui.gripe.shot + '">' : '') +
    micTa('gripe', 'nt', 'What\u2019s wrong?') +
    '<div class="acts"><div class="save" data-a="gripesend">' + (ui.gripe.busy ? '<span class="spin"></span>' : 'Send') + '</div></div>', 'gripex');
}
// Opening stashes the screen's own typed fields: ui.d is shared, and closing must hand them back untouched.
function openGripe(png) {
  if (!canComplain() || ui.gripe || ui.talk) return;
  ui.gripe = { shot: png ? 'data:image/png;base64,' + png : null, prevD: ui.d, route: ui.route };
  ui.d = {}; render();
}
function closeGripe() { var g = ui.gripe; ui.gripe = null; ui.d = g ? g.prevD : {}; render(); }
// What Claude needs to find the screen: the route stack, the ids it shows, and recent client errors.
function gripeContext() {
  return { route: ui.gripe.route, stack: ui.stack.map(function (x) { return x.route; }).join(' > '), fightId: ui.fightId || null, todoId: ui.todoId || null,
    chId: ui.chId || null, who: firstName(nameOf(St.me())), userAgent: navigator.userAgent, errors: St.errLogText().slice(-3000) };
}
function sentToast() {
  var el = document.createElement('div');
  el.className = 'ign-toast'; el.innerHTML = '<span>Sent</span>';
  document.body.appendChild(el);
  setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 400); }, 1800);
}
function notifKey() { return 'notifnag:' + St.me(); }
async function checkNotif() {
  if (!St.hasNative || !S.session) return;
  var status = await St.native.status();
  ui.notif = status === 'denied' && (await St.kv.get(notifKey())) !== '1';
  render();
}
// A newer native build is on the install page (never for web-only changes): the bar stays until the app is updated.
async function checkUpdate() {
  var on = !!S.session && await St.nativeUpdateAvailable();
  if (on !== !!ui.upd) { ui.upd = on; render(); }
}
function sheetFor() { return ui.sheet.type === 'still' ? stillSheet() : ''; }

// Re-render on store changes unless the user is typing.
function typing() { var a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); }
window.addEventListener('online', function () { if (ui.ready) render(); });
window.addEventListener('offline', function () { if (ui.ready) render(); });
St.on(function () {
  if (S.priv && S.priv.queued.length && St.partner()) {
    try { flushQueued(); } catch (e) { console.error('cycle queued asks not sent:', e); showErr(plain(e)); }
  }
  if (!ui.ready) return; if (typing()) ui.dirty = true; else render(); });
document.addEventListener('focusout', function () { setTimeout(function () { if (ui.dirty && !typing()) { ui.dirty = false; render(); } }, 0); });
app.addEventListener('input', function (e) {
  var k = e.target.getAttribute('data-d'); if (!k) return;
  ui.d[k] = e.target.value;
  saveDraft(draftKey());
  if (ui.rec && ui.rec.field === k) guard(stopRec)(); // typing takes over from the mic
  if (e.target.closest('.ta.nt')) fitNote(e.target);
  if (k === 'dotherv') doneRefresh();
  if (k === 'more' || k === 'qans') noteSaveSync();
  var nb = k === 'chname' && document.getElementById('chnew');
  if (nb) nb.classList.toggle('dis', !e.target.value.trim());
  var pt = e.target.getAttribute('data-pt');
  if (pt) e.target.previousElementSibling.textContent = dispPick(pt, e.target.value);
});

// ---- Talk: a spoken back-and-forth about a fight ---------------------------------------------------------------
// Drawn INSTEAD of the current screen while ui.talk is set (not a route): ui.d holds the unsaved Log-a-fight form, and
// every route change wipes it. ui.talk = {field, key, route, fid, msgs[{role,text}], draft, text (composer),
// listen, speak, pending, failed, finish, seq, spk}. The words are kept in St.kv (on this device
// only, never synced) on every change, so a crash or Close loses nothing; Use this / Use my words / Save clear them.
// Fallback for a speechSynthesis whose `end` never fires: proportional to the text, then fall back to idle.
function talkSpeakMs(text) { return 5000 + text.length * 120; }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0]; }
function talkStoreKey(fid) { return 'talk:' + (fid || 'new'); }
// The fight a Talk belongs to: the open fight, or null on the Log a fight form.
function talkFid() { return ui.route === 'fightdetail' ? ui.fightId : null; }
function talkClearSaved(fid) { return St.kv.set(talkStoreKey(fid), ''); }
function talkSave(t) { return St.kv.set(t.key, t.msgs.length || t.draft ? JSON.stringify({ msgs: t.msgs, draft: t.draft }) : ''); }
// Context for the model: this fight's already-shared notes only (never intensity, hits or other private tiers).
function talkNotes(fid) {
  if (!fid) return [];
  return fightNotes(fid).filter(function (n) { return !n.deleted_at; }).slice(-40).map(function (n) { return firstName(nameOf(n.author_id)) + ': ' + n.body.slice(0, 4000); });
}
// Gemini-Live-style screen: only the NEWEST assistant reply is drawn (large, top); earlier turns live on in t.msgs and the
// saved conversation, never on screen. data-state on the glow drives its animation and is what tests read.
function talkLast(t, role) { for (var i = t.msgs.length - 1; i >= 0; i--) if (t.msgs[i].role === role) return t.msgs[i].text; return ''; }
function talkState(t) { return t.speak ? 'speaking' : t.pending ? 'thinking' : t.listen ? 'listening' : t.muted ? 'muted' : 'idle'; }
var TALK_FADE_MS = 500;
function talkScreen() {
  var t = ui.talk, reply = talkLast(t, 'assistant'), fail = t.failed && !t.pending, st = talkState(t);
  // Every render rebuilds the DOM, so a fade-in would restart on each one (the speak/listen state changes render right after
  // the reply lands). A negative animation-delay equal to the time already elapsed lets the rebuilt element carry on.
  if (reply !== t.shown) { t.shown = reply; t.shownAt = Date.now(); t.resetScroll = true; }
  var age = Date.now() - t.shownAt, fade = reply && age < TALK_FADE_MS ? ' fresh" style="animation-delay:-' + age + 'ms' : '';
  var body = '<p class="tkrep' + fade + '">' + esc(reply) + '</p>' + (t.draft ? '<div class="tkd"><p>' + esc(t.draft) + '</p></div>' : '');
  var x = '<span class="tkb" data-a="tkx" role="button" aria-label="End"><svg class="ic"><path d="M6 6l12 12M18 6L6 18"/></svg></span>';
  var bar;
  if (t.draft || fail) {
    bar = '<div class="tkact">' + (t.draft ? '<span class="save" data-a="tkuse">Use this</span><span class="ghost" data-a="tkkeep">Keep talking</span>' :
      '<span class="save" data-a="tkretry">Retry</span><span class="ghost" data-a="tkwords">Use my words</span>') + x + '</div>';
  } else {
    var ph = talkLast(t, 'user'); // the last sent turn until the next one starts
    var mic = St.hasNative ? '<span class="tkb tkmic' + (t.listen ? ' rec' : '') + (t.muted ? ' off' : '') + (t.pending ? ' busy' : '') + '" data-a="tkmic" role="button" aria-label="' + (t.pending ? 'Thinking' : 'Mute') + '">' + (t.pending ? '<span class="spin"></span>' : ic('mic')) + '</span>' : '<span class="tksp"></span>';
    bar = '<div class="tkpill' + (t.text.trim() ? ' has' : '') + '"><span class="tkph">' + esc(ph) + '</span>' +
      '<input class="tkin" data-t="tk" aria-label="Message" autocomplete="off" autocapitalize="sentences" value="' + esc(t.text) + '">' +
      '<span class="tksend" data-a="tksend" role="button" aria-label="Send"><svg class="ic"><path d="M12 19V6M6 12l6-6 6 6"/></svg></span></div>' +
      '<div class="tkrow">' + mic + '<span class="tkglow" data-a="tkglow" data-state="' + st + '" role="button" aria-label="Talk"></span>' + x + '</div>';
  }
  return phone('p2 tk', body, { band: false, tab: false, pin: '<div class="tkbar">' + bar + '</div>' });
}
// Best installed English voice: the Premium/Enhanced downloads sound far more natural than the default compact voice.
function talkPickVoice(list) {
  var best = null, bs = -1;
  list.forEach(function (v) {
    if (!/^en([-_]|$)/i.test(v.lang)) return;
    var s = (/premium/i.test(v.name) ? 40 : /enhanced/i.test(v.name) ? 30 : 0) + (/^en[-_]US/i.test(v.lang) ? 3 : /^en[-_]GB/i.test(v.lang) ? 2 : 0) + (v.localService ? 1 : 0);
    if (s > bs) { best = v; bs = s; }
  });
  return best;
}
// getVoices() is empty until the engine has loaded them (WebKit then fires voiceschanged): wait briefly instead of
// speaking in the default voice. 800ms is a guess; a device with no voices at all just proceeds without one.
function talkVoices(ss) {
  var l = ss.getVoices();
  if (l.length) return Promise.resolve(l);
  return new Promise(function (res) {
    var done = false;
    function fin() { if (done) return; done = true; ss.removeEventListener('voiceschanged', fin); res(ss.getVoices()); }
    ss.addEventListener('voiceschanged', fin); setTimeout(fin, 800);
  });
}
// Stops speech and recording, keeping what was said so far as an unsent turn (shown with Retry) so Close, backgrounding or
// typing never drops it. Awaits the transcription, so the native audio session is free before anything else.
async function talkHalt(t, quiet) {
  t = t || ui.talk;
  if (!t) return;
  t.spk++; t.speak = false;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (!(ui.rec && ui.rec.field === 'talk')) return;
  ui.rec = null; t.listen = false;
  if (ui.talk === t) render(); // else the mic stays lit after typing or backgrounding
  var h = (await St.transcribe()).trim();
  // `quiet` (typing took over): keep the words but stay on the pill, since Retry/Use my words would replace the field being typed in.
  if (h) { t.msgs.push({ role: 'user', text: h }); t.failed = !quiet; talkSave(t); }
  if (ui.talk === t) render();
}
// Begin a listening turn (native only). Cuts any speech first; the tap that got here is the user gesture.
async function talkListen() {
  var t = ui.talk;
  if (!t || !St.hasNative || t.pending || ui.rec) return;
  t.spk++; t.speak = false;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  ui.rec = { field: 'talk' }; t.listen = true; render();
  try { await St.native.speechStart(); } catch (e) { ui.rec = null; t.listen = false; render(); throw e; }
}
// The shell's silence event (cycleNative.speechSilence) or a mic tap ends the turn: stop recording, transcribe (the glow shows
// 'thinking'), then send what was said. Nothing said goes back to idle.
async function talkEndTurn() {
  var t = ui.talk;
  if (!t || !(ui.rec && ui.rec.field === 'talk')) return;
  ui.rec = null; t.listen = false; t.pending = true; render();
  var h;
  try { h = (await St.transcribe()).trim(); } catch (e) { t.pending = false; if (ui.talk === t) render(); throw e; }
  if (ui.talk !== t) return;
  t.pending = false;
  if (h) await talkSend(h, false); else render();
}
// One request. A failure keeps the user's turn on screen with Retry; a stale answer (Closed meanwhile) is dropped.
async function talkSend(text, finish) {
  var t = ui.talk;
  if (text) t.msgs.push({ role: 'user', text: text });
  t.pending = true; t.failed = false; t.finish = !!finish; var seq = ++t.seq;
  talkSave(t); render();
  var r;
  try {
    r = await St.talk({ messages: t.msgs, finish: !!finish, speaker: firstName(nameOf(St.me())), partner: firstName(pName()), notes: talkNotes(t.fid) });
  } catch (e) {
    if (ui.talk !== t || t.seq !== seq) return;
    St.logErr('talk', e); t.pending = false; t.failed = true; render(); return;
  }
  if (ui.talk !== t || t.seq !== seq) return;
  t.pending = false; t.msgs.push({ role: 'assistant', text: r.reply }); t.draft = r.draft;
  talkSave(t); render();
  return talkSpeak(t, r.reply);
}
// Speak the reply, then listen again. No speechSynthesis, an error, or an `end` that never comes all land on idle with the
// mic tappable and no error: the text is on screen regardless. Any recording is cancelled (awaited) first because it holds the audio session.
async function talkSpeak(t, text) {
  var ss = window.speechSynthesis;
  if (!St.hasNative || !ss || typeof SpeechSynthesisUtterance === 'undefined') return;
  var id = ++t.spk;
  await St.native.speechCancel();
  if (ui.talk !== t || t.spk !== id) return;
  var voice = talkPickVoice(await talkVoices(ss));
  if (ui.talk !== t || t.spk !== id) return;
  var u = new SpeechSynthesisUtterance(text), done = false, timer = 0;
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  u.rate = 1; // natural pace; the engine default is slower on iOS
  function fin(listen) {
    if (done || ui.talk !== t || t.spk !== id) return;
    done = true; clearTimeout(timer); t.speak = false; render();
    if (listen && !t.muted) guard(talkListen)();
  }
  u.onend = function () { fin(true); };
  u.onerror = function () { fin(false); };
  timer = setTimeout(function () { ss.cancel(); fin(false); }, talkSpeakMs(text));
  t.speak = true; render();
  ss.speak(u);
}
function talkMic() {
  var t = ui.talk;
  if (!t || t.pending) return;
  if (ui.rec && ui.rec.field === 'talk') { t.muted = true; return talkEndTurn(); }
  t.muted = false; return talkListen();
}
// Leave Talk keeping the conversation saved (X with an answer, a draft or an unsent turn; also a push moving the route).
async function talkExit(t) { await talkHalt(t); await talkSave(t); talkLeave(t); }
// Close Talk with `text` appended to the field it was opened from, after a blank line when the field has text.
async function talkApply(text) {
  var t = ui.talk, f = t.field;
  await talkHalt(t);
  var cur = (ui.d[f] || '').replace(/\s+$/, '');
  ui.d[f] = cur ? cur + '\n\n' + text : text;
  await talkClearSaved(t.fid);
  talkLeave(t);
  saveDraft(draftKey());
}
function talkLeave(t) {
  ui.talk = null; render();
  var sc = document.querySelector('.scr'); if (sc) sc.scrollTop = t.top;
}
app.addEventListener('input', function (e) {
  if (e.target.getAttribute('data-t') !== 'tk' || !ui.talk) return;
  ui.talk.text = e.target.value;
  e.target.parentNode.classList.toggle('has', !!e.target.value.trim()); // shows the send arrow; a re-render here would drop the keyboard
  guard(talkHalt)(ui.talk, true); // typing takes over from the mic and the voice
});
app.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.getAttribute && e.target.getAttribute('data-t') === 'tk') { e.preventDefault(); guard(ACT.tksend)(); }
});

// ---- actions ---------------------------------------------------------------------------------------------------
// A delivered ask becomes the partner's to do (type carried through, so an 'ownup' ask becomes an 'ownup' to do).
// The row is stamped with the item's delivered_at: now for an ordinary delivery, T for a scheduled one.
function deliverAsk(item) {
  var at = C.ms(item.delivered_at);
  St.insert('todos', C.askToTodo(item, St.uuid(), at));
}
function deliver(item) {
  St.patch('items', item.id, { status: 'delivered', delivered_at: nowIso() });
  if (item.kind === 'ask') deliverAsk(S.rows.items[item.id]);
}
// Builds an outgoing item without writing anything, so a caller can validate every piece before the first insert.
// Throws when there is no partner to send to.
function buildAsk(kind, o) {
  if (!St.partner()) throw new Error('Partner not joined');
  return C.buildItem({ id: St.uuid(), couple: S.couple, me: St.me(), to: St.partner().user_id, kind: kind, gift_points: o.gift_points, body: o.body, description: o.description, ask_type: o.ask_type, due_date: o.due_date, target: o.target, period: o.period, points_earn: o.points_earn, points_miss: o.points_miss, needs_note: o.needs_note, origin: o.origin, response_type: o.response_type, fight_marker_id: o.fight_marker_id, held_until: o.held_until, now: now(), at: o.at != null ? C.scheduleAt(S.couple, kind, o.at, now()) : null });
}
// Writes a built item (and, for an ask that is already delivered, the partner's to do).
function sendBuilt(item) {
  St.insert('items', item);
  if (item.status === 'delivered' && item.kind === 'ask') deliverAsk(item);
  return item;
}
function sendItem(kind, o) { return sendBuilt(buildAsk(kind, o)); }
function celebrate(item, el) { M.play(item.status === 'held' ? 'hold' : item.kind === 'kudos' ? 'kudos' : 'send', el); St.native.haptic('success'); }
// Asks saved before the partner joined go out through the normal Ask hold the moment they appear.
function flushQueued() {
  // Build everything first: if any ask cannot be built the queue stays intact (it used to be emptied before sending, so one
  // bad entry lost them all). The queue is cleared BEFORE the inserts because insert() emits, and the store listener
  // would call flushQueued again and send every ask twice.
  var items = S.priv.queued.map(function (o) { return buildAsk('ask', o); });
  S.priv.queued = []; St.savePriv();
  items.forEach(sendBuilt);
}
function todoTally(t, el, note) {
  St.patch('todos', t.id, { tally: t.tally + 1 });
  St.insert('todo_events', { id: St.uuid(), couple_id: S.couple.id, todo_id: t.id, user_id: St.me(), kind: 'tally', at: nowIso(), note: note || null });
  if (C.earnPts(t)) M.play('points', el, C.earnPts(t)); // a to do with Points off has 0, and the pop would read "\u22120"
}
// Opening a to do the partner owned up to is what clears its Home card. Any other to do is a no-op.
function markOwnupSeen(id) {
  var t = S.rows.todos[id], seen = S.priv.ownupSeen;
  if (t && t.type === 'ownup' && t.owner_id !== St.me() && seen.indexOf(id) < 0) { seen.push(id); St.savePriv(); }
}
function todoDone(t, el, note) {
  St.patch('todos', t.id, { done_at: nowIso() });
  St.insert('todo_events', { id: St.uuid(), couple_id: S.couple.id, todo_id: t.id, user_id: St.me(), kind: 'done', at: nowIso(), note: note || null });
  if (t.type === 'response') {
    var f = S.priv.fights.filter(function (x) { return x.id === t.fight_marker_id; })[0];
    if (f) { f.followed = true; St.savePriv(); }
    var mk = t.fight_marker_id && S.rows.fight_markers[t.fight_marker_id];
    if (mk && !mk.repaired_at) St.patch('fight_markers', mk.id, { repaired_at: nowIso() });
  }
  M.play('todo', el); St.native.haptic('success');
}
function logFight() {
  var d = ui.d, id = St.uuid(), at = whenMs('when'), chips = d.chips || {}, el = document.querySelector('.p2.s2 .save'), note = (d.note || '').trim();
  // All-or-nothing: validate and build every row first, insert only at the end. A throw half way (no partner to ask)
  // used to leave the marker and note queued while the screen stayed up, so the retry wrote them a second time.
  var marker = { id: id, couple_id: S.couple.id, logged_by: St.me(), at: new Date(at).toISOString(), repaired_at: null,
    // Shared on purpose: the partner sees these on the Points ledger's Fight line. null = not answered;
    // hit_related is false only when the "not related" box is checked after a Yes (the DB rejects it otherwise), else null.
    hit_self: ynVal(d.hit), hit_related: d.hit === 'yes' && d.hitNot ? false : null,
    // How many times, >= 1 after a Yes; null otherwise (the DB rejects any other combination).
    hit_count: d.hit === 'yes' ? d.hitN || 1 : null,
    text_on: !!d.textOn, text_note: d.textOn && (d.tnote || '').trim() ? d.tnote.trim() : null };
  // The first note is shared immediately and deliberately skips the hold; only the asks wait.
  var noteRow = note ? { id: St.uuid(), couple_id: S.couple.id, fight_marker_id: id, author_id: St.me(), body: note, created_at: new Date(at).toISOString() } : null;
  var asks = [['apologize', 'Apologize'], ['reflect', 'Reflect'], ['custom', (d.customTitle || '').trim()]].filter(function (c) { return chips[c[0]] && c[1]; })
    .map(function (c) { return buildAsk('ask', { body: c[1], ask_type: 'task', origin: 'fight', response_type: c[0], fight_marker_id: id }); });
  St.insert('fight_markers', marker);
  if (noteRow) St.insert('fight_notes', noteRow);
  asks.forEach(sendBuilt);
  // The text of my own log stays on this phone; the intensity is also shared as my rating (after the marker in the outbox).
  setRating(id, d.int || 3);
  S.priv.fights.push({ id: id, at: at, logged_at: Date.now(), intensity: d.int || 3 });
  St.savePriv();
  draftSent(); talkClearSaved();
  M.play('crack', el);
  tab('home');
}
function saveNote() {
  var body = (ui.d.more || '').trim();
  // Intensity saves on tap, so Save with no note has nothing left to do.
  if (!body) return ACT.back();
  if (!S.rows.fight_markers[ui.fightId]) throw new Error('Fight is gone');
  var row = { id: St.uuid(), couple_id: S.couple.id, fight_marker_id: ui.fightId, author_id: St.me(), body: body, created_at: new Date(whenMs('mw', noteDef(S.rows.fight_markers[ui.fightId], ui.d.fnkind === 'analysis' ? 'analysis' : 'note'))).toISOString() };
  // An analysis is the author's own reading, shown word for word; only an analysis can point at earlier fights.
  if (ui.d.fnkind === 'analysis') {
    row.kind = 'analysis';
    row.linked_fight_ids = Object.keys(ui.d.nlinks || {}).filter(function (id) { return ui.d.nlinks[id] && S.rows.fight_markers[id]; });
  }
  St.insert('fight_notes', row);
  draftSent(); talkClearSaved(ui.fightId); ui.d.more = ''; ui.d.fnkind = 'note'; ui.d.nlinks = {}; delete ui.d.mwD; delete ui.d.mwT; render();
}

var ACT = {
  retry: function () { if (ui.ready) render(); else location.reload(); },
  gohome: function () { tab('home'); },
  bootexport: guard(async function () {
    var text = await St.rawExport();
    return St.hasNative ? St.native.share({ filename: 'cycle-data.json', text: text }) : St.native.copy(text);
  }),
  bootsignout: guard(async function () { await St.signOut(); location.reload(); }),
  deadletters: function () { go('deadletters'); },
  errlog: function () { ui.errOpen = !ui.errOpen; render(); },
  errcopy: guard(function () { return St.native.copy(St.errLogText()); }),
  // Hands the unsent rows to the share sheet (native) or the clipboard (browser) so the text can be kept elsewhere.
  dlexport: guard(function () {
    var text = St.deadLetterText();
    return St.hasNative ? St.native.share({ filename: 'cycle-not-sent.json', text: text }) : St.native.copy(text);
  }),
  back: back,
  go: function (r) { go(r); },
  tab: tab,
  sheet: function () { ui.sheet = null; ui.d = {}; render(); },
  mic: guard(function (field) {
    if (ui.busy) return;
    if (ui.rec) return finishRec();
    ui.rec = { field: field, orig: ui.d[field] || '' }; render();
    return St.native.speechStart().catch(function (e) { ui.rec = null; throw e; });
  }),
  // Talk: open from a note field (restoring this fight's saved conversation), and the controls inside it.
  talk: guard(async function (field) {
    var fid = talkFid(), key = talkStoreKey(fid), sc = document.querySelector('.scr');
    var saved = JSON.parse((await St.kv.get(key)) || 'null') || { msgs: [], draft: null };
    var last = saved.msgs[saved.msgs.length - 1];
    ui.talk = { field: field, key: key, route: ui.route, fid: fid, top: sc ? sc.scrollTop : 0, msgs: saved.msgs, draft: saved.draft, text: '', listen: false, speak: false,
      pending: false, failed: !!last && last.role === 'user' && !saved.draft, finish: false, seq: 0, spk: 0 };
    render();
    if (St.hasNative && !ui.talk.failed) await talkListen();
  }),
  // Mic and glow: speaking -> cut it and listen; listening -> mute (what was said is sent, no auto-relisten); muted -> listen.
  tkmic: guard(function () { return talkMic(); }),
  tkglow: guard(function () { return talkMic(); }),
  // X: with an answer, a draft or an unsent turn on screen it just leaves (words stay saved); otherwise with at least one
  // user turn it asks the model to finish, exactly what Done did; with nothing said it exits.
  tkx: guard(async function () {
    var t = ui.talk;
    if (t.pending || t.draft || t.failed) return talkExit(t);
    await talkHalt(t);
    var text = t.text.trim();
    if (!text && !t.msgs.some(function (m) { return m.role === 'user'; })) return talkExit(t);
    t.text = ''; return talkSend(text || null, true);
  }),
  tksend: guard(async function () {
    var t = ui.talk, text = t.text.trim(); if (!text || t.pending) return;
    await talkHalt(t); t.text = ''; return talkSend(text, false);
  }),
  tkretry: guard(function () { return talkSend(null, ui.talk.finish); }),
  tkkeep: function () { ui.talk.draft = null; ui.talk.muted = false; talkSave(ui.talk); render(); if (St.hasNative) guard(talkListen)(); },
  tkuse: guard(function () { return talkApply(ui.talk.draft); }),
  tkwords: guard(function () { return talkApply(ui.talk.msgs.filter(function (m) { return m.role === 'user'; }).map(function (m) { return m.text; }).join(' ')); }),
  upd: guard(function () { return St.openInstall(); }),
  notifx: function () { ui.notif = false; render(); },
  gripex: closeGripe,
  // Queued in kv before any network call (St.complain), so Sent is true even offline: it goes out on the next foreground.
  gripesend: guard(async function () {
    var g = ui.gripe, text = (ui.d.gripe || '').trim();
    if (!g || g.busy || ui.rec || ui.busy) return;
    if (!text) throw new Error('Say what\u2019s wrong');
    g.busy = true; render();
    try { await St.complain({ text: text, screenshot: g.shot, context: gripeContext() }); }
    catch (e) { g.busy = false; render(); throw e; } // stays open with the words in it
    draftSent('gripe'); ui.d = {}; closeGripe(); sentToast(); St.native.haptic('success');
  }),
  notifset: function () { St.native.openSettings(); },
  notifoff: function () { ui.notif = false; render(); St.kv.set(notifKey(), '1'); },
  mode: function (m) { ui.mode = m; render(); },
  signin: guard(async function () { await St.signIn(ui.d.email, ui.d.password); ui.d = {}; render(); }),
  signup: guard(async function () { await St.signUp(ui.d.email, ui.d.password); ui.d = {}; render(); }),
  signout: guard(async function () { await St.signOut(); ui.route = 'home'; ui.stack = []; ui.d = {}; render(); }),
  create: guard(async function () {
    if (!ui.d.name) throw new Error('Name needed');
    ui.code = await St.createCouple(ui.d.name, Intl.DateTimeFormat().resolvedOptions().timeZone); render();
  }),
  join: guard(async function () {
    if (!ui.d.name || !ui.d.code) throw new Error('Name and code needed');
    await St.joinCouple(ui.d.code.trim().toUpperCase(), ui.d.name); ui.d = {}; render();
  }),
  copycode: guard(async function () {
    await St.native.copy(ui.code);
    St.native.haptic('success');
    ui.copied = true; render();
    clearTimeout(ui.copiedTimer); ui.copiedTimer = setTimeout(function () { ui.copied = false; render(); }, 1500);
  }),
  sharecode: guard(function () { return St.native.shareText('Together code: ' + ui.code); }),
  codedone: function () { ui.code = null; ui.copied = false; ui.d = {}; render(); },
  todoseg: function (v) { ui.todoSeg = v; render(); },
  remview: function (v) { ui.remView = v; render(); },
  fzreset: function () { ui.fz = null; ui.fpick = null; render(); },
  doneopen: function () { ui.doneOpen = !ui.doneOpen; render(); },
  doneall: function () { ui.doneAll = !ui.doneAll; render(); },
  decline: guard(function (id) { St.patch('redemptions', id, { status: 'declined', decided_by: St.me(), decided_at: nowIso() }); }),
  approve: guard(function (id) {
    var el = document.querySelector('.nc.tall'), price = S.rows.redemptions[id].price;
    St.patch('redemptions', id, { status: 'approved', decided_by: St.me(), decided_at: nowIso() });
    M.play('points', el, -price);
  }),
  still: function (id) { ui.sheet = stillHeld(id) ? { type: 'still', id: id } : null; ui.d = {}; render(); },
  edit: function (id) { ui.sheet.edit = true; ui.d.edit = S.rows.items[id].body; render(); },
  editsave: guard(function (id) { var b = (ui.d.edit || '').trim(); if (!b) throw new Error('Message needed'); St.patch('items', id, { body: b }); draftSent(); ui.sheet.edit = false; ui.d = {}; render(); }),
  deliver: guard(function (id) { var it = S.rows.items[id]; if (it.origin === 'issue' && C.ms(it.held_until) > now()) throw new Error('Not yet'); var el = document.querySelector('.bs .save'); deliver(S.rows.items[id]); M.play('send', el); ui.sheet = null; render(); }),
  drop: guard(function (id) { St.patch('items', id, { status: 'dropped' }); ui.sheet = null; render(); }),
  addpick: function () { ui.sheet = { type: 'addpick' }; ui.d = {}; render(); },
  newtodo: function (kind) {
    // From Home the sheet has no host screen: open the To-dos tab first.
    if (ui.route !== 'todo') { ui.todoSeg = 'todo'; tab('todo'); }
    ui.sheet = { type: 'newtodo', who: 'them', when: 'now', kind: 'task', period: 'week', tgt: 3, pe: 3, pm: 3, pt: false, pts: false, nn: false }; ui.d = {}; ACT.nkind(kind); },
  etodo: function (id) {
    var t = S.rows.todos[id];
    ui.sheet = { type: 'newtodo', edit: id, kind: t.type, period: t.period || 'week', tgt: t.target || 3, pe: C.earnPts(t), pm: C.missPts(t), pt: true, pts: C.earnPts(t) > 0 || C.missPts(t) > 0, nn: t.needs_note };
    ui.d = { title: t.title, desc: t.description || '', due: t.due_date || '' }; render();
  },
  tview: function (id) { markOwnupSeen(id); go('tododetail', { todoId: id }); },
  tnudge: guard(function (id) {
    var t = S.rows.todos[id];
    if (t.owner_id === St.me() || closed(t) || t.deleted_at) throw new Error('Cannot nudge');
    if (nudgedToday(id)) throw new Error('Already nudged');
    var n = nowIso();
    St.insert('todo_nudges', { id: St.uuid(), couple_id: S.couple.id, todo_id: id, sender_id: St.me(), created_at: n, updated_at: n, deleted_at: null });
    render();
  }),
  chping: guard(function (id) {
    var c = ledger().challenges.filter(function (x) { return x.id === id; })[0];
    if (!c || c.for_user === St.me() || c.status === 'done' || c.status === 'failed') throw new Error('Cannot ping');
    if (pingedToday(id)) throw new Error('Already pinged');
    var n = nowIso();
    St.insert('challenge_nudges', { id: St.uuid(), couple_id: S.couple.id, challenge_id: id, sender_id: St.me(), created_at: n, updated_at: n, deleted_at: null });
    render();
  }),
  notedel: guard(function (id) {
    var n = S.rows.fight_notes[id];
    if (!n || n.author_id !== St.me() || n.deleted_at) throw new Error('Cannot delete');
    ui.sheet = { type: 'notedel', id: id }; render();
  }),
  notedelok: guard(function () {
    var id = ui.sheet.id, n = S.rows.fight_notes[id];
    if (!n || n.author_id !== St.me() || n.deleted_at) throw new Error('Cannot delete');
    ui.sheet = null; St.patch('fight_notes', id, { deleted_at: nowIso() }); render();
  }),
  // 2026-11-05: the author may rewrite their own note's body any time; the server stamps edited_at so the partner sees "Edited".
  notedit: guard(function (id) {
    var n = S.rows.fight_notes[id];
    if (!n || n.author_id !== St.me() || n.deleted_at) throw new Error('Cannot edit');
    ui.sheet = { type: 'notedit', id: id }; ui.d = { nedit: n.body }; render();
  }),
  noteditsave: guard(function () {
    var n = S.rows.fight_notes[ui.sheet.id], b = (ui.d.nedit || '').trim();
    if (!n || n.author_id !== St.me() || n.deleted_at) throw new Error('Cannot edit');
    if (!b) throw new Error('Note needed');
    if (b !== n.body) St.patch('fight_notes', n.id, { body: b });
    ui.sheet = null; ui.d = {}; render();
  }),
  fightedit: guard(function () {
    var mk = S.rows.fight_markers[ui.fightId];
    if (!mk || !fightEditable(mk)) throw new Error('Fight is not editable');
    var at = C.ms(mk.at);
    ui.sheet = { type: 'fightedit' };
    ui.d = { int: myRating(mk) || 3, hit: mk.hit_self === true ? 'yes' : mk.hit_self === false ? 'no' : null, hitN: mk.hit_count || 1, hitNot: mk.hit_related === false, textOn: !!mk.text_on, tnote: mk.text_note || '',
      ewD: C.localDay(at, tz()), ewT: hmOf(at) };
    render();
  }),
  fighteditsave: guard(function () {
    var mk = S.rows.fight_markers[ui.fightId], d = ui.d;
    // Re-checked at save: a delete request (from this phone or a stale sheet) may have arrived while the sheet was open.
    if (!mk || !fightEditable(mk)) throw new Error('Fight is not editable');
    var at = whenMs('ew'), f = { hit_self: ynVal(d.hit), hit_related: d.hit === 'yes' && d.hitNot ? false : null, hit_count: d.hit === 'yes' ? d.hitN || 1 : null }, ch = {};
    Object.keys(f).forEach(function (k) { if ((mk[k] == null ? null : mk[k]) !== f[k]) ch[k] = f[k]; });
    if (at !== C.ms(mk.at)) ch.at = new Date(at).toISOString();
    // Unticking keeps the written context, so ticking again brings it back.
    if (!!d.textOn !== !!mk.text_on) ch.text_on = !!d.textOn;
    if (d.textOn && ((d.tnote || '').trim() || null) !== (mk.text_note || null)) ch.text_note = (d.tnote || '').trim() || null;
    // The marker patch carries only the marker's own fields; intensity goes through my fight_ratings row.
    if (Object.keys(ch).length) St.patch('fight_markers', mk.id, ch);
    var rec = ownFight(mk);
    if (rec) { rec.intensity = d.int || 3; rec.at = at; St.savePriv(); }
    setRating(mk.id, d.int || 3);
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  fightdelq: function () { ui.sheet = { type: 'fightdel' }; render(); },
  fightdelreq: guard(function () {
    var mk = S.rows.fight_markers[ui.fightId];
    if (!mk || mk.logged_by !== St.me() || mk.deleted_at || mk.delete_requested_at) throw new Error('Cannot ask');
    // Only the request goes out: no intensity, no private field. A re-ask after a decline clears the declined stamp.
    St.patch('fight_markers', mk.id, { delete_requested_at: nowIso(), delete_declined_at: null });
    ui.sheet = null; render();
  }),
  fightdelok: guard(function (id) {
    var mk = S.rows.fight_markers[id];
    if (!mk || mk.logged_by === St.me() || !mk.delete_requested_at || mk.deleted_at) throw new Error('Nothing to approve');
    St.patch('fight_markers', id, { deleted_at: nowIso() });
    if (ui.route === 'fightdetail') back(); else render();
  }),
  fightdeldecl: guard(function (id) {
    var mk = S.rows.fight_markers[id];
    if (!mk || mk.logged_by === St.me() || !mk.delete_requested_at || mk.deleted_at) throw new Error('Nothing to decline');
    St.patch('fight_markers', id, { delete_requested_at: null, delete_declined_at: nowIso() });
    render();
  }),
  tundo: guard(function (id) {
    var t = S.rows.todos[id], habit = t && t.type === 'habit', kind = habit ? 'tally' : 'done';
    if (!t || t.owner_id !== St.me() || t.deleted_at) throw new Error('Cannot undo');
    if (habit ? !(t.tally > 0) : !t.done_at) throw new Error('Nothing to undo');
    // The event is what the points read, so it is undone together with the to-do's own done_at / tally.
    var ev = L('todo_events').filter(function (e) { return e.todo_id === id && e.user_id === St.me() && e.kind === kind; }).sort(function (a, b) { return C.ms(b.at) - C.ms(a.at); })[0];
    if (!ev) throw new Error('No ' + kind + ' to undo');
    St.patch('todo_events', ev.id, { deleted_at: nowIso() });
    St.patch('todos', id, habit ? { tally: t.tally - 1 } : { done_at: null });
    if (t.type === 'response') {
      var mk = t.fight_marker_id && S.rows.fight_markers[t.fight_marker_id];
      if (mk && mk.repaired_at) St.patch('fight_markers', mk.id, { repaired_at: null });
      var f = S.priv.fights.filter(function (x) { return x.id === t.fight_marker_id; })[0];
      if (f && f.followed) { f.followed = false; St.savePriv(); }
    }
    render();
  }),
  brundo: guard(function () {
    var b = todayBreak(ui.chId, true);
    if (!b) throw new Error('Nothing to undo');
    St.patch('challenge_breaks', b.id, { deleted_at: nowIso() }); render();
  }),
  charch: guard(function () {
    var c = S.rows.challenges[ui.chId];
    if (!c) throw new Error('Challenge is gone');
    St.patch('challenges', c.id, { archived_at: c.archived_at ? null : nowIso() });
    ui.sheet = null; ui.d = {}; render();
  }),
  redcancel: guard(function (id) {
    var r = S.rows.redemptions[id];
    if (!r || r.requested_by !== St.me() || r.status !== 'pending') throw new Error('Cannot cancel');
    St.patch('redemptions', id, { status: 'cancelled', decided_by: St.me(), decided_at: nowIso() });
    ui.sheet = null; render();
  }),
  cmtdel: guard(function (id) {
    var c = S.rows.todo_comments[id];
    if (!c || c.author_id !== St.me() || c.deleted_at) throw new Error('Cannot delete');
    St.patch('todo_comments', id, { deleted_at: nowIso() }); render();
  }),
  repdel: guard(function (id) {
    var r = S.rows.nudge_replies[id];
    if (!r || r.author_id !== St.me() || r.deleted_at) throw new Error('Cannot delete');
    St.patch('nudge_replies', id, { deleted_at: nowIso() }); render();
  }),
  // Cancel a reminder still waiting for its send time (its recipient has not seen it). The row is soft deleted, which the sender may do.
  sendcancel: guard(function (a) {
    var p = a.split(':'), s = findSend(p[1]);
    if (!s || s.deleted_at) throw new Error('Already gone');
    if (!isQueued(s)) throw new Error('Already sent');
    if (p[0] === 'me') { s.deleted_at = nowIso(); St.savePriv(); St.reschedule(); } else St.patch('nudge_sends', s.id, { deleted_at: nowIso() });
    render();
  }),
  sentopen: function (a) { var p = a.split(':'); ui.ntier = p[0]; ACT.nudge(p[1]); },
  nudgerestore: guard(function (a) {
    var p = a.split(':'), n = nudgeRow(p[0], p[1]);
    if (!n || n.deleted_at || !n.archived_at) throw new Error('Cannot restore');
    nPatch(p[0], p[1], { archived_at: null }); render();
  }),
  // A dropped ask goes back on hold; its old hold time has passed, so it shows as "Still send?" at once.
  restore: guard(function (id) {
    var it = S.rows.items[id];
    if (!it || it.status !== 'dropped' || it.deleted_at) throw new Error('Cannot restore');
    St.patch('items', id, { status: 'held' }); render();
  }),
  tcomment: guard(function (id) {
    var body = (ui.d.cmt || '').trim(); if (!body) throw new Error('Comment needed');
    if (!S.rows.todos[id] || S.rows.todos[id].deleted_at) throw new Error('To-do is gone');
    var n = nowIso();
    St.insert('todo_comments', { id: St.uuid(), couple_id: S.couple.id, todo_id: id, author_id: St.me(), body: body, created_at: n, updated_at: n, deleted_at: null });
    draftSent(); ui.d.cmt = ''; render();
  }),
  nfor: function (v) { ui.sheet.who = v; render(); },
  nkind: function (v) { setTodoKind(ui.sheet, v); render(); },
  nper: function (v) { ui.sheet.period = v; render(); },
  stp: function (a) { var p = a.split(':'), s = ui.sheet; s[p[0]] = Math.max(p[0] === 'tgt' ? 1 : 0, s[p[0]] + +p[1]); if (p[0] !== 'tgt') s.pt = true; render(); },
  nnote: function () { ui.sheet.nn = !ui.sheet.nn; render(); },
  npts: function () { ui.sheet.pts = !ui.sheet.pts; render(); },
  nwhen: function (v) { ui.sheet.when = v; render(); },
  awhen: function (v) { ui.awhen = v; render(); },
  schedcancel: guard(function (id) {
    var t = S.rows.todos[id];
    St.patch('todos', id, { deleted_at: nowIso() });
    if (t.item_id) St.patch('items', t.item_id, { deleted_at: nowIso() });
    render();
  }),
  nodue: function () { ui.d.due = ''; render(); },
  savetodo: guard(function () {
    var s = ui.sheet, title = (ui.d.title || '').trim(), habit = s.kind === 'habit', nn = s.kind === 'ownup' || s.nn; if (!title) throw new Error('Title needed');
    // Points toggle off saves an explicit 0/0 (null would fall back to the per-type defaults in C.earnPts/missPts).
    var pe = s.pts ? s.pe : 0, pm = s.pts ? s.pm : 0;
    var f = { title: title, description: (ui.d.desc || '').trim() || null, type: s.kind, due_date: !habit ? ui.d.due || null : null, target: habit ? s.tgt : null, period: habit ? s.period : null, points_earn: pe, points_miss: pm, needs_note: nn };
    var at = !s.edit && s.when === 'later' ? laterMs() : null;
    if (at !== null && s.who === 'me' && at <= now()) throw new Error('Pick a future time');
    if (s.edit) {
      var cur = S.rows.todos[s.edit];
      if (!cur || cur.deleted_at) throw new Error('To-do is gone');
      if (!canEditTodo(cur)) throw new Error('Too late to edit');
      // Read before the patch: St.patch mutates cur in place, so comparing cur.title afterwards never saw a rename.
      var renamed = cur.title !== title;
      St.patch('todos', s.edit, Object.assign(f, { edited_at: nowIso() })); // the owner sees Edited until they next log it
      if (cur.item_id && renamed) St.patch('items', cur.item_id, { body: title }); // the sender's own record of the ask
    }
    else if (s.who === 'them') {
      var ask = { at: at, body: title, description: f.description, ask_type: s.kind, due_date: f.due_date, target: f.target, period: f.period, points_earn: pe, points_miss: pm, needs_note: nn };
      if (St.partner()) sendItem('ask', ask); else { S.priv.queued.push(ask); St.savePriv(); }
    }
    else St.insert('todos', Object.assign({ id: St.uuid(), couple_id: S.couple.id, owner_id: St.me(), created_by: St.me(), item_id: null, fight_marker_id: null, tally: 0, done_at: null, edited_at: null, created_at: at !== null ? new Date(at).toISOString() : nowIso(), updated_at: nowIso(), deleted_at: null }, f));
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  // A scheduled to do's Delete (from its row's Edit sheet) is the row's Cancel: the item goes too, or it would still deliver.
  tododel: guard(function (id) { var t = S.rows.todos[id]; St.patch('todos', id, { deleted_at: nowIso() }); if (t.item_id && C.isScheduled(t, now())) St.patch('items', t.item_id, { deleted_at: nowIso() }); draftSent('todo:' + id); ui.sheet = null; ui.d = {}; if (ui.route === 'tododetail') back(); else render(); }),
  done: guard(function (id) {
    var t = S.rows.todos[id];
    if (t.needs_note) { ui.sheet = { type: 'note', id: id, kind: 'done' }; ui.d = {}; render(); }
    else todoDone(t, document.querySelector('[data-todo="' + id + '"] .om'));
  }),
  // Declining is not doing: no done_at, no event, no points, and the fight stays unrepaired.
  tdecline: guard(function (id) {
    var t = S.rows.todos[id];
    if (!t || t.owner_id !== St.me() || t.type !== 'response' || closed(t) || t.deleted_at) throw new Error('Cannot decline');
    ui.sheet = { type: 'decline', id: id }; ui.d = {}; render();
  }),
  tdeclinego: guard(function () {
    var t = S.rows.todos[ui.sheet.id], note = (ui.d.dnote || '').trim();
    draftSent(); ui.sheet = null; ui.d = {};
    St.patch('todos', t.id, { declined_at: nowIso(), decline_note: note || null }); render();
  }),
  tundecline: guard(function (id) {
    var t = S.rows.todos[id];
    if (!t || t.owner_id !== St.me() || !t.declined_at || t.deleted_at) throw new Error('Nothing to undo');
    St.patch('todos', id, { declined_at: null, decline_note: null }); render();
  }),
  tally: guard(function (id) {
    var t = S.rows.todos[id];
    if (t.needs_note) { ui.sheet = { type: 'note', id: id, kind: 'tally' }; ui.d = {}; render(); }
    else todoTally(t, document.querySelector('[data-todo="' + id + '"] .p1b'));
  }),
  lognote: guard(function () {
    var k = ui.sheet.kind, t = S.rows.todos[ui.sheet.id], note = (ui.d.note || '').trim();
    C.requireNote(t, note);
    draftSent(); ui.sheet = null; ui.d = {}; render();
    if (k === 'done') todoDone(t, document.querySelector('[data-todo="' + t.id + '"] .om'), note); else todoTally(t, document.querySelector('[data-todo="' + t.id + '"] .p1b'), note);
  }),
  int: function (n) { ui.d.int = +n; render(); },
  // Intensity is shared now: both of us can rate, each only our own. The on-device copy is kept in step for my own fights.
  fightint: function (n) {
    var mk = S.rows.fight_markers[ui.fightId], rec = ownFight(mk);
    if (rec) { rec.intensity = +n; St.savePriv(); }
    setRating(mk.id, +n); render();
  },
  fnkind: function (v) { ui.d.fnkind = v; render(); },
  nlink: function (id) { ui.d.nlinks = ui.d.nlinks || {}; ui.d.nlinks[id] = !ui.d.nlinks[id]; render(); },
  notestoggle: function () { ui.notesOpen = ui.notesOpen === ui.fightId ? null : ui.fightId; render(); },
  // Either of us can hide the summary for both; the raw notes then show. The server stamps who did it.
  sumhide: guard(function () { St.patch('fight_markers', ui.fightId, { summary_hidden_at: nowIso() }); render(); }),
  sumshow: guard(function () { St.patch('fight_markers', ui.fightId, { summary_hidden_at: null }); render(); }),
  yn: function (a) { var p = a.split(':'), k = p[0], v = p[1]; ui.d[k] = ui.d[k] === v ? null : v; render(); },
  // Steps .5, 1, 2, 3...; .5 is a light hit.
  hitn: function (a) { var n = ui.d.hitN || 1; ui.d.hitN = n === 0.5 ? (+a > 0 ? 1 : 0.5) : n === 1 && +a < 0 ? 0.5 : n + +a; render(); },
  hitnot: function () { ui.d.hitNot = !ui.d.hitNot; render(); },
  texton: function () { ui.d.textOn = !ui.d.textOn; render(); },
  // The logger's answer to the box's question is appended to the context; the box re-runs the summary when it sees the change.
  qsave: guard(function () {
    var mk = S.rows.fight_markers[ui.fightId], a = (ui.d.qans || '').trim();
    if (!mk || !mk.text_question || !fightEditable(mk)) throw new Error('No question to answer');
    if (!a) return;
    St.patch('fight_markers', mk.id, { text_note: (mk.text_note ? mk.text_note + '\n\n' : '') + 'Q: ' + mk.text_question + '\nA: ' + a });
    draftSent(); ui.d.qans = ''; render();
  }),
  chip: function (c) { ui.d.chips = ui.d.chips || {}; ui.d.chips[c] = !ui.d.chips[c]; render(); },
  fightsave: guard(function () { logFight(); }),
  notesave: guard(saveNote),
  openfight: function (id) { go('fightdetail', { fightId: id }); },
  facelock: guard(async function () { await St.native.lockSet(!ui.lockOn); ui.lockOn = await St.native.lockGet(); render(); }),
  export: guard(function () {
    var text = JSON.stringify(S.priv, null, 2);
    // WKWebView cannot download a blob URL, so inside the shell the export goes through the native share sheet.
    if (St.hasNative) return St.native.share({ filename: 'cycle-private.json', text: text });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'cycle-private.json'; a.click();
  }),
  shopedit: function () { ui.shopEdit = !ui.shopEdit; render(); },
  rewardarch: guard(function (id) {
    var r = S.rows.rewards[id];
    if (!r || r.archived) throw new Error('Reward is gone');
    St.patch('rewards', id, { archived: true }); draftSent('editreward:' + id); ui.sheet = null; ui.d = {}; render();
  }),
  reward: function (id) {
    var r = S.rows.rewards[id], led = ledger();
    if (ui.shopEdit) { ui.sheet = { type: 'editreward', id: id }; ui.d = { rname: r.name, rprice: String(r.price) }; render(); return; }
    // My own pending ask opens a cancel sheet (approved ones are final). The partner's ask is theirs to decide on Home.
    var pendR = L('redemptions').filter(function (x) { return x.reward_id === id && x.status === 'pending'; })[0];
    if (pendR) { if (pendR.requested_by === St.me()) { ui.sheet = { type: 'redcancel', id: pendR.id }; render(); } return; }
    if (r.price > led.balance) { M.play('jiggle', document.querySelector('[data-a="reward:' + id + '"]')); return; }
    ui.sheet = { type: 'redeem', id: id }; render();
  },
  redeem: guard(function (id) {
    var r = S.rows.rewards[id];
    St.insert('redemptions', { id: St.uuid(), couple_id: S.couple.id, reward_id: id, price: r.price, requested_by: St.me(), status: 'pending', decided_by: null, decided_at: null, created_at: nowIso(), updated_at: nowIso() });
    ui.sheet = null; render();
  }),
  challenge: function (id) { go('challenge', { chId: id }); },
  newch: function () { go('newch'); },
  chfor: function (id) { ui.d.chfor = id; render(); },
  chbr: function (k) { ui.d.chbr = k; render(); },
  chnew: guard(function () {
    var n = (ui.d.chname || '').trim(); if (!n) throw new Error('Name needed');
    if (!St.partner()) throw new Error('Partner not joined');
    var id = St.uuid();
    St.insert('challenges', { couple_id: S.couple.id, id: id, name: n, start: today(), for_user: val('chfor', St.partner().user_id), breaks_on: val('chbr', 'tap'), accepted_at: null, created_at: nowIso(), updated_at: nowIso() });
    draftSent();
    ui.route = ui.stack.length ? ui.stack.pop().route : 'progress';
    go('challenge', { chId: id });
  }),
  broke: function () { ui.sheet = { type: 'broke' }; ui.d = {}; render(); },
  brsave: guard(function () {
    var c = ledger().challenges.filter(function (x) { return x.id === ui.chId; })[0];
    if (!c) throw new Error('Challenge is gone');
    // Saying nothing here lost the typed note with no explanation (the day was already broken, e.g. from another phone).
    if (c.broken_today) throw new Error('Already logged today');
    // (challenge_id, day) is unique on the server: a break undone earlier today is revived in place, not inserted again.
    var oldB = todayBreakRow(ui.chId), bnote = (ui.d.brnote || '').trim() || null;
    if (oldB) { St.patch('challenge_breaks', oldB.id, { deleted_at: null, note: bnote }); draftSent(); ui.sheet = null; ui.d = {}; render(); return; }
    St.insert('challenge_breaks', { couple_id: S.couple.id, id: St.uuid(), challenge_id: ui.chId, day: today(), note: (ui.d.brnote || '').trim() || null, by: St.me(), created_at: nowIso(), updated_at: nowIso() });
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  chlog: function () { ui.sheet = { type: 'chlog' }; ui.d = {}; render(); },
  chlogsave: guard(function () {
    var note = (ui.d.chlognote || '').trim(); if (!note) throw new Error('Note needed');
    var c = ledger().challenges.filter(function (x) { return x.id === ui.chId; })[0];
    if (!c) throw new Error('Challenge is gone');
    if (c.logged_today) throw new Error('Already logged today');
    if (c.status !== 'active') throw new Error('Not active');
    return stopRec().then(function () {
      // (challenge_id, day) is unique on the server: a day deleted earlier is revived in place, not inserted again.
      var old = St.list('challenge_days').filter(function (x) { return x.challenge_id === ui.chId && x.day === today(); })[0];
      if (old) St.patch('challenge_days', old.id, { note: note, deleted_at: null });
      else St.insert('challenge_days', { couple_id: S.couple.id, id: St.uuid(), challenge_id: ui.chId, day: today(), note: note, by: St.me(), created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
      draftSent(); ui.sheet = null; ui.d = {}; render();
    });
  }),
  chlogview: function (id) { ui.sheet = { type: 'chlogview', id: id }; ui.rdShut = {}; render(); },
  // Folds or unfolds one exercise card in the day reading sheet.
  rdcard: function (k) { ui.rdShut = ui.rdShut || {}; ui.rdShut[k] = !ui.rdShut[k]; render(); },
  chlogedit: function (id) { ui.sheet = { type: 'chlogedit', id: id }; ui.d = { chlognote: S.rows.challenge_days[id].note }; render(); },
  chlogeditsave: guard(function () {
    var note = (ui.d.chlognote || '').trim(); if (!note) throw new Error('Note needed');
    var row = S.rows.challenge_days[ui.sheet.id];
    if (row.deleted_at) throw new Error('Already deleted');
    return stopRec().then(function () {
      if (note !== row.note) St.patch('challenge_days', row.id, { note: note });
      draftSent(); ui.sheet = null; ui.d = {}; render();
    });
  }),
  chlogdelq: guard(function () { return stopRec().then(function () { ui.sheet = { type: 'chlogdel', id: ui.sheet.id }; render(); }); }),
  chlogdel: guard(function () { St.patch('challenge_days', ui.sheet.id, { deleted_at: nowIso() }); draftSent('chlogedit:' + ui.sheet.id); ui.sheet = null; ui.d = {}; render(); }),
  chedit: function () { ui.sheet = { type: 'chedit' }; ui.d = { chname: ledger().challenges.filter(function (x) { return x.id === ui.chId; })[0].name }; render(); },
  chaccept: guard(function () { if (!S.rows.challenges[ui.chId]) throw new Error('Challenge is gone'); St.patch('challenges', ui.chId, { accepted_at: nowIso() }); render(); }),
  chsave: guard(function () {
    var n = (ui.d.chname || '').trim(); if (!n) throw new Error('Name needed');
    if (!S.rows.challenges[ui.chId]) throw new Error('Challenge is gone');
    if (n !== S.rows.challenges[ui.chId].name) St.patch('challenges', ui.chId, { name: n });
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  addreward: function () { ui.sheet = { type: 'addreward' }; ui.d = {}; render(); },
  savereward: guard(function () {
    var n = (ui.d.rname || '').trim(), p = parseInt(ui.d.rprice, 10);
    if (!n || !(p >= 0)) throw new Error('Name and price needed');
    if (ui.sheet.type === 'editreward') {
      var row = S.rows.rewards[ui.sheet.id];
      if (!row || row.archived) throw new Error('Reward is gone');
      St.patch('rewards', row.id, { name: n, price: p }); draftSent(); ui.sheet = null; ui.d = {}; render(); return;
    }
    St.insert('rewards', { id: St.uuid(), couple_id: S.couple.id, name: n, price: p, created_by: St.me(), archived: false, created_at: nowIso(), updated_at: nowIso() });
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  weekshop: function () { M.play('week'); prefs().weekSeen = ledger().current.start; St.savePriv(); ui.route = 'shop'; ui.stack = [{ route: 'home' }]; render(); },
  weekdone: function () { M.play('week'); prefs().weekSeen = ledger().current.start; St.savePriv(); tab('home'); },
  // ---- Nudges ----
  noop: function () {},
  ntier: function (t) { ui.ntier = t; render(); },
  nudge: function (id) { markRead(idSet(sendsOfNudge(id))); go('nudge', { nid: id, tip: false }); },
  tip: function () { ui.tip = !ui.tip; render(); },
  // One tap = one send: a second tap inside SEND_LOCK_MS (nothing visibly moved yet on a slow phone) is dropped. A reminder
  // that already went out today asks before sending again.
  nudgesend: guard(function () {
    if (sendLocked()) return;
    var n = nudgeRow(ui.ntier, ui.nid);
    if (sentToday(nudgeTier(ui.ntier).sends.filter(function (s) { return s.nudge_id === n.id; }))) { ui.sheet = { type: 'resend' }; render(); return; }
    sendNudge();
  }),
  nudgeresend: guard(function () { if (sendLocked()) return; ui.sheet = null; sendNudge(); }),
  nudgepin: guard(function () { var n = nudgeRow(ui.ntier, ui.nid); nPatch(ui.ntier, n.id, { pinned: !n.pinned }); render(); }),
  nudgeedit: function () { go('nudgenew', { nedit: ui.nid, nfor: ui.ntier }); },
  nudgedone: function () { go('nudgedone', { dpts: 30, dother: false, dpay: '3mo' }); },
  donepts: function (v) { if (v === 'other') ui.dother = true; else { ui.dother = false; ui.dpts = +v; } render(); },
  donepay: function (v) { ui.dpay = v; render(); },
  // The award (couple-visible, so Esme's ledger pays it) and nudges.done_at go out together; the nudge then
  // leaves the library for the Done section. Back twice: Done sheet -> nudge card -> library.
  donemark: guard(function () {
    var pts = donePts(), n = nudgeRow('esme', ui.nid);
    if (pts === null) throw new Error('Points needed');
    var at = new Date(now()).toISOString();
    St.insert('nudge_awards', { id: St.uuid(), couple_id: S.couple.id, author_id: St.me(), recipient_id: St.partner().user_id, nudge_id: n.id, body: n.body,
      points: pts, payout: ui.dpay, done_at: at, stopped_at: null, created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    nPatch('esme', n.id, { done_at: at });
    ui.stack.pop(); back();
  }),
  nudgestop: guard(function () { St.patch('nudge_awards', awardOf(ui.nid).id, { stopped_at: new Date(now()).toISOString() }); render(); }),
  nudgearchive: guard(function () { nPatch(ui.ntier, ui.nid, { archived_at: nowIso() }); back(); }),
  issuenew: function () { go('issuenew', { itype: 'apologize' }); },
  itype: function (v) { ui.itype = v; render(); },
  issuesave: guard(function () {
    var body = (ui.d.ibody || '').trim(), el = document.querySelector('.save');
    if (!body) { M.play('jiggle', document.querySelector('.ta')); throw new Error('Issue needed'); }
    // No partner yet means nothing to send to; unlike a to do there is no queue, since the hold is computed now.
    if (!St.partner()) throw new Error('No partner yet');
    var apologize = ui.itype === 'apologize';
    celebrate(sendItem('ask', { body: body, origin: 'issue', response_type: ui.itype, ask_type: apologize ? 'ownup' : 'task', needs_note: apologize,
      held_until: C.issueHeldUntil(now(), St.myMember().tz || tz()) }), el);
    draftSent(); back();
  }),
  nudgenew: function () { go('nudgenew', { nedit: null, nfor: ui.ntier }); },
  nudgefor: function (v) { ui.nfor = v; render(); },
  // Save from the Edit screen (a new reminder has only Send): updates the library row, sends nothing.
  nudgesave: guard(function () { saveNudge(); draftSent(); ui.ntier = ui.nfor; back(); }),
  nudgenewsend: guard(function () {
    if (sendLocked()) return;
    lockSend();
    var el = document.querySelector('.save');
    M.play('send', el); // before the store write: insert() re-renders synchronously and would detach el (rect 0,0)
    var row = saveNudge(); doSend(ui.nfor, row); draftSent(); ui.ntier = ui.nfor; ui.tip = false;
    back();
  }),
  // Replies are not held: the row goes straight into the outbox.
  nreply: guard(function () {
    var body = (ui.d.reply || '').trim(), s = replyTarget();
    if (!body) throw new Error('Reply needed');
    if (!s) throw new Error('Nothing to reply to');
    St.insert('nudge_replies', { id: St.uuid(), couple_id: S.couple.id, send_id: s.id, author_id: St.me(), body: body, read_at: null,
      created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    draftSent(); ui.d.reply = ''; render();
  }),
  nudgein: function (id) { openSend(id); go('nudgein', { sendId: id }); },
  replyopen: function (id) { openSend(id); go('nudgein', { sendId: id }); },
  day: function (d) { ui.cyc.sel = d; render(); },
  mon: function (n) { var c = ui.cyc, m = c.m + +n; c.y += m < 1 ? -1 : m > 12 ? 1 : 0; c.m = m < 1 ? 12 : m > 12 ? 1 : m; render(); }
};

// Shared-setting writes go straight to REST (couples/members are not in the offline outbox).
async function setHold(kind, min) {
  var field = 'hold_' + kind + '_min';
  await St.api('PATCH', 'couples?id=eq.' + S.couple.id, (function (o) { o[field] = min; return o; })({}), { Prefer: 'return=minimal' });
  S.couple[field] = min; await St.persistNow(); St.emit();
}
['truth', 'ask'].forEach(function (k) { ACT['hold' + k] = guard(function (m) { return setHold(k, +m); }); });

// Tapping a non-field control keeps the focused field (and keyboard), as on iOS.
app.addEventListener('mousedown', function (e) {
  var el = e.target.closest('[data-a]');
  if (el && typing() && !/^(INPUT|TEXTAREA|LABEL)$/.test(el.tagName)) e.preventDefault();
});
app.addEventListener('click', function (e) {
  var el = e.target.closest('[data-a]');
  if (!el || el.tagName === 'INPUT') return;
  if (ui.suppressClick) { ui.suppressClick = false; return; }
  var a = el.getAttribute('data-a'), i = a.indexOf(':'), name = i < 0 ? a : a.slice(0, i), arg = i < 0 ? undefined : a.slice(i + 1);
  // One action+argument runs at a time: a second tap while the first is unfinished (queued behind its guard, or awaiting
  // the bridge) used to run the whole action again and double-write (two "done" events for one check).
  if (busy[a]) return;
  busy[a] = true;
  function fail(err) { console.error('cycle action failed:', err); showErr(plain(err)); }
  var r;
  try {
    if (!ACT[name]) throw new Error('no action ' + name);
    r = ACT[name](arg);
  } catch (err) { delete busy[a]; fail(err); return; }
  Promise.resolve(r).then(null, fail).then(function () { delete busy[a]; });
});
var busy = {};

// ---- Nudge library reorder: hold the grip, drag within its own section -----------------------------------------
// Same hold-then-drag gesture as Home. A row can only move among the rows of its own section (Pinned or All),
// so the sort_order rewrite on drop never has to reconcile two sections. Recent has no grip: it is derived.
(function () {
  var timer = 0, drag = null, y0 = 0, pos = 0, pid = 0;
  function siblings() { return Array.prototype.slice.call(drag.row.parentNode.querySelectorAll('.rem')); }
  app.addEventListener('pointerdown', function (e) {
    var g = e.target.closest('[data-grip]');
    if (!g) return;
    var row = g.closest('.rem'); pid = e.pointerId; y0 = pos = e.clientY;
    timer = setTimeout(function () {
      timer = 0; ui.suppressClick = true;
      drag = { row: row, y: pos }; row.classList.add('lift'); row.setPointerCapture(pid);
    }, 500);
  });
  app.addEventListener('pointermove', function (e) {
    pos = e.clientY;
    if (timer && Math.abs(pos - y0) > 10) { clearTimeout(timer); timer = 0; }
    if (!drag) return;
    var others = siblings().filter(function (r) { return r !== drag.row; });
    var before = others.filter(function (r) { var b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; })[0];
    var top0 = drag.row.getBoundingClientRect().top;
    drag.row.parentNode.insertBefore(drag.row, before || null);
    drag.y += top0 - drag.row.getBoundingClientRect().top; // keep the row under the finger after the DOM move
    drag.row.style.transform = 'translateY(' + (e.clientY - drag.y) + 'px) scale(1.03) rotate(-1deg)';
  });
  function end() {
    clearTimeout(timer); timer = 0;
    if (!drag) return;
    siblings().forEach(function (r, i) { nPatch(ui.ntier, r.getAttribute('data-nid'), { sort_order: i }); });
    drag = null; render();
  }
  app.addEventListener('pointerup', end); app.addEventListener('pointercancel', end);
})();

// ---- Back swipe: drag from the left edge, as in a UINavigationController -------------------------------------------
// Works wherever back() has somewhere to go: a pushed screen, or a non-tab screen opened from a notification (Today).
function canBack() { return !!(S.session && S.couple && !ui.sheet && (ui.stack.length || ['home', 'todo', 'fights', 'progress'].indexOf(ui.route) < 0)); }
(function () {
  var EDGE = 24, sw = null;
  function ph() { return document.querySelector('.phone'); }
  function place(p, dx) { p.style.transform = 'translateX(' + dx + 'px)'; p.style.opacity = 1 - dx / p.offsetWidth / 2; }
  app.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    sw = e.touches.length === 1 && t.clientX <= EDGE && canBack() ? { x: t.clientX, y: t.clientY, dx: 0, v: 0, t: e.timeStamp, on: false } : null;
  }, { passive: true });
  app.addEventListener('touchmove', function (e) {
    if (!sw) return;
    var t = e.touches[0], dx = Math.max(0, t.clientX - sw.x), dy = Math.abs(t.clientY - sw.y);
    if (!sw.on) {
      if (dy > 10 && dy > dx) { sw = null; return; }
      if (dx < 10) return;
      sw.on = true; if (typing()) document.activeElement.blur();
    }
    e.preventDefault();
    sw.v = (dx - sw.dx) / Math.max(1, e.timeStamp - sw.t); sw.t = e.timeStamp; sw.dx = dx;
    place(ph(), dx);
  }, { passive: false });
  function end() {
    var s = sw; sw = null;
    if (!s || !s.on) return;
    var p = ph(), w = p.offsetWidth, leave = s.dx > w / 3 || s.v > 0.5;
    p.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
    place(p, leave ? w : 0);
    setTimeout(function () { if (leave) back(); else { p.style.transition = p.style.transform = p.style.opacity = ''; } }, 200);
  }
  app.addEventListener('touchend', end); app.addEventListener('touchcancel', end);
})();

// ---- Swipe left on an open to-do of mine (To-dos tab or Home) to ignore it ---------------------------------------------------------------
// The row slides left over a pink "Ignore" underlay. On commit it is hidden locally and a toast offers Undo; only when
// the toast has faded is declined_at written (the box pushes the partner's notification off that column, so an accidental
// swipe that was undone must never reach Supabase). A second swipe, leaving the screen or hiding the page commits at once.
var IGNORE_MS = 5000, IGNORE_FADE = 350;
function commitIgnore(noRender) {
  var p = pendIgnore; if (!p) return;
  pendIgnore = null; clearTimeout(p.t1); clearTimeout(p.t2); p.el.remove();
  var t = S.rows.todos[p.id];
  if (t && !closed(t) && !t.deleted_at) St.patch('todos', p.id, { declined_at: nowIso(), decline_note: null });
  if (noRender !== true) render();
}
function undoIgnore() {
  var p = pendIgnore; if (!p) return;
  pendIgnore = null; clearTimeout(p.t1); clearTimeout(p.t2); p.el.remove(); render();
}
function ignoreRow(id) {
  commitIgnore(true);
  var el = document.createElement('div');
  el.className = 'ign-toast'; el.innerHTML = '<span>Ignored</span><b>Undo</b>';
  el.querySelector('b').addEventListener('click', undoIgnore);
  document.body.appendChild(el);
  pendIgnore = { id: id, el: el, t1: setTimeout(function () { el.classList.add('out'); pendIgnore.t2 = setTimeout(commitIgnore, IGNORE_FADE); }, IGNORE_MS) };
  St.native.haptic('success');
  render();
}
(function () {
  var EDGE = 24, sw = null;
  app.addEventListener('touchstart', function (e) {
    var t = e.touches[0], row = e.target.closest && e.target.closest('.td-row[data-sw], .nc[data-sw]');
    sw = row && e.touches.length === 1 && t.clientX > EDGE && !ui.sheet ? { row: row, x: t.clientX, y: t.clientY, dx: 0, v: 0, t: e.timeStamp, on: false } : null;
  }, { passive: true });
  app.addEventListener('touchmove', function (e) {
    if (!sw) return;
    var t = e.touches[0], dx = sw.x - t.clientX, dy = Math.abs(t.clientY - sw.y);
    if (!sw.on) {
      if (dy > 10 && dy > Math.abs(dx)) { sw = null; return; } // vertical wins: a scroll
      if (dx < -10) { sw = null; return; }
      if (dx < 10) return;
      sw.on = true; sw.row.classList.add('swp');
      var ul = document.createElement('span'); ul.className = 'sw-ul'; ul.textContent = 'Ignore'; sw.row.appendChild(ul);
    }
    e.preventDefault();
    dx = Math.max(0, dx);
    sw.v = (dx - sw.dx) / Math.max(1, e.timeStamp - sw.t); sw.t = e.timeStamp; sw.dx = dx;
    sw.row.style.transform = 'translateX(' + -dx + 'px)';
  }, { passive: false });
  function end(e) {
    var s = sw; sw = null;
    if (!s || !s.on) return;
    var w = s.row.offsetWidth, go = e.type === 'touchend' && (s.dx > w * 0.35 || (s.v > 0.6 && s.dx > 40)), id = s.row.getAttribute('data-todo');
    s.row.style.transition = 'transform .18s ease-out';
    s.row.style.transform = 'translateX(' + (go ? -w : 0) + 'px)';
    setTimeout(function () {
      if (go) { ignoreRow(id); return; }
      s.row.style.transition = s.row.style.transform = ''; s.row.classList.remove('swp');
      var u = s.row.querySelector('.sw-ul'); if (u) u.remove();
    }, 180);
  }
  app.addEventListener('touchend', end); app.addEventListener('touchcancel', end);
})();

// ---- native routes ---------------------------------------------------------------------------------------------------
// cycleNative exists from the first script tick so the shell can call route() at any time;
// routes that arrive before boot finishes wait in routeQ and apply once the UI is ready.
var routeQ = [];
// Does the row a deep link names exist on this phone yet? A push can arrive before the poll has pulled its row.
function routeRowExists(kind, id) {
  if (kind === 'nudge') return !!findSend(id);
  if (kind === 'challenge') return ledger().challenges.some(function (x) { return x.id === id; });
  if (kind === 'fight') return !!S.rows.fight_markers[id];
  return !!S.rows.todos[id];
}
function applyRoute(r, synced) {
  if (!S.session || !S.couple) return;
  var m = /^held\/(.+)$/.exec(r);
  var rm = /^(nudge|challenge|fight|todo)\/(.+)$/.exec(r);
  if (rm && !routeRowExists(rm[1], rm[2])) {
    // Sync once and retry; a row that still is not here means a stale link, so land on Today instead of a screen that throws.
    if (synced) { tab('home'); return; }
    return St.syncNow().then(function () { return applyRoute(r, true); });
  }
  if (m) { ui.stack = []; ui.route = 'todo'; ui.sheet = stillHeld(m[1]) ? { type: 'still', id: m[1] } : null; ui.d = {}; render(); }
  else if ((m = /^nudge\/(.+)$/.exec(r))) { ui.stack = []; ui.route = 'nudgein'; ui.sendId = m[1]; ui.d = {}; ui.sheet = null; openSend(m[1]); render(); }
  else if ((m = /^challenge\/(.+)$/.exec(r))) { ui.stack = [{ route: 'progress' }]; ui.route = 'challenge'; ui.chId = m[1]; ui.d = {}; ui.sheet = null; render(); }
  else if ((m = /^fight\/(.+)$/.exec(r))) { ui.stack = [{ route: 'fights' }]; ui.route = 'fightdetail'; ui.fightId = m[1]; ui.d = {}; ui.sheet = null; render(); }
  else if ((m = /^todo\/(.+)$/.exec(r))) { markOwnupSeen(m[1]); ui.stack = [{ route: 'todo' }]; ui.route = 'tododetail'; ui.todoId = m[1]; ui.d = {}; ui.sheet = null; render(); }
  else if (r === 'today') tab('home'); // a reminder scheduled by an older build
  else if (r === 'log-followup' || r === 'todo') { ui.todoSeg = 'todo'; tab('todo'); }
  // 'acks' is the route notifications delivered before owning up became a to do carry; it opens Home.
  else if (r === 'acks') tab('home');
  else throw new Error('unknown route ' + r);
}
// Hold menu on a recording dictation mic (voice-hold.js, the one gesture every app's mics share): holding the mic while it
// listens pops Cancel / Insert. Insert stops and transcribes into the box, which is what a tap does here too, since these mics
// fill their box and never send. Cancel discards the recording and puts the box back to what it held before the mic started
// (ui.rec.orig), so a dictation that came out wrong costs nothing. The Talk screen's mic (.tkmic) is a turn-taking control, not
// dictation, and is not matched by '.mic.rec'.
VoiceHold.init({
  mic: '.mic.rec',
  key: function (el) { return el.getAttribute('data-a'); },
  actions: function (a) {
    var f = a.slice(4); // 'mic:<field>'
    // Asked again at release: a recording that already ended (final transcript, field gone) has nothing to cancel.
    if (!ui.rec || ui.rec.field !== f) return null;
    return {
      insert: guard(finishRec),
      cancel: guard(function () {
        var base = ui.rec.orig, el = document.querySelector('[data-d="' + f + '"]');
        ui.d[f] = base; if (el) el.value = base; saveDraft(draftKey()); if (f === 'more' || f === 'qans') noteSaveSync();
        return stopRec().then(render);
      })
    };
  }
});
// Native calls in through evaluateJavaScript, and WebKit reports a throw from that script to window 'error' only as
// "Script error." with no detail, so each entry point catches its own throw and logs the real one.
function nativeEntry(fn) {
  return function () { try { return fn.apply(null, arguments); } catch (e) { console.error('cycle native call failed:', e); St.logErr('native', e); showErr(plain(e)); } };
}
window.cycleNative = {
  route: function (r) { if (ui.ready) guard(applyRoute)(r); else routeQ.push(r); },
  ready: function () { while (ui.ready && routeQ.length) guard(applyRoute)(routeQ.shift()); },
  pushToken: function (t) { St.setPushToken(t); },
  shake: function (png) { if (ui.ready) openGripe(png); },
  // The shell heard speech and then silence (also sent when the app is backgrounded mid-recording; the clip is kept for the
  // stop). Only Talk acts on it; a dictated field waits for its mic tap.
  speechSilence: function () { if (ui.rec && ui.rec.field === 'talk') guard(talkEndTurn)(); },
  speechError: function (msg) { var talk = ui.rec && ui.rec.field === 'talk'; ui.rec = null; if (talk && ui.talk) { ui.talk.listen = false; render(); } showErr(plain(new Error(msg))); },
  foreground: function () { St.retryPush(); St.abortInflight(); guard(St.flushComplaints)(); if (S.session) { St.sync(); St.pullPriv(); } render(); checkNotif(); checkUpdate(); }
};
Object.keys(window.cycleNative).forEach(function (k) { window.cycleNative[k] = nativeEntry(window.cycleNative[k]); });

// ---- boot --------------------------------------------------------------------------------------------------------------
St.boot().then(function () { return St.hasNative ? St.native.lockGet() : false; }).then(function (lockOn) {  ui.lockOn = lockOn; ui.ready = true; render(); window.cycleNative.ready(); St.native.ready(); checkNotif(); checkUpdate(); guard(St.flushComplaints)();
  // No realtime channel: poll while visible (cursor-based, so a quiet poll is 9 tiny GETs), plus the
  // 15s repaint that moves countdowns and promotes a held item to "ready".
  setInterval(function () { if (document.visibilityState === 'visible' && S.session) St.sync(); }, 5000);
  setInterval(function () { if (!typing()) render(); }, 15000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { commitIgnore(true); guard(talkHalt)(); guard(finishRec)(); } if (document.visibilityState === 'visible') window.cycleNative.foreground(); });
}).catch(function (e) {
  // Boot failed (unreadable storage, bridge error). Say so instead of leaving a blank page; storage is left exactly as found.
  console.error('cycle boot failed:', e);
  app.innerHTML = errScreen(false);
});
})();
