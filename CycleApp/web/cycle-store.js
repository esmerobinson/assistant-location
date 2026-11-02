// Cycle store: storage adapter, session, shared-row cache, private tier, outbox
// and Supabase sync (plain fetch against PostgREST + GoTrue, no supabase-js).
//
// Two storage backends, chosen ONCE at boot: the native `cycle` bridge when the
// iOS shell injected it (native data survives app updates; file-origin web
// storage does not), otherwise localStorage with no-op notifications (dev + tests).
var CycleStore = (function () {
  'use strict';
  var C = CycleCore;
  var cfg = window.CYCLE_CONFIG;
  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('config.js missing or incomplete: window.CYCLE_CONFIG needs supabaseUrl + supabaseAnonKey');

  // ---- storage adapter --------------------------------------------------
  var hasNative = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cycle);
  var calls = {}, callSeq = 0;
  // Native replies arrive on this global; ids pair them with their promise.
  window.__cycleReply = function (id, result, error) {
    var p = calls[id]; delete calls[id];
    if (!p) throw new Error('cycle bridge reply for unknown call ' + id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  };
  function bridge(cmd, args) {
    return new Promise(function (resolve, reject) {
      var id = ++callSeq; calls[id] = { resolve: resolve, reject: reject };
      window.webkit.messageHandlers.cycle.postMessage({ id: id, cmd: cmd, args: args || {} });
    });
  }
  var LS = 'cycle:';
  var kv = hasNative ? {
    get: function (k) { return bridge('store.get', { key: k }); },
    set: function (k, v) { return bridge('store.set', { key: k, value: v }); },
    keys: function (p) { return bridge('store.keys', { prefix: p }); }
  } : {
    get: function (k) { return Promise.resolve(localStorage.getItem(LS + k)); },
    set: function (k, v) { if (v === null) localStorage.removeItem(LS + k); else localStorage.setItem(LS + k, v); return Promise.resolve(); },
    keys: function (p) { return Promise.resolve(Object.keys(localStorage).filter(function (k) { return k.indexOf(LS + p) === 0; }).map(function (k) { return k.slice(LS.length); })); }
  };
  var native = {
    // Tells the shell the page can take calls. CycleBridge holds the push token, notification taps, foreground and
    // speech callbacks until this arrives, so without it the box never learns this phone's push token.
    ready: function () { return hasNative ? bridge('ready') : Promise.resolve(); },
    permission: function () { return hasNative ? bridge('notify.permission') : Promise.resolve(false); },
    schedule: function (o) { return hasNative ? bridge('notify.schedule', o) : Promise.resolve(); },
    cancel: function (id) { return hasNative ? bridge('notify.cancel', { id: id }) : Promise.resolve(); },
    // 'granted' | 'denied' | 'notDetermined' without prompting; the browser has no notifications ('unsupported').
    status: function () { return hasNative ? bridge('notify.status') : Promise.resolve('unsupported'); },
    // Opens this app's page in iOS Settings.
    openSettings: function () { return hasNative ? bridge('app.openSettings') : Promise.resolve(); },
    haptic: function (kind) { return hasNative ? bridge('haptic', { kind: kind }) : Promise.resolve(); },
    // Presents the iOS share sheet with `text` as a file; resolves true once presented.
    share: function (o) { return bridge('share', o); },
    // Clipboard / share sheet for plain text (the invite code); the browser falls back to its own APIs.
    copy: function (text) { return hasNative ? bridge('clipboard.set', { text: text }) : navigator.clipboard.writeText(text); },
    shareText: function (text) {
      if (hasNative) return bridge('share.text', { text: text });
      if (!navigator.share) throw new Error('Share unavailable');
      return navigator.share({ text: text });
    },
    // Face ID app lock flag (native only; the browser has no lock).
    // Live speech-to-text into a page field: start resolves once capture runs (rejects 'Mic off' when denied); text arrives via cycleNative.speech.
    speechStart: function () { return bridge('speech.start'); },
    speechStop: function () { return bridge('speech.stop'); },
    lockGet: function () { return hasNative ? bridge('lock.get') : Promise.resolve(false); },
    lockSet: function (on) { return hasNative ? bridge('lock.set', { on: on }) : Promise.resolve(); }
  };
  // Keychain-held credentials for silent re-login when GoTrue rejects the refresh token.
  var creds = {
    set: function (email, password) { return hasNative ? bridge('creds.set', { email: email, password: password }) : Promise.resolve(); },
    get: function () { return hasNative ? bridge('creds.get') : Promise.resolve(null); },
    clear: function () { return hasNative ? bridge('creds.clear') : Promise.resolve(); }
  };

  // ---- state ---------------------------------------------------------------
  var SHARED = ['items', 'todos', 'todo_events', 'fight_markers', 'rewards', 'redemptions', 'nudges', 'nudge_sends', 'nudge_replies', 'nudge_awards', 'fight_notes', 'challenges', 'challenge_breaks', 'challenge_days', 'todo_comments', 'todo_nudges', 'challenge_nudges'];
  // Pull strategy per table: cursor column, or null = re-pull everything each sync.
  // nudge_sends MUST be re-pulled whole: the recipient's RLS hides a send until deliver_at, and when it
  // becomes visible its updated_at is old (it was stamped at insert), so an updated_at cursor would skip it forever.
  var CURSOR = { items: 'updated_at', todos: 'updated_at', rewards: 'updated_at', redemptions: 'updated_at', todo_events: 'updated_at', fight_markers: null, nudges: 'updated_at', nudge_sends: null, nudge_replies: 'updated_at', nudge_awards: 'updated_at', fight_notes: 'updated_at', challenges: 'updated_at', challenge_breaks: 'updated_at', challenge_days: 'updated_at', todo_comments: 'updated_at', todo_nudges: 'updated_at', challenge_nudges: 'updated_at' };
  // Sort column for tables with no cursor (the default is `at`).
  var ORDER = { nudge_sends: 'created_at' };
  var S = { session: null, couple: null, members: [], rows: {}, cursors: {}, outbox: [], priv: null, syncError: null, syncing: false,
    // Writes the server permanently refused, kept whole (never deleted automatically) so the person can read and export the text.
    deadLetters: [], persistError: null, loaded: false, pushFails: 0, pushNextAt: 0, pushErr: null };
  SHARED.forEach(function (t) { S.rows[t] = {}; });
  var listeners = [];
  function emit() { listeners.forEach(function (f) { f(); }); }
  function on(f) { listeners.push(f); }
  function nowIso() { return new Date().toISOString(); }
  function uuid() { return crypto.randomUUID(); }

  function me() { return S.session && S.session.user.id; }
  function partner() { return S.members.filter(function (m) { return m.user_id !== me(); })[0] || null; }
  function myMember() { return S.members.filter(function (m) { return m.user_id === me(); })[0] || null; }
  function list(t) { return Object.keys(S.rows[t]).map(function (k) { return S.rows[t][k]; }); }
  function get(t, id) { return S.rows[t][id]; }

  // ---- persistence ---------------------------------------------------------
  var persistTimer = 0;
  function persist() {
    clearTimeout(persistTimer);
    // persistNow already reported its failure (S.persistError + error bar); the catch only stops a second, unhandled rejection.
    persistTimer = setTimeout(function () { persistNow().catch(function () {}); }, 50);
  }
  // Writes everything that must survive a kill. A failed write is never silent: it sets S.persistError (shown in the
  // error bar) and still rejects so an awaiting caller (sign-out, token refresh) stops too.
  // S.loaded guards the shared/priv writes: if loadUserData failed half way, S holds empty rows, and writing them would
  // overwrite the person's real data with nothing.
  async function persistNow() {
    clearTimeout(persistTimer);
    try {
      var uid = me();
      var jobs = [kv.set('session', JSON.stringify(S.session))];
      if (uid && S.loaded) {
        jobs.push(kv.set('shared.' + uid, JSON.stringify({ couple: S.couple, members: S.members, rows: S.rows, cursors: S.cursors, outbox: S.outbox, deadLetters: S.deadLetters })));
        if (S.priv) jobs.push(kv.set('priv.' + uid, JSON.stringify(S.priv)));
      }
      await Promise.all(jobs);
      if (S.persistError) { S.persistError = null; emit(); }
    } catch (e) {
      console.error('cycle persist failed:', e);
      if (!S.persistError) { S.persistError = 'Not saved'; emit(); }
      throw e;
    }
  }

  // Me nudges live here, never in Supabase: `nudges` shaped like the shared table, `nudge_sends` like
  // nudge_sends (recipient = me) so the UI treats both tiers with one code path.
  function emptyPriv() { return { fights: [], nudges: [], nudge_sends: [], prefs: {}, queued: [], drafts: {} }; }

  // ---- HTTP ------------------------------------------------------------------
  function authHeaders(extra) {
    var h = { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' };
    if (S.session) h.Authorization = 'Bearer ' + S.session.access_token;
    else h.Authorization = 'Bearer ' + cfg.supabaseAnonKey;
    for (var k in extra) h[k] = extra[k];
    return h;
  }
  function setSession(j) {
    S.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: { id: j.user.id, email: j.user.email } };
  }
  // fetch that tags a network failure (a TypeError from fetch itself) as err.offline, so sync can tell "no connection" from a
  // TypeError thrown by a bug in our own code, which must stay loud.
  async function netFetch(url, opts) {
    try { return await fetch(url, opts); }
    catch (e) { if (e instanceof TypeError) e.offline = true; throw e; }
  }
  async function gotrue(path, body) {
    var r = await netFetch(cfg.supabaseUrl + '/auth/v1' + path, { method: 'POST', headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json();
    if (!r.ok) {
      var err = new Error(j.msg || j.error_description || j.message || 'auth failed ' + r.status);
      err.authRejected = true;
      throw err;
    }
    return j;
  }
  // Refresh shortly before expiry. Single-flight: concurrent callers share one refresh, because a
  // second refresh with the same token trips GoTrue's reuse detection and revokes the session.
  // The new tokens are persisted before anyone proceeds, so an app kill cannot leave a stale refresh token.
  // A refresh GoTrue rejects (HTTP error; a fetch TypeError = offline propagates untouched) falls back to the
  // Keychain password; with none, or if that fails too, the error surfaces.
  var refreshing = null;
  function ensureFresh() {
    if (!S.session || S.session.expires_at - Date.now() / 1000 > 60) return Promise.resolve();
    if (!refreshing) refreshing = doRefresh().finally(function () { refreshing = null; });
    return refreshing;
  }
  async function doRefresh() {
    var j;
    try {
      j = await gotrue('/token?grant_type=refresh_token', { refresh_token: S.session.refresh_token });
    } catch (e) {
      if (!e.authRejected) throw e;
      var c = await creds.get();
      if (!c) throw e;
      j = await gotrue('/token?grant_type=password', { email: c.email, password: c.password });
    }
    setSession(j); await persistNow();
  }
  // One PostgREST call. Returns {status, data}. Only a real PostgREST answer counts: a 2xx with a body must be JSON,
  // because a captive portal or proxy answers 200 text/html and the caller would otherwise treat the write as delivered.
  async function apiRaw(method, path, body, extra) {
    await ensureFresh();
    var r = await netFetch(cfg.supabaseUrl + '/rest/v1/' + path, { method: method, headers: authHeaders(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    var text = await r.text();
    if (!r.ok) {
      var err = new Error(method + ' ' + path.split('?')[0] + ' ' + r.status + ' ' + text);
      err.status = r.status; err.body = text; throw err;
    }
    if (!text) return { status: r.status, data: null };
    if (!/json/i.test(r.headers.get('content-type') || '')) {
      var bad = new Error('Unexpected reply (' + r.status + ') from ' + path.split('?')[0]);
      bad.status = r.status; bad.badReply = true; throw bad;
    }
    return { status: r.status, data: JSON.parse(text) };
  }
  async function api(method, path, body, extra) { return (await apiRaw(method, path, body, extra)).data; }

  // ---- auth --------------------------------------------------------------------
  async function loadUserData(uid) {
    var sh = JSON.parse((await kv.get('shared.' + uid)) || 'null');
    if (sh) {
      S.couple = sh.couple; S.members = sh.members; S.rows = sh.rows; S.cursors = sh.cursors; S.outbox = sh.outbox; S.deadLetters = sh.deadLetters || [];
      // inflight only means something within one run; a kill mid-send leaves it stale and edits must fold again.
      S.outbox.forEach(function (o) { delete o.inflight; });
    }
    else { S.couple = null; S.members = []; SHARED.forEach(function (t) { S.rows[t] = {}; }); S.cursors = {}; S.outbox = []; S.deadLetters = []; }
    // A cache written before a table existed lacks it; the first pull fills it.
    SHARED.forEach(function (t) { if (!S.rows[t]) S.rows[t] = {}; });
    S.priv = JSON.parse((await kv.get('priv.' + uid)) || 'null') || emptyPriv();
    migrateAffirmations();
    S.loaded = true;
    // Owning-ups the partner finished that I opened (private, on-device). `since` is when this install first ran: rows
    // finished before it (the acknowledgments the migration turned into to dos) are history and never raise a card.
    if (!S.priv.ownupSeen) { S.priv.ownupSeen = []; S.priv.ownupSince = Date.now(); persist(); }
  }
  // One-time: the self-set affirmations become Me nudges (oldest first, so they keep their order), then
  // the field is deleted so this never runs twice.
  function migrateAffirmations() {
    var p = S.priv;
    if (!p.nudges) { p.nudges = []; p.nudge_sends = []; }
    if (!p.queued) p.queued = []; // asks for a partner who has not joined yet
    if (!p.drafts) p.drafts = {}; // unsent text per compose surface (see Drafts in cycle-ui.js)
    if (!p.affirmations) return;
    p.affirmations.forEach(function (a, i) {
      var body = typeof a === 'string' ? a : a.text || a.body;
      p.nudges.push({ id: uuid(), body: body, pinned: false, sort_order: p.nudges.length + i, archived_at: null, created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    });
    delete p.affirmations;
    persist();
  }
  async function signUp(email, password) {
    var j = await gotrue('/signup', { email: email, password: password });
    if (!j.access_token) throw new Error('Account created but no session: email confirmation is still on');
    setSession(j); await creds.set(email, password); await loadUserData(j.user.id); await persistNow(); emit();
  }
  async function signIn(email, password) {
    var j = await gotrue('/token?grant_type=password', { email: email, password: password });
    setSession(j); await creds.set(email, password); await loadUserData(j.user.id); await persistNow(); await sync(); emit();
  }
  async function signOut() {
    // Persist first: edits typed in the last 50ms sit in the debounce timer, and clearing state below would lose them.
    await persistNow();
    cancelAllNotifications(); backupAllowed = null; pushRegistered = null;
    S.loaded = false; S.deadLetters = [];
    S.session = null; S.couple = null; S.members = []; S.outbox = []; S.priv = null;
    SHARED.forEach(function (t) { S.rows[t] = {}; }); S.cursors = {};
    await kv.set('session', null); await creds.clear(); emit();
  }

  // ---- couple setup ---------------------------------------------------------------
  // sync() returns immediately when one is already running (e.g. the one sign-in kicked off), which
  // would leave S.couple/S.members stale right after the RPC. Callers that need the result wait their turn.
  async function syncNow() {
    while (S.syncing) await new Promise(function (r) { setTimeout(r, 50); });
    await sync();
  }
  async function createCouple(name, tz) {
    var code = await api('POST', 'rpc/create_couple', { p_name: name, p_tz: tz });
    await syncNow(); return code;
  }
  async function joinCouple(code, name) {
    await api('POST', 'rpc/join_couple', { p_code: code, p_name: name });
    await syncNow();
  }

  // ---- sync -------------------------------------------------------------------------
  var syncTimer = 0, syncAgain = false;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 400); }
  async function pullTable(t) {
    var cur = CURSOR[t], since = cur && S.cursors[t];
    var q = t + '?select=*' + (since ? '&' + cur + '=gte.' + encodeURIComponent(since) : '') + '&order=' + (cur || ORDER[t] || 'at') + '.asc';
    var max = since || null, from = 0, seen = {};
    for (;;) { // PostgREST caps a response at 1000 rows: page with Range until a short page
      var page = await api('GET', q, undefined, { Range: from + '-' + (from + 999), 'Range-Unit': 'items' });
      page.forEach(function (row) {
        var pend = S.outbox.filter(function (o) { return o.table === t && o.id === row.id; });
        // A local edit not yet pushed wins over the server copy (last write wins).
        pend.forEach(function (o) { if (o.op === 'patch') for (var k in o.patch) row[k] = o.patch[k]; });
        S.rows[t][row.id] = row; seen[row.id] = true;
        if (cur && (!max || row[cur] > max)) max = row[cur];
      });
      if (page.length < 1000) break;
      from += 1000;
    }
    // A table with no cursor is pulled whole, so a row the server no longer has was deleted there. Rows still waiting to push stay.
    if (!cur) Object.keys(S.rows[t]).forEach(function (id) {
      if (!seen[id] && !S.outbox.some(function (o) { return o.table === t && o.id === id; })) delete S.rows[t][id];
    });
    if (cur) S.cursors[t] = max;
  }
  async function pull() {
    var c = await api('GET', 'couples?select=*');
    S.couple = c[0] || null;
    S.members = await api('GET', 'members?select=*');
    if (!S.couple) return;
    for (var i = 0; i < SHARED.length; i++) await pullTable(SHARED[i]);
  }
  // A write the server will never accept (bad data, RLS refusal) as opposed to one worth retrying (auth, timeout, throttle, 5xx, offline).
  // Exception: PostgREST answers 404/400 PGRST204/PGRST205 ("column/table not in the schema cache") and Postgres 42703/42P01 (column
  // or relation does not exist) while a migration is not applied yet or the schema cache has not reloaded. The row is fine and
  // the server will accept it later, so dead-lettering it would strand a good write; it stays queued and retries with backoff.
  function permanent(e) {
    if (!(e.status >= 400 && e.status < 500) || [401, 408, 429].indexOf(e.status) >= 0) return false;
    return !/PGRST20[45]|42703|42P01|schema cache/.test(e.body || '');
  }
  function deadLetter(o, why, status) {
    var entry = Object.assign({}, o); delete entry.inflight;
    S.deadLetters.push({ id: uuid(), at: nowIso(), error: why, status: status || null, entry: entry });
  }
  // Sends one outbox entry; returns normally only when the server confirmed it. Throws otherwise (see push for the classes).
  async function sendEntry(o) {
    if (o.op === 'insert') {
      try {
        var r = await apiRaw('POST', o.table, o.row, { Prefer: 'return=minimal' });
        if (r.status !== 201) { var e = new Error('Unexpected reply (' + r.status + ') from ' + o.table); e.status = r.status; e.badReply = true; throw e; }
      } catch (e2) {
        // 409 = a row with this id may already be there (response lost, retried). Only a row that really exists counts as applied.
        if (e2.status !== 409) throw e2;
        var g = await apiRaw('GET', o.table + '?select=id&id=eq.' + encodeURIComponent(o.id));
        if (!Array.isArray(g.data) || !g.data.length) { e2.noRow = true; throw e2; }
      }
    } else {
      // return=representation so "matched zero rows" (RLS hides the row: PostgREST answers 204) is distinguishable from applied.
      var p = await apiRaw('PATCH', o.table + '?id=eq.' + encodeURIComponent(o.id), o.patch, { Prefer: 'return=representation' });
      if (p.status === 204 || (Array.isArray(p.data) && !p.data.length)) { var e4 = new Error('PATCH ' + o.table + ' matched no row'); e4.status = 404; e4.noRow = true; throw e4; }
      if (p.status !== 200 || !Array.isArray(p.data)) { var e3 = new Error('Unexpected reply (' + p.status + ') from ' + o.table); e3.status = p.status; e3.badReply = true; throw e3; }
    }
  }
  async function push() {
    // Backing off after a retryable failure: skip the network but keep reporting that failure, so sync() does not read
    // "no error" and clear the error bar while the write is still stuck in the outbox.
    if (Date.now() < S.pushNextAt) { if (S.pushErr) throw S.pushErr; return; }
    while (S.outbox.length) {
      var o = S.outbox[0];
      o.inflight = true; // patch()/insert() must not fold into an entry whose body is already on the wire
      try {
        await sendEntry(o);
      } catch (e) {
        o.inflight = false;
        if (!(permanent(e) || e.noRow)) {
          // Worth retrying: stop here (order matters), back off so a dead link is not hammered every poll.
          // Capped at 30 s (was 300 s): after the server recovers a person must not wait minutes for a queued write.
          // A foreground, going online, or any new write also resets the wait (retryPush).
          S.pushFails++; S.pushNextAt = Date.now() + Math.min(2000 * Math.pow(2, S.pushFails - 1), 30000); S.pushErr = e;
          throw e;
        }
        console.error('cycle write refused, kept as not sent:', e);
        deadLetter(o, e.message, e.status);
        var di = S.outbox.indexOf(o); if (di >= 0) S.outbox.splice(di, 1);
        persist(); emit();
        continue;
      }
      S.pushFails = 0; S.pushNextAt = 0; S.pushErr = null;
      var i = S.outbox.indexOf(o); if (i >= 0) S.outbox.splice(i, 1);
    }
  }
  // Push local writes first so the pull that follows returns their server-stamped rows. A failed push never
  // skips the pull: a head row the server cannot take must not freeze everything the partner sends.
  async function sync() {
    if (!S.session || S.syncing) { syncAgain = !!S.session; return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    S.syncing = true;
    try {
      var pushErr = null, pullErr = null;
      try { if (S.couple) await push(); } catch (e) { pushErr = e; }
      try { await pull(); } catch (e) { pullErr = e; }
      var err = pushErr || pullErr;
      // Only fetch's own network failure is "offline"; a TypeError from our code is a bug and shows.
      if (!err || err.offline) { S.syncError = null; S.syncErrorStatus = null; }
      else { S.syncError = err.message; S.syncErrorStatus = err.status || null; console.error('cycle sync failed:', err); }
    } finally {
      S.syncing = false; persist(); emit(); reschedule();
      if (S.couple) registerPush();
      if (syncAgain) { syncAgain = false; scheduleSync(); }
    }
  }
  // Ends any backoff so the next push tries now: called on foreground and on every local write.
  function retryPush() { S.pushNextAt = 0; }
  // True when the server permanently refused this row's insert: it still sits in S.rows with its text, but was never sent.
  function notSent(t, id) { return S.deadLetters.some(function (d) { return d.entry.table === t && d.entry.id === id && d.entry.op === 'insert'; }); }
  // Everything on disk exactly as stored (no JSON.parse), so a blob that will not load can still be taken off the phone.
  async function rawExport() {
    var keys = await kv.keys(''), out = {};
    for (var i = 0; i < keys.length; i++) out[keys[i]] = await kv.get(keys[i]);
    return JSON.stringify(out, null, 1);
  }
  function deadLetterText() { return JSON.stringify(S.deadLetters, null, 2); }

  // ---- writes -------------------------------------------------------------------------
  function insert(t, row) {
    S.rows[t][row.id] = row;
    S.outbox.push({ op: 'insert', table: t, id: row.id, row: Object.assign({}, row) });
    retryPush();
    persist(); emit(); scheduleSync(); reschedule();
    return row;
  }
  // Partial update. Folds into a still-unsent insert or patch of the same row so the
  // outbox stays small and a recipient only ever PATCHes the columns it may change.
  function patch(t, id, fields) {
    var row = S.rows[t][id];
    if (!row) throw new Error('patch of unknown ' + t + ' ' + id);
    var cols = Object.assign({}, fields);
    Object.assign(row, cols);
    if ('updated_at' in row) row.updated_at = nowIso();
    var last = S.outbox.filter(function (o) { return o.table === t && o.id === id; }).pop();
    // An in-flight entry already left with its old body, and push() will drop it on success: folding into it would lose this edit.
    if (last && last.inflight) S.outbox.push({ op: 'patch', table: t, id: id, patch: cols });
    else if (last && last.op === 'insert') Object.assign(last.row, cols);
    else if (last && last.op === 'patch' && last === S.outbox[S.outbox.length - 1]) Object.assign(last.patch, cols);
    else S.outbox.push({ op: 'patch', table: t, id: id, patch: cols });
    retryPush();
    persist(); emit(); scheduleSync(); reschedule();
  }

  // ---- private tier --------------------------------------------------------------------
  var backupTimer = 0;
  function savePriv() {
    persist(); emit();
    clearTimeout(backupTimer);
    backupTimer = setTimeout(backup, 3000);
  }
  // Private-tier backup to the box. Only the box owner's account may write it, and the box
  // answers 403 AFTER the bytes arrived, so every other install would upload its private tier
  // for nothing. Hence a cheap GET /backup first: 200 = this user is the owner (PUT allowed for
  // the session), 403 = never PUT again this session. Anything else is loud and retried next save.
  var backupAllowed = null;
  // A priv holding nothing at all: every field null or an empty array/object (emptyPriv() qualifies).
  function privEmpty(p) {
    return !p || Object.keys(p).every(function (k) { var v = p[k]; return v == null || (typeof v === 'object' && !Object.keys(v).length); });
  }
  // Fresh-install guard: a reinstalled or wiped device starts with an empty priv, and without this its first save
  // would PUT that emptiness over the one good backup on the box (which keeps only the latest main file plus daily
  // copies of whatever was last PUT). So while local priv is empty, GET the box copy and refuse to overwrite a
  // non-empty one. Load-bearing: removing it silently destroys the backup the next time the app is reinstalled.
  async function backup() {
    if (!cfg.boxUrl || !S.session || backupAllowed === false || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    try {
      await ensureFresh();
      var auth = { Authorization: 'Bearer ' + S.session.access_token };
      var remote = null;
      if (backupAllowed === null || privEmpty(S.priv)) {
        var g = await fetch(cfg.boxUrl + '/backup', { method: 'GET', headers: auth });
        if (g.status === 403) { backupAllowed = false; return; }
        // 404 = the owner has no backup yet, so the first PUT is safe.
        if (!g.ok && g.status !== 404) { console.error('cycle backup probe failed: HTTP ' + g.status); return; }
        backupAllowed = true;
        if (g.ok && privEmpty(S.priv)) remote = JSON.parse(await g.text());
      }
      if (privEmpty(S.priv) && remote && !privEmpty(remote)) { console.error('cycle backup skipped: this device is empty but the box backup is not'); return; }
      var r = await fetch(cfg.boxUrl + '/backup', { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify(S.priv) });
      if (!r.ok) console.error('cycle backup failed: HTTP ' + r.status);
    } catch (e) { if (!(e instanceof TypeError)) console.error('cycle backup failed:', e); }
  }
  // ---- remote push ---------------------------------------------------------------------------
  // Native hands over the APNs token (cycleNative.pushToken); the box stores it for this account so the
  // partner's new to dos reach this phone while the app is closed. Registered once per
  // token + account per launch, only after sync shows a couple (the box rejects non-members).
  var pushRegistered = null;
  function setPushToken(t) { S.pushToken = t; if (S.couple) registerPush(); }
  async function registerPush() {
    if (!cfg.boxUrl || !S.session || !S.pushToken || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    var key = S.session.user.id + ':' + S.pushToken;
    if (pushRegistered === key) return;
    try {
      await ensureFresh();
      var r = await fetch(cfg.boxUrl + '/push/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.session.access_token }, body: JSON.stringify({ token: S.pushToken }) });
      if (!r.ok) { console.error('cycle push register failed: HTTP ' + r.status); return; }
      pushRegistered = key;
    } catch (e) { if (!(e instanceof TypeError)) console.error('cycle push register failed:', e); }
  }
  // ---- local notifications -----------------------------------------------------------------
  // Everything the shell must have scheduled is derived from state on every change; ids that
  // were scheduled before but are no longer wanted are cancelled. Native replaces a re-used id.
  // 'checkin' is the id an older build scheduled; it is not wanted, so the first reschedule cancels it.
  var scheduledIds = ['checkin'], reschedTimer = 0;
  function reschedule() { clearTimeout(reschedTimer); reschedTimer = setTimeout(rescheduleNow, 200); }
  function wanted() {
    var out = [], m = myMember(), now = Date.now();
    if (!m || !S.couple) return out;
    list('items').forEach(function (i) {
      if (i.sender_id === me() && i.status === 'held' && !i.deleted_at)
        out.push({ id: 'held-' + i.id, at: Math.max(C.ms(i.held_until), now + 1000), title: i.origin === 'issue' ? 'Do you still want to send this?' : 'Still send?', body: i.origin === 'issue' ? i.body : i.kind.charAt(0).toUpperCase() + i.kind.slice(1), route: 'held/' + i.id });
    });
    // A to do I scheduled for myself appears for me at T. One my partner scheduled reaches
    // me as a remote push from the box at T, so a local notification here would be a duplicate.
    list('todos').forEach(function (t) {
      if (t.owner_id === me() && t.created_by === me() && !t.deleted_at && !t.done_at && C.isScheduled(t, now))
        out.push({ id: 'sched-' + t.id, at: C.ms(t.created_at), title: 'To do', body: t.title, route: 'todo' });
    });
    // Nudges: a synced send to me that is unopened with a future deliver_at, and my own Me nudges at theirs.
    // (The server hides a partner's send until deliver_at, so the first kind only appears under clock skew;
    // the real 8 am alert for a partner nudge is remote push, phase 2.)
    list('nudge_sends').forEach(function (n) {
      if (n.recipient_id === me() && !n.opened_at && !n.deleted_at && C.ms(n.deliver_at) > now)
        out.push({ id: 'nudge-' + n.id, at: C.ms(n.deliver_at), title: 'Reminder', body: n.body, route: 'nudge/' + n.id });
    });
    (S.priv ? S.priv.nudge_sends : []).forEach(function (n) {
      if (!n.opened_at && !n.deleted_at && C.ms(n.deliver_at) > now)
        out.push({ id: 'nudge-' + n.id, at: C.ms(n.deliver_at), title: 'Reminder', body: n.body, route: 'nudge/' + n.id });
    });
    (S.priv ? S.priv.fights : []).forEach(function (f) {
      var at = f.at + 24 * 3600000;
      var mk = S.rows.fight_markers[f.id];
      if (mk && !mk.deleted_at && at > now && !f.followed && !mk.repaired_at) out.push({ id: 'fu-' + f.id, at: at, title: 'Follow up', body: '', route: 'log-followup' });
    });
    // A fight I logged with no note from me yet: ask 30 min after logging, then every 2 hours until there is one, skipping 22:00-08:00.
    // iOS can't repeat on its own, so the next 6 are scheduled and each change or launch tops them up. Fights logged before this have no logged_at.
    var hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: m.tz || S.couple.tz, hourCycle: 'h23', hour: '2-digit' });
    (S.priv ? S.priv.fights : []).forEach(function (f) {
      var mk2 = S.rows.fight_markers[f.id];
      if (!f.logged_at || !mk2 || mk2.deleted_at || list('fight_notes').some(function (n) { return n.fight_marker_id === f.id && n.author_id === me(); })) return;
      for (var k = 0, n = 0; n < 6; k++) {
        var at = f.logged_at + 30 * 60000 + k * 2 * 3600000, h = +hourFmt.format(at);
        if (at <= now || h >= 22 || h < 8) continue;
        out.push({ id: 'fnote-' + f.id + '-' + k, at: at, title: 'Log fight', body: 'What happened?', route: 'fight/' + f.id });
        n++;
      }
    });
    // An unaccepted challenge for me: a 09:00 reminder (my timezone) on each of the next 7 days until I accept.
    var tz = m.tz || S.couple.tz;
    list('challenges').forEach(function (c) {
      if (c.for_user !== me() || c.accepted_at) return;
      for (var day = C.localDay(now, tz), n = 0; n < 7; day = C.addDays(day, 1)) {
        var at = C.zonedMs(day, 9, 0, tz);
        if (at <= now) continue;
        out.push({ id: 'chal-' + c.id + '-' + day, at: at, title: 'Challenge', body: c.name, route: 'challenge/' + c.id });
        n++;
      }
    });
    return out;
  }
  async function rescheduleNow() {
    if (!hasNative || !S.session) return;
    var w = wanted(), ids = w.map(function (x) { return x.id; });
    for (var i = 0; i < scheduledIds.length; i++) if (ids.indexOf(scheduledIds[i]) < 0) await native.cancel(scheduledIds[i]);
    for (var j = 0; j < w.length; j++) {
      // A time that slipped into the past between wanted() and the bridge call is simply not scheduled; any other rejection is real.
      try { await native.schedule(w[j]); } catch (e) { if (!/not in the future/.test(String(e && e.message || e))) throw e; }
    }
    scheduledIds = ids;
  }
  function cancelAllNotifications() { scheduledIds.forEach(native.cancel); scheduledIds = []; }

  // ---- boot ------------------------------------------------------------------------------------
  async function boot() {
    var s = JSON.parse((await kv.get('session')) || 'null');
    if (s) { S.session = s; await loadUserData(s.user.id); }
    window.addEventListener('online', function () { retryPush(); sync(); });
    // iOS can kill a backgrounded page without any later event: flush the 50ms debounce the moment the page leaves the screen.
    function flush() { if (S.session) persistNow().catch(function () {}); }
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    if (S.session) { native.permission(); sync(); }
  }

  return {
    S: S, boot: boot, on: on, emit: emit, uuid: uuid, me: me, partner: partner, myMember: myMember, list: list, get: get,
    signUp: signUp, signIn: signIn, signOut: signOut, createCouple: createCouple, joinCouple: joinCouple,
    kv: kv, sync: sync, syncNow: syncNow, insert: insert, patch: patch, savePriv: savePriv, native: native, creds: creds, reschedule: reschedule,
    api: api, deadLetterText: deadLetterText, retryPush: retryPush, notSent: notSent, rawExport: rawExport, persistNow: persistNow, persist: persist, hasNative: hasNative, backup: backup, setPushToken: setPushToken,
  };
})();
