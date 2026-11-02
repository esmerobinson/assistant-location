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
  reorder: false, dirty: false, ready: false, cyc: null,
  mode: 'create', code: null, todoTab: 'all',
  ntier: 'esme', tip: false, nid: null, nedit: null, nfor: 'esme', sendId: null
};

// ---- small helpers -----------------------------------------------------------------------
// Rows scheduled for a future time are invisible to every reader until then (C.isScheduled). Only these two tables
// carry scheduled rows; the sender's own view of them goes through scheduledRows().
var SCHED_TABLES = { items: 1, todos: 1 };
function L(t) { var r = St.list(t); return SCHED_TABLES[t] ? r.filter(function (x) { return !C.isScheduled(x, now()); }) : r; }
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var KIND = { focus: 'Focus', kudos: 'Kudos', truth: 'Truth', ask: 'Ask' };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function ic(id, cls) { return '<svg class="ic ' + (cls || '') + '"><use href="#' + id + '"/></svg>'; }
function now() { return Date.now(); }
function tz() { return S.couple.tz; }
function today() { return C.localDay(now(), tz()); }
function dayName(day) { return WD[C.dow(day)]; }
function fmtDay(day) { var p = day.split('-'); return dayName(day) + ' ' + (+p[2]) + ' ' + MON[+p[1] - 1]; }
function dueOf(day) { return C.dueInfo(day, today(), function (d) { return d <= C.addDays(today(), 6) ? dayName(d) : fmtDay(d); }); }
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
function whenRow(k) {
  return '<div class="frow wh"><span class="lab0">When</span>' + dpick('date', k + 'D', val(k + 'D', today())) + dpick('time', k + 'T', val(k + 'T', nowHm())) + '</div>';
}
function whenMs(k) {
  var hm = val(k + 'T', nowHm()).split(':');
  return Math.min(now(), C.zonedMs(val(k + 'D', today()), +hm[0], +hm[1], tz()));
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
function openTodos(list) { return list.filter(function (t) { return !t.done_at; }); }
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
  [/failed to fetch|load failed|networkerror|internet connection|network request failed/i, 'No connection']
];
function plain(e) {
  var m = String((e && e.message) || e);
  for (var i = 0; i < PLAIN.length; i++) if (PLAIN[i][0].test(m)) return PLAIN[i][1];
  if (e && e.status >= 500) return 'Server error';
  if (e && (e.status === 401 || e.status === 403)) return 'Sign in again';
  if (e && e.status) return 'Try again';
  return m.length <= 28 ? m : 'Try again';
}
function showErr(msg) {
  ui.err = msg; render();
  clearTimeout(ui.errTimer); ui.errTimer = setTimeout(function () { ui.err = null; render(); }, 5000);
}
function guard(fn) {
  return function () {
    var args = arguments;
    return Promise.resolve().then(function () { return fn.apply(null, args); }).catch(function (e) { console.error('cycle action failed:', e); showErr(plain(e)); });
  };
}

