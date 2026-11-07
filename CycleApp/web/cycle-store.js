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
  // Logged here rather than thrown: a throw from native-evaluated script reaches window 'error' only as "Script error.".
  window.__cycleReply = function (id, result, error) {
    var p = calls[id]; delete calls[id];
    if (!p) { console.error('cycle bridge reply for unknown call ' + id); logErr('bridge', new Error('reply for unknown call ' + id)); return; }
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
    // Voice input: start resolves once recording runs (rejects 'Mic off' when denied). stop resolves the clip as {audio: base64, mime}
    // (null when nothing was recorded) for St.transcribe to upload; cancel discards it. cycleNative.speechSilence fires while recording.
    speechStart: function () { return bridge('speech.start'); },
    speechStop: function () { return bridge('speech.stop'); },
    speechCancel: function () { return bridge('speech.cancel'); },
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
  var SHARED = ['items', 'todos', 'todo_events', 'fight_markers', 'rewards', 'redemptions', 'nudges', 'nudge_sends', 'nudge_replies', 'nudge_awards', 'fight_notes', 'challenges', 'challenge_breaks', 'challenge_days', 'todo_comments', 'todo_nudges', 'challenge_nudges', 'fight_ratings'];
  // Pull strategy per table: cursor column, or null = re-pull everything each sync.
  // nudge_sends MUST be re-pulled whole: the recipient's RLS hides a send until deliver_at, and when it
  // becomes visible its updated_at is old (it was stamped at insert), so an updated_at cursor would skip it forever.
  var CURSOR = { items: 'updated_at', todos: 'updated_at', rewards: 'updated_at', redemptions: 'updated_at', todo_events: 'updated_at', fight_markers: null, nudges: 'updated_at', nudge_sends: null, nudge_replies: 'updated_at', nudge_awards: 'updated_at', fight_notes: 'updated_at', challenges: 'updated_at', challenge_breaks: 'updated_at', challenge_days: 'updated_at', todo_comments: 'updated_at', todo_nudges: 'updated_at', challenge_nudges: 'updated_at', fight_ratings: 'updated_at' };
  // Sort column for tables with no cursor (the default is `at`).
  var ORDER = { nudge_sends: 'created_at' };
  var S = { session: null, couple: null, members: [], rows: {}, cursors: {}, outbox: [], priv: null, syncError: null, syncing: false,
    // Writes the server permanently refused, kept whole (never deleted automatically) so the person can read and export the text.
    deadLetters: [], errLog: [], persistError: null, loaded: false, pushFails: 0, pushNextAt: 0, pushErr: null };
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
        jobs.push(kv.set('errlog.' + uid, JSON.stringify(S.errLog)));
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
  // Every request carries a timeout and is abortable. iOS can suspend the page mid-request and then never settle that
  // fetch; S.syncing then stays true forever and every later sync() returns at its first line, so a partner's new send
  // never arrived until the app was force-quit. abortInflight() (called on foreground) rejects those requests at once;
  // the timeout covers a hang with no foreground event. Sync is idempotent (cursor pulls, 409-safe inserts), so a
  // cut-off request is simply retried by the next sync.
  var inflight = new Set(), FETCH_TIMEOUT_MS = 20000;
  function abortInflight() { inflight.forEach(function (c) { c.abort(); }); }
  async function netFetch(url, opts, keep) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS);
    if (!keep) inflight.add(ctl); // keep = never cut by abortInflight: a refresh the server already processed must not be re-sent with the old (now reused) token
    try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts)); }
    catch (e) { if (e instanceof TypeError || e.name === 'AbortError') e.offline = true; throw e; }
    finally { clearTimeout(timer); inflight.delete(ctl); }
  }
  async function gotrue(path, body) {
    var r = await netFetch(cfg.supabaseUrl + '/auth/v1' + path, { method: 'POST', headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, true);
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
  function forceRefresh() {
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
    var go = function () { return netFetch(cfg.supabaseUrl + '/rest/v1/' + path, { method: method, headers: authHeaders(extra), body: body === undefined ? undefined : JSON.stringify(body) }); };
    var used = S.session && S.session.access_token, r = await go();
    // A 401 means the server no longer accepts this token although our own expiry clock says it is fine (clock skew, a token
    // revoked elsewhere). ensureFresh only looks at that clock, so without this the phone retried the dead token forever.
    // Refresh once (unless another caller already swapped the token) and retry once; a second 401 surfaces as usual.
    if (r.status === 401 && S.session) { if (S.session.access_token === used) await forceRefresh(); r = await go(); }
    var text = await r.text();
    if (!r.ok) {
      var err = new Error(method + ' ' + path.split('?')[0] + ' ' + r.status + ' ' + text);
      err.status = r.status; err.body = text; err.where = method + ' ' + path.split('?')[0]; throw err;
    }
    if (!text) return { status: r.status, data: null };
    if (!/json/i.test(r.headers.get('content-type') || '')) {
      var bad = new Error('Unexpected reply (' + r.status + ') from ' + path.split('?')[0]);
      bad.status = r.status; bad.badReply = true; bad.where = method + ' ' + path.split('?')[0]; throw bad;
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
    S.errLog = JSON.parse((await kv.get('errlog.' + uid)) || 'null') || [];
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
    setSession(j); await creds.set(email, password); await loadUserData(j.user.id); pullPriv(); await persistNow(); await sync(); emit();
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
        pend.forEach(function (o) { if (o.op === 'patch') for (var k in o.patch) row[k] = o.patch[k]; else if (o.op === 'upsert') Object.assign(row, o.row); });
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
    if (o.op === 'upsert') {
      // fight_ratings: one row per (fight, person), so a re-rating must merge into the existing row rather than 409.
      // Only the writable columns go out: id is generated on the server and updated_at is stamped there (neither is grantable).
      var u = await apiRaw('POST', o.table + '?on_conflict=' + o.conflict, { fight_marker_id: o.row.fight_marker_id, user_id: o.row.user_id, intensity: o.row.intensity }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (u.status !== 201 && u.status !== 200 && u.status !== 204) { var e5 = new Error('Unexpected reply (' + u.status + ') from ' + o.table); e5.status = u.status; e5.badReply = true; throw e5; }
    } else if (o.op === 'insert') {
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
      try { await pull(); uploadOwnRatings(); } catch (e) { pullErr = e; }
      var err = pushErr || pullErr;
      // Only fetch's own network failure is "offline"; a TypeError from our code is a bug and shows.
      if (!err || err.offline) { S.syncError = null; S.syncErrorStatus = null; }
      else { S.syncError = err.message; S.syncErrorStatus = err.status || null; console.error('cycle sync failed:', err); logErr('sync', err); }
    } finally {
      S.syncing = false; persist(); emit(); reschedule();
      if (S.couple) registerPush();
      if (syncAgain) { syncAgain = false; scheduleSync(); }
    }
  }
  // One-time: the intensities this phone kept in S.priv.fights (before ratings were shared) become fight_ratings rows, so the
  // partner's chart can use them. Runs after a pull so only fights the server knows are sent; `ratingsUploaded` makes it never repeat.
  function uploadOwnRatings() {
    if (!S.couple || !S.priv || S.priv.ratingsUploaded) return;
    var me = S.session.user.id;
    S.priv.fights.forEach(function (f) {
      var mk = S.rows.fight_markers[f.id];
      if (!mk || mk.logged_by !== me || !(f.intensity >= 1 && f.intensity <= 5)) return;
      var id = f.id + ':' + me;
      if (S.rows.fight_ratings[id]) return; // already rated on the server (or on another phone): that value stands
      upsert('fight_ratings', { id: id, fight_marker_id: f.id, user_id: me, intensity: f.intensity, updated_at: nowIso() }, 'fight_marker_id,user_id');
    });
    S.priv.ratingsUploaded = true; persist();
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
  // Last 20 failures kept on the device so the cause survives the 5s error bar. Never the request body or the row: only
  // when (UTC), where (verb + table, never the filter), the HTTP status, and PostgREST's own `message` (its `details`
  // can echo row values, so it is dropped). A non-HTTP error contributes only the first 120 chars of its own message.
  function logErr(kind, e) {
    var msg = String((e && e.message) || e), body = null;
    if (e && e.status && e.body) { try { body = JSON.parse(e.body); } catch (x) { body = null; } }
    msg = body && body.message ? String(body.message) : e && e.status ? 'HTTP ' + e.status : msg;
    S.errLog.push({ t: nowIso(), kind: kind, where: (e && e.where) || null, status: (e && e.status) || null, msg: msg.slice(0, 120) });
    if (S.errLog.length > 20) S.errLog.splice(0, S.errLog.length - 20);
    persist();
  }
  function errLogText() {
    return S.errLog.slice().reverse().map(function (r) { return [r.t, r.kind, r.status || '-', r.where || '-', r.msg].join(' | '); }).join('\n');
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
  // Insert-or-replace for a table keyed by more than id (fight_ratings: fight + person). A still-unsent upsert of the same row
  // is replaced, so tapping 3 then 4 sends one write. `row.id` must be the derived text id the server also exposes.
  function upsert(t, row, conflict) {
    S.rows[t][row.id] = row;
    var last = S.outbox.filter(function (o) { return o.table === t && o.id === row.id; }).pop();
    if (last && last.op === 'upsert' && !last.inflight) last.row = Object.assign({}, row);
    else S.outbox.push({ op: 'upsert', table: t, id: row.id, conflict: conflict, row: Object.assign({}, row) });
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
    S.priv.savedAt = Date.now();
    persist(); emit();
    clearTimeout(backupTimer);
    backupTimer = setTimeout(backup, 3000);
  }
  // Private-tier backup to the box. Only the box owner's account may write it, and the box
  // answers 403 AFTER the bytes arrived, so every other install would upload its private tier
  // for nothing. Hence a cheap GET /backup first: 200 = this user is the owner (PUT allowed for
  // the session), 403 = never PUT again this session. Anything else is loud and retried next save.
  var backupAllowed = null;
  // A priv holding nothing at all: every field null or an empty array/object (emptyPriv() qualifies); scalar bookkeeping
  // (ownupSince, ratingsUploaded, savedAt) is not content.
  function privEmpty(p) {
    return !p || Object.keys(p).every(function (k) { var v = p[k]; if (k === 'ownupSince' || k === 'ratingsUploaded' || k === 'savedAt') return true; return v == null || (typeof v === 'object' && !Object.keys(v).length); });
  }
  // Fresh-install guard: a reinstalled or wiped device starts with an empty priv, and without this its first save
  // would PUT that emptiness over the one good backup on the box (which keeps only the latest main file plus daily
  // copies of whatever was last PUT). So while local priv is empty, GET the box copy and refuse to overwrite a
  // non-empty one. Load-bearing: removing it silently destroys the backup the next time the app is reinstalled.
  async function backup() {
    if (!cfg.boxUrl || !S.session || backupAllowed === false || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    try {
      // A first pull still in flight may replace S.priv: PUT only after it, or a fresh install would overwrite the box.
      if (pullPromise) await pullPromise;
      if (backupAllowed === false) return;
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
  // Pull the box copy of the private tier so every device shares it. Whole-doc last-writer-wins on savedAt.
  var pullPromise = null;
  function pullPriv() {
    if (!cfg.boxUrl || !S.session || backupAllowed === false || (typeof navigator !== 'undefined' && navigator.onLine === false)) return Promise.resolve();
    var p = pullPromise = (async function () {
      try {
        await ensureFresh();
        var g = await fetch(cfg.boxUrl + '/backup', { method: 'GET', headers: { Authorization: 'Bearer ' + S.session.access_token } });
        if (g.status === 403) { backupAllowed = false; return; }
        if (g.status === 404) return;
        if (!g.ok) { console.error('cycle pull failed: HTTP ' + g.status); return; }
        var remote = JSON.parse(await g.text());
        if (!((remote.savedAt || 0) > (S.priv.savedAt || 0) || privEmpty(S.priv))) return;
        S.priv = remote; migrateAffirmations();
        if (!S.priv.ownupSeen) { S.priv.ownupSeen = []; S.priv.ownupSince = Date.now(); }
        persist(); emit(); reschedule();
      } catch (e) { if (!(e instanceof TypeError)) console.error('cycle pull failed:', e); }
    })();
    p.then(function () { if (pullPromise === p) pullPromise = null; });
    return p;
  }
  // ---- remote push ---------------------------------------------------------------------------
  // Native hands over the APNs token (cycleNative.pushToken); the box stores it for this account so the
  // partner's new to dos reach this phone while the app is closed. Registered once per
  // token + account per launch, only after sync shows a couple (the box rejects non-members).
  var pushRegistered = null, pushRetryAt = 0, PUSH_RETRY_MS = 60000;
  function setPushToken(t) { S.pushToken = t; if (S.couple) registerPush(); }
  async function registerPush() {
    if (!cfg.boxUrl || !S.session || !S.pushToken || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    var key = S.session.user.id + ':' + S.pushToken;
    if (pushRegistered === key || Date.now() < pushRetryAt) return;
    try {
      await ensureFresh();
      var post = function () { return fetch(cfg.boxUrl + '/push/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.session.access_token }, body: JSON.stringify({ token: S.pushToken }) }); };
      var used = S.session.access_token, r = await post();
      if (r.status === 401) { if (S.session.access_token === used) await forceRefresh(); r = await post(); }
      if (!r.ok) {
        // Called after every sync (5 s): without a back-off a rejected register hit the box 12 times a minute (2026-11-06, 401s).
        pushRetryAt = Date.now() + PUSH_RETRY_MS;
        console.error('cycle push register failed: HTTP ' + r.status); return;
      }
      pushRegistered = key;
    } catch (e) { if (!(e instanceof TypeError)) console.error('cycle push register failed:', e); }
  }
  // ---- talk -----------------------------------------------------------------------------------
  // One turn of the spoken fight conversation. Throws (with .status for HTTP failures) so the UI can keep the person's
  // words on screen and offer Retry; a fetch TypeError means offline.
  async function talk(payload) {
    await ensureFresh();
    var r = await fetch(cfg.boxUrl + '/talk', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.session.access_token }, body: JSON.stringify(payload) });
    if (!r.ok) { var e = new Error('talk failed: HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  // Stops the recording and returns its transcript ('' when nothing was said). The box forwards the clip to Deepgram and keeps
  // nothing; a fetch TypeError means offline (same convention as talk).
  async function transcribe() {
    var rec = await native.speechStop();
    if (!rec) return '';
    await ensureFresh();
    var bin = atob(rec.audio), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var r;
    try {
      r = await fetch(cfg.boxUrl + '/transcribe', { method: 'POST', headers: { 'Content-Type': rec.mime, Authorization: 'Bearer ' + S.session.access_token }, body: new Blob([bytes], { type: rec.mime }) });
    } catch (e) {
      if (e instanceof TypeError) throw new Error('Offline');
      throw e;
    }
    if (r.status === 422) return '';
    if (!r.ok) throw new Error('Transcription failed');
    return (await r.json()).text;
  }
  // ---- local notifications -----------------------------------------------------------------
  // Everything the shell must have scheduled is derived from state on every change; ids that
  // were scheduled before but are no longer wanted are cancelled. Native replaces a re-used id.
  // 'checkin' is the id an older build scheduled; it is not wanted, so the first reschedule cancels it.
  var scheduledIds = ['checkin'], reschedTimer = 0, scheduleFailed = {}, legacySwept = {};
  // The pre-2026-11-04 build asked about a note every 2 hours and gave each ask the id fnote-<fight>-<k>, k counting every
  // 2-hour slot since logging (night slots included), so ids ran well past the 0..2 the 3-ask policy uses. scheduledIds
  // lives in memory only, so those ids are unknown after an update and would keep firing every 2 hours (Oliver got one at
  // 14:36 for a fight logged at 00:06). Once per fight per launch, every id the old build could have used is marked as
  // scheduled so rescheduleNow cancels whichever are not wanted. Cancelling an id iOS never had is a no-op.
  function sweepLegacyFightNotes(now) {
    (S.priv ? S.priv.fights : []).forEach(function (f) {
      if (!f.logged_at || legacySwept[f.id]) return;
      legacySwept[f.id] = true;
      // The old build topped up 6 asks ahead of now, so k reached (elapsed slots) + 6 plus the skipped night slots; +12 covers that.
      var maxK = Math.ceil((now - f.logged_at) / (2 * 3600000)) + 12;
      for (var k = 3; k <= maxK; k++) scheduledIds.push('fnote-' + f.id + '-' + k);
    });
  }
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
      if (t.owner_id === me() && t.created_by === me() && !t.deleted_at && !t.done_at && !t.declined_at && C.isScheduled(t, now))
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
      if (mk && !mk.deleted_at && at > now && !f.followed && !mk.repaired_at) out.push({ id: 'fu-' + f.id, at: at, title: 'Follow up', body: 'How is it now?', route: 'log-followup' });
    });
    // A fight I logged with no note from me yet: ask 30 min after logging, then once a day at that time for two more days,
    // three asks in all. Oliver found a 2-hourly repeat nagging; the wording changes each time so the third reads as the end.
    // An ask that falls in 22:00-08:00 moves to the next 08:00 rather than being dropped, so all three still come.
    // Each ask's id is fixed by its index k, so an ask already past is gone for good (no top-up). Fights logged before
    // logged_at existed have none and never ask.
    var tzF = m.tz || S.couple.tz;
    var hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tzF, hourCycle: 'h23', hour: '2-digit' });
    var FNOTE_BODY = ['What happened?', 'Still want to note what happened?', 'Last reminder: what happened?'];
    (S.priv ? S.priv.fights : []).forEach(function (f) {
      var mk2 = S.rows.fight_markers[f.id];
      if (!f.logged_at || !mk2 || mk2.deleted_at || list('fight_notes').some(function (n) { return n.fight_marker_id === f.id && n.author_id === me(); })) return;
      for (var k = 0; k < FNOTE_BODY.length; k++) {
        var at = f.logged_at + 30 * 60000 + k * 24 * 3600000, h = +hourFmt.format(at);
        if (h >= 22) at = C.zonedMs(C.addDays(C.localDay(at, tzF), 1), 8, 0, tzF);
        else if (h < 8) at = C.zonedMs(C.localDay(at, tzF), 8, 0, tzF);
        if (at <= now) continue;
        out.push({ id: 'fnote-' + f.id + '-' + k, at: at, title: 'Log fight', body: FNOTE_BODY[k], route: 'fight/' + f.id });
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
    var w = wanted(), ids = w.map(function (x) { return x.id; }), fresh = false;
    sweepLegacyFightNotes(Date.now());
    for (var i = 0; i < scheduledIds.length; i++) if (ids.indexOf(scheduledIds[i]) < 0) await native.cancel(scheduledIds[i]);
    for (var j = 0; j < w.length; j++) {
      // A time that slipped into the past between wanted() and the bridge call is simply not scheduled; any other rejection is real.
      // One refused reminder must not cost the others after it, so the loop carries on. This runs after every sync (each 5s):
      // the empty follow-up body once rejected here on every pass, keeping a generic "Couldn't save" up for 24h with an empty
      // error log. So each distinct failure is logged and raised once, with a bar that names what failed.
      try { await native.schedule(w[j]); } catch (e) {
        var why = String(e && e.message || e);
        if (/not in the future/.test(why)) continue;
        var seen = w[j].id + ':' + why;
        if (scheduleFailed[seen]) continue;
        scheduleFailed[seen] = true;
        logErr('notify', e);
        fresh = true;
      }
    }
    scheduledIds = ids;
    if (fresh) throw new Error('Reminder not set');
  }
  function cancelAllNotifications() { scheduledIds.forEach(native.cancel); scheduledIds = []; }

  // ---- boot ------------------------------------------------------------------------------------
  async function boot() {
    var s = JSON.parse((await kv.get('session')) || 'null');
    if (s) { S.session = s; await loadUserData(s.user.id); pullPriv(); }
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
    kv: kv, sync: sync, syncNow: syncNow, insert: insert, patch: patch, upsert: upsert, savePriv: savePriv, native: native, creds: creds, reschedule: reschedule,
    talk: talk, transcribe: transcribe, canTalk: !!cfg.boxUrl, api: api, logErr: logErr, errLogText: errLogText, deadLetterText: deadLetterText, retryPush: retryPush, abortInflight: abortInflight, notSent: notSent, rawExport: rawExport, persistNow: persistNow, persist: persist, hasNative: hasNative, backup: backup, pullPriv: pullPriv, setPushToken: setPushToken,
  };
})();
