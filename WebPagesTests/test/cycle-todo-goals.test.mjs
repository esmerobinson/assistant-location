// To do edit sheet, per-todo points, habit period progress, "needs a note" logging, and asks queued for a partner who
// has not joined yet. Real app in headless WebKit against seeded localStorage; the backend is aborted (offline) so every
// write is observed in the store's own persistence (outbox + rows). The queue test then answers the sync calls itself.
// Needs GL_WEBKIT_PW / GL_WEBKIT_EXEC (see cycle-fight.test.mjs). TODO_SHOTS=<dir> also writes screenshots.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_WK = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = HAS_WK ? await import(process.env.GL_WEBKIT_PW) : null;
const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const SHOTS = process.env.TODO_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ME = 'u-me', HER = 'u-her';
const NOW = '2026-10-21T15:00:00Z'; // Wed 11:00 New York; the week began Mon 10-19
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60 };
const MEMBERS = [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Her', checkin_time: '21:00' }];
const td = (id, o = {}) => ({ id, couple_id: 'c1', owner_id: ME, created_by: ME, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null,
  created_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:00:00Z', deleted_at: null, ...o });
const ev = (id, todo, at, note = null) => ({ id, couple_id: 'c1', todo_id: todo, user_id: ME, kind: 'tally', at, note });

function seed({ todos = [], events = [], members = [MEMBERS[0]] } = {}) {
  const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: ME, email: 'me@x.test' } },
    ['shared.' + ME]: { couple: COUPLE, members,
      rows: { items: {}, todos: byId(todos), todo_events: byId(events), checkins: {}, fight_markers: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {} },
      cursors: {}, outbox: [] },
    ['priv.' + ME]: { fights: [], affirmations: [], prefs: {} },
  };
}

