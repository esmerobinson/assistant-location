// Job-tabs redesign guarantees: store sync/backoff/dead-letter rules and the screens' new behaviours (edit window, soft deletes,
// cancel a queued send, restores, reward edit/archive, fight privacy, same-day fights, mic drafts, no silent saves).
// WebKit only (GL_WEBKIT_PW/GL_WEBKIT_EXEC, see ~/.claude/bin/cycle-webkit.sh); skipped without it.
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
const NOW = '2026-10-21T15:00:00Z'; // Wed 11:00 New York
const iso = (minAgo) => new Date(Date.parse(NOW) - minAgo * 6e4).toISOString();
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
const MEMBERS = [{ user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Esme', checkin_time: '21:00', hits_self: true }];
const todo = (id, o = {}) => ({ id, couple_id: 'c1', owner_id: UID, created_by: UID, item_id: null, fight_marker_id: null, type: 'task', title: 'Title ' + id, description: null, due_date: null,
  target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null, created_at: iso(300), updated_at: iso(300), deleted_at: null, ...o });
const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));
const EMPTY = ['items', 'todos', 'todo_events', 'todo_comments', 'todo_nudges', 'checkins', 'fight_markers', 'fight_notes', 'rewards', 'redemptions', 'nudges', 'nudge_sends', 'nudge_replies', 'nudge_awards', 'challenges', 'challenge_days', 'challenge_breaks'];

// rows: { table: [row, ...] }; dead: deadLetters; priv: private store overrides.
function seed({ rows = {}, dead, priv = {}, outbox = [] } = {}) {
  const r = Object.fromEntries(EMPTY.map((t) => [t, byId(rows[t] || [])]));
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
    ['shared.' + UID]: { couple: COUPLE, members: MEMBERS, rows: r, cursors: {}, outbox, deadLetters: dead || [] },
    ['priv.' + UID]: { fights: [], nudges: [], nudge_sends: [], prefs: {}, queued: [], drafts: {}, ...priv },
  };
}
const dl = (table, row) => ({ id: 'dl-' + row.id, at: NOW, error: 'refused', status: 400, entry: { table, id: row.id, op: 'insert', row } });

