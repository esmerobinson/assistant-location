// Owning up is a to-do type ('ownup'): created from the Actions Add picker, asked of the partner through the Ask hold,
// completed with a required note (the written owning-up), shown to the partner as a Home card that opens the to-do's
// view page. Talk is Kudos only. WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it.
// OWNUP_SHOTS=<dir> saves phone-size screenshots of the new sheet, the Home card, the partner's detail view and Talk.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import C from './cycle-load.mjs';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;

const ME = 'u-me', HER = 'u-her', TZ = 'America/New_York';
const HOUR = 36e5;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const members = [{ user_id: ME, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: HER, name: 'Her', checkin_time: '21:00', hits_self: true }];
const couple = { id: 'c1', tz: TZ, created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
const seed = (uid) => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: uid, email: uid + '@x.test' } },
  ['shared.' + uid]: {
    couple, members,
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {} },
    cursors: {}, outbox: [],
  },
  // ownupSince 0: every finished owning-up in a fixture counts as new (a real install sets it on first run).
  ['priv.' + uid]: { fights: [], affirmations: [], prefs: {}, queued: [], nudges: [], nudge_sends: [], ownupSeen: [], ownupSince: 0 },
});
const ownup = (id, o) => ({ id, couple_id: 'c1', owner_id: ME, created_by: ME, item_id: null, fight_marker_id: null, title: id, description: null, type: 'ownup', due_date: null, target: null, period: null,
  points_earn: null, points_miss: null, needs_note: true, edited_at: null, tally: 0, done_at: null, created_at: ago(5), updated_at: ago(5), deleted_at: null, ...o });