describe('todo goals (webkit)', { skip: !HAS_WK && 'needs GL_WEBKIT_PW and GL_WEBKIT_EXEC' }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // `server`: null = offline (every call aborted); otherwise {partner: bool} and the sync calls get real-looking answers.
  async function open(s, server = null) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(NOW));
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    const posts = [];
    await context.route('https://x.test/**', (r) => {
      if (!server) return r.abort();
      const q = r.request(), u = q.url();
      if (q.method() !== 'GET') { posts.push(q.method() + ' ' + u.split('?')[0].split('/rest/v1/')[1]); return r.fulfill({ status: 201, body: '' }); }
      const j = u.includes('/rest/v1/couples') ? [COUPLE] : u.includes('/rest/v1/members') ? (server.partner ? MEMBERS : [MEMBERS[0]]) : [];
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(j) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.click('[data-a="tab:todo"]');
    await page.waitForSelector('[data-a="addpick"]');
    return { context, page, posts };
  }
  // The store's persisted copy (debounced write), waiting until `ok` holds.
  async function stored(page, ok = () => true) {
    const key = 'cycle:shared.' + ME, fn = `(() => { const s = JSON.parse(localStorage.getItem('${key}')); return (${ok.toString()})(s); })()`;
    await page.waitForFunction(fn);
    return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  }
  const queued = async (page, n) => { await page.waitForFunction((k) => JSON.parse(localStorage.getItem('cycle:priv.u-me')).queued?.length === k, n); };
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

  test('edit round trip: reopen shows the saved values, edit back restores, outbox patches, Delete soft-deletes', async () => {
    const { page, context } = await open(seed({ todos: [td('t1', { title: 'Book flight', due_date: '2026-10-30' })] }));
    await page.click('[data-todo="t1"] .tx p'); await page.click('.fight[data-a="etodo:t1"]');
    await page.waitForSelector('.bs [data-a="tododel:t1"]');
    assert.equal(await page.inputValue('[data-d="title"]'), 'Book flight');
    assert.equal(await page.$eval('.bs .frow:has([data-a="stp:pe:1"]) b', (e) => e.textContent), '3');
    await shot(page, '2-edit-sheet');
    await page.fill('[data-d="title"]', 'Book flights');
    await page.click('[data-a="stp:pe:1"]'); await page.click('[data-a="stp:pm:-1"]'); await page.click('[data-a="nnote"]');
    await page.click('[data-a="savetodo"]');
    let s = await stored(page, (x) => x.rows.todos.t1.title === 'Book flights');
    const t = s.rows.todos.t1;
    assert.deepEqual([t.points_earn, t.points_miss, t.needs_note, t.due_date], [4, 2, true, '2026-10-30']);
    assert.ok(t.edited_at, 'edited_at set');
    assert.equal(s.outbox.at(-1).op, 'patch'); assert.equal(s.outbox.at(-1).patch.title, 'Book flights');
    // reopen: still on the view page after saving, whose Edit pill shows the new values
    await page.click('.fight[data-a="etodo:t1"]');
    await page.waitForSelector('.bs [data-a="tododel:t1"]');
    assert.equal(await page.inputValue('[data-d="title"]'), 'Book flights');
    assert.equal(await page.$eval('.bs .frow:has([data-a="stp:pe:1"]) b', (e) => e.textContent), '4');
    assert.equal(await page.$eval('.bs .frow:has([data-a="stp:pm:1"]) b', (e) => e.textContent), '2');
    assert.equal(await page.$eval('[data-a="nnote"]', (e) => e.classList.contains('on')), true);
    // edit back
    await page.fill('[data-d="title"]', 'Book flight');
    await page.click('[data-a="stp:pe:-1"]'); await page.click('[data-a="stp:pm:1"]'); await page.click('[data-a="nnote"]');
    await page.click('[data-a="savetodo"]');
    s = await stored(page, (x) => x.rows.todos.t1.title === 'Book flight');
    assert.deepEqual([s.rows.todos.t1.points_earn, s.rows.todos.t1.points_miss, s.rows.todos.t1.needs_note], [3, 3, false]);
    // delete (from the view page, which returns to the list)
    await page.click('.fight[data-a="etodo:t1"]'); await page.click('[data-a="tododel:t1"]');
    s = await stored(page, (x) => !!x.rows.todos.t1.deleted_at);
    assert.equal(await page.$('[data-todo="t1"]'), null);
    await context.close();
  });

  test('every row opens the view page; Edit only for the creator; the owner sees Edited until they next log it', async () => {
    const mine = td('m1', { title: 'Mine' }), hers = td('h1', { title: 'From her', created_by: HER, edited_at: '2026-10-21T14:00:00Z' });
    const { page, context } = await open(seed({ todos: [mine, hers], members: MEMBERS }));
    assert.ok(await page.$('[data-todo="h1"][data-a="tview:h1"]'));
    assert.ok(await page.$('[data-todo="m1"][data-a="tview:m1"]'));
    assert.equal(await page.$eval('[data-todo="h1"] small.ed', (e) => e.textContent), 'Edited');
    assert.equal(await page.$('[data-todo="m1"] small.ed'), null);
    // Created by her: view page, no Edit pill.
    await page.click('[data-todo="h1"] .tx p');
    await page.waitForSelector('.tdd2');
    assert.equal(await page.$('[data-a^="etodo:"]'), null);
    await page.click('[data-a="back"]');
    // Created by me: Edit pill present.
    await page.click('[data-todo="m1"] .tx p');
    await page.waitForSelector('.tdd2 [data-a="etodo:m1"]');
    await page.click('[data-a="back"]');
    // The Done button inside a row logs it without opening the page.
    await page.click('[data-a="done:h1"]');
    await stored(page, (x) => !!x.rows.todos.h1.done_at);
    assert.equal(await page.$('.tdd2'), null);
    await context.close();
  });

  test('Day / Week / Month fit inside their pills without touching each other or the border', async () => {
    const { page, context } = await open(seed());
    await page.click('[data-a="addpick"]'); await page.click('[data-a="newtodo:task"]'); await page.click('[data-a="nkind:habit"]');
    await shot(page, '6-per-seg');
    // Measure the glyphs, not the span: a centered word wider than its fixed-width span spills out both sides while
    // the span boxes themselves still sit neatly side by side (that is how MONTH ran into WEEK and the border).
    const r = await page.$eval('.seg.hs', (seg) => {
      const box = seg.getBoundingClientRect();
      return { seg: [box.left, box.right], words: [...seg.querySelectorAll('span')].map((s) => {
        const rg = document.createRange(); rg.selectNodeContents(s); const t = rg.getBoundingClientRect(), b = s.getBoundingClientRect();
        return { w: s.textContent, text: [t.left, t.right], pill: [b.left, b.right] };
      }) };
    });
    for (const x of r.words) assert.ok(x.text[0] >= x.pill[0] + 4 && x.text[1] <= x.pill[1] - 4, x.w + ' fits its pill: ' + JSON.stringify(x));
    for (let i = 1; i < r.words.length; i++) assert.ok(r.words[i - 1].pill[1] <= r.words[i].pill[0], 'no overlap: ' + JSON.stringify(r));
    assert.ok(r.words[0].pill[0] >= r.seg[0] + 2 && r.words.at(-1).pill[1] <= r.seg[1] - 2, 'inside the border: ' + JSON.stringify(r));
    await context.close();
  });

  test('a to do she made for me sits under Open, in the one list', async () => {
    const fromHer = td('h1', { title: 'From her', created_by: HER });
    const { page, context } = await open(seed({ todos: [fromHer], members: MEMBERS }));
    const sections = await page.$$eval('.td .list', (els) => els.map((e) => [e.querySelector('.lab')?.textContent, [...e.querySelectorAll('[data-todo]')].map((r) => r.dataset.todo), !!e.querySelector('.empty')]));
    await shot(page, '5-sections');
    // One list now: hers sits in Open with a tag saying whose it is; there is no separate partner section.
    assert.deepEqual(sections, [['Open', ['h1'], false]]);
    await context.close();
  });

  test('habit row shows progress in the current period and +1 advances it', async () => {
    const h = td('h', { title: 'Stretch', type: 'habit', target: 3, period: 'week' });
    const e = [ev('e1', 'h', '2026-10-19T14:00:00Z'), ev('e2', 'h', '2026-10-20T14:00:00Z'), ev('e0', 'h', '2026-10-18T14:00:00Z')]; // e0 is last week
    const { page, context } = await open(seed({ todos: [h], events: e }));
    const row = '[data-todo="h"]';
    assert.equal(await page.$eval(row + ' .hv', (x) => x.textContent), '2/3');
    assert.equal(await page.$$eval(row + ' .dt i:not(.o)', (x) => x.length), 2);
    assert.equal(await page.$$eval(row + ' .dt i.o', (x) => x.length), 1);
    await shot(page, '3-habit-row');
    await page.click('[data-a="tally:h"]');
    await stored(page, (x) => Object.values(x.rows.todo_events).length === 4);
    assert.equal(await page.$eval(row + ' .hv', (x) => x.textContent), '3/3');
    await context.close();
  });

  test('needs a note: an empty log is refused, the text is stored on the event and shown on the row', async () => {
    const t = td('t', { title: 'Call mum', needs_note: true }), h = td('h', { title: 'Run', type: 'habit', target: 2, period: 'day', needs_note: true });
    const { page, context } = await open(seed({ todos: [t, h] }));
    await page.click('[data-a="done:t"]');
    await page.waitForSelector('[data-a="lognote"]');
    await shot(page, '4-note-sheet');
    await page.click('[data-a="lognote"]'); // empty
    assert.equal(await page.textContent('.errbar[role="alert"]'), 'Note needed');
    let s = await stored(page);
    assert.equal(s.rows.todos.t.done_at, null);
    assert.equal(Object.keys(s.rows.todo_events).length, 0);
    assert.ok(await page.$('[data-a="lognote"]'), 'sheet stays open');
    await page.fill('[data-d="note"]', '   '); await page.click('[data-a="lognote"]'); // whitespace only
    s = await stored(page);
    assert.equal(Object.keys(s.rows.todo_events).length, 0);
    await page.fill('[data-d="note"]', 'Talked for an hour'); await page.click('[data-a="lognote"]');
    s = await stored(page, (x) => !!x.rows.todos.t.done_at);
    const e = Object.values(s.rows.todo_events);
    assert.deepEqual(e.map((x) => [x.kind, x.todo_id, x.note]), [['done', 't', 'Talked for an hour']]);
    // habit +1 goes through the same sheet and the row shows the latest note
    await page.click('[data-a="tally:h"]');
    await page.fill('[data-d="note"]', '5k loop'); await page.click('[data-a="lognote"]');
    s = await stored(page, (x) => Object.keys(x.rows.todo_events).length === 2);
    assert.ok(Object.values(s.rows.todo_events).some((x) => x.kind === 'tally' && x.note === '5k loop'));
    assert.equal(await page.$eval('[data-todo="h"] .tdd', (x) => x.textContent), '5k loop');
    await context.close();
  });

  test('an ask for a partner who has not joined is queued, shown as Queued, and sent through the hold once they appear', async () => {
    const { page, context, posts } = await open(seed(), { partner: false });
    await page.click('[data-a="addpick"]'); await page.click('[data-a="newtodo:task"]');
    await page.waitForSelector('[data-a="nfor:them"]');
    await shot(page, '1-add-sheet');
    // A new to do is for the partner by default, even before they have joined.
    assert.equal(await page.getAttribute('[data-a="nfor:them"]', 'class'), 'on');
    await page.fill('[data-d="title"]', 'Water the plants');
    await page.click('[data-a="nkind:habit"]'); await page.click('[data-a="nper:day"]'); await page.click('[data-a="stp:pe:1"]');
    await page.click('[data-a="savetodo"]');
    await page.waitForSelector('.td-row small:has-text("Queued")');
    assert.equal(await page.$eval('.td-row small:has-text("Queued")', (e) => e.textContent), 'Queued');
    assert.equal(await page.$eval('.td-row .tx p', (e) => e.textContent), 'Water the plants');
    let s = await stored(page);
    assert.equal(Object.keys(s.rows.items).length, 0);
    assert.equal(s.outbox.length, 0);
    await queued(page, 1);
    // the partner joins: the next sync brings them into members
    await context.unroute('https://x.test/**');
    await context.route('https://x.test/**', (r) => {
      const q = r.request(), u = q.url();
      if (q.method() !== 'GET') { posts.push(q.method() + ' ' + u.split('?')[0].split('/rest/v1/')[1]); return r.fulfill({ status: 201, body: '' }); }
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(u.includes('/rest/v1/couples') ? [COUPLE] : u.includes('/rest/v1/members') ? MEMBERS : []) });
    });
    await page.evaluate(() => CycleStore.sync());
    s = await stored(page, (x) => Object.keys(x.rows.items).length === 1);
    const it = Object.values(s.rows.items)[0];
    assert.deepEqual([it.kind, it.recipient_id, it.status, it.body, it.ask_type, it.period, it.target, it.points_earn, it.points_miss], ['ask', HER, 'held', 'Water the plants', 'habit', 'day', 3, 2, 0]);
    await queued(page, 0);
    await page.waitForSelector('.held .td-row');
    assert.equal(await page.$('.td-row small:has-text("Queued")'), null, 'Queued row is gone');
    await context.close();
  });

  test('the to do count reads "You <mine> · <partner> <theirs + queued>" on the To-dos header, ignoring done and deleted', async () => {
    const mem = [MEMBERS[0], { ...MEMBERS[1], name: 'Esme' }];
    const read = async (page) => page.$eval('header.hd .dl', (e) => e.textContent);
    const hers = [td('h1', { owner_id: HER }), td('h2', { owner_id: HER }), td('h3', { owner_id: HER, done_at: '2026-10-20T12:00:00Z' }), td('h4', { owner_id: HER, deleted_at: '2026-10-20T12:00:00Z' })];
    let o = await open(seed({ todos: hers, members: mem }));
    assert.equal(await read(o.page), 'You 0 \u00b7 Esme 2');
    await o.context.close();
    const mine = [td('m1'), td('m2'), td('m3'), td('m4', { done_at: '2026-10-20T12:00:00Z' }), td('m5', { deleted_at: '2026-10-20T12:00:00Z' })];
    o = await open(seed({ todos: [...mine, ...hers.slice(0, 1)], members: mem }));
    assert.equal(await read(o.page), 'You 3 \u00b7 Esme 1');
    await o.context.close();
    // an ask queued for a partner who has not joined counts toward the partner
    o = await open(seed({ todos: [td('m1')] }));
    await o.page.click('[data-a="addpick"]'); await o.page.click('[data-a="newtodo:task"]');
    await o.page.fill('[data-d="title"]', 'Water the plants');
    await o.page.click('[data-a="savetodo"]');
    await o.page.waitForSelector('.td-row small:has-text("Queued")');
    assert.equal(await read(o.page), 'You 1 \u00b7 Partner 1');
    await o.context.close();
  });
});
