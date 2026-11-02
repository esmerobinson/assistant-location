// To-do view page: every row opens it, Edit only for the creator, Ping on the partner's open to dos (once per local day),
// and a comment thread. Real app in headless WebKit against seeded localStorage; the backend is aborted (offline) so
// every write is observed in the store's own persistence (outbox + rows). Needs GL_WEBKIT_PW / GL_WEBKIT_EXEC (see
// cycle-fight.test.mjs). DETAIL_SHOTS=<dir> also writes screenshots.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_WK = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = HAS_WK ? await import(process.env.GL_WEBKIT_PW) : null;
const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const SHOTS = process.env.DETAIL_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ME = 'u-me', HER = 'u-her';
const NOW = '2026-10-21T15:00:00Z'; // Wed 11:00 New York
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60 };
const MEMBERS = [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Esme', checkin_time: '21:00' }];
const td = (id, o = {}) => ({ id, couple_id: 'c1', owner_id: ME, created_by: ME, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null,
  created_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:00:00Z', deleted_at: null, ...o });

function seed({ todos = [], extra = {} } = {}) {
  const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: ME, email: 'me@x.test' } },
    ['shared.' + ME]: { couple: COUPLE, members: MEMBERS,
      rows: { items: {}, todos: byId(todos), todo_events: {}, checkins: {}, fight_markers: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {},
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, byId(v)])) },
      cursors: {}, outbox: [] },
    ['priv.' + ME]: { fights: [], affirmations: [], prefs: {} },
  };
}
const HERS = td('hers', { title: 'Renew insurance', description: 'Ask about the multi-car rate', owner_id: HER, created_by: ME, due_date: '2026-10-25' });
const MINE_FROM_HER = td('mine', { title: 'Take the bins out', owner_id: ME, created_by: HER });