const doneEvent = (id, todo, user, note) => ({ id, couple_id: 'c1', todo_id: todo, user_id: user, kind: 'done', at: ago(1), note });
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // tweak(shared, priv) edits the fixture before first load.
  async function open(tweak, uid = ME) {
    const s = seed(uid);
    if (tweak) tweak(s['shared.' + uid], s['priv.' + uid]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rows .row');
    return { context, page, uid };
  }
  // The store persists on a debounce; wait for it, then read the real localStorage copy.
  const read = async (page, key) => { await page.waitForTimeout(500); return page.evaluate((k) => JSON.parse(localStorage.getItem('cycle:' + k)), key); };
  const rowsOf = async ({ page, uid }, t) => Object.values((await read(page, 'shared.' + uid)).rows[t]);
  const shot = async (page, name) => { if (process.env.OWNUP_SHOTS) await page.screenshot({ path: path.join(process.env.OWNUP_SHOTS, name), clip: { x: 0, y: 0, width: 390, height: 844 } }); };
  const openNew = async (page) => { await page.click('[data-a="tab:todo"]'); await page.click('[data-a="addpick"]'); await page.click('[data-a="newtodo:ownup"]'); };

  test('Add picker offers Task, Habit, Owning up (challenges live on Progress); the sheet has a three-option Type, a Points toggle (off) and no Needs a note', async () => {
    const a = await open();
    await a.page.click('[data-a="tab:todo"]');
    await a.page.click('[data-a="addpick"]');
    assert.deepEqual(await a.page.$$eval('.opt', (els) => els.map((e) => e.textContent.trim())), ['Task', 'Habit', 'Owning up']);
    await a.page.click('[data-a="newtodo:ownup"]');
    assert.deepEqual(await a.page.$$eval('[data-a^="nkind:"]', (els) => els.map((e) => e.textContent.trim())), ['Task', 'Habit', 'Owning up']);
    assert.equal(await a.page.$eval('[data-a="nkind:ownup"]', (e) => e.classList.contains('on')), true);
    const labs = await a.page.$$eval('.frow .lab0', (els) => els.map((e) => e.textContent));
    assert.deepEqual(labs, ['For', 'Type', 'Due', 'Points', 'When']);
    assert.equal(await a.page.$('[data-a="nnote"]'), null, 'toggle hidden');
    await shot(a.page, '1-new-ownup-sheet.png');
    // Switching to Task brings the toggle back (it is hidden for ownup only).
    await a.page.click('[data-a="nkind:task"]');
    assert.notEqual(await a.page.$('[data-a="nnote"]'), null);
    await a.context.close();
  });

  test('for me: saved as an ownup to do with needs_note on; Points on gives task points; completing needs the note, and the ledger pays the task +3', async () => {
    const a = await open();
    await openNew(a.page);
    await a.page.click('[data-a="nfor:me"]');
    await a.page.click('[data-a="savetodo"]');
    assert.equal((await rowsOf(a, 'todos')).length, 0, 'empty title saves nothing');
    await a.page.fill('input[data-d="title"]', 'I raised my voice');
    await a.page.click('[data-a="npts"]');
    await a.page.click('[data-a="savetodo"]');
    await a.page.waitForSelector('.td-row');
    const [t] = await rowsOf(a, 'todos');
    assert.deepEqual([t.type, t.owner_id, t.created_by, t.needs_note, t.points_earn, t.points_miss, t.title], ['ownup', ME, ME, true, 3, 3, 'I raised my voice']);
    assert.equal((await rowsOf(a, 'items')).length, 0, 'self-written is not held');
    // Done opens the note sheet; an empty note is refused, a written one completes it.
    await a.page.click(`[data-a="done:${t.id}"]`);
    await a.page.click('[data-a="lognote"]');
    await a.page.waitForTimeout(300);
    assert.equal((await rowsOf(a, 'todos'))[0].done_at, null, 'empty note: still open');
    assert.match(await a.page.textContent('body'), /Note needed/);
    await a.page.fill('textarea[data-d="note"]', 'I should have paused first');
    await a.page.click('[data-a="lognote"]');
    await a.page.waitForTimeout(300);
    const [done] = await rowsOf(a, 'todos');
    assert.ok(done.done_at);
    const [ev] = await rowsOf(a, 'todo_events');
    assert.deepEqual([ev.todo_id, ev.kind, ev.user_id, ev.note], [t.id, 'done', ME, 'I should have paused first']);
    // Real stored rows through the real ledger: finished with no due date pays the task earn, once.
    const led = C.computeLedger({ members, items: [], todos: [done], todo_events: [ev], fight_markers: [], redemptions: [], nudge_sends: [], nudge_awards: [], challenges: [] }, { tz: TZ, now: Date.now() + HOUR, since: C.localDay(Date.now() - 24 * HOUR, TZ) });
    const lines = Object.values(led.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'To do on time');
    assert.deepEqual(lines.map((x) => x.pts), [3]);
    await a.context.close();
  });

  test('for her: held ask with ask_type ownup and needs_note; delivery becomes her ownup to do (not a task, no ack row)', async () => {
    const a = await open();
    await openNew(a.page); // For defaults to her
    await a.page.fill('input[data-d="title"]', 'Own the tone');
    await a.page.click('[data-a="npts"]');
    await a.page.click('[data-a="savetodo"]');
    const [item] = await rowsOf(a, 'items');
    assert.deepEqual([item.kind, item.ask_type, item.status, item.recipient_id, item.needs_note, item.points_earn, item.points_miss], ['ask', 'ownup', 'held', HER, true, 3, 3]);
    assert.equal((await rowsOf(a, 'todos')).length, 0, 'nothing reaches her during the hold');
    await a.context.close();

    // Hold over: the Still send? path delivers it.
    const b = await open((sh) => {
      sh.rows.items.i1 = { id: 'i1', couple_id: 'c1', sender_id: ME, recipient_id: HER, kind: 'ask', ask_type: 'ownup', body: 'Own the tone', description: null, due_date: null, target: null, period: null, points_earn: 3, points_miss: 3, needs_note: true, origin: null,
        status: 'held', held_until: ago(1), created_at: ago(3), delivered_at: null, deleted_at: null, updated_at: ago(3) };
    });
    await b.page.click('[data-a="still:i1"]');
    await b.page.click('[data-a="deliver:i1"]');
    const todos = await rowsOf(b, 'todos');
    assert.equal(todos.length, 1);
    assert.deepEqual([todos[0].type, todos[0].owner_id, todos[0].created_by, todos[0].item_id, todos[0].needs_note, todos[0].title], ['ownup', HER, ME, 'i1', true, 'Own the tone']);
    await b.context.close();
  });

  test('round trip: she finishes it with a note, my Home shows From Her, opening shows the note and clears the card for good', async () => {
    // Her phone: the to do I asked of her, completed through her real UI.
    const her = await open((sh) => { sh.rows.todos.t1 = ownup('t1', { owner_id: HER, created_by: ME, title: 'Own the tone' }); }, HER);
    await her.page.click('[data-a="tab:todo"]');
    assert.match(await her.page.textContent('.td-row'), /Own the tone/);
    await her.page.click('[data-a="done:t1"]');
    await her.page.fill('textarea[data-d="note"]', 'Next time I pause before answering');
    await her.page.click('[data-a="lognote"]');
    await her.page.waitForTimeout(300);
    const todos = await rowsOf(her, 'todos'), events = await rowsOf(her, 'todo_events');
    assert.ok(todos[0].done_at);
    await her.context.close();

    // My phone receives those two rows.
    const me = await open((sh) => { sh.rows.todos = byId(todos); sh.rows.todo_events = byId(events); });
    const card = '.nc[data-a="tview:t1"]';
    assert.match(await me.page.textContent(card), /From Her[\s\S]*Own the tone/);
    assert.equal(await me.page.$('[data-a^="ackedit"], [data-a="acks"]'), null);
    await me.page.locator(card).scrollIntoViewIfNeeded();
    await shot(me.page, '2-home-card.png');
    await me.page.click(card);
    await me.page.waitForSelector('.tdd2');
    assert.match(await me.page.textContent('.tdd2'), /Own the tone[\s\S]*Next time I pause before answering/);
    assert.match(await me.page.textContent('.tdd2'), /Her/);
    await shot(me.page, '3-partner-detail-note.png');
    await me.page.click('[data-a="back"]');
    assert.equal(await me.page.$(card), null, 'card gone once opened');
    assert.deepEqual((await read(me.page, 'priv.' + ME)).ownupSeen, ['t1']);
    await me.page.reload({ waitUntil: 'domcontentloaded' });
    await me.page.waitForSelector('.rows .row');
    assert.equal(await me.page.$(card), null, 'still gone after a relaunch');
    // The to do stays reachable from the push route even though it is done and hers.
    await me.page.evaluate(() => window.cycleNative.route('todo/t1'));
    assert.match(await me.page.textContent('.tdd2'), /Next time I pause before answering/);
    await me.context.close();
  });

  test('no card for: my own finished owning-up, an open one of hers, a deleted one, or one finished before this install first ran', async () => {
    const me = await open((sh, priv) => {
      priv.ownupSince = Date.now() - HOUR; // first ran an hour ago
      sh.rows.todos = byId([ownup('mine', { done_at: ago(1) }), ownup('open', { owner_id: HER, created_by: HER }), ownup('del', { owner_id: HER, done_at: ago(0.5), deleted_at: ago(0.2) }),
        ownup('migrated', { owner_id: HER, done_at: ago(300) }), ownup('fresh', { owner_id: HER, done_at: ago(0.5) })]);
    });
    assert.deepEqual(await me.page.$$eval('.nc[data-a^="tview:"]', (els) => els.map((e) => e.dataset.a)), ['tview:fresh']);
    await me.context.close();
  });

  test('a first-ever launch seeds the install floor so a cached finished owning-up does not pop up', async () => {
    const me = await open((sh, priv) => { delete priv.ownupSeen; delete priv.ownupSince; sh.rows.todos = byId([ownup('old', { owner_id: HER, done_at: ago(300) })]); });
    assert.equal(await me.page.$('.nc[data-a^="tview:"]'), null);
    const priv = await read(me.page, 'priv.' + ME);
    assert.deepEqual(priv.ownupSeen, []);
    assert.ok(priv.ownupSince > Date.now() - 60000);
    await me.context.close();
  });

  test('my open ownup asked by her is a normal Actions row, not a Home card; Edit works like a task', async () => {
    const me = await open((sh) => { sh.rows.todos = byId([ownup('t2', { created_by: HER, title: 'Own the interruption', due_date: '2099-01-01' })]); });
    assert.equal(await me.page.$('.nc[data-a^="tview:"], [data-a^="ackedit"]'), null);
    await me.page.click('[data-a="tab:todo"]');
    assert.match(await me.page.textContent('.td-row[data-todo="t2"]'), /Own the interruption/);
    assert.notEqual(await me.page.$('[data-a="done:t2"]'), null);
    await me.context.close();
    // My own: creator can edit through the same sheet; needs_note stays on.
    const b = await open((sh) => { sh.rows.todos = byId([ownup('t3', { title: 'Mine' })]); });
    await b.page.click('[data-a="tab:todo"]');
    await b.page.click('[data-a="tview:t3"]');
    await b.page.click('[data-a="etodo:t3"]');
    assert.equal(await b.page.$('[data-a="nnote"]'), null);
    await b.page.fill('input[data-d="title"]', 'Mine, edited');
    await b.page.click('[data-a="savetodo"]');
    const [t] = await rowsOf(b, 'todos');
    assert.deepEqual([t.title, t.type, t.needs_note], ['Mine, edited', 'ownup', true]);
    await b.context.close();
  });

  test('Home has no Talk row; the old acks route and a cached acks table open Home', async () => {
    const a = await open();
    assert.equal(await a.page.$('[data-id="ack"]'), null);
    await a.context.close();

    const b = await open((sh) => {
      // A store cached before this change still carries an acks table.
      sh.rows.acks = { a1: { id: 'a1', couple_id: 'c1', author_id: HER, requested_by: null, title: 'old ack', status: 'done', done_at: ago(2), read_at: null, created_at: ago(3), updated_at: ago(2), deleted_at: null } };
    });
    await b.page.evaluate(() => window.cycleNative.route('acks'));
    assert.ok(await b.page.$('.rows .row'), 'Home rows shown');
    assert.equal(await b.page.$('[data-id="ack"]'), null);
    assert.doesNotMatch(await b.page.textContent('main'), /old ack/);
    await b.context.close();
  });
});