// ---- layout pieces -------------------------------------------------------------------------------
// opts.band=false for screens whose mockup has no pink band (Log fight, Settings).
// Every screen gets the tab bar, active tab from the route; opts.tab=false only for modal flows (auth, editors, Week).
function phone(cls, inner, o) {
  o = o || {};
  var band = o.band === false ? '' : '<div class="band" aria-hidden="true"></div>';
  var err = ui.err || S.syncError;
  var off = !navigator.onLine || (S.outbox && S.outbox.length) ? '<span class="off' + (o.band === false ? ' nb' : '') + '">Offline</span>' : '';
  return '<div class="phone ' + cls + (o.tab === false ? ' nt' : '') + '"><div class="scr">' + band + off + '<div class="status"></div><main>' + inner + '</main></div>' +
    (o.tab === false ? '' : tabbar(tabFor(ui.route))) + (o.sheet || '') + (err ? '<div class="errbar' + (o.sheet ? ' top' : '') + '" role="alert">' + esc(err) + '</div>' : '') + '</div>';
}
function tabbar(active) {
  // Badge: open to-dos the partner created for me (what an Ask turns into).
  var n = openTodos(myTodos()).filter(function (t) { return t.created_by !== St.me() && t.type !== 'response'; }).length;
  function tab(id, icon, label, badge) {
    return '<span class="tab' + (active === id ? ' on' : '') + '" data-a="tab:' + id + '">' + ic(icon) + '<b>' + label + '</b>' + (badge ? '<i class="bdg">' + badge + '</i>' : '') + '</span>';
  }
  return '<nav class="tabbar">' + tab('home', 'moon', 'Today') + tab('todo', 'circ', 'Actions', n) + tab('us', 'us', 'Us') + '</nav>';
}
function tabFor(r) { return ['todo', 'tododetail', 'challenge', 'newch'].indexOf(r) >= 0 ? 'todo' : ['us', 'points', 'shop', 'settings', 'cycle'].indexOf(r) >= 0 ? 'us' : 'home'; }
function backLabel() { var p = ui.stack[ui.stack.length - 1]; return { home: 'Today', us: 'Us', cycle: 'Cycle', points: 'Points', todo: 'Actions', settings: 'Settings', nudges: 'Nudges', nudge: 'Nudge', nudgedone: 'Done', talk: 'Talk', kudosnew: 'Talk' }[p && p.route] || 'Today'; }
function back() { var p = ui.stack.pop(); ui.route = p ? p.route : 'home'; ui.d = {}; ui.sheet = null; render(); }
function go(route, extra) {
  ui.stack.push({ route: ui.route });
  ui.route = route; ui.d = {}; ui.sheet = null; ui.reorder = false;
  if (extra) Object.assign(ui, extra);
  render(); var sc = document.querySelector('.scr'); if (sc) sc.scrollTop = 0;
}
function tab(id) { ui.stack = []; ui.route = id; ui.d = {}; ui.sheet = null; ui.reorder = false; render(); }
function hdBack(label) { return '<p class="txtbtn back" data-a="back">' + ic('chev', 'sm') + label + '</p>'; }
function ptsBack(label) { return '<p class="back" data-a="back"><svg><use href="#chev"/></svg>' + label + '</p>'; }
function val(k, def) { return ui.d[k] == null ? (def == null ? '' : def) : ui.d[k]; }
function inp(k, ph, extra) { return '<input class="inp" data-d="' + k + '" value="' + esc(val(k)) + '" placeholder="' + esc(ph || '') + '" ' + (extra || '') + '>'; }
function seg(items, cur, act, cls) {
  return '<div class="seg ' + (cls || '') + '">' + items.map(function (x) { return '<span class="' + (String(x[0]) === String(cur) ? 'on' : '') + '" data-a="' + act + ':' + x[0] + '">' + x[1] + '</span>'; }).join('') + '</div>';
}
// ---- voice input (bridge speech.start / speech.stop; the transcript comes back through cycleNative.speech) ----
var NOTE_SHEETS = { chlog: 1, chlogedit: 1 };
// A note field with a mic at its right end (only where a native shell can listen).
function micField(k, ph) {
  var f = inp(k, ph).replace('class="inp"', 'class="inp fill"');
  if (!St.hasNative) return f;
  var on = ui.rec && ui.rec.field === k;
  return '<div class="micw">' + f + '<span class="mic' + (on ? ' rec' : '') + '" data-a="mic" role="button" aria-label="' + (on ? 'Stop' : 'Voice') + '">' + ic('mic') + '</span></div>';
}
function stopRec() {
  if (!ui.rec) return Promise.resolve();
  ui.rec = null;
  return St.native.speechStop();
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

function rowsOrder() {
  // The saved order wins. Rows added since it was saved (a new default id) are appended in default order,
  // and saved ids no longer in the default set (the removed Send row) are dropped, so an old order never
  // renders a row with no label or screen and never loses the user's arrangement.
  var def = ['nudges', 'todo', 'ack', 'fight'], kept = (prefs().rows || []).filter(function (id) { return def.indexOf(id) >= 0; });
  return kept.concat(def.filter(function (id) { return kept.indexOf(id) < 0; }));
}
function rowMeta(id) {
  if (id === 'nudges') {
    // A queued send to the partner shows the moon tag; otherwise the size of the library.
    if (nudgeTier('esme').sends.some(isQueued)) return '<span class="tmr">' + ic('moon') + 'Tmrw 8 am</span>';
    return nudgeTier('esme').nudges.filter(live).length + ' saved';
  }
  if (id === 'todo') return todoCount();
  if (id === 'ack') return kudosEntries().length || 'None';
  var f = S.priv.fights.slice().sort(function (a, b) { return b.at - a.at; })[0];
  if (!f) return 'None';
  var d = C.localDay(f.at, tz());
  return d === today() ? 'Today' : d === C.addDays(today(), -1) ? 'Yesterday' : 'Last ' + dayName(d);
}
// First open of a local day: what moved in the points since the banner was last dismissed. Recomputed from the ledger
// on every render rather than stored, so a sync that brings the partner's overnight rows in updates it. Stays until
// dismissed, including across launches: marking it seen on first paint would lose it if that launch had no fresh data yet.
var DIGEST_LINES = 3; // chosen to keep the banner small above the Today rows; the rest are on Points
function digestCard(led) {
  var g = C.dailyDigest(led, prefs().digestDay);
  if (!g) return '';
  var d = C.dayDiff(g.start, today()), when = d === 1 ? 'Yesterday' : 'Since ' + (d < 7 ? dayName(g.start) : fmtShort(g.start));
  var more = g.lines.length - DIGEST_LINES;
  return '<div class="dg" data-a="digest"><div class="dgh"><p class="lab">' + when + '</p><p class="dgn">' + sg(g.net) + '</p><span class="dgx" data-a="digestx">&#x2715;</span></div>' +
    g.lines.slice(0, DIGEST_LINES).map(function (l) {
      return '<p class="dgl' + (l.pts < 0 ? ' ls' : '') + '"><b>' + sg(l.pts) + '</b><span>' + esc(l.label) + (l.who ? ' &middot; ' + esc(l.who) : '') + '</span></p>';
    }).join('') + (more > 0 ? '<p class="dgm">+' + more + ' more</p>' : '') + '</div>';
}
var ROWLAB = { nudges: 'Nudges', todo: 'Actions', ack: 'Talk', fight: 'Log fight' };

SCREEN.home = function () {
  var led = ledger(), t = today();
  var cards = C.needsYou({ me: St.me(), now: now(), tz: tz(), items: L('items'), redemptions: L('redemptions'), members: S.members,
    nudge_sends: L('nudge_sends'), nudge_replies: L('nudge_replies'), fight_markers: L('fight_markers'), fight_notes: L('fight_notes'), todos: L('todos'), seen: S.priv.ownupSeen, since: S.priv.ownupSince });
  var html = cards.map(function (n) {
    if (n.type === 'ready') {
      return '<div class="nc pk" data-a="still:' + n.item.id + '"><div class="mid"><p class="s">Still send? &middot; ' + n.count + ' ready</p><p class="x">' + esc(itemTitle(n.item)) + '</p></div><span class="go">Send</span></div>';
    }
    if (n.type === 'approve') {
      var rw = S.rows.rewards[n.redemption.reward_id];
      return '<div class="nc pk tall"><div class="mid"><p class="s">' + pnx(nameOf(n.redemption.requested_by)) + '</p><p class="x">' + esc(rw ? rw.name : '') + ' &middot; ' + n.redemption.price + '</p></div><div class="two"><span class="go" data-a="approve:' + n.redemption.id + '">Approve</span><span class="go o" data-a="decline:' + n.redemption.id + '">Decline</span></div></div>';
    }
    if (n.type === 'fight') {
      return '<div class="nc" data-a="openfight:' + n.marker.id + '"><div class="mid"><p class="s">' + pnx(nameOf(n.marker.logged_by)) + '</p><p class="x">Add your version</p></div>' + ic('chevr', 'chv') + '</div>';
    }
    if (n.type === 'ownup') {
      return '<div class="nc" data-a="tview:' + n.todo.id + '"><div class="mid"><p class="s">From ' + pnx(nameOf(n.todo.owner_id)) + '</p><p class="x">' + esc(n.todo.title) + '</p></div>' + ic('chevr', 'chv') + '</div>';
    }
    if (n.type === 'nudge') {
      return '<div class="nc" data-a="nudgein:' + n.send.id + '"><div class="mid"><p class="s">From ' + pnx(nameOf(n.send.sender_id)) + '</p><p class="x">' + esc(n.send.body) + '</p></div>' + ic('chevr', 'chv') + '</div>';
    }
    // n.type === 'reply': a reply from the other person on one of the nudge threads.
    return '<div class="nc" data-a="replyopen:' + n.reply.send_id + '"><div class="mid"><p class="s">Reply from ' + pnx(nameOf(n.reply.author_id)) + '</p><p class="x">' + esc(n.reply.body) + '</p></div>' + ic('chevr', 'chv') + '</div>';
  }).join('');
  // Week close appears from Sunday until acknowledged.
  if (C.dow(t) === 6 && prefs().weekSeen !== led.current.start) {
    html += '<div class="nc" data-a="go:week"><div class="mid"><p class="x">Week</p><p class="s">' + sg(led.current.net) + '</p></div>' + ic('chevr', 'chv') + '</div>';
  }
  // Only your own late and due-today to dos: the partner's are theirs to act on, and stay on the Actions tab.
  var dueCards = urgentFirst(myTodos().filter(function (x) {
    return !x.done_at && x.due_date && x.due_date <= t;
  })).map(function (x) {
    var d = dueOf(x.due_date);
    return '<div class="nc dc" data-a="tview:' + x.id + '"><div class="mid"><p class="s ' + d.state + '">' + d.text + '</p><p class="x">' + esc(x.title) + '</p></div>' + ic('chevr', 'chv') + '</div>';
  }).join('');
  var rows = rowsOrder().map(function (id) {
    return '<div class="row r2" data-id="' + id + '" data-a="row:' + id + '">' + (ui.reorder ? '<i class="slot"></i>' : '') + '<p class="lb">' + ROWLAB[id] + '</p><p class="mt">' + rowMeta(id) + '</p></div>';
  }).join('');
  var right = ui.reorder ? '<span class="done" data-a="reorderdone">Done</span>' :
    '<span class="bal" data-a="go:points">' + led.balance + '</span>';
  return phone('pts' + (ui.reorder ? ' hold' : ''), '<header class="hd"><div class="ttl"><span class="mark"><svg><use href="#arwh"/></svg></span><div><h2>Today</h2><p class="dl">' + fmtDay(t) + '</p></div></div>' + right + '</header>' +
    (ui.reorder ? '' : digestCard(led)) + '<div class="rows">' + rows + '</div>' + (dueCards ? '<div class="nd"><p class="lab">Due</p>' + dueCards + '</div>' : '') + (html ? '<div class="nd"><p class="lab">Needs you</p>' + html + '</div>' : ''));
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
    (e ? '<div class="ta"><textarea data-d="edit">' + esc(val('edit', i.body)) + '</textarea></div>' : '<p class="ask">' + esc(i.body) + '</p>') +
    '<p class="to">To ' + esc(nameOf(i.recipient_id)) + '</p>' +
    '<div class="acts"><div class="save" data-a="' + (e ? 'editsave' : 'deliver') + ':' + i.id + '">' + (e ? 'Save' : 'Send') + '</div>' + (e ? '' : '<div class="ghost" data-a="edit:' + i.id + '">Edit</div>') + '<div class="tdrop" data-a="drop:' + i.id + '">Drop</div></div>');
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
SCREEN.todo = function () {
  var mine = myTodos(), op = openTodos(mine);
  var held = heldItems();
  function eb(x) { return x.created_by !== St.me() ? '<span class="eb">' + esc(nameOf(x.created_by).charAt(0).toUpperCase()) + '</span>' : ''; }
  // Every row opens its view page (the Edit pill there is the creator's only way into the edit sheet); the Done / +1
  // buttons inside a row carry their own data-a, and the click handler takes the closest one, so they never open it.
  function open(x) { return ' data-a="tview:' + x.id + '"'; }
  function edited(x) { return C.isEdited(x, L('todo_events'), St.me()) ? '<small class="ed">Edited</small>' : ''; }
  function row(x) {
    var resp = x.type === 'response', habit = x.type === 'habit', om = resp ? '<svg><use href="#fa"/></svg>' : eb(x);
    var due = dueTag(x);
    if (habit) {
      var h = hprog(x);
      return '<div class="td-row" data-todo="' + x.id + '"' + open(x) + '><span class="om">' + om + '</span><div class="tx"><p>' + esc(x.title) + '</p>' + tdDesc(x) + lastNote(x) + h.bar + edited(x) + '</div><span class="hv">' + h.hv + '</span><span class="p1b" data-a="tally:' + x.id + '">+1</span></div>';
    }
    return '<div class="td-row" data-todo="' + x.id + '"' + open(x) + '><span class="om">' + om + '</span><div class="tx"><p>' + esc(x.title) + '</p>' + tdDesc(x) + due + edited(x) + '</div><span class="done" data-a="done:' + x.id + '">Done</span></div>';
  }
  var heldHtml = held.length ? section('Held', held.map(function (i) {
    var rd = C.ms(i.held_until) <= now();
    return '<div class="td-row hrow2"><span class="om"><svg class="hold-ic"><use href="#hg"/></svg></span><p class="ht">' + esc(itemTitle(i)) + '</p><p class="hm2">To ' + pn() + '</p><div class="hact"><span class="cd">' + C.countdown(C.ms(i.held_until), now()) + '</span><span class="elink" data-a="still:' + i.id + '">' + (rd ? 'Send' : 'Edit') + '</span></div></div>';
  }).join(''), 'held') : '';
  var sched = scheduledTodos();
  var schedHtml = sched.length ? section('Scheduled', sched.map(function (t) {
    return '<div class="td-row hrow2"><span class="om"></span><p class="ht">' + esc(t.title) + '</p><p class="hm2">' + fmtWhen(C.ms(t.created_at)) + ' &middot; ' + (t.owner_id === St.me() ? 'You' : pn()) + '</p><div class="hact"><span class="elink" data-a="schedcancel:' + t.id + '">Cancel</span></div></div>';
  }).join(''), 'held') : '';
  var theirs = theirTodos(), queued = S.priv.queued;
  // Both sections always show, so whose list a to do sits in is never left to the creator's initial in the circle.
  var ro = section('For ' + pnx(pName()), (theirs.length || queued.length ? '' : '<p class="empty">None</p>') + queued.map(function (q) {
    return '<div class="td-row"><span class="om"></span><div class="tx"><p>' + esc(q.body) + '</p>' + tdDesc(q) + '<small>Queued</small></div></div>';
  }).join('') + urgentFirst(theirs).map(function (x) {
    var resp = x.type === 'response', h = x.type === 'habit' && hprog(x);
    return '<div class="td-row"' + open(x) + '><span class="om">' + (resp ? '<svg><use href="#fa"/></svg>' : '') + '</span><div class="tx"><p>' + esc(x.title) + '</p>' + tdDesc(x) + (h ? '' : dueTag(x)) + lastNote(x) + (h ? h.bar : '') + '</div>' + (h ? '<span class="hv">' + h.hv + '</span>' : '') + '</div>';
  }).join(''), 'ro2');
  var sh = ui.sheet && ui.sheet.type === 'newtodo' ? newTodoSheet() : ui.sheet && ui.sheet.type === 'note' ? noteSheet() : ui.sheet && ui.sheet.type === 'still' ? stillSheet() : ui.sheet && ui.sheet.type === 'addpick' ? addPick() : '';
  // Mine, urgent first: Today holds what is late or due today plus Response items, Open the rest (habits included).
  var mineList = urgentFirst(op), isNow = function (x) { return x.type === 'response' || isHot(x); };
  var nowRows = mineList.filter(isNow), laterRows = mineList.filter(function (x) { return !isNow(x); });
  var chs = ledger().challenges;
  return phone('p2 td' + (held.length || sched.length ? ' hl' : ''), '<header class="hd"><div><h2>Actions</h2><p class="dl">' + todoCount() + '</p></div><span class="fight" data-a="addpick">Add</span></header>' + heldHtml + schedHtml +
    (chs.length ? section('Challenges', '<div class="deck">' + chs.map(chCard).join('') + '</div>') : '') +
    (nowRows.length ? section('Today', nowRows.map(row).join('')) : '') +
    (laterRows.length || !nowRows.length ? section('Open', laterRows.length ? laterRows.map(row).join('') : '<p class="empty">None</p>') : '') + ro, { sheet: sh });
};
// The Add picker: Task, Habit and Owning up open the new-to-do sheet on that type, Challenge opens its own screen.
function addPick() {
  return sheet('ap', '<div class="bsh"><h3>New</h3><span class="x" data-a="sheet:close">&#x2715;</span></div>' +
    [['newtodo:task', 'Task'], ['newtodo:habit', 'Habit'], ['newtodo:ownup', 'Owning up'], ['newch', 'Challenge']].map(function (o) { return '<div class="opt' + (o[0] === 'newch' ? ' hl' : '') + '" data-a="' + o[0] + '">' + o[1] + ic('chevr', 'chv') + '</div>'; }).join(''));
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
    '<div class="ta msg"><textarea data-d="desc" placeholder="Description (optional)">' + esc(val('desc')) + '</textarea></div>' +
    (t ? '' : '<div class="frow"><span class="lab0">For</span>' + seg([['me', 'You'], ['them', pn()]], s.who, 'nfor') + '</div>') +
    '<div class="frow"><span class="lab0">Type</span>' + seg([['task', 'Task'], ['habit', 'Habit'], ['ownup', 'Owning up']], s.kind, 'nkind') + '</div>' +
    (s.kind !== 'habit' ? '<div class="frow"><span class="lab0">Due</span><span class="chip' + (val('due') ? '' : ' on') + '" data-a="nodue">None</span>' + dpick('date', 'due', val('due')) + '</div>' : '') +
    (s.kind === 'habit' ? '<div class="frow"><span class="lab0">Per</span>' + seg([['day', 'Day'], ['week', 'Week'], ['month', 'Month']], s.period, 'nper', 'hs') + '</div><div class="frow"><span class="lab0">Times</span>' + stepper('tgt') + '</div>' : '') +
    '<div class="frow"><span class="lab0">Earn</span>' + stepper('pe') + '</div><div class="frow"><span class="lab0">Lose</span>' + stepper('pm') + '</div>' +
    // An owning-up is its note, so the toggle is hidden and savetodo forces needs_note on.
    (s.kind === 'ownup' ? '' : '<div class="frow"><span class="lab0">Needs a note</span>' + tgl('nn', 'nnote') + '</div>') +
    (t ? '' : laterRow(s.when === 'later', 'nwhen')) +
    (notes.length ? '<p class="lab">Log</p>' + notes.map(function (e) { return '<p class="tdd">' + esc(fmtDay(C.localDay(C.ms(e.at), tz()))) + ' &middot; ' + esc(e.note) + '</p>'; }).join('') : '') +
    (t ? '<div class="acts"><div class="save" data-a="savetodo">Save</div><div class="tdrop" data-a="tododel:' + t.id + '">Delete</div></div>' : '<div class="save" data-a="savetodo">Save</div>'));
}
// The view page of one to do: everything about it, the log, a Ping when it is the partner's, and a comment thread.
// Edit is the existing edit sheet, offered only to the creator (and never for a response to do), as before.
function todoComments(id) { return L('todo_comments').filter(function (c) { return c.todo_id === id && !c.deleted_at; }).sort(function (a, b) { return C.ms(a.created_at) - C.ms(b.created_at); }); }
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
  if (!t || t.deleted_at) { ui.stack.pop(); ui.route = 'todo'; ui.sheet = null; return SCREEN.todo(); }
  var mineOwn = t.owner_id === St.me(), habit = t.type === 'habit', h = habit && hprog(t);
  var notes = L('todo_events').filter(function (e) { return e.todo_id === t.id && e.note; }).sort(function (a, b) { return C.ms(b.at) - C.ms(a.at); });
  function fr(l, v) { return '<div class="frow"><span class="lab0">' + l + '</span><span>' + v + '</span></div>'; }
  function dueFact(x) { var d = dueOf(x.due_date), hot = !x.done_at && d.state; return fmtDay(x.due_date) + (hot ? ' <span class="due ' + d.state + '">' + d.text + '</span>' : ''); }
  var facts = fr('For', mineOwn ? 'You' : pnx(nameOf(t.owner_id))) + fr('From', t.created_by === St.me() ? 'You' : pnx(nameOf(t.created_by))) +
    (habit ? fr('Progress', h.hv + (t.period ? ' ' + { day: 'today', week: 'this week', month: 'this month' }[t.period] : '')) : t.due_date ? fr('Due', dueFact(t)) : '') +
    fr('Earn', C.earnPts(t)) + fr('Lose', C.missPts(t)) + (t.done_at ? fr('Done', fmtDay(C.localDay(C.ms(t.done_at), tz()))) : '');
  var canNudge = !mineOwn && !t.done_at, nudged = nudgedToday(t.id);
  var nudge = canNudge ? '<div class="ghost' + (nudged ? ' dis' : '') + '"' + (nudged ? '' : ' data-a="tnudge:' + t.id + '"') + '>' + (nudged ? 'Pinged' : 'Ping') + '</div>' : '';
  var cm = todoComments(t.id);
  var thread = cm.map(function (c) { return '<div class="fn"><p class="meta">' + pnx(nameOf(c.author_id)) + ' &middot; ' + noteStamp(C.ms(c.created_at)) + '</p><p>' + esc(c.body) + '</p></div>'; }).join('');
  var edit = t.created_by === St.me() && t.type !== 'response' ? '<span class="fight" data-a="etodo:' + t.id + '">Edit</span>' : '';
  var sh = ui.sheet && ui.sheet.type === 'newtodo' ? newTodoSheet() : '';
  return phone('p2 tdd2', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>' + esc(t.title) + '</h2></div>' + edit + '</header>' +
    (t.description ? '<section><p class="tdd">' + esc(t.description) + '</p></section>' : '') +
    '<section class="list">' + facts + (habit ? h.bar : '') + '</section>' +
    (notes.length ? section('Log', notes.map(function (e) { return '<p class="tdd">' + esc(fmtDay(C.localDay(C.ms(e.at), tz()))) + ' &middot; ' + esc(e.note) + '</p>'; }).join('')) : '') +
    (nudge ? '<section>' + nudge + '</section>' : '') +
    section('Comments', (thread ? '<div class="fns">' + thread + '</div>' : '') + '<div class="ta nt"><textarea data-d="cmt" placeholder="Comment">' + esc(val('cmt')) + '</textarea></div><div class="save" data-a="tcomment:' + t.id + '">Send</div>'),
    { sheet: sh });
};
function noteSheet() {
  var t = S.rows.todos[ui.sheet.id];
  return sheet('', '<div class="bsh"><h3>' + esc(clip(t.title, 28)) + '</h3><span class="x" data-a="sheet:close">&#x2715;</span></div>' +
    '<p class="lab">What did you do</p><div class="ta msg"><textarea data-d="note">' + esc(val('note')) + '</textarea></div><div class="save" data-a="lognote">Log</div>');
}