describe('job tabs (webkit)', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // Fake Supabase: handler({method,path,search,body}) -> {status, body} | undefined (= empty tables / 201 / 204).
  // native: mock cycle bridge; native.rejectSchedule rejects notify.schedule with that message. Calls land in window.__calls.
  async function open({ sd = seed(), handler, rawStorage, native, now = NOW, pageErrors, offline = false } = {}) {
    const sent = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(now));
    await context.addInitScript(({ sd, raw, nat }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!sessionStorage.getItem('seeded')) { // once per tab: a reload after sign-out must not re-seed the session
        sessionStorage.setItem('seeded', '1');
        for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
        for (const k in raw || {}) localStorage.setItem('cycle:' + k, raw[k]);
      }
      window.__calls = [];
      if (!nat) return;
      window.__rejectSchedule = nat.rejectSchedule || null;
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        window.__calls.push({ cmd, args });
        let r = null, err = null;
        if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
        else if (cmd === 'store.set') { if (args.value === null) localStorage.removeItem('cycle:' + args.key); else localStorage.setItem('cycle:' + args.key, args.value); }
        else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.indexOf('cycle:' + args.prefix) === 0).map((k) => k.slice(6));
        else if (cmd === 'notify.status') r = 'granted';
        else if (cmd === 'lock.get') r = false;
        else if (cmd === 'notify.permission') r = true;
        else if (cmd === 'notify.schedule' && window.__rejectSchedule) err = window.__rejectSchedule;
        else if (cmd === 'speech.start' || cmd === 'speech.stop') r = true;
        setTimeout(() => window.__cycleReply(id, r, err), 0);
      } } } };
    }, { sd, raw: rawStorage, nat: native });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', async (route) => {
      const req = route.request(), u = new URL(req.url()), rec = { method: req.method(), url: req.url(), path: u.pathname.replace('/rest/v1/', ''), search: u.search, body: req.postData() ? JSON.parse(req.postData()) : null };
      sent.push(rec);
      if (offline) return route.abort();
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
  const ready = (page) => page.waitForSelector('[data-a="go:fight"], .errscreen');
  const shared = async (page) => (await page.waitForTimeout(400), page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.u-me'))));
  const priv = async (page) => (await page.waitForTimeout(400), page.evaluate(() => JSON.parse(localStorage.getItem('cycle:priv.u-me'))));
  const wait = (page, ms) => page.waitForTimeout(ms);
  const insertTodo = (page, id) => page.evaluate((r) => CycleStore.insert('todos', r), todo(id, { title: 'New ' + id }));
  const posts = (sent) => sent.filter((x) => x.method === 'POST').length;

  // ---- store: dead letters and backoff ----
  test('C1 schema-cache / unapplied-migration rejections stay queued, never dead-lettered', async () => {
    for (const [status, code] of [[400, 'PGRST204'], [404, 'PGRST205']]) {
      const { context, page } = await open({ handler: (r) => r.method === 'POST' ? { status, body: { code, message: "Could not find the 'x' column of 'todos' in the schema cache" } } : undefined });
      await ready(page);
      await insertTodo(page, 'n1'); await wait(page, 1200);
      const sh = await shared(page);
      assert.equal(sh.outbox.length, 1, 'kept queued for ' + code);
      assert.equal(sh.deadLetters.length, 0, 'not dead for ' + code);
      await context.close();
    }
  });
  test('C1b a plain 400 constraint failure still dead-letters', async () => {
    const { context, page } = await open({ handler: (r) => r.method === 'POST' ? { status: 400, body: { code: '23514', message: 'check constraint' } } : undefined });
    await ready(page);
    await insertTodo(page, 'n1'); await wait(page, 1200);
    assert.equal((await shared(page)).deadLetters.length, 1);
    await context.close();
  });
  test('C2 while backing off the failure stays visible; a user write or a foreground retries at once; the wait is capped at 30 s', async () => {
    let fail = true;
    const { context, page, sent } = await open({ handler: (r) => r.method === 'POST' && fail ? { status: 503, body: {} } : undefined });
    await ready(page);
    await insertTodo(page, 'n1'); await wait(page, 1200);
    const first = posts(sent);
    await page.evaluate(() => CycleStore.sync()); await wait(page, 300);
    assert.equal(posts(sent), first, 'no hammering during the backoff');
    assert.ok(await page.evaluate(() => CycleStore.S.syncError), 'the failure is still reported while backing off');
    assert.ok(await page.locator('.errbar').count(), 'error bar stays up');
    const cap = await page.evaluate(() => { CycleStore.S.pushFails = 30; CycleStore.retryPush(); return CycleStore.sync().then(() => CycleStore.S.pushNextAt - Date.now()); });
    assert.ok(cap <= 30000, 'wait ' + cap);
    // foreground
    fail = false;
    await page.evaluate(() => window.cycleNative.foreground()); await wait(page, 1200);
    assert.equal((await shared(page)).outbox.length, 0, 'foreground retried and sent');
    // a user write
    fail = true;
    await insertTodo(page, 'n2'); await wait(page, 1200);
    assert.equal((await shared(page)).outbox.length, 1);
    fail = false;
    const before = posts(sent);
    await insertTodo(page, 'n3'); await wait(page, 1500);
    assert.ok(posts(sent) > before && (await shared(page)).outbox.length === 0, 'a new write ends the backoff');
    await context.close();
  });
  test('C6 syncErrorStatus clears once a sync succeeds', async () => {
    let fail = true;
    const { context, page } = await open({ handler: (r) => r.path === 'members' && fail ? { status: 403, body: {} } : undefined });
    await ready(page); await wait(page, 800);
    assert.equal(await page.evaluate(() => CycleStore.S.syncErrorStatus), 403);
    fail = false;
    await page.evaluate(() => CycleStore.sync()); await wait(page, 500);
    const st = await page.evaluate(() => [CycleStore.S.syncError, CycleStore.S.syncErrorStatus]);
    assert.deepEqual(st, [null, null]);
    await context.close();
  });

  // ---- boot error screen ----
  test('C3 boot failure offers Export (raw data) and Sign out (data stays on disk)', async () => {
    const { context, page } = await open({ rawStorage: { ['priv.' + UID]: '{not json' } });
    await page.waitForSelector('.errscreen [data-a="bootexport"]');
    await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); });
    await page.click('[data-a="bootexport"]');
    await page.waitForFunction(() => window.__copied);
    const out = JSON.parse(await page.evaluate(() => window.__copied));
    assert.equal(out['priv.u-me'], '{not json', 'raw, unparsed');
    assert.ok(out['shared.u-me'], 'every stored key');
    await page.click('[data-a="bootsignout"]');
    await page.waitForLoadState('domcontentloaded'); await wait(page, 800);
    assert.equal(await page.evaluate(() => localStorage.getItem('cycle:priv.u-me')), '{not json', 'priv kept');
    assert.ok(await page.evaluate(() => localStorage.getItem('cycle:shared.u-me')), 'shared kept');
    assert.equal(await page.evaluate(() => localStorage.getItem('cycle:session')), null, 'signed out');
    await context.close();
  });

  // ---- Not sent marker ----
  test('C4 a dead-lettered row is marked Not sent wherever it shows, text kept', async () => {
    const t = todo('t1', { title: 'Stuck todo' });
    const cm = { id: 'cm1', couple_id: 'c1', todo_id: 't1', author_id: UID, body: 'stuck comment', created_at: iso(5), deleted_at: null };
    const mk = { id: 'f1', couple_id: 'c1', logged_by: UID, at: iso(60), repaired_at: null, hit_self: null, hit_related: null };
    const fn = { id: 'fn1', couple_id: 'c1', fight_marker_id: 'f1', author_id: UID, body: 'stuck note', created_at: iso(30) };
    const sd = seed({ rows: { todos: [t], todo_comments: [cm], fight_markers: [mk], fight_notes: [fn] },
      dead: [dl('todos', t), dl('todo_comments', cm), dl('fight_notes', fn), dl('fight_markers', mk)] });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await page.click('[data-a="tab:todo"]');
    await page.waitForSelector('.td-row[data-todo="t1"]');
    assert.match(await page.textContent('.td-row[data-todo="t1"]'), /Stuck todo[\s\S]*Not sent/);
    await page.click('.td-row[data-todo="t1"]');
    await page.waitForSelector('.fn');
    assert.match(await page.textContent('.fn'), /Not sent/);
    assert.match(await page.textContent('.fn'), /stuck comment/);
    await page.click('[data-a="tab:fights"]');
    await page.waitForSelector('.rf');
    assert.match(await page.textContent('.rf'), /Not sent/);
    await page.click('.rf');
    await page.waitForSelector('.fns .fn');
    assert.match(await page.textContent('.fns .fn'), /stuck note/);
    assert.match(await page.textContent('.fns .fn'), /Not sent/);
    await context.close();
  });

  // ---- notification scheduling ----
  test('C5 a notify.schedule rejection for a time already past is handled at the call site; other rejections still surface', async () => {
    // A Me reminder due in 10 minutes gives the store something to schedule.
    const sd = () => seed({ priv: { nudge_sends: [{ id: 's1', body: 'Breathe', deliver_at: new Date(Date.parse(NOW) + 6e5).toISOString(), opened_at: null, deleted_at: null }] } });
    const errs = [];
    const { context, page } = await open({ sd: sd(), native: { rejectSchedule: "notify.schedule: 'at' 1 is not in the future (0.4s ago)" }, pageErrors: errs, offline: true });
    await ready(page); await wait(page, 1500);
    assert.equal(await page.locator('.errbar').count(), 0, 'no false Try again');
    assert.equal(errs.length, 0);
    assert.ok(await page.evaluate(() => window.__calls.some((c) => c.cmd === 'notify.schedule')), 'the schedule call was really attempted');
    await context.close();
    const b = await open({ sd: sd(), native: { rejectSchedule: 'notify.schedule: UNUserNotificationCenter exploded' }, pageErrors: [], offline: true });
    await ready(b.page); await wait(b.page, 1500);
    assert.equal(await b.page.locator('.errbar').count(), 1, 'a genuine failure is still shown');
    await b.context.close();
  });
});