describe('todo view page (webkit)', { skip: !HAS_WK && 'needs GL_WEBKIT_PW and GL_WEBKIT_EXEC' }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(s, now = NOW) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(now));
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (r) => r.abort()); // offline: writes stay in the outbox
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.click('[data-a="tab:todo"]');
    await page.waitForSelector('[data-a="addpick"]');
    return { context, page };
  }
  async function stored(page, ok = () => true) {
    const key = 'cycle:shared.' + ME, fn = `(() => { const s = JSON.parse(localStorage.getItem('${key}')); return (${ok.toString()})(s); })()`;
    await page.waitForFunction(fn);
    return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  }
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

  // NOW is Wed 21 Oct. Rows used to show a bare weekday, so a to do 6 days late read the same as one due next week.
  test('due labels: late, today, and upcoming read differently, and late and due-today sort first in both lists', async () => {
    const { page, context } = await open(seed({ todos: [
      td('soon', { title: 'soon', due_date: '2026-10-23' }), td('far', { title: 'far', due_date: '2026-11-14' }),
      td('now', { title: 'now', due_date: '2026-10-21' }), td('late', { title: 'late', due_date: '2026-10-18' }),
      td('hers-soon', { title: 'hs', owner_id: HER, due_date: '2026-10-22' }), td('hers-late', { title: 'hl', owner_id: HER, due_date: '2026-10-20' }),
    ] }));
    const rows = (sel) => page.$$eval(sel, (es) => es.map((e) => e.querySelector('.tx p').textContent + ': ' + (e.querySelector('.due') ? e.querySelector('.due').textContent : '')));
    // One list now: mine first (late, due-today first), then hers, tagged by owner.
    assert.deepEqual(await rows('.td-row'), ['late: 3 days late', 'now: Due today', 'soon: Due Fri', 'far: Due Sat 14 Nov', 'hl: 1 day late', 'hs: Due tomorrow']);
    // Overdue, close, and plain must each paint differently.
    const paint = (id) => page.$eval('[data-todo="' + id + '"] .due', (e) => { const c = getComputedStyle(e); return [c.color, c.borderColor, c.backgroundColor].join(); });
    const [late, now, far] = [await paint('late'), await paint('now'), await paint('far')];
    assert.equal(new Set([late, now, far]).size, 3, [late, now, far].join(' | '));
    assert.equal(late, 'rgb(10, 10, 10),rgb(255, 46, 136),rgb(255, 46, 136)');
    assert.ok(now.startsWith('rgb(255, 176, 32),rgb(255, 176, 32)'), now);
    await shot(page, 'due-list');
    await context.close();
  });

  test('Home lists only my late and due-today to dos, never hers, and a card opens the view page', async () => {
    const { page, context } = await open(seed({ todos: [
      td('late', { title: 'Mine late', due_date: '2026-10-18' }), td('now', { title: 'Mine today', due_date: '2026-10-21' }),
      td('soon', { title: 'Mine soon', due_date: '2026-10-22' }), td('finished', { title: 'Mine done', due_date: '2026-10-18', done_at: '2026-10-17T12:00:00Z' }),
      td('hl', { title: 'Hers late', owner_id: HER, due_date: '2026-10-20' }), td('ht', { title: 'Hers today', owner_id: HER, due_date: '2026-10-21' }),
    ] }));
    await page.click('.tabbar [data-a="tab:home"]');
    await page.waitForSelector('.nc.dc');
    assert.deepEqual(await page.$$eval('.nc.dc', (es) => es.map((e) => e.querySelector('.s').textContent + ' | ' + e.querySelector('.x').textContent)),
      ['3 days late | Mine late', 'Due today | Mine today']);
    await shot(page, 'due-home');
    await page.click('.nc.dc >> text=Mine late');
    await page.waitForSelector('.tdd2');
    assert.match(await page.$eval('.tdd2 .list', (e) => e.textContent), /Sun 18 Oct 3 days late/);
    await context.close();
  });

  // The view page is where Oliver looked and saw no state: it must paint the same pill as the list, not theme-pink text.
  for (const [due, text, colour] of [['2026-10-18', '3 days late', 'rgb(255, 46, 136)'], ['2026-10-21', 'Due today', 'rgb(255, 176, 32)'], ['2026-10-22', 'Due tomorrow', 'rgb(255, 176, 32)']]) {
    test('view page due row: ' + text, async () => {
      const { page, context } = await open(seed({ todos: [td('x', { title: 'x', owner_id: HER, due_date: due })] }));
      await page.click('.td-row .tx p');
      await page.waitForSelector('.tdd2');
      assert.equal(await page.$eval('.tdd2 .frow .due', (e) => e.textContent), text);
      assert.equal(await page.$eval('.tdd2 .frow .due', (e) => getComputedStyle(e).borderTopColor), colour);
      await shot(page, 'due-detail-' + text.replace(/ /g, '-'));
      await context.close();
    });
  }

  test('view page due row has no pill when the date is not close', async () => {
    const { page, context } = await open(seed({ todos: [td('x', { title: 'x', owner_id: HER, due_date: '2026-10-30' })] }));
    await page.click('.td-row .tx p');
    await page.waitForSelector('.tdd2');
    assert.equal(await page.$('.tdd2 .frow .due'), null);
    await context.close();
  });

  test('a long title stays on the pink band: the band reaches past the last line', async () => {
    const title = 'Can you tell me what you are doing for the whole of next weekend so that I can plan around it please';
    const { page, context } = await open(seed({ todos: [td('long', { title, owner_id: HER, due_date: '2026-10-18' })] }));
    await page.click('.td-row .tx p');
    await page.waitForSelector('.tdd2');
    // The band's rotated bottom edge rises to the right, so measure at the last line's right end, the tightest point.
    const gap = await page.evaluate(() => {
      const hd = document.querySelector('.tdd2 .hd'), hr = hd.getBoundingClientRect();
      const r = document.createRange(); r.selectNodeContents(document.querySelector('.tdd2 h2'));
      const last = [...r.getClientRects()].pop();
      const cs = getComputedStyle(hd, '::before');
      const bandBottomCenter = hr.top + parseFloat(cs.top) + parseFloat(cs.height);
      const cx = hr.left + hr.width / 2;
      return bandBottomCenter - (last.right - cx) * Math.tan(5 * Math.PI / 180) - last.bottom;
    });
    assert.ok(gap > 0, 'last title line is above the band edge by ' + gap);
    await shot(page, 'due-long-title');
    await context.close();
  });

  test("tap her to do I created: view page with Edit and Ping; Edit saves and stays on the page; back returns to To-dos", async () => {
    // Edit on a delivered ask only shows inside the edit window, so this one was delivered 5 minutes before NOW.
    const { page, context } = await open(seed({ todos: [{ ...HERS, created_at: '2026-10-21T14:55:00Z' }] }));
    await page.click('.td-row .tx p');
    await page.waitForSelector('.tdd2');
    assert.equal(await page.$eval('.tdd2 h2', (e) => e.textContent), 'Renew insurance');
    assert.match(await page.$eval('.tdd2', (e) => e.textContent), /Ask about the multi-car rate/);
    assert.ok(await page.$('.tdd2 [data-a="etodo:hers"]'), 'Edit pill');
    assert.equal(await page.$eval('.tdd2 [data-a="tnudge:hers"]', (e) => e.textContent), 'Ping', 'Ping button');
        await page.click('[data-a="etodo:hers"]');
    await page.waitForSelector('.bs [data-a="savetodo"]');
    await page.fill('[data-d="title"]', 'Renew the insurance');
    await page.click('[data-a="savetodo"]');
    await stored(page, (x) => x.rows.todos.hers.title === 'Renew the insurance');
    assert.equal(await page.$eval('.tdd2 h2', (e) => e.textContent), 'Renew the insurance', 'still on the view page, showing the edit');
    await page.click('[data-a="back"]');
    await page.waitForSelector('[data-a="addpick"]');
    await context.close();
  });

  test('my to do created by her: view page without Edit and without Ping', async () => {
    const { page, context } = await open(seed({ todos: [MINE_FROM_HER] }));
    await page.click('[data-todo="mine"] .tx p');
    await page.waitForSelector('.tdd2');
    assert.equal(await page.$('[data-a^="etodo:"]'), null);
    assert.equal(await page.$('[data-a^="tnudge:"]'), null);
    assert.equal(await page.$('.tdd2 .ghost'), null);
    await shot(page, 'b-mine-from-esme');
    await context.close();
  });

  test('Done and +1 inside rows do not open the page', async () => {
    const hab = td('hab', { title: 'Run', type: 'habit', target: 3, period: 'week' }), tk = td('tk', { title: 'Task' });
    const { page, context } = await open(seed({ todos: [hab, tk] }));
    await page.click('[data-a="tally:hab"]');
    await stored(page, (x) => x.outbox.some((o) => o.table === 'todo_events'));
    assert.equal(await page.$('.tdd2'), null);
    await page.click('[data-a="done:tk"]');
    await stored(page, (x) => !!x.rows.todos.tk.done_at);
    assert.equal(await page.$('.tdd2'), null);
    await context.close();
  });

  test('nudge: one per to do per local day; Pinged is disabled, survives reload, and a new day allows another', async () => {
    const { page, context } = await open(seed({ todos: [HERS] }));
    await page.click('.td-row .tx p');
    await page.click('[data-a="tnudge:hers"]');
    await shot(page, 'a3-nudged');
    const s = await stored(page, (x) => Object.keys(x.rows.todo_nudges || {}).length === 1);
    const n = Object.values(s.rows.todo_nudges)[0];
    assert.deepEqual([n.todo_id, n.sender_id, n.couple_id], ['hers', ME, 'c1']);
    assert.ok(s.outbox.some((o) => o.op === 'insert' && o.table === 'todo_nudges' && o.id === n.id), 'nudge queued for sync');
    assert.equal(await page.$eval('.tdd2 .ghost', (e) => e.textContent), 'Pinged');
    assert.equal(await page.$('[data-a="tnudge:hers"]'), null, 'no action left on the button');
    assert.equal(await page.$eval('.tdd2 .ghost', (e) => e.classList.contains('dis')), true);
    await page.click('.tdd2 .ghost', { force: true }).catch(() => {});
    assert.equal(Object.keys((await stored(page)).rows.todo_nudges).length, 1, 'second tap writes nothing');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-a="tab:todo"]'); await page.click('.td-row .tx p');
    assert.equal(await page.$eval('.tdd2 .ghost', (e) => e.textContent), 'Pinged');
    await context.close();
    // Yesterday's nudge does not block today's.
    const old = { id: 'n0', couple_id: 'c1', todo_id: 'hers', sender_id: ME, created_at: '2026-10-20T15:00:00Z', updated_at: '2026-10-20T15:00:00Z', deleted_at: null };
    const o2 = await open(seed({ todos: [HERS], extra: { todo_nudges: [old] } }));
    await o2.page.click('.td-row .tx p');
    assert.ok(await o2.page.$('[data-a="tnudge:hers"]'));
    await o2.context.close();
  });

  test('no Ping on a done to do of hers', async () => {
    const { page, context } = await open(seed({ todos: [{ ...HERS, done_at: '2026-10-21T13:00:00Z' }] }));
    // Done to dos leave the list, so reach the page by the push route.
    await page.evaluate(() => window.cycleNative.route('todo/hers'));
    await page.waitForSelector('.tdd2');
    assert.equal(await page.$('.tdd2 .ghost'), null);
    await context.close();
  });

  test('comment: Send adds it to the thread with author and time, persists across reload; empty is refused; offline it queues', async () => {
    const theirs = { id: 'c0', couple_id: 'c1', todo_id: 'hers', author_id: HER, body: 'On it tomorrow', created_at: '2026-10-21T13:00:00Z', updated_at: '2026-10-21T13:00:00Z', deleted_at: null };
    const { page, context } = await open(seed({ todos: [HERS], extra: { todo_comments: [theirs] } }));
    await page.click('.td-row .tx p');
    assert.match(await page.$eval('.tdd2 .fns', (e) => e.textContent), /Esme.*On it tomorrow/s);
    await page.click('[data-a="tcomment:hers"]'); // empty
    assert.equal((await stored(page)).outbox.length, 0, 'empty comment writes nothing');
    await page.fill('[data-d="cmt"]', '  Thanks, please do  ');
    await page.click('[data-a="tcomment:hers"]');
    const s = await stored(page, (x) => Object.keys(x.rows.todo_comments).length === 2);
    const c = Object.values(s.rows.todo_comments).find((r) => r.author_id === ME);
    assert.deepEqual([c.body, c.todo_id, c.couple_id], ['Thanks, please do', 'hers', 'c1']);
    assert.ok(s.outbox.some((o) => o.op === 'insert' && o.table === 'todo_comments' && o.id === c.id), 'offline comment queued');
    const thread = await page.$$eval('.tdd2 .fn', (els) => els.map((e) => e.textContent));
    assert.equal(thread.length, 2);
    assert.match(thread[1], /Me.*11:00 am.*Thanks, please do/s);
    assert.equal(await page.inputValue('[data-d="cmt"]'), '', 'input cleared');
    if (SHOTS) { await page.evaluate(() => { document.querySelectorAll('div').forEach((e) => { if (!e.children.length && e.textContent === 'Comment needed') e.remove(); }); window.scrollTo(0, 0); document.querySelectorAll('*').forEach((e) => { e.scrollTop = 0; }); }); }
    await shot(page, 'a1-top');
    // a2: scrolled to the bottom, so the thread, the input and Send show above the tab bar.
    await page.evaluate(() => { document.querySelector('[data-a^="tcomment:"]').scrollIntoView({ block: 'end' }); });
    await page.waitForTimeout(300);
    await shot(page, 'a2-comments-input');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-a="tab:todo"]'); await page.click('.td-row .tx p');
    assert.match(await page.$eval('.tdd2 .fns', (e) => e.textContent), /Thanks, please do/);
    await context.close();
  });

  test('375px: the comment input and Send clear the tab bar when scrolled to the bottom', async () => {
    const { page, context } = await open(seed({ todos: [HERS] }));
    await page.setViewportSize({ width: 375, height: 667 });
    await page.click('.td-row .tx p');
    await page.evaluate(() => { document.querySelector('[data-a^="tcomment:"]').scrollIntoView({ block: 'end' }); });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ save: document.querySelector('[data-a^="tcomment:"]').getBoundingClientRect().bottom, ta: document.querySelector('[data-d="cmt"]').getBoundingClientRect().top, bar: document.querySelector('.tabbar').getBoundingClientRect().top }));
    assert.ok(r.save <= r.bar - 8, 'Send bottom ' + r.save + ' vs tab bar top ' + r.bar);
    assert.ok(r.ta >= 0, 'input top on screen');
    await context.close();
  });

  test('push route todo/<id> opens that view page with Back to To-dos', async () => {
    const { page, context } = await open(seed({ todos: [HERS] }));
    await page.evaluate(() => window.cycleNative.route('todo/hers'));
    await page.waitForSelector('.tdd2');
    assert.equal(await page.$eval('.tdd2 h2', (e) => e.textContent), 'Renew insurance');
    assert.match(await page.$eval('.tdd2 .back', (e) => e.textContent), /To-dos/);
    await page.click('[data-a="back"]');
    await page.waitForSelector('[data-a="addpick"]');
    await context.close();
  });
});