// Single-choice Yes/No chips for a Log fight question; tapping the selected chip clears it.
function yn(k) {
  return '<div class="tdc">' + [['yes', 'Yes'], ['no', 'No']].map(function (c) { return '<span class="chip' + (ui.d[k] === c[0] ? ' on' : '') + '" data-a="yn:' + k + ':' + c[0] + '">' + c[1] + '</span>'; }).join('') + '</div>';
}
function ynVal(v) { return v === 'yes' ? true : v === 'no' ? false : null; }
SCREEN.fight = function () {
  var d = ui.d, i = d.int || 3, chips = d.chips || {}, esme = St.myMember().hits_self;
  var arrows = [1, 2, 3, 4, 5].map(function (n) {
    return '<span' + (n === i ? ' class="sel"' : ' style="color:#5e5e5e"') + ' data-a="int:' + n + '"><svg><use href="#' + (n === i ? 'arwh' : 'arw') + '"/></svg><b>' + n + '</b></span>';
  }).join('');
  return phone('p2 s2', '<header class="hd"><div><h2>Log a fight</h2></div><span class="txtbtn" data-a="back">Cancel</span></header>' +
    '<section><p class="lab">Intensity</p><div class="arrows">' + arrows + '</div><div class="ends"><span>Low</span><span>High</span></div></section>' +
    // Esme is the one who may hit herself, so her questions are in the first person; the flag lives on her member row.
    '<section><p class="lab">' + (esme ? 'Did you hit yourself?' : 'Did she hit herself?') + '</p>' + yn('hit') +
    (d.hit === 'yes' ? '<div class="frow"><span class="lab0">How many times?</span><div class="stp"><span data-a="hitn:-1"><svg class="ic sm"><path d="M6 12h12"/></svg></span><b>' + (d.hitN === 0.5 ? '.5' : d.hitN || 1) + '</b><span data-a="hitn:1">' + ic('plus', 'sm') + '</span></div></div>' : '') +
    (d.hit === 'yes' ? '<div class="ck' + (d.hitNot ? ' on' : '') + '" data-a="hitnot"><i></i><span>Click here if it was not related to ' + (esme ? pn() : 'you') + '</span></div>' : '') + '</section>' +
    '<section><p class="lab">What happened</p><div class="ta nt"><textarea data-d="note">' + esc(val('note')) + '</textarea></div>' + whenRow('when') + '</section>' +
    '<section><p class="lab">Ask ' + pn() + ' to</p><div class="tdc">' + [['apologize', 'Apologize'], ['reflect', 'Reflect'], ['custom', 'Custom']].map(function (c) { return '<span class="chip' + (chips[c[0]] ? ' on' : '') + '" data-a="chip:' + c[0] + '">' + c[1] + '</span>'; }).join('') + '</div>' +
    (chips.custom ? '<p class="lab">Title</p>' + inp('customTitle') : '') + '</section>' +
    '<div class="save" data-a="fightsave">Save</div>', { band: false });
};

