// Data-loss and error-handling guarantees ("never lose what someone typed"): outbox success rules, in-flight edits,
// dead letters, persistence failures, atomic Log fight, boot/render failure screens, deep links, double taps.
// WebKit only (needs GL_WEBKIT_PW/GL_WEBKIT_EXEC, see ~/.claude/bin/cycle-webkit.sh); skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;

const UID = 'u-me', PID = 'u-her';
const HOUR = 36e5;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
const MEMBERS = [{ user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Her', checkin_time: '21:00', hits_self: true }];
const todo = (id, extra) => ({ id, couple_id: 'c1', owner_id: UID, created_by: UID, item_id: null, fight_marker_id: null, type: 'task', title: 'Stored title', description: null, due_date: null, target: null, period: null, points_earn: 3, points_miss: 3, needs_note: false, tally: 0, done_at: null, edited_at: null, created_at: ago(2), updated_at: ago(2), deleted_at: null, ...extra });
const seed = (tweak) => {
  const sh = {
    couple: COUPLE, members: MEMBERS,
    rows: { items: {}, todos: { t1: todo('t1') }, todo_events: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {}, challenges: {}, challenge_days: {}, challenge_breaks: {} },
    cursors: {}, outbox: [],
  };
  if (tweak) tweak(sh);
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
    ['shared.' + UID]: sh,
    ['priv.' + UID]: { fights: [], nudges: [], nudge_sends: [], prefs: {}, queued: [], drafts: {} },
  };
};

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // Fake Supabase: handler({method, path, search, body}) -> {status, body, type} | undefined (= default: empty tables, 201/204 for writes).
  async function open({ tweak, handler, rawStorage, pageErrors } = {}) {
    const s = seed(tweak);
    const sent = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript(({ sd, raw }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) {
        for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
        for (const k in raw || {}) localStorage.setItem('cycle:' + k, raw[k]);
      }
    }, { sd: s, raw: rawStorage });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', async (route) => {
      const req = route.request(), u = new URL(req.url()), rec = { method: req.method(), url: req.url(), path: u.pathname.replace('/rest/v1/', ''), search: u.search, body: req.postData() ? JSON.parse(req.postData()) : null };
      sent.push(rec);
      const r = handler ? await handler(rec) : undefined;
      if (r) return route.fulfill({ status: r.status, contentType: r.type || 'application/json', body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body === undefined ? [] : r.body) });
      if (rec.method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rec.path === 'couples' ? [COUPLE] : rec.path === 'members' ? MEMBERS : []) });
      return route.fulfill({ status: rec.method === 'POST' ? 201 : 204, body: '' });
    });
    const page = await context.newPage();
    if (pageErrors) page.on('pageerror', (e) => pageErrors.push(e)); else page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    return { context, page, sent };
  }
  const ready = (page) => page.waitForSelector('.rows .row, .errscreen');
  const shared = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')));
  const settle = (page, ms = 1200) => page.waitForTimeout(ms);
  const insertTodo = (page, id) => page.evaluate((r) => CycleStore.insert('todos', r), todo(id, { title: 'New ' + id }));

  // ---- 1: success must be the expected status and content ------------------------------------------------
  test('1 captive-portal 200 HTML does not count as sent; the row stays in the outbox', async () => {
    const { context, page } = await open({ handler: (r) => r.method === 'POST' ? { status: 200, type: 'text/html', body: '<html>Wi-Fi login</html>' } : undefined });
    await ready(page);
    await insertTodo(page, 'n1'); await settle(page);
    const sh = await shared(page);
    assert.equal(sh.outbox.length, 1, 'row must stay queued');
    assert.ok(sh.rows.todos.n1);
    await context.close();
  });
  test('1b a non-network TypeError during sync is shown, not swallowed as offline', async () => {
    const { context, page } = await open({ handler: (r) => r.path === 'couples' ? { status: 200, body: 'null' } : undefined });
    await ready(page); await settle(page);
    assert.ok(await page.evaluate(() => CycleStore.S.syncError), 'syncError must be set');
    assert.ok(await page.locator('.errbar').count(), 'error bar shown');
    await context.close();
  });

  // ---- 2: in-flight entry is never folded into ------------------------------------------------------------
  test('2 an edit made while the insert is in flight is sent after it, not discarded', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { context, page, sent } = await open({ handler: async (r) => { if (r.method === 'POST') await gate; } });
    await ready(page);
    await insertTodo(page, 'n2'); // sync() fires 400ms later and hangs on the gate
    for (let i = 0; i < 50 && !sent.some((x) => x.method === 'POST'); i++) await page.waitForTimeout(100); // the POST is now held at the gate
    await page.evaluate(() => CycleStore.patch('todos', 'n2', { title: 'Edited while sending' }));
    release(); await settle(page, 2000);
    const patches = sent.filter((x) => x.method === 'PATCH' && /id=eq.n2/.test(x.search));
    assert.equal(patches.length, 1, 'the edit must be sent as its own PATCH');
    assert.equal(patches[0].body.title, 'Edited while sending');
    await context.close();
  });

  // ---- 3: permanent rejections become dead letters ------------------------------------------------------------
  test('3 a rejected head row goes to deadLetters with its full row; the queue and pull continue; UI shows a count and the text', async () => {
    const { context, page, sent } = await open({ handler: (r) => r.method === 'POST' && r.body.id === 'bad' ? { status: 400, body: { message: 'check constraint' } } : undefined });
    await ready(page);
    await insertTodo(page, 'bad'); await insertTodo(page, 'good');
    const pullsBefore = sent.filter((x) => x.method === 'GET' && x.path === 'couples').length;
    await settle(page, 2500);
    const sh = await shared(page);
    assert.equal(sh.outbox.length, 0, 'queue continued past the rejected row');
    assert.equal(sh.deadLetters.length, 1);
    assert.equal(sh.deadLetters[0].entry.row.id, 'bad');
    assert.equal(sh.deadLetters[0].entry.row.title, 'New bad', 'full row kept');
    assert.ok(sent.some((x) => x.method === 'POST' && x.body.id === 'good'));
    assert.ok(sent.filter((x) => x.method === 'GET' && x.path === 'couples').length > pullsBefore, 'pull ran after the failed push');
    assert.match(await page.textContent('.errbar'), /1 change not sent/);
    await page.click('.errbar[data-a="deadletters"]');
    assert.match(await page.textContent('.dlist'), /New bad/, 'text visible');
    assert.ok(await page.locator('[data-a="dlexport"]').count(), 'export control');
    await context.close();
  });
  test('3b 429 / 401 / 5xx are retried, never dead-lettered', async () => {
    for (const status of [429, 401, 503]) {
      const { context, page } = await open({ handler: (r) => r.method === 'POST' ? { status, body: {} } : undefined });
      await ready(page);
      await insertTodo(page, 'n3'); await settle(page);
      const sh = await shared(page);
      assert.equal(sh.outbox.length, 1, 'kept for ' + status);
      assert.equal((sh.deadLetters || []).length, 0, 'not dead for ' + status);
      await context.close();
    }
  });
  test('3c repeated failure backs off instead of hammering', async () => {
    const { context, page, sent } = await open({ handler: (r) => r.method === 'POST' ? { status: 503, body: {} } : undefined });
    await ready(page);
    await insertTodo(page, 'n4');
    for (let i = 0; i < 4; i++) { await page.evaluate(() => CycleStore.sync()); await page.waitForTimeout(300); }
    assert.ok(sent.filter((x) => x.method === 'POST').length <= 2, 'POSTs: ' + sent.filter((x) => x.method === 'POST').length);
    await context.close();
  });

  // ---- 4: 409 ------------------------------------------------------------------------------------------------------
  test('4 409 on insert counts as applied only when the row exists on the server', async () => {
    for (const exists of [true, false]) {
      const { context, page } = await open({ handler: (r) => r.method === 'POST' ? { status: 409, body: { message: 'dup' } } : (r.path === 'todos' && /id=eq.n5/.test(r.search) ? { status: 200, body: exists ? [{ id: 'n5' }] : [] } : undefined) });
      await ready(page);
      await insertTodo(page, 'n5'); await settle(page, 2000);
      const sh = await shared(page);
      assert.equal(sh.outbox.length, 0);
      assert.equal((sh.deadLetters || []).length, exists ? 0 : 1, 'exists=' + exists);
      await context.close();
    }
  });

  // ---- 5: PATCH that matched nothing --------------------------------------------------------------------------------
  test('5 a PATCH that matches zero rows (RLS) is dead-lettered, not applied', async () => {
    for (const rows of [0, 1]) {
      const { context, page } = await open({ handler: (r) => r.method === 'PATCH' ? (rows ? { status: 200, body: [todo('t1')] } : { status: 204, type: 'text/plain', body: '' }) : undefined });
      await ready(page);
      await page.evaluate(() => CycleStore.patch('todos', 't1', { title: 'Mine' })); await settle(page, 2000);
      const sh = await shared(page);
      assert.equal(sh.outbox.length, 0);
      assert.equal((sh.deadLetters || []).length, rows ? 0 : 1, 'rows=' + rows);
      await context.close();
    }
  });

  // ---- 6/7: persistence ------------------------------------------------------------------------------------------------
  test('6 a failed persist and an unhandled rejection both show in the error bar', async () => {
    const { context, page } = await open({ pageErrors: [] }); // the deliberate rejection below also fires pageerror
    await ready(page);
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); }; CycleStore.patch('todos', 't1', { title: 'x' }); });
    await page.waitForSelector('.errbar', { timeout: 3000 });
    assert.match(await page.textContent('.errbar'), /Not saved/);
    await page.evaluate(() => { Promise.reject(new Error('boom')); });
    await page.waitForFunction(() => /boom/.test(document.querySelector('.errbar').textContent), null, { timeout: 3000 });
    await context.close();
  });
  test('7 pagehide and visibility-hidden flush pending writes at once; sign-out persists first', async () => {
    const { context, page } = await open();
    await ready(page);
    const flushed = await page.evaluate(() => {
      CycleStore.patch('todos', 't1', { title: 'A' });
      window.dispatchEvent(new Event('pagehide'));
      return JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.todos.t1.title;
    });
    assert.equal(flushed, 'A', 'pagehide');
    const hid = await page.evaluate(() => {
      CycleStore.patch('todos', 't1', { title: 'B' });
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.todos.t1.title;
    });
    assert.equal(hid, 'B', 'visibilitychange');
    await page.evaluate(async () => { CycleStore.patch('todos', 't1', { title: 'C' }); await CycleStore.signOut(); });
    await page.waitForTimeout(300);
    assert.equal((await shared(page)).rows.todos.t1.title, 'C', 'sign-out');
    await context.close();
  });

  // ---- 8: Log fight is all-or-nothing ----------------------------------------------------------------------------------
  test('8 Log fight with an Ask chip and no partner queues nothing and says why; the typed note stays', async () => {
    const { context, page } = await open({ tweak: (sh) => { sh.members = [MEMBERS[0]]; }, handler: (r) => r.path === 'members' ? { status: 200, body: [MEMBERS[0]] } : undefined });
    await ready(page);
    await page.click('[data-a="go:fight"]');
    await page.fill('textarea[data-d="note"]', 'She said');
    await page.click('[data-a="chip:apologize"]');
    await page.click('[data-a="fightsave"]');
    await page.waitForTimeout(300);
    const sh = await shared(page);
    assert.equal(sh.outbox.length, 0, 'no marker or note queued');
    assert.equal(Object.keys(sh.rows.fight_markers).length, 0);
    assert.ok(await page.locator('.errbar').count(), 'message shown');
    assert.equal(await page.inputValue('textarea[data-d="note"]'), 'She said');
    await context.close();
  });
  test('8b a Log fight draft survives a reload', async () => {
    const { context, page } = await open();
    await ready(page);
    await page.click('[data-a="go:fight"]');
    await page.fill('textarea[data-d="note"]', 'Draft text');
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
    await page.click('[data-a="go:fight"]');
    assert.equal(await page.inputValue('textarea[data-d="note"]'), 'Draft text');
    await context.close();
  });
  test('8c flushQueued keeps the queue when an item cannot be built', async () => {
    const { context, page } = await open({ tweak: (sh) => { sh.members = [MEMBERS[0]]; } });
    await ready(page);
    await page.evaluate(() => { CycleStore.S.priv.queued = [{ body: 'Ok', ask_type: 'task' }, null]; CycleStore.S.members = [{ user_id: 'u-me' }, { user_id: 'u-her' }]; });
    await page.evaluate(() => { try { CycleStore.emit(); } catch (e) {} });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => CycleStore.S.priv.queued.length), 2, 'nothing lost');
    await context.close();
  });

  // ---- 9: boot + render failure screens ------------------------------------------------------------------------------------
  test('9 corrupt storage at boot shows a data-is-safe screen with Retry and wipes nothing', async () => {
    const { context, page } = await open({ rawStorage: { ['priv.' + UID]: '{not json' } });
    await page.waitForSelector('.errscreen');
    assert.match(await page.textContent('.errscreen'), /data is safe/i);
    assert.ok(await page.locator('.errscreen [data-a="retry"]').count());
    assert.equal(await page.evaluate(() => localStorage.getItem('cycle:priv.u-me')), '{not json');
    assert.ok(await page.evaluate(() => localStorage.getItem('cycle:shared.u-me')));
    await context.close();
  });
  test('9b a screen that throws renders an error screen with a way home', async () => {
    const { context, page } = await open();
    await ready(page);
    await page.evaluate(() => { const l = CycleStore.list; CycleStore.list = () => { throw new Error('bad row'); }; window.__l = l; CycleStore.emit(); });
    await page.waitForSelector('.errscreen');
    // Restore and tap in one step: a background emit (sync backoff) may re-render the healthy screen on its own between two separate steps,
    // which is fine for the user but would leave a separate click with nothing to hit.
    await page.evaluate(() => { CycleStore.list = window.__l; document.querySelector('.errscreen [data-a="gohome"]').click(); });
    await page.waitForSelector('.rows .row');
    await context.close();
  });

  // ---- 11: deep links to rows that are not here yet ------------------------------------------------------------------------------
  test('11 a deep link to an unknown row falls back to Today; one that arrives by sync opens', async () => {
    const mk = { id: 'f9', couple_id: 'c1', logged_by: PID, at: ago(1), repaired_at: null, hit_self: null, hit_related: null, hit_count: null };
    const { context, page } = await open({ handler: (r) => r.path === 'fight_markers' ? { status: 200, body: [mk] } : undefined });
    await ready(page);
    await page.evaluate(() => cycleNative.route('fight/nope')); await settle(page, 800);
    await page.waitForSelector('.rows .row');
    assert.equal(await page.locator('.errscreen').count(), 0);
    await page.evaluate(() => cycleNative.route('fight/f9')); await settle(page, 800);
    assert.ok(await page.evaluate(() => !!CycleStore.S.rows.fight_markers.f9));
    assert.equal(await page.locator('.errscreen').count(), 0);
    assert.equal(await page.locator('.rows .row').count(), 0, 'on the fight detail, not Today');
    await context.close();
  });

  // ---- 14: silent no-op saves ----------------------------------------------------------------------------------------------------------
  test('14 Broke it on a day already broken says so and keeps the text', async () => {
    const { context, page } = await open({ tweak: (sh) => { sh.rows.challenges.ch1 = { id: 'ch1', couple_id: 'c1', name: 'No yelling', start: '2026-01-02', for_user: UID, breaks_on: 'tap', accepted_at: ago(5000), created_at: ago(5000), updated_at: ago(5000) }; } });
    await ready(page);
    await page.evaluate(() => cycleNative.route('challenge/ch1')); await page.waitForSelector('[data-a="broke"]');
    await page.click('[data-a="broke"]');
    await page.fill('[data-d="brnote"]', 'my note');
    await page.evaluate(() => CycleStore.insert('challenge_breaks', { couple_id: 'c1', id: 'b1', challenge_id: 'ch1', day: CycleCore.localDay(Date.now(), 'America/New_York'), note: null, by: 'u-me', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
    await page.click('[data-a="brsave"]');
    await page.waitForSelector('.errbar');
    assert.equal(await page.inputValue('[data-d="brnote"]'), 'my note');
    await context.close();
  });

  // ---- 16/21: double taps and click guard -----------------------------------------------------------------------------------------------------------
  test('16 a double tap on a to do\'s check records one done event', async () => {
    const { context, page } = await open();
    await ready(page);
    await page.click('[data-a="tab:todo"]');
    await page.waitForSelector('[data-a="done:t1"]');
    await page.evaluate(() => { const b = document.querySelector('[data-a="done:t1"]'); b.click(); b.click(); });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => CycleStore.list('todo_events').filter((e) => e.kind === 'done').length), 1);
    await context.close();
  });
  test('21 an action that throws synchronously shows an error instead of an unhandled exception', async () => {
    const pageErrors = [];
    const { context, page } = await open({ pageErrors });
    await ready(page);
    await page.evaluate(() => { const r = document.querySelector('.rows .row'); r.setAttribute('data-a', 'nosuchaction'); r.click(); });
    await page.waitForSelector('.errbar');
    assert.equal(pageErrors.length, 0, pageErrors.map((e) => e.message).join());
    await context.close();
  });
});
