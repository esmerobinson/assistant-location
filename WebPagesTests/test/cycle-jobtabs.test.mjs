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
  // ---- B: new screen behaviours ----
  const tabTodo = async (page) => { await page.click('[data-a="tab:todo"]'); await page.waitForSelector('[data-a="todoseg:rem"]'); };
  const library = async (page, view) => { await tabTodo(page); await page.click('[data-a="todoseg:rem"]'); if (view) await page.click('[data-a="remview:' + view + '"]'); };
  const stored = async (page, table, id) => (await shared(page)).rows[table][id];
  const detail = async (page, id) => { await tabTodo(page); await page.click('[data-a="todoseg:todo"]'); await page.click('.td-row[data-todo="' + id + '"]'); await page.waitForSelector('.tdd2'); };

  test('B1 Edit on a to-do I made for her exists only inside the 15 minute window, and disappears when it passes', async () => {
    const sd = seed({ rows: { todos: [todo('mine', { owner_id: UID }), todo('fresh', { owner_id: PID, created_at: iso(10) }), todo('stale', { owner_id: PID, created_at: iso(40) })] } });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await detail(page, 'mine');
    assert.equal(await page.locator('[data-a^="etodo:"]').count(), 1, 'my own to-do is always editable');
    await page.click('[data-a="back"]');
    await detail(page, 'stale');
    assert.equal(await page.locator('[data-a^="etodo:"]').count(), 0, 'older than the window: no Edit');
    await page.click('[data-a="back"]');
    await detail(page, 'fresh');
    assert.equal(await page.locator('[data-a^="etodo:"]').count(), 1, 'inside the window: Edit');
    await context.clock.setFixedTime(new Date(Date.parse(NOW) + 10 * 6e4)); // 20 minutes after creation
    await page.evaluate(() => window.cycleNative.foreground()); await wait(page, 300);
    assert.equal(await page.locator('[data-a^="etodo:"]').count(), 0, 'window expired while open');
    await context.close();
  });

  test('B2 deleting my own comment leaves a Deleted marker and a soft-delete patch; her comment has no Delete', async () => {
    const cm = (id, by, body) => ({ id, couple_id: 'c1', todo_id: 't1', author_id: by, body, created_at: iso(5), updated_at: iso(5), deleted_at: null });
    const sd = seed({ rows: { todos: [todo('t1')], todo_comments: [cm('c-me', UID, 'my words'), cm('c-her', PID, 'her words')] } });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await detail(page, 't1');
    assert.equal(await page.locator('[data-a="cmtdel:c-her"]').count(), 0);
    await page.click('[data-a="cmtdel:c-me"]');
    await page.waitForSelector('.fn.gone');
    assert.match(await page.textContent('.fn.gone'), /Deleted/);
    assert.doesNotMatch(await page.textContent('.tdd2'), /my words/);
    assert.ok((await stored(page, 'todo_comments', 'c-me')).deleted_at, 'soft-deleted in the store');
    assert.equal((await stored(page, 'todo_comments', 'c-her')).deleted_at, null);
    await context.close();
  });

  // A reminder I sent her, with a reply from each of us.
  const threadSeed = () => {
    const rep = (id, by, body) => ({ id, couple_id: 'c1', send_id: 's1', author_id: by, body, read_at: null, created_at: iso(20), updated_at: iso(20), deleted_at: null });
    return seed({ rows: {
      nudges: [{ id: 'n1', couple_id: 'c1', author_id: UID, body: 'Breathe', tag: 'Calm', pinned: false, sort_order: 0, archived_at: null, created_at: iso(900), updated_at: iso(900), deleted_at: null }],
      nudge_sends: [{ id: 's1', couple_id: 'c1', nudge_id: 'n1', sender_id: UID, recipient_id: PID, body: 'Breathe', deliver_at: iso(60), opened_at: iso(50), created_at: iso(61), deleted_at: null }],
      nudge_replies: [rep('r-me', UID, 'my reply'), rep('r-her', PID, 'her reply')] } });
  };
  test('B3 deleting my reply leaves a Deleted marker and a soft-delete patch; hers has no Delete', async () => {
    const { context, page } = await open({ sd: threadSeed(), offline: true });
    await ready(page);
    await library(page);
    await page.click('[data-a="nudge:n1"]');
    await page.waitForSelector('.bub');
    assert.equal(await page.locator('[data-a="repdel:r-her"]').count(), 0);
    await page.click('[data-a="repdel:r-me"]');
    await page.waitForSelector('.bub.gone');
    assert.match(await page.textContent('.bub.gone'), /Deleted/);
    assert.doesNotMatch(await page.textContent('.th'), /my reply/);
    assert.ok((await stored(page, 'nudge_replies', 'r-me')).deleted_at);
    assert.equal((await stored(page, 'nudge_replies', 'r-her')).deleted_at, null);
    await context.close();
  });

  test('B4 Cancel on a queued send soft-deletes it (shared patch, and the private Me tier); a delivered one has no Cancel', async () => {
    const future = new Date(Date.parse(NOW) + 6 * 36e5).toISOString();
    const nsend = (id, o) => ({ id, couple_id: 'c1', nudge_id: 'n1', sender_id: UID, recipient_id: PID, body: 'Body ' + id, deliver_at: future, opened_at: null, created_at: iso(1), deleted_at: null, ...o });
    const sd = seed({ rows: { nudges: [{ id: 'n1', couple_id: 'c1', author_id: UID, body: 'Breathe', tag: 'Calm', pinned: false, sort_order: 0, archived_at: null, created_at: iso(900), updated_at: iso(900), deleted_at: null }],
      nudge_sends: [nsend('q1'), nsend('done1', { deliver_at: iso(60), opened_at: iso(50) })] },
      priv: { nudge_sends: [{ id: 'pq1', nudge_id: 'pn1', body: 'Me later', deliver_at: future, opened_at: null, created_at: iso(1), deleted_at: null }] } });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await library(page, 'sent');
    assert.equal(await page.locator('[data-a^="sendcancel:"]').count(), 2, 'only the two queued sends offer Cancel');
    await page.click('[data-a="sendcancel:esme:q1"]');
    await wait(page, 300);
    assert.ok((await stored(page, 'nudge_sends', 'q1')).deleted_at, 'shared send soft-deleted');
    assert.equal(await page.locator('[data-a="sendcancel:esme:q1"]').count(), 0, 'gone from the list');
    await page.click('[data-a="sendcancel:me:pq1"]');
    await wait(page, 300);
    assert.ok((await priv(page)).nudge_sends[0].deleted_at, 'private send soft-deleted');
    await context.close();
  });

  test('B5 an archived reminder can be restored, and it returns to Saved', async () => {
    const sd = seed({ rows: { nudges: [{ id: 'n1', couple_id: 'c1', author_id: UID, body: 'Old calm', tag: 'Calm', pinned: false, sort_order: 0, archived_at: iso(100), created_at: iso(900), updated_at: iso(900), deleted_at: null }] } });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await library(page, 'arch');
    await page.click('[data-a="nudgerestore:esme:n1"]');
    await wait(page, 300);
    assert.equal((await stored(page, 'nudges', 'n1')).archived_at, null);
    await page.click('[data-a="remview:lib"]');
    assert.ok(await page.locator('[data-nid="n1"]').count(), 'back in Saved');
    await context.close();
  });

  test('B6 a dropped ask can be restored to held from Dropped', async () => {
    const it = { id: 'i1', couple_id: 'c1', sender_id: UID, recipient_id: PID, kind: 'ask', body: 'Dropped ask', ask_type: 'task', description: null, due_date: null, target: null, period: null, points_earn: null, points_miss: null,
      needs_note: false, origin: null, response_type: null, fight_marker_id: null, held_until: iso(30), status: 'dropped', delivered_at: null, opened_at: null, kept: null, created_at: iso(120), updated_at: iso(120), deleted_at: null };
    const { context, page } = await open({ sd: seed({ rows: { items: [it] } }), offline: true });
    await ready(page);
    await page.click('[data-a="go:more"]'); await page.click('[data-a="go:dropped"]');
    await page.click('[data-a="restore:i1"]');
    await wait(page, 300);
    assert.equal((await stored(page, 'items', 'i1')).status, 'held');
    await context.close();
  });

  test('B7 a reward can be edited (name and price) and archived from the shop', async () => {
    const rw = { id: 'r1', couple_id: 'c1', name: 'Breakfast', price: 40, created_by: UID, archived: false, art: null, created_at: iso(900), updated_at: iso(900), deleted_at: null };
    const { context, page } = await open({ sd: seed({ rows: { rewards: [rw] } }), offline: true });
    await ready(page);
    await page.click('[data-a="tab:progress"]'); await page.click('[data-a="go:shop"]');
    await page.click('[data-a="shopedit"]'); await page.click('[data-a="reward:r1"]');
    await page.fill('[data-d="rname"]', 'Brunch'); await page.fill('[data-d="rprice"]', '55');
    await page.click('[data-a="savereward"]'); await wait(page, 300);
    const r = await stored(page, 'rewards', 'r1');
    assert.deepEqual([r.name, r.price, r.archived], ['Brunch', 55, false]);
    assert.match(await page.textContent('.shop'), /Brunch/);
    await page.click('[data-a="reward:r1"]');
    await page.click('[data-a="rewardarch:r1"]'); await wait(page, 300);
    assert.equal((await stored(page, 'rewards', 'r1')).archived, true);
    assert.doesNotMatch(await page.textContent('.shop'), /Brunch/);
    await context.close();
  });

  // Own fight carries intensity on this phone only; the partner's fight is a bare marker.
  const mine = { id: 'fm', couple_id: 'c1', logged_by: UID, at: iso(60), repaired_at: null, hit_self: null, hit_related: null };
  const hers = { id: 'fh', couple_id: 'c1', logged_by: PID, at: iso(120), repaired_at: null, hit_self: null, hit_related: null };
  test('B8 the fight list shows intensity for my fights and never for hers (list and detail)', async () => {
    // A stale private entry under her marker's id must still not surface: intensity is shown only for fights I logged.
    const sd = seed({ rows: { fight_markers: [mine, hers] }, priv: { fights: [{ id: 'fm', at: Date.parse(mine.at), intensity: 4 }, { id: 'fh', at: Date.parse(hers.at), intensity: 5 }] } });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await page.click('[data-a="tab:fights"]'); await page.waitForSelector('.rf');
    assert.equal(await page.locator('[data-a="openfight:fm"] .ix i.f').count(), 4);
    assert.equal(await page.locator('[data-a="openfight:fh"] .ix').count(), 0, 'no intensity on her fight');
    await page.click('[data-a="openfight:fh"]'); await page.waitForSelector('.fd');
    assert.equal(await page.locator('.fd .ix').count(), 0, 'nor on her fight detail');
    assert.equal(await page.locator('.fd .arrows').count(), 0, 'and no picker on her fight');
    await context.close();
  });
  test('B8b my fight intensity is labeled, editable from its detail, persists on the phone, and never syncs', async () => {
    const sd = seed({ rows: { fight_markers: [mine] }, priv: { fights: [{ id: 'fm', at: Date.parse(mine.at), intensity: 2 }] } });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await page.click('[data-a="tab:fights"]'); await page.waitForSelector('.rf');
    assert.equal(await page.locator('[data-a="openfight:fm"] .ixl').innerText(), 'INTENSITY');
    await page.click('[data-a="openfight:fm"]'); await page.waitForSelector('.fd');
    await page.fill('.fd textarea', 'keep this draft');
    assert.equal(await page.locator('.fd .arrows .sel b').innerText(), '2');
    await page.click('[data-a="fightint:5"]');
    assert.equal(await page.locator('.fd .arrows .sel b').innerText(), '5');
    assert.equal(await page.inputValue('.fd textarea'), 'keep this draft', 'picking keeps the typed note');
    assert.equal((await priv(page)).fights[0].intensity, 5);
    const outbox = await page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')).outbox);
    assert.deepEqual(outbox, [], 'intensity stays private');
    await page.click('[data-a="fightint:1"]');
    assert.equal((await priv(page)).fights[0].intensity, 1, 'and back down');
    await page.fill('.fd textarea', '');
    await page.click('[data-a="notesave"]');
    await page.waitForSelector('.rf');
    assert.equal(await page.locator('.errbar[role="alert"]').count(), 0, 'Save with no note is not an error');
    assert.equal((await priv(page)).fights[0].intensity, 1, 'the picked intensity survives Save');
    assert.deepEqual(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_notes)), [], 'and no empty note is written');
    await page.reload(); await ready(page);
    await page.click('[data-a="tab:fights"]'); await page.waitForSelector('.rf');
    assert.equal(await page.locator('[data-a="openfight:fm"] .ix i.f').count(), 1, 'list reflects the edit after reload');
    await context.close();
  });

  test('B9 several fights on one calendar day are all reachable from the Cycle day view', async () => {
    const fights = [30, 90, 150].map((m, i) => ({ id: 'f' + i, at: Date.parse(NOW) - m * 6e4, intensity: 2 + i }));
    const sd = seed({ rows: { fight_markers: fights.map((f) => ({ id: f.id, couple_id: 'c1', logged_by: UID, at: new Date(f.at).toISOString(), repaired_at: null, hit_self: null, hit_related: null })) }, priv: { fights } });
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    await page.click('[data-a="go:more"]'); await page.click('[data-a="go:cycle"]'); await page.waitForSelector('.cyc');
    assert.equal(await page.locator('section.det').count(), 3, 'one block per fight on the picked day');
    for (const f of fights) assert.equal(await page.locator('section.det[data-a="openfight:' + f.id + '"]').count(), 1);
    await context.close();
  });

  // Fight detail with a mic field; draft key fightdetail:<id>.
  const openFight = async (page) => { await page.click('[data-a="tab:fights"]'); await page.click('[data-a="openfight:fm"]'); await page.waitForSelector('.fd textarea'); };
  const fightSeed = () => seed({ rows: { fight_markers: [mine] }, priv: { fights: [{ id: 'fm', at: Date.parse(mine.at), intensity: 3 }] } });
  test('B10 dictated text survives a re-render and a reload; an interrupted recording keeps what was heard', async () => {
    // Offline: fight_markers is pulled whole, so the empty mock server would otherwise drop the seeded marker as deleted.
    const { context, page } = await open({ sd: fightSeed(), native: {}, offline: true });
    await ready(page); await openFight(page);
    await page.fill('.fd textarea', 'typed first');
    await page.click('.fd .mic');
    await page.evaluate(() => window.cycleNative.speech('and then some', false));
    assert.equal(await page.inputValue('.fd textarea'), 'typed first and then some');
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); // forces a render
    assert.equal(await page.inputValue('.fd textarea'), 'typed first and then some', 'survives a re-render');
    await page.evaluate(() => window.cycleNative.speechError('Mic cut off')); // interrupted: shell reports an error, no final
    assert.equal(await page.inputValue('.fd textarea'), 'typed first and then some', 'interrupted recording keeps the text');
    assert.equal((await priv(page)).drafts['fightdetail:fm'].d.more, 'typed first and then some', 'persisted as a draft');
    await page.reload(); await ready(page); await openFight(page);
    assert.equal(await page.inputValue('.fd textarea'), 'typed first and then some', 'restored after reload');
    await context.close();
  });

  test('B11 Save with nothing to save says so instead of doing nothing (reply, comment)', async () => {
    const sd = threadSeed();
    sd['shared.' + UID].rows.fight_markers = byId([mine]);
    sd['shared.' + UID].rows.todos = byId([todo('t1')]);
    sd['priv.' + UID].fights = [{ id: 'fm', at: Date.parse(mine.at), intensity: 3 }];
    const { context, page } = await open({ sd, offline: true });
    await ready(page);
    const expectErr = async (sel, label) => {
      const queuedBefore = (await shared(page)).outbox.length; // opening a thread legitimately queues read receipts
      await page.click(sel);
      await page.waitForSelector('.errbar');
      assert.equal((await shared(page)).outbox.length, queuedBefore, label + ': nothing queued');
      await page.evaluate(() => { const e = document.querySelector('.errbar'); if (e) e.remove(); });
    };
    await library(page); await page.click('[data-a="nudge:n1"]'); await page.waitForSelector('[data-a="nreply"]');
    await expectErr('[data-a="nreply"]', 'reply');
    await page.click('[data-a="back"]').catch(() => {});
    await detail(page, 't1');
    await expectErr('[data-a^="tcomment:"]', 'comment');
    await context.close();
  });
  // ---- D: layout guarantees found in screenshot review ----
  const tabRects = (page) => page.evaluate(() => {
    const r = (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10); };
    return { bar: r(document.querySelector('.tabbar')), tabs: [...document.querySelectorAll('.tabbar .tab')].map((t) => [r(t), r(t.querySelector('svg')), r(t.querySelector('b'))]) };
  });
  test('D2 the tab bar, its icons and its labels sit at the same place on all four tabs', async () => {
    const { context, page } = await open({ sd: seed({ rows: { fight_markers: [mine] }, priv: { fights: [{ id: 'fm', at: Date.parse(mine.at), intensity: 3 }] } }), offline: true });
    await ready(page);
    const seen = {};
    for (const t of ['home', 'todo', 'fights', 'progress']) {
      await page.click('[data-a="tab:' + t + '"]'); await wait(page, 200);
      seen[t] = await tabRects(page);
    }
    for (const t of ['todo', 'fights', 'progress']) assert.deepEqual(seen[t], seen.home, t + ' tab bar differs from Home');
    await context.close();
  });
  test('D2b the Fights header adds a fight from a styled icon button with no text', async () => {
    const { context, page } = await open({ offline: true });
    await ready(page);
    await page.click('[data-a="tab:fights"]');
    const btn = page.locator('.fl .hd [data-a="go:fight"]');
    assert.equal((await btn.textContent()).trim(), '');
    assert.equal(await btn.locator('use').getAttribute('href'), '#plus');
    // Size proves the .fl CSS applies: the .plus rule was scoped to .nd, and unstyled the span collapses to a bare glyph.
    const box = await btn.boundingBox();
    assert.deepEqual([box.width, box.height], [40, 40]);
    await btn.click();
    await page.waitForSelector('[data-a="fightsave"]');
    await context.close();
  });
  test('D3 a fight logged with a note shows the same date and time in the detail header and on the note', async () => {
    const { context, page } = await open({ offline: true });
    await ready(page);
    await page.click('[data-a="go:fight"]');
    await page.click('[data-a="int:3"]');
    await page.fill('[data-d="note"]', 'about the dishes');
    await page.click('[data-a="fightsave"]');
    await page.click('[data-a="tab:fights"]');
    await page.click('[data-a^="openfight:"]');
    await page.waitForSelector('.fd .fn');
    const head = (await page.textContent('.fd .hd .dl')).trim();
    const note = (await page.textContent('.fd .fn .meta')).trim();
    assert.ok(head.length > 8, 'header shows a stamp: ' + head);
    assert.ok(note.endsWith(head), 'note stamp "' + note + '" should end with header "' + head + '"');
    await context.close();
  });
  test('D1 Home keeps Log fight / To-do / Reminder visible above the tab bar however long the list, and the list scrolls clear of them', async () => {
    const dues = Array.from({ length: 9 }, (_, i) => todo('due' + i, { due_date: '2026-10-21', title: 'Due thing number ' + i }));
    const { context, page } = await open({ sd: seed({ rows: { todos: dues } }), offline: true });
    await page.setViewportSize({ width: 375, height: 844 });
    await ready(page);
    const box = (sel) => page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }, sel);
    const scr = await page.evaluate(() => { const s = document.querySelector('.scr'); return { sh: s.scrollHeight, ch: s.clientHeight }; });
    assert.ok(scr.sh > scr.ch + 200, 'seed must overflow the screen: ' + JSON.stringify(scr));
    const rows = await page.$$eval('.pin .row', (els) => els.map((e) => { const b = e.getBoundingClientRect(); return [e.textContent.trim(), b.top, b.bottom, b.left, b.right]; }));
    assert.deepEqual(rows.map((r) => r[0]), ['Log fight', 'To-do', 'Reminder']);
    const tab = await box('.tabbar');
    for (const [name, top, bottom, left, right] of rows) {
      assert.ok(top >= 0 && bottom <= 844 && left >= 0 && right <= 375, name + ' inside the viewport');
      assert.ok(bottom <= tab.top, name + ' not covered by the tab bar');
    }
    await page.evaluate(() => { const s = document.querySelector('.scr'); s.scrollTop = s.scrollHeight; });
    const pin = await box('.pin'), last = await box('.scr main > .nd:last-child');
    assert.ok(last.bottom <= pin.top, 'last card (' + last.bottom + ') scrolls fully clear of the pinned row (' + pin.top + ')');
    await page.click('.pin [data-a="nudgenew"]'); // still tappable while the list is scrolled
    await page.waitForSelector('.pin', { state: 'detached' }); // navigated off Home
    await context.close();
  });
});