// Notes are append-only and shared: both people read the same time-ordered list and can only add.
function fightNotes(id) { return L('fight_notes').filter(function (n) { return n.fight_marker_id === id; }).sort(function (a, b) { return C.ms(a.created_at) - C.ms(b.created_at); }); }
function noteStamp(ms) { return fmtDay(C.localDay(ms, tz())) + ' &middot; ' + fmtTime(ms); }
SCREEN.fightdetail = function () {
  var mk = S.rows.fight_markers[ui.fightId], notes = fightNotes(mk.id), mine = notes.some(function (n) { return n.author_id === St.me(); });
  var old = mk.logged_by === St.me() ? S.priv.fights.filter(function (f) { return f.id === mk.id; })[0] : null;
  var oldNote = old && old.about ? '<div class="fn"><p class="meta">' + pnx(nameOf(mk.logged_by)) + ' &middot; ' + noteStamp(C.ms(mk.at)) + '</p><p>' + esc(old.about) + '</p></div>' : '';
  var list = oldNote + notes.map(function (n) {
    return '<div class="fn"><p class="meta">' + pnx(nameOf(n.author_id)) + ' &middot; ' + noteStamp(C.ms(n.created_at)) + '</p><p>' + esc(n.body) + '</p></div>';
  }).join('');
  var prev = ui.stack[ui.stack.length - 1];
  return phone('p2 fd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Fight</h2><p class="dl">' + noteStamp(C.ms(mk.at)) + '</p></div></header>' +
    (list ? '<section class="fns">' + list + '</section>' : '') +
    '<section><p class="lab">' + (mk.logged_by !== St.me() && !mine ? 'Add your version' : 'Add more') + '</p><div class="ta nt"><textarea data-d="more">' + esc(val('more')) + '</textarea></div>' + whenRow('mw') + '</section>' +
    '<div class="save" data-a="notesave">Save</div>', { tab: tabFor(prev && prev.route) });
};

SCREEN.us = function () {
  var truths = L('items').filter(function (i) { return i.kind === 'truth' && i.recipient_id === St.me() && i.status === 'delivered' && !i.deleted_at; }).sort(byDelivered).slice(0, 3);
  var tr = truths.length ? truths.map(function (i) {
    var hl = C.heldLabel(i);
    return '<div class="tru"><p>' + esc(i.body) + '</p><p class="hm">' + (hl ? '<svg><use href="#hg"/></svg>' + hl + ' &middot; ' : '') + pnx(nameOf(i.sender_id)) + ' &middot; ' + dayName(C.localDay(C.ms(i.delivered_at), tz())) + '</p></div>';
  }).join('') : '<p class="empty">None</p>';
  var led = ledger();
  return phone('p2 s4 ur', '<header class="hd"><div><h2>Us</h2></div><span class="gear" data-a="go:settings">' + ic('cog') + '</span></header>' +
    '<div class="sum" data-a="go:points"><div><p class="lab">Balance</p><p class="big">' + led.balance + '</p></div><div class="r"><p class="lab">This week</p><p class="big">' + sg(led.current.net) + '</p></div>' + ic('chevr', 'chv') + '</div>' +
    '<div class="srow" data-a="go:shop"><span>Shop</span>' + ic('chevr', 'sm') + '</div>' +
    '<section><p class="lab">Truths</p>' + tr + '</section>' +
    '<div class="srow" data-a="go:cycle"><span>Cycle</span>' + ic('chevr', 'sm') + '</div>');
};

SCREEN.settings = function () {
  var hrs = [[0, 'None'], [60, '1h'], [120, '2h'], [720, '12h'], [1440, '24h']];
  function hold(kind) { return '<div class="hrw2"><span class="hl0">' + KIND[kind] + '</span>' + seg(hrs, C.holdMinutes(S.couple, kind), 'hold' + kind, 'h5') + '</div>'; }
  return phone('p2 s5 st', '<header class="hd"><div>' + hdBack('Us') + '<h2>Settings</h2></div></header>' +
    '<section class="grp"><p class="lab">Holds<span class="tag">Shared</span></p>' + hold('truth') + hold('ask') + '</section>' +
    (St.hasNative ? '<div class="srow" data-a="facelock"><span>Face ID</span><span class="val">' + (ui.lockOn ? 'On' : 'Off') + '</span></div>' : '') +
    '<div class="srow" data-a="export"><span>Export</span>' + ic('chevr', 'sm') + '</div>' +
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

SCREEN.challenge = function () {
  var c = ledger().challenges.filter(function (x) { return x.id === ui.chId; })[0];
  if (!c) throw new Error('unknown challenge ' + ui.chId);
  var tap = c.breaks_on === 'tap', goal = c.breaks_on === 'goal';
  var logRow = ui.sheet && ui.sheet.id ? S.rows.challenge_days[ui.sheet.id] : null;
  var sh = ui.sheet && ui.sheet.type === 'chlog' ? sheet('t3', '<div class="bsh"><h3>Log today</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Note</p>' + micField('chlognote', 'What did you do?') + '<div class="acts" style="margin-top:44px"><div class="save" data-a="chlogsave">Save</div></div>')
    : ui.sheet && ui.sheet.type === 'chlogedit' && logRow ? sheet('t3', '<div class="bsh"><h3>' + fmtShort(logRow.day) + '</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Note</p>' + micField('chlognote', 'What did you do?') + '<div class="acts" style="margin-top:44px"><div class="save" data-a="chlogeditsave">Save</div><div class="tdrop" data-a="chlogdelq">Delete</div></div>')
    : ui.sheet && ui.sheet.type === 'chlogdel' && logRow ? sheet('t3', '<div class="bsh"><h3>Delete ' + fmtShort(logRow.day) + '?</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><div class="acts" style="margin-top:44px"><div class="save" data-a="chlogdel">Delete</div><div class="tdrop" data-a="sheet:close">Cancel</div></div>')
    : ui.sheet && ui.sheet.type === 'broke' ? sheet('t3', '<div class="bsh"><h3>Broke it</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Note</p>' + inp('brnote', 'Optional').replace('class="inp"', 'class="inp fill"') + '<div class="acts" style="margin-top:44px"><div class="save" data-a="brsave">Save</div></div>')
    : ui.sheet && ui.sheet.type === 'chedit' ? sheet('', '<div class="bsh"><h3>Edit</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div><p class="lab">Name</p>' + inp('chname').replace('class="inp"', 'class="inp fill"') + '<div class="acts"><div class="save" data-a="chsave">Save</div></div>') : '';
  function stat(l, v) { return '<div><p class="lab">' + l + '</p><p class="big">' + v + '</p></div>'; }
  var rules = '<div class="rules"><p class="rule">+1, +2, +3&hellip; up to +10 a day, plus +10 every week and +100 every month!</p>' + (tap ? '' : '<p class="rule">A hit: &minus;10, then &minus;5 for each more that day. A .5 is half.</p>') + '</div>';
  var notes = L('challenge_days').filter(function (x) { return x.challenge_id === c.id && !x.deleted_at; }).sort(function (a, b) { return a.day < b.day ? 1 : -1; });
  function goalBody() { var open = c.opens <= today(); return '<p class="rule">' + esc(c.rule || '') + '</p>' + (c.accepted && open
    ? '<div class="four g">' + stat('Days', c.count + '/' + c.goal_days) + stat('Due', monDay(c.deadline)) + stat('Reward', sg(c.goal_earn)) + stat('Miss', sg(-c.goal_miss)) + '</div>' + challengeCal(c, today()) +
      notes.map(function (x) { return '<p class="rule" data-a="chlogedit:' + esc(x.id) + '"><b>' + fmtShort(x.day) + '</b> ' + esc(x.note) + '</p>'; }).join('') +
      (c.for_user === St.me() && c.status === 'active' && !c.logged_today ? '<div class="pin"><div class="save" data-a="chlog">Log today</div></div>' : '')
    : '<div class="four g">' + stat(open ? 'Days' : 'Starts', open ? '0/' + c.goal_days : monDay(c.opens)) + stat('Due', monDay(c.deadline)) + stat('Reward', sg(c.goal_earn)) + stat('Miss', sg(-c.goal_miss)) + '</div>' + (c.accepted ? '' : c.for_user === St.me() ? '<div class="save" data-a="chaccept">Accept</div>' : '<p class="lab">Waiting for ' + esc(nameOf(c.for_user)) + '</p>')); }
  // Ping: only on the partner's challenge, until it is done or failed (not started counts). Pinned with Broke it when both show.
  var pinged = pingedToday(c.id), canPing = c.for_user !== St.me() && c.status !== 'done' && c.status !== 'failed';
  var pingBtn = canPing ? '<div class="ghost' + (pinged ? ' dis' : '') + '"' + (pinged ? '' : ' data-a="chping:' + c.id + '"') + '>' + (pinged ? 'Pinged' : 'Ping') + '</div>' : '';
  var pinger = pingBtn ? '<div class="pin">' + pingBtn + '</div>' : '';
  var body = goal ? goalBody() + pinger : c.accepted
    ? '<div class="four">' + stat('Day', c.day) + stat('Tonight', sg(c.tonight)) + stat('Best', c.best) + stat('Earned', c.earned) + '</div>' + challengeCal(c, today()) + rules + (tap && !c.broken_today ? '<div class="pin"><div class="ghost" data-a="broke">Broke it</div>' + pingBtn + '</div>' : pinger)
    : rules + (c.for_user === St.me() ? '<div class="save" data-a="chaccept">Accept</div>' : '<p class="lab">Waiting for ' + esc(nameOf(c.for_user)) + '</p>') + pinger;
  return phone('pts cdet', '<header class="hd"><div>' + ptsBack(backLabel()) + '<h2>' + esc(c.name) + '</h2></div><span class="pillb" data-a="chedit">Edit</span></header>' + body, { sheet: sh });
};

SCREEN.shop = function () {
  var led = ledger(), pend = L('redemptions').filter(function (r) { return r.status === 'pending'; });
  var items = L('rewards').filter(function (r) { return !r.archived; }).sort(function (a, b) { return a.price - b.price; }).map(function (r) {
    var isP = pend.some(function (p) { return p.reward_id === r.id; });
    return '<div class="it' + (r.price > led.balance ? ' no' : '') + '" data-a="reward:' + r.id + '"><span class="rthumb">' + artSvg(r.art, 'row') + '</span><span class="nm">' + esc(r.name) + '</span><span class="pr">' + (isP ? 'Pending' : r.price) + '</span></div>';
  }).join('');
  var sh = '';
  if (ui.sheet && ui.sheet.type === 'redeem') {
    var r = S.rows.rewards[ui.sheet.id];
    sh = sheet('', '<div class="bsh"><h3>' + esc(r.name) + '</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div>' + '<div class="rart">' + artSvg(r.art, 'big') + '</div>' + '<p class="ask">Spend ' + r.price + '?</p><p class="to">' + led.balance + ' &rarr; ' + (led.balance - r.price) + '</p><div class="acts"><div class="save" data-a="redeem:' + r.id + '">Ask ' + pn() + '</div><div class="tdrop" data-a="sheet:close">Cancel</div></div>');
  } else if (ui.sheet && ui.sheet.type === 'addreward') {
    sh = sheet('', '<div class="bsh"><h3>Add</h3><span class="xb" data-a="sheet:close">&#x2715;</span></div>' + '<p class="lab">Reward</p>' + inp('rname').replace('class="inp"', 'class="inp fill"') + '<div class="frow"><span class="lab0">Price</span><input class="inp" type="number" inputmode="numeric" min="0" data-d="rprice" value="' + esc(val('rprice')) + '"></div><div class="save" data-a="savereward">Save</div>');
  }
  return phone('pts', '<header class="hd"><div>' + ptsBack(backLabel()) + '<h2>Shop</h2></div><span class="bal" style="transform:translateY(-8px)">' + led.balance + '</span></header><div class="shop">' + items + '<div class="it add" data-a="addreward"><span class="nm">Add</span></div></div>', { sheet: sh });
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
function repliesFor(sendIds) {
  return L('nudge_replies').filter(function (r) { return sendIds[r.send_id] && !r.deleted_at; }).sort(function (a, b) { return C.ms(a.created_at) - C.ms(b.created_at); });
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

SCREEN.nudges = function () {
  var tier = ui.ntier, T = nudgeTier(tier), sec = C.sectionNudges(T.nudges, T.sends);
  function row(n, grip) {
    var q = T.sends.some(function (s) { return s.nudge_id === n.id && isQueued(s); });
    var right = (q ? '<span class="tmr">' + ic('moon', 'moon') + 'Tmrw</span>' : '') + (grip ? '<svg class="ic gr" data-a="noop" data-grip="1"><use href="#grip"/></svg>' : '');
    return '<div class="rem c' + (q ? ' t' : '') + '" data-nid="' + n.id + '" data-a="nudge:' + n.id + '"><div><p>' + esc(n.body) + '</p><small>' + nudgeMeta(tier, n) + '</small></div>' + (right ? '<div class="rt">' + right + '</div>' : '') + '</div>';
  }
  function group(label, list, key, grip) {
    return list.length ? '<div class="lst" data-sec="' + key + '"><p class="lab">' + label + '</p>' + list.map(function (n) { return row(n, grip); }).join('') + '</div>' : '';
  }
  var total = sec.pinned.length + sec.recent.length + sec.all.length, all = total + sec.done.length;
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Nudges</h2><p class="dl">' + total + ' saved</p></div><span class="plus" data-a="nudgenew">' + ic('plus') + '</span></header>' +
    seg([['esme', pn()], ['me', 'Me']], tier, 'ntier') +
    (all ? group('Pinned', sec.pinned, 'pinned', true) + group('Recent', sec.recent, 'recent', false) + group('All', sec.all, 'all', true) + group('Done', sec.done, 'done', false) : '<p class="empty">None</p>'));
};

function thread(sends) {
  // Replies grouped under the date their nudge went out; sends without replies are skipped.
  return sends.slice().sort(function (a, b) { return C.ms(a.deliver_at) - C.ms(b.deliver_at); }).map(function (s) {
    var reps = repliesFor(idSet([s]));
    if (!reps.length) return '';
    var p = C.localDay(C.ms(s.deliver_at), tz()).split('-');
    return '<p class="when">' + (+p[2]) + ' ' + MON[+p[1] - 1] + '</p>' + reps.map(function (r) {
      var mine = r.author_id === St.me();
      return '<div class="bub ' + (mine ? 'me' : 'her') + '">' + esc(r.body) + '<small>' + esc(mine ? 'You' : nameOf(r.author_id)) + ' · ' + fmtTime(C.ms(r.created_at)) + '</small></div>';
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
SCREEN.nudge = function () {
  var tier = ui.ntier, n = nudgeRow(tier, ui.nid), sends = nudgeTier(tier).sends.filter(function (s) { return s.nudge_id === n.id; });
  var late = isLate(tier), shared = tier === 'esme', aw = n.done_at && awardOf(n.id);
  var thr = shared ? '<div class="th">' + thread(sends) + '</div>' + (replyTarget() ? replyBox() : '') : '';
  if (aw) {
    // Done card: Send again is a normal send (8 pm rule applies) and the nudge stays in Done.
    var st = C.awardStatus(aw, today(), tz());
    return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Nudges</h2><p class="dl">' + (sends.length ? 'Sent ' + sends.length + (sends.length === 1 ? ' time' : ' times') : 'Not sent') + '</p></div></header>' +
      '<div class="card dn"><p class="q2">' + esc(n.body) + '</p><p class="meta">Done ' + fmtShort(C.localDay(C.ms(n.done_at), tz())) + ' \u00b7 ' + (st.complete ? st.total + ' paid' : st.paid + ' of ' + st.total + ' paid') + '</p>' +
      (late && ui.tip ? '<div class="tip">' + TIP_TEXT + '</div>' : '') +
      '<div class="row3"><span class="btn o" data-a="nudgesend">Send again' + (late ? '<span class="qm" data-a="tip">?</span>' : '') + '</span>' +
      (st.complete || st.stopped ? '' : '<span class="btn g bd" data-a="nudgestop">Stop the rest</span>') + '</div></div>' + thr);
  }
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Nudges</h2><p class="dl">' + (sends.length ? 'Sent ' + sends.length + (sends.length === 1 ? ' time' : ' times') : 'Not sent') + '</p></div></header>' +
    '<div class="card"><p class="q2">' + esc(n.body) + '</p>' + (n.pinned ? '<p class="meta">pinned</p>' : '') +
    (late && ui.tip ? '<div class="tip">' + TIP_TEXT + '</div>' : '') +
    '<span class="btn f" data-a="nudgesend">' + (late ? 'Send tomorrow<span class="qm" data-a="tip">?</span>' : 'Send') + '</span>' +
    '<div class="row3"><span class="btn o" data-a="nudgepin">' + (n.pinned ? 'Unpin' : 'Pin') + '</span><span class="btn o" data-a="nudgeedit">Edit</span></div>' +
    // Points only exist between the two of us: a Me nudge can be archived but never marked done.
    (shared ? '<div class="row3"><span class="btn o" data-a="nudgedone">Done</span><span class="btn g bd" data-a="nudgearchive">Archive</span></div>' : '<span class="btn g" data-a="nudgearchive">Archive</span>') + '</div>' + thr);
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
  var name = priv ? '' : nameOf(s.sender_id);
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>' + (priv ? 'Nudge' : 'From ' + pnx(name)) + '</h2><p class="dl">' + fmtDay(C.localDay(C.ms(s.deliver_at), tz())) + '</p></div></header>' +
    '<div class="card"><p class="quote">' + esc(s.body) + '</p></div>' +
    (priv ? '' : '<div class="th">' + thread(sendsOfNudge(s.nudge_id)) + '</div>' + replyBox()));
};

// Add / edit. Edit keeps the nudge in its tier, so For is only offered when creating.
SCREEN.nudgenew = function () {
  var edit = ui.nedit ? nudgeRow(ui.nfor, ui.nedit) : null;
  if (edit && ui.d.nbody == null) ui.d.nbody = edit.body;
  var late = isLate(ui.nfor);
  return phone('p2 nd', '<header class="hd"><div><h2>' + (edit ? 'Edit' : 'New') + '</h2><p class="dl">&nbsp;</p></div><span class="txtbtn" data-a="back">Cancel</span></header>' +
    '<div class="ta msg"><textarea data-d="nbody">' + esc(val('nbody')) + '</textarea></div>' +
    (edit ? '' : '<section><p class="lab">For</p>' + seg([['esme', pn()], ['me', 'Me']], ui.nfor, 'nudgefor') + '</section>') +
    (late && ui.tip && !edit ? '<div class="tip">' + TIP_TEXT + '</div>' : '') +
    (edit ? '<div class="save" data-a="nudgesave">Save</div>' :
      '<div class="pair"><span class="ghost" data-a="nudgesave">Save</span><span class="save" data-a="nudgenewsend">' + (late ? 'Send tomorrow<span class="qm" data-a="tip">?</span>' : 'Send') + '</span></div>'), { tab: false });
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

// ---- Talk -------------------------------------------------------------------------------------------------------
// Kudos only. Owning up is a to-do type ('ownup', see the Actions screen and the Home needs-you card), so it has no list here.
SCREEN.talk = function () {
  function sub(label, act, inner) { return '<section class="list"><p class="lab tsh"><span>' + label + '</span><span class="elink" data-a="' + act + '">Add</span></p>' + (inner || '<p class="empty">None</p>') + '</section>'; }
  return phone('p2 nd', '<header class="hd"><div>' + hdBack(backLabel()) + '<h2>Talk</h2></div></header>' + sub('Kudos', 'kudosnew', kudosRows()));
};

// Kudos list: given and received between us (items).
function kudosEntries() {
  var me = St.me(), out = [];
  L('items').filter(function (i) { return i.kind === 'kudos' && !i.deleted_at && i.status !== 'dropped' && (i.sender_id === me || (i.recipient_id === me && i.status === 'delivered')); })
    .forEach(function (i) {
      var mine = i.sender_id === me;
      out.push({ at: C.ms(i.delivered_at || i.created_at), body: i.body, small: (mine ? 'To ' : 'From ') + pn() + (i.gift_points > 0 ? ' &middot; ' + i.gift_points + (i.gift_points === 1 ? ' point' : ' points') : i.gift_points == null && i.points === false ? ' &middot; No points' : '') + (i.status === 'held' ? ' &middot; Held' : '') });
    });
  return out.sort(function (a, b) { return b.at - a.at; });
}
function kudosRows() {
  return kudosEntries().map(function (k) {
    return '<div class="rem c"><div><p>' + esc(k.body) + '</p><small>' + k.small + ' &middot; ' + fmtDay(C.localDay(k.at, tz())) + '</small></div></div>';
  }).join('');
}
SCREEN.kudosnew = function () {
  return phone('p2 nd', '<header class="hd"><div><h2>Kudos</h2><p class="dl">&nbsp;</p></div><span class="txtbtn" data-a="back">Cancel</span></header>' +
    inp('ktext', 'Kudos').replace('class="inp"', 'class="inp fill"') +
    '<div class="frow"><span class="lab0">Gift points</span><input class="inp" type="number" inputmode="numeric" min="0" step="1" data-d="kgift" value="' + esc(val('kgift')) + '"></div>' +
    '<div class="save" data-a="kudossave">Send</div>', { tab: false });
};

// ---- Cycle (private) screen -----------------------------------------------------------------------------
// Ring geometry and per-phase angles are measured from the approved mockup (degrees clockwise from top).
var SEG = { Fight: [4.3, 31.7], Cool: [40.3, 146.9], Warm: [155.5, 283.7], Tension: [292.3, 355.7] };
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
function fightRecs() { return S.priv.fights.slice().sort(function (a, b) { return b.at - a.at; }); }
// The logger's own words: the pre-sharing on-device text, else their first shared note.
function fightText(f) { var n = fightNotes(f.id).filter(function (x) { return x.author_id === St.me(); })[0]; return f.about || (n ? n.body : ''); }
function chipsFor(f) {
  var tds = L('todos').filter(function (t) { return t.fight_marker_id === f.id; }), out = '';
  var chk = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  tds.forEach(function (t) { out += '<span class="rc' + (t.done_at ? ' d' : '') + '">' + (t.done_at ? chk : '') + esc(t.title) + '</span>'; });
  var mk = S.rows.fight_markers[f.id], hit = mk && C.hitText(mk, 'me');
  if (hit) out += '<span class="rc">' + esc(hit) + '</span>';
  return out;
}
function ix(n) { var s = ''; for (var i = 1; i <= 5; i++) s += '<i' + (i <= n ? ' class="f"' : '') + '></i>'; return '<span class="ix">' + s + '</span>'; }
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
  var selF = fights.filter(function (f) { return C.localDay(f.at, tz()) === cy.sel; })[0];
  var det = selF ? '<section class="det" data-a="openfight:' + selF.id + '"><div class="meta"><span>' + dayName(cy.sel) + ' ' + (+cy.sel.slice(8)) + ' &middot; ' + fmtTime(selF.at) + '</span>' + ix(selF.intensity) + '</div><p>' + esc(fightText(selF)) + '</p><div class="rcs">' + chipsFor(selF) + '</div></section>' : '';
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
  if (s) {
    if (s.type === 'newtodo') return 'todo:' + (s.edit || 'new');
    if (s.type === 'still') return s.edit ? 'still:' + s.id : null;
    if (s.type === 'note' || s.type === 'chlogedit') return s.type + ':' + s.id;
    if (s.type === 'chlog' || s.type === 'broke' || s.type === 'chedit') return s.type + ':' + ui.chId;
    return s.type === 'addreward' ? 'addreward' : null; // the rest (pickers, confirms) have no text field
  }
  if (name === 'fight' || name === 'kudosnew' || name === 'newch') return name;
  if (name === 'fightdetail') return name + ':' + ui.fightId;
  if (name === 'tododetail') return name + ':' + ui.todoId;
  if (name === 'nudge') return name + ':' + ui.nid;
  if (name === 'nudgein') return name + ':' + ui.sendId;
  if (name === 'nudgenew') return name + ':' + (ui.nedit || 'new');
  return null;
}
// Choices held outside ui.d. Without them a restored ask to the partner would come back as a note to self.
var DRAFT_UI = { 'nudgenew': ['nfor'] };
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
  syncDraft();
  if (ui.rec && !(ui.sheet && NOTE_SHEETS[ui.sheet.type])) guard(stopRec)(); // the mic only lives while its sheet is up
  var sc = document.querySelector('.scr'), top = sc ? sc.scrollTop : 0, name = currentScreen(), key = name + (ui.sheet ? 's' : '');
  // A tapped control must not close the keyboard: hand focus to the field's twin after the swap (else .scr grows and clamps scrollTop).
  var fa = document.activeElement, fk = typing() && fa.getAttribute('data-d'), fs = fk && fa.selectionStart, fe = fk && fa.selectionEnd;
  var html = SCREEN[name]();
  // Sheets are rendered inside the owning screen (so they inherit its family CSS); screens that
  // host sheets read ui.sheet themselves. Everything else shows the sheet via the shared hook below.
  if (ui.notif && S.session) html = html.replace(/<\/div>$/, notifSheet() + '</div>');
  if (ui.sheet && name !== 'todo' && name !== 'tododetail' && name !== 'shop' && name !== 'challenge') html = html.replace(/<\/div>$/, sheetFor() + '</div>');
  app.innerHTML = html;
  // Before scrollTop is restored below: a box still at its min height would make .scr too short and clamp it.
  app.querySelectorAll('.ta.nt textarea').forEach(fitNote);
  var ns = document.querySelector('.scr');
  var nf = fk && lastKey.split('|')[0] === name && document.querySelector('[data-d="' + fk + '"]');
  if (nf) { nf.focus({ preventScroll: true }); if (fs != null) nf.setSelectionRange(fs, fe); } // email inputs have no selection
  if (ns && lastKey.split('|')[0] === name) ns.scrollTop = top;
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
function notifKey() { return 'notifnag:' + St.me(); }
async function checkNotif() {
  if (!St.hasNative || !S.session) return;
  var status = await St.native.status();
  ui.notif = status === 'denied' && (await St.kv.get(notifKey())) !== '1';
  render();
}
function sheetFor() { return ui.sheet.type === 'still' ? stillSheet() : ''; }

// Re-render on store changes unless the user is typing.
function typing() { var a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); }
window.addEventListener('online', function () { if (ui.ready) render(); });
window.addEventListener('offline', function () { if (ui.ready) render(); });
St.on(function () { if (S.priv && S.priv.queued.length && St.partner()) flushQueued(); if (!ui.ready) return; if (typing()) ui.dirty = true; else render(); });
document.addEventListener('focusout', function () { setTimeout(function () { if (ui.dirty && !typing()) { ui.dirty = false; render(); } }, 0); });
app.addEventListener('input', function (e) {
  var k = e.target.getAttribute('data-d'); if (!k) return;
  ui.d[k] = e.target.value;
  saveDraft(draftKey());
  if (ui.rec && ui.rec.field === k) guard(stopRec)(); // typing takes over from the mic
  if (e.target.closest('.ta.nt')) fitNote(e.target);
  if (k === 'dotherv') doneRefresh();
  var nb = k === 'chname' && document.getElementById('chnew');
  if (nb) nb.classList.toggle('dis', !e.target.value.trim());
  var pt = e.target.getAttribute('data-pt');
  if (pt) e.target.previousElementSibling.textContent = dispPick(pt, e.target.value);
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
function sendItem(kind, o) {
  var item = C.buildItem({ id: St.uuid(), couple: S.couple, me: St.me(), to: St.partner().user_id, kind: kind, gift_points: o.gift_points, body: o.body, description: o.description, ask_type: o.ask_type, due_date: o.due_date, target: o.target, period: o.period, points_earn: o.points_earn, points_miss: o.points_miss, needs_note: o.needs_note, origin: o.origin, response_type: o.response_type, fight_marker_id: o.fight_marker_id, now: now(), at: o.at != null ? C.scheduleAt(S.couple, kind, o.at, now()) : null });
  St.insert('items', item);
  if (item.status === 'delivered' && kind === 'ask') deliverAsk(item);
  return item;
}
function celebrate(item, el) { M.play(item.status === 'held' ? 'hold' : item.kind === 'kudos' ? 'kudos' : 'send', el); St.native.haptic('success'); }
// Asks saved before the partner joined go out through the normal Ask hold the moment they appear.
function flushQueued() {
  var q = S.priv.queued; S.priv.queued = []; St.savePriv();
  q.forEach(function (o) { sendItem('ask', o); });
}
function todoTally(t, el, note) {
  St.patch('todos', t.id, { tally: t.tally + 1 });
  St.insert('todo_events', { id: St.uuid(), couple_id: S.couple.id, todo_id: t.id, user_id: St.me(), kind: 'tally', at: nowIso(), note: note || null });
  M.play('points', el, C.earnPts(t));
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
  St.insert('fight_markers', { id: id, couple_id: S.couple.id, logged_by: St.me(), at: new Date(at).toISOString(), repaired_at: null,
    // Shared on purpose: the partner sees these on the Points ledger's Fight line. null = not answered;
    // hit_related is false only when the "not related" box is checked after a Yes (the DB rejects it otherwise), else null.
    hit_self: ynVal(d.hit), hit_related: d.hit === 'yes' && d.hitNot ? false : null,
    // How many times, >= 1 after a Yes; null otherwise (the DB rejects any other combination).
    hit_count: d.hit === 'yes' ? d.hitN || 1 : null });
  // The first note is shared immediately and deliberately skips the hold; only the asks wait.
  if (note) St.insert('fight_notes', { id: St.uuid(), couple_id: S.couple.id, fight_marker_id: id, author_id: St.me(), body: note, created_at: new Date(at).toISOString() });
  [['apologize', 'Apologize'], ['reflect', 'Reflect'], ['custom', (d.customTitle || '').trim()]].forEach(function (c) {
    if (chips[c[0]] && c[1]) sendItem('ask', { body: c[1], ask_type: 'task', origin: 'fight', response_type: c[0], fight_marker_id: id });
  });
  // Intensity is the only part that stays on this phone.
  S.priv.fights.push({ id: id, at: at, intensity: d.int || 3 });
  St.savePriv();
  draftSent();
  M.play('crack', el);
  tab('home');
}
function saveNote() {
  var body = (ui.d.more || '').trim();
  if (!body) return;
  St.insert('fight_notes', { id: St.uuid(), couple_id: S.couple.id, fight_marker_id: ui.fightId, author_id: St.me(), body: body, created_at: new Date(whenMs('mw')).toISOString() });
  draftSent(); ui.d.more = ''; delete ui.d.mwD; delete ui.d.mwT; render();
}

var ACT = {
  back: back,
  go: function (r) { go(r); },
  tab: tab,
  sheet: function () { ui.sheet = null; ui.d = {}; render(); },
  mic: guard(function () {
    if (ui.rec) return stopRec().then(render);
    var field = 'chlognote';
    ui.rec = { field: field, base: ui.d[field] || '' }; render();
    return St.native.speechStart().catch(function (e) { ui.rec = null; throw e; });
  }),
  notifx: function () { ui.notif = false; render(); },
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
  row: function (id) { if (ui.reorder) return; if (id === 'ack') ACT.talk(); else go(id === 'fight' ? 'fight' : id); },
  reorderdone: function () { ui.reorder = false; render(); },
  decline: guard(function (id) { St.patch('redemptions', id, { status: 'declined', decided_by: St.me(), decided_at: nowIso() }); }),
  approve: guard(function (id) {
    var el = document.querySelector('.nc.tall'), price = S.rows.redemptions[id].price;
    St.patch('redemptions', id, { status: 'approved', decided_by: St.me(), decided_at: nowIso() });
    M.play('points', el, -price);
  }),
  still: function (id) { ui.sheet = stillHeld(id) ? { type: 'still', id: id } : null; ui.d = {}; render(); },
  edit: function (id) { ui.sheet.edit = true; render(); },
  editsave: guard(function (id) { var b = (ui.d.edit || '').trim(); if (!b) throw new Error('Message needed'); St.patch('items', id, { body: b }); draftSent(); ui.sheet.edit = false; ui.d = {}; render(); }),
  deliver: guard(function (id) { var el = document.querySelector('.bs .save'); deliver(S.rows.items[id]); M.play('send', el); ui.sheet = null; render(); }),
  drop: guard(function (id) { St.patch('items', id, { status: 'dropped' }); ui.sheet = null; render(); }),
  addpick: function () { ui.sheet = { type: 'addpick' }; ui.d = {}; render(); },
  newtodo: function (kind) { ui.sheet = { type: 'newtodo', who: 'them', when: 'now', kind: 'task', period: 'week', tgt: 3, pe: 3, pm: 3, pt: false, nn: false }; ui.d = {}; ACT.nkind(kind); },
  etodo: function (id) {
    var t = S.rows.todos[id];
    ui.sheet = { type: 'newtodo', edit: id, kind: t.type, period: t.period || 'week', tgt: t.target || 3, pe: C.earnPts(t), pm: C.missPts(t), pt: true, nn: t.needs_note };
    ui.d = { title: t.title, desc: t.description || '', due: t.due_date || '' }; render();
  },
  tview: function (id) { markOwnupSeen(id); go('tododetail', { todoId: id }); },
  tnudge: guard(function (id) {
    var t = S.rows.todos[id];
    if (t.owner_id === St.me() || t.done_at || t.deleted_at) throw new Error('Cannot nudge');
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
  tcomment: guard(function (id) {
    var body = (ui.d.cmt || '').trim(); if (!body) throw new Error('Comment needed');
    var n = nowIso();
    St.insert('todo_comments', { id: St.uuid(), couple_id: S.couple.id, todo_id: id, author_id: St.me(), body: body, created_at: n, updated_at: n, deleted_at: null });
    draftSent(); ui.d.cmt = ''; render();
  }),
  nfor: function (v) { ui.sheet.who = v; render(); },
  nkind: function (v) { setTodoKind(ui.sheet, v); render(); },
  nper: function (v) { ui.sheet.period = v; render(); },
  stp: function (a) { var p = a.split(':'), s = ui.sheet; s[p[0]] = Math.max(p[0] === 'tgt' ? 1 : 0, s[p[0]] + +p[1]); if (p[0] !== 'tgt') s.pt = true; render(); },
  nnote: function () { ui.sheet.nn = !ui.sheet.nn; render(); },
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
    var f = { title: title, description: (ui.d.desc || '').trim() || null, type: s.kind, due_date: !habit ? ui.d.due || null : null, target: habit ? s.tgt : null, period: habit ? s.period : null, points_earn: s.pe, points_miss: s.pm, needs_note: nn };
    var at = !s.edit && s.when === 'later' ? laterMs() : null;
    if (at !== null && s.who === 'me' && at <= now()) throw new Error('Pick a future time');
    if (s.edit) St.patch('todos', s.edit, Object.assign(f, { edited_at: nowIso() }));
    else if (s.who === 'them') {
      var ask = { at: at, body: title, description: f.description, ask_type: s.kind, due_date: f.due_date, target: f.target, period: f.period, points_earn: s.pe, points_miss: s.pm, needs_note: nn };
      if (St.partner()) sendItem('ask', ask); else { S.priv.queued.push(ask); St.savePriv(); }
    }
    else St.insert('todos', Object.assign({ id: St.uuid(), couple_id: S.couple.id, owner_id: St.me(), created_by: St.me(), item_id: null, fight_marker_id: null, tally: 0, done_at: null, edited_at: null, created_at: at !== null ? new Date(at).toISOString() : nowIso(), updated_at: nowIso(), deleted_at: null }, f));
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  tododel: guard(function (id) { St.patch('todos', id, { deleted_at: nowIso() }); draftSent('todo:' + id); ui.sheet = null; ui.d = {}; if (ui.route === 'tododetail') back(); else render(); }),
  done: guard(function (id) {
    var t = S.rows.todos[id];
    if (t.needs_note) { ui.sheet = { type: 'note', id: id, kind: 'done' }; ui.d = {}; render(); }
    else todoDone(t, document.querySelector('[data-todo="' + id + '"] .om'));
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
  yn: function (a) { var p = a.split(':'), k = p[0], v = p[1]; ui.d[k] = ui.d[k] === v ? null : v; render(); },
  // Steps .5, 1, 2, 3...; .5 is a light hit.
  hitn: function (a) { var n = ui.d.hitN || 1; ui.d.hitN = n === 0.5 ? (+a > 0 ? 1 : 0.5) : n === 1 && +a < 0 ? 0.5 : n + +a; render(); },
  hitnot: function () { ui.d.hitNot = !ui.d.hitNot; render(); },
  chip: function (c) { ui.d.chips = ui.d.chips || {}; ui.d.chips[c] = !ui.d.chips[c]; render(); },
  fightsave: guard(function () { logFight(); }),
  notesave: guard(saveNote),
  openfight: function (id) { go('fightdetail', { fightId: id }); },
  hold: guard(function (arg) { /* arg = kind:minutes */ }),
  facelock: guard(async function () { await St.native.lockSet(!ui.lockOn); ui.lockOn = await St.native.lockGet(); render(); }),
  export: guard(function () {
    var text = JSON.stringify(S.priv, null, 2);
    // WKWebView cannot download a blob URL, so inside the shell the export goes through the native share sheet.
    if (St.hasNative) return St.native.share({ filename: 'cycle-private.json', text: text });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'cycle-private.json'; a.click();
  }),
  reward: function (id) {
    var r = S.rows.rewards[id], led = ledger();
    if (L('redemptions').some(function (x) { return x.reward_id === id && x.status === 'pending'; })) return;
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
    var n = (ui.d.chname || '').trim(); if (!n) return;
    var id = St.uuid();
    St.insert('challenges', { couple_id: S.couple.id, id: id, name: n, start: today(), for_user: val('chfor', St.partner().user_id), breaks_on: val('chbr', 'tap'), accepted_at: null, created_at: nowIso(), updated_at: nowIso() });
    draftSent();
    ui.route = ui.stack.pop().route;
    go('challenge', { chId: id });
  }),
  broke: function () { ui.sheet = { type: 'broke' }; ui.d = {}; render(); },
  brsave: guard(function () {
    var c = ledger().challenges.filter(function (x) { return x.id === ui.chId; })[0];
    if (c.broken_today) return;
    St.insert('challenge_breaks', { couple_id: S.couple.id, id: St.uuid(), challenge_id: ui.chId, day: today(), note: (ui.d.brnote || '').trim() || null, by: St.me(), created_at: nowIso(), updated_at: nowIso() });
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  chlog: function () { ui.sheet = { type: 'chlog' }; ui.d = {}; render(); },
  chlogsave: guard(function () {
    var note = (ui.d.chlognote || '').trim(); if (!note) throw new Error('Note needed');
    var c = ledger().challenges.filter(function (x) { return x.id === ui.chId; })[0];
    if (c.logged_today || c.status !== 'active') return;
    return stopRec().then(function () {
      // (challenge_id, day) is unique on the server: a day deleted earlier is revived in place, not inserted again.
      var old = St.list('challenge_days').filter(function (x) { return x.challenge_id === ui.chId && x.day === today(); })[0];
      if (old) St.patch('challenge_days', old.id, { note: note, deleted_at: null });
      else St.insert('challenge_days', { couple_id: S.couple.id, id: St.uuid(), challenge_id: ui.chId, day: today(), note: note, by: St.me(), created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
      draftSent(); ui.sheet = null; ui.d = {}; render();
    });
  }),
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
  chaccept: guard(function () { St.patch('challenges', ui.chId, { accepted_at: nowIso() }); render(); }),
  chsave: guard(function () {
    var n = (ui.d.chname || '').trim(); if (!n) throw new Error('Name needed');
    if (n !== S.rows.challenges[ui.chId].name) St.patch('challenges', ui.chId, { name: n });
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  addreward: function () { ui.sheet = { type: 'addreward' }; ui.d = {}; render(); },
  savereward: guard(function () {
    var n = (ui.d.rname || '').trim(), p = parseInt(ui.d.rprice, 10);
    if (!n || !(p >= 0)) throw new Error('Name and price needed');
    St.insert('rewards', { id: St.uuid(), couple_id: S.couple.id, name: n, price: p, created_by: St.me(), archived: false, created_at: nowIso(), updated_at: nowIso() });
    draftSent(); ui.sheet = null; ui.d = {}; render();
  }),
  digestx: function () { prefs().digestDay = today(); St.savePriv(); render(); },
  digest: function () { prefs().digestDay = today(); St.savePriv(); go('points'); },
  weekshop: function () { M.play('week'); prefs().weekSeen = ledger().current.start; St.savePriv(); ui.route = 'shop'; ui.stack = [{ route: 'home' }]; render(); },
  weekdone: function () { M.play('week'); prefs().weekSeen = ledger().current.start; St.savePriv(); tab('home'); },
  // ---- Nudges ----
  noop: function () {},
  ntier: function (t) { ui.ntier = t; render(); },
  nudge: function (id) { markRead(idSet(sendsOfNudge(id))); go('nudge', { nid: id, tip: false }); },
  tip: function () { ui.tip = !ui.tip; render(); },
  nudgesend: guard(function () {
    var el = document.querySelector('.card .btn.f') || document.querySelector('.card .btn.o');
    doSend(ui.ntier, nudgeRow(ui.ntier, ui.nid)); ui.tip = false;
    M.play('send', el); render();
  }),
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
  nudgenew: function () { go('nudgenew', { nedit: null, nfor: ui.ntier }); },
  nudgefor: function (v) { ui.nfor = v; render(); },
  // Save only: the nudge joins the library of the tier chosen in For, and the library shows that tier.
  nudgesave: guard(function () { saveNudge(); draftSent(); ui.ntier = ui.nfor; back(); }),
  nudgenewsend: guard(function () {
    var el = document.querySelector('.pair .save');
    var row = saveNudge(); doSend(ui.nfor, row); draftSent(); ui.ntier = ui.nfor; ui.tip = false;
    M.play('send', el); back();
  }),
  // Replies are not held: the row goes straight into the outbox.
  nreply: guard(function () {
    var body = (ui.d.reply || '').trim(), s = replyTarget();
    if (!body) return;
    St.insert('nudge_replies', { id: St.uuid(), couple_id: S.couple.id, send_id: s.id, author_id: St.me(), body: body, read_at: null,
      created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    draftSent(); ui.d.reply = ''; render();
  }),
  nudgein: function (id) { openSend(id); go('nudgein', { sendId: id }); },
  replyopen: function (id) { openSend(id); go('nudgein', { sendId: id }); },
  // ---- Talk ----
  talk: function () { go('talk'); },
  // ---- Kudos ----
  kudosnew: function () { go('kudosnew'); },
  kudossave: guard(function () {
    var body = (ui.d.ktext || '').trim(), el = document.querySelector('.save');
    if (!body) { M.play('jiggle', document.querySelector('.inp')); throw new Error('Kudos needed'); }
    var gift = (ui.d.kgift || '').trim();
    if (gift && !/^\d+$/.test(gift)) { M.play('jiggle', document.querySelector('[data-d="kgift"]')); throw new Error('Whole number needed'); }
    if (!St.partner()) throw new Error('No partner yet');
    celebrate(sendItem('kudos', { body: body, gift_points: gift ? +gift : 0 }), el);
    draftSent();
    back();
  }),
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
  if (!ACT[name]) throw new Error('no action ' + name);
  ACT[name](arg);
});

// ---- Home reorder: long-press a row, then drag ------------------------------------------------------------------
(function () {
  var timer = 0, drag = null, pid = 0, y0 = 0, pos = 0;
  function startDrag(row, y) { drag = { row: row, y: y }; row.classList.add('drag'); row.setPointerCapture(pid); }
  app.addEventListener('pointerdown', function (e) {
    var row = e.target.closest('.rows .row');
    if (!row) return;
    pid = e.pointerId; y0 = pos = e.clientY;
    if (!ui.reorder) {
      // Press-hold enters reorder mode and the same finger carries straight on into the drag.
      var id = row.getAttribute('data-id');
      timer = setTimeout(function () {
        timer = 0; ui.reorder = true; ui.suppressClick = true; render();
        startDrag(document.querySelector('.rows .row[data-id="' + id + '"]'), pos);
      }, 500);
      return;
    }
    startDrag(row, e.clientY);
  });
  app.addEventListener('pointermove', function (e) {
    pos = e.clientY;
    if (timer && Math.abs(pos - y0) > 10) { clearTimeout(timer); timer = 0; }
    if (!drag) return;
    drag.row.style.transform = 'translateY(' + (e.clientY - drag.y) + 'px) scale(1.03)';
    var rows = Array.prototype.slice.call(document.querySelectorAll('.rows .row')).filter(function (r) { return r !== drag.row; });
    var before = rows.filter(function (r) { var b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; })[0];
    var parent = drag.row.parentNode, y0r = drag.row.getBoundingClientRect().top;
    parent.insertBefore(drag.row, before || null);
    drag.y += y0r - drag.row.getBoundingClientRect().top; // keep the row under the finger after the DOM move
    drag.row.style.transform = 'translateY(' + (e.clientY - drag.y) + 'px) scale(1.03)';
  });
  function end() {
    clearTimeout(timer); timer = 0;
    if (!drag) return;
    prefs().rows = Array.prototype.map.call(document.querySelectorAll('.rows .row'), function (r) { return r.getAttribute('data-id'); });
    St.savePriv(); drag = null; render();
  }
  app.addEventListener('pointerup', end); app.addEventListener('pointercancel', end);
})();

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
function canBack() { return !!(S.session && S.couple && !ui.sheet && (ui.stack.length || ['home', 'todo', 'us'].indexOf(ui.route) < 0)); }
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

// ---- native routes ---------------------------------------------------------------------------------------------------
// cycleNative exists from the first script tick so the shell can call route() at any time;
// routes that arrive before boot finishes wait in routeQ and apply once the UI is ready.
var routeQ = [];
function applyRoute(r) {
  if (!S.session || !S.couple) return;
  var m = /^held\/(.+)$/.exec(r);
  if (m) { ui.stack = []; ui.route = 'todo'; ui.sheet = stillHeld(m[1]) ? { type: 'still', id: m[1] } : null; ui.d = {}; render(); }
  else if ((m = /^nudge\/(.+)$/.exec(r))) { ui.stack = []; ui.route = 'nudgein'; ui.sendId = m[1]; ui.d = {}; ui.sheet = null; openSend(m[1]); render(); }
  else if ((m = /^challenge\/(.+)$/.exec(r))) { ui.stack = [{ route: 'todo' }]; ui.route = 'challenge'; ui.chId = m[1]; ui.d = {}; ui.sheet = null; render(); }
  else if ((m = /^todo\/(.+)$/.exec(r))) { markOwnupSeen(m[1]); ui.stack = [{ route: 'todo' }]; ui.route = 'tododetail'; ui.todoId = m[1]; ui.d = {}; ui.sheet = null; render(); }
  else if (r === 'today') tab('home'); // a reminder scheduled by an older build
  else if (r === 'log-followup' || r === 'todo') tab('todo');
  // 'acks' is the route notifications delivered before owning up became a to do carry; it opens Talk.
  else if (r === 'acks') { tab('home'); ACT.talk(); }
  else throw new Error('unknown route ' + r);
}
window.cycleNative = {
  route: function (r) { if (ui.ready) applyRoute(r); else routeQ.push(r); },
  ready: function () { while (ui.ready && routeQ.length) applyRoute(routeQ.shift()); },
  pushToken: function (t) { St.setPushToken(t); },
  // Transcript so far (the whole utterance, not a delta); final = capture ended (natural end, or the shell stopped it).
  speech: function (text, final) {
    if (!ui.rec) return;
    var f = ui.rec.field, el = document.querySelector('[data-d="' + f + '"]');
    if (text) { ui.d[f] = C.appendSpeech(ui.rec.base, text); if (el) el.value = ui.d[f]; saveDraft(draftKey()); }
    if (final) { ui.rec = null; render(); }
  },
  speechError: function (msg) { ui.rec = null; showErr(plain(new Error(msg))); },
  foreground: function () { if (S.session) St.sync(); render(); checkNotif(); }
};

// ---- boot --------------------------------------------------------------------------------------------------------------
St.boot().then(function () { return St.hasNative ? St.native.lockGet() : false; }).then(function (lockOn) {
  ui.lockOn = lockOn; ui.ready = true; render(); window.cycleNative.ready(); St.native.ready(); checkNotif();
  // No realtime channel: poll while visible (cursor-based, so a quiet poll is 9 tiny GETs), plus the
  // 15s repaint that moves countdowns and promotes a held item to "ready".
  setInterval(function () { if (document.visibilityState === 'visible' && S.session) St.sync(); }, 5000);
  setInterval(function () { if (!typing()) render(); }, 15000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') guard(stopRec)(); if (document.visibilityState === 'visible') window.cycleNative.foreground(); });
});
})();
