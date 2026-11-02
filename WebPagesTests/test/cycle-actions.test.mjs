// The Actions tab (was To do): section assignment, challenge cards, the Add picker, and challenges gone from Us / Points.
// Real app in headless WebKit against seeded localStorage, backend aborted. Needs GL_WEBKIT_PW / GL_WEBKIT_EXEC.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_WK = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = HAS_WK ? await import(process.env.GL_WEBKIT_PW) : null;
const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';

const ME = 'u-me', HER = 'u-her';
const NOW = '2026-10-21T15:00:00Z'; // Wed 11:00 New York, so "today" is 2026-10-21
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60 };
const MEMBERS = [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Esme', checkin_time: '21:00' }];
const td = (id, o = {}) => ({ id, couple_id: 'c1', owner_id: ME, created_by: ME, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null,
  created_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:00:00Z', deleted_at: null, ...o });
const T = { yesterday: '2026-10-20', today: '2026-10-21', tomorrow: '2026-10-22', later: '2026-11-05' };
const ch = (id, o = {}) => ({ id, couple_id: 'c1', name: id, start: '2026-10-01', for_user: ME, breaks_on: 'hit', accepted_at: '2026-10-01T12:00:00Z', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...o });
const goal = (id, o = {}) => ch(id, { breaks_on: 'goal', start: '2026-10-19', goal_days: 10, goal_window_days: 14, goal_earn: 150, goal_miss: 50, rule: 'Read', accepted_at: '2026-10-19T12:00:00Z', ...o });
const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));

function seed({ todos = [], challenges = [], fights = [], days = [] } = {}) {
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: ME, email: 'me@x.test' } },
    ['shared.' + ME]: { couple: COUPLE, members: MEMBERS,
      rows: { items: {}, todos: byId(todos), todo_events: {}, checkins: {}, fight_markers: byId(fights), rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {},
        challenges: byId(challenges), challenge_days: byId(days) },
      cursors: {}, outbox: [] },
    ['priv.' + ME]: { fights: [], affirmations: [], prefs: {} },
  };
}

describe('actions tab (webkit)', { skip: !HAS_WK && 'needs GL_WEBKIT_PW and GL_WEBKIT_EXEC' }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(s) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(NOW));
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (r) => r.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rows .row');
    await page.click('.tabbar [data-a="tab:todo"]');
    await page.waitForSelector('[data-a="addpick"]');
    return { context, page };
  }
  // [label, [row ids]] per labelled section on the Actions screen, in screen order.
  const sections = (page) => page.$$eval('.td .list', (els) => els.map((e) => [e.querySelector('.lab').textContent, [...e.querySelectorAll('[data-a^="tview:"]')].map((r) => r.dataset.a.slice(6)), !!e.querySelector('.empty')]));

  test('every user-visible name for the tab says Actions: tab bar, header, home row, and the Back label from a to do', async () => {
    const { context, page } = await open(seed({ todos: [td('a')] }));
    assert.equal(await page.$eval('.tabbar .tab.on b', (e) => e.textContent), 'Actions');
    assert.equal(await page.textContent('.hd h2'), 'Actions');
    await page.click('.tabbar [data-a="tab:home"]');
    assert.equal(await page.$eval('.row[data-id="todo"]', (e) => e.textContent.includes('Actions') && !e.textContent.includes('To do')), true);
    await page.click('.tabbar [data-a="tab:todo"]');
    await page.click('[data-todo="a"]');
    assert.equal((await page.textContent('.tdd2 .back')).trim(), 'Actions');
    await context.close();
  });

  test('Today holds my late and due-today to dos (oldest first) plus Response items; Open holds the rest incl. habits; done and partner items stay out', async () => {
    const todos = [td('later', { due_date: T.later }), td('none'), td('today', { due_date: T.today }), td('habit', { type: 'habit', target: 3, period: 'week' }),
      td('tomorrow', { due_date: T.tomorrow }), td('late', { due_date: T.yesterday }), td('resp', { type: 'response' }), td('resp-future', { type: 'response', due_date: T.later }),
      td('finished', { due_date: T.yesterday, done_at: '2026-10-21T12:00:00Z' }), td('hers', { owner_id: HER, due_date: T.yesterday })];
    const { context, page } = await open(seed({ todos }));
    assert.deepEqual(await sections(page), [
      ['Today', ['late', 'today', 'resp', 'resp-future'], false],
      ['Open', ['later', 'none', 'habit', 'tomorrow'], false],
      ['For Esme', ['hers'], false],
    ]);
    await context.close();
  });

  test('Today and Open each vanish when empty; with both empty a single None shows; For <partner> keeps its own None', async () => {
    let { context, page } = await open(seed({ todos: [td('later', { due_date: T.later })] }));
    assert.deepEqual(await sections(page), [['Open', ['later'], false], ['For Esme', [], true]]);
    await context.close();
    ({ context, page } = await open(seed({ todos: [td('late', { due_date: T.yesterday })] })));
    assert.deepEqual(await sections(page), [['Today', ['late'], false], ['For Esme', [], true]]);
    await context.close();
    ({ context, page } = await open(seed({ todos: [td('finished', { done_at: '2026-10-21T12:00:00Z' })] })));
    assert.deepEqual(await sections(page), [['Open', [], true], ['For Esme', [], true]]);
    await context.close();
  });

  test('Done still works from the Today section and the row leaves it', async () => {
    const { context, page } = await open(seed({ todos: [td('late', { due_date: T.yesterday }), td('later', { due_date: T.later })] }));
    await page.click('[data-a="done:late"]');
    await page.waitForFunction(() => !document.querySelector('[data-todo="late"]'));
    assert.deepEqual((await sections(page)).map((x) => x[0]), ['Open', 'For Esme']);
    await context.close();
  });

  test('challenge cards: one per challenge in ledger order, big status per state, caption is the person or, for goals, a bar and the window end', async () => {
    const fights = [{ id: 'f1', couple_id: 'c1', at: '2026-10-18T16:00:00Z', logged_by: HER, hit_self: true, hit_count: 1 }];
    const days = [{ id: 'd1', couple_id: 'c1', challenge_id: 'g-active', day: '2026-10-20', note: 'x', by: ME }, { id: 'd2', couple_id: 'c1', challenge_id: 'g-done', day: '2026-10-20', note: 'x', by: ME }];
    const challenges = [
      ch('hit-mine', { name: 'No hitting', for_user: ME }),
      ch('tap-hers', { name: 'No yelling', for_user: HER, breaks_on: 'tap' }),
      ch('tap-new', { name: 'No phone', for_user: HER, breaks_on: 'tap', accepted_at: null }),
      goal('g-active', { name: 'Read', for_user: ME }),
      goal('g-new', { name: 'Walk', for_user: HER, accepted_at: null }),
      goal('g-done', { name: 'Sleep', goal_days: 1 }),
      goal('g-failed', { name: 'Stretch', goal_window_days: 2, start: '2026-10-10', accepted_at: '2026-10-10T12:00:00Z' }),
    ];
    const { context, page } = await open(seed({ challenges, fights, days }));
    const cards = await page.$$eval('.deck .ach', (els) => els.map((e) => ({ id: e.dataset.a, nm: e.querySelector('.nm').textContent, big: e.querySelector('.big').textContent,
      bt: e.querySelector('.bt').textContent, bar: e.querySelector('.pb i')?.style.width || null, n: e.classList.contains('n'), o: e.classList.contains('o') })));
    assert.deepEqual(cards.map((c) => c.id), challenges.map((c) => 'challenge:' + c.id), 'every challenge, in the order the ledger returns them');
    const row = (c) => [c.nm, c.big, c.bt, c.bar, c.n, c.o];
    assert.deepEqual(cards.map(row), [
      ['No hitting', 'Day 3', 'You', null, false, false],
      ['No yelling', 'Day 21', 'Esme', null, false, true],
      ['No phone', 'Not started', 'Esme', null, true, true],
      ['Read', '1/10', 'To Nov 1', '10%', false, false],
      ['Walk', 'Not started', 'To Nov 1', '0%', true, true],
      ['Sleep', 'Done', 'To Nov 1', '100%', false, false],
      ['Stretch', 'Failed', 'To Oct 11', '0%', false, false],
    ]);
    await page.click('.ach[data-a="challenge:g-active"]');
    assert.equal(await page.textContent('.hd h2'), 'Read');
    await context.close();
  });

  test('the card row is its own horizontal scroller (the page does not move), and the Challenges section sits between Held/Scheduled and Today', async () => {
    const challenges = ['a', 'b', 'c', 'd', 'e'].map((n) => ch(n, { name: 'Challenge ' + n }));
    const { context, page } = await open(seed({ challenges, todos: [td('late', { due_date: T.yesterday })] }));
    assert.deepEqual((await sections(page)).map((x) => x[0]), ['Challenges', 'Today', 'For Esme']);
    const m = await page.$eval('.deck', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, oy: getComputedStyle(e).overflowY, ox: getComputedStyle(e).overflowX }));
    assert.ok(m.sw > m.cw && m.ox === 'auto', JSON.stringify(m));
    const before = await page.evaluate(() => ({ x: document.querySelector('.deck').scrollLeft, y: document.querySelector('.scr').scrollTop }));
    // Programmatic scroll proves the container is the scroller; the page itself did not move.
    await page.$eval('.deck', (e) => { e.scrollLeft = 120; });
    const after = await page.evaluate(() => ({ x: document.querySelector('.deck').scrollLeft, y: document.querySelector('.scr').scrollTop }));
    assert.ok(after.x === 120 && after.y === before.y, JSON.stringify({ before, after }));
    await context.close();
  });

  test('Add opens a New picker: Task and Habit open the new-to-do sheet on that type, Challenge opens the new challenge screen', async () => {
    const { context, page } = await open(seed({}));
    await page.click('.hd [data-a="addpick"]');
    assert.equal(await page.textContent('.bs h3'), 'New');
    assert.deepEqual(await page.$$eval('.bs .opt', (e) => e.map((x) => x.textContent)), ['Task', 'Habit', 'Owning up', 'Challenge']);
    await page.click('.bs [data-a="newtodo:task"]');
    assert.equal(await page.textContent('.bs h3'), 'New to do');
    assert.equal(await page.$eval('[data-a="nkind:task"]', (e) => e.classList.contains('on')), true);
    assert.equal(await page.$('.frow .lab0:text("Times")'), null);
    await page.click('.bs [data-a="sheet:close"]');
    await page.click('.hd [data-a="addpick"]');
    await page.click('.bs [data-a="newtodo:habit"]');
    assert.equal(await page.$eval('[data-a="nkind:habit"]', (e) => e.classList.contains('on')), true);
    assert.ok((await page.$$eval('.frow .lab0', (l) => l.map((e) => e.textContent))).includes('Times'));
    await page.click('.bs [data-a="sheet:close"]');
    await page.click('.hd [data-a="addpick"]');
    await page.click('.bs [data-a="newch"]');
    assert.equal(await page.textContent('.hd h2'), 'New');
    assert.ok(await page.$('#chnew'));
    assert.equal((await page.textContent('.hd .back')).trim(), 'Actions');
    await context.close();
  });

  test('a habit made through Add > Habit saves as a habit with the habit point defaults', async () => {
    const { context, page } = await open(seed({}));
    await page.click('.hd [data-a="addpick"]'); await page.click('.bs [data-a="newtodo:habit"]');
    await page.click('[data-a="nfor:me"]');
    await page.fill('input[data-d="title"]', 'Stretch');
    await page.click('[data-a="savetodo"]');
    const key = 'cycle:shared.' + ME;
    await page.waitForFunction((k) => Object.keys(JSON.parse(localStorage.getItem(k)).rows.todos).length === 1, key);
    const t = await page.evaluate((k) => Object.values(JSON.parse(localStorage.getItem(k)).rows.todos)[0], key);
    assert.deepEqual([t.type, t.title, t.points_earn, t.points_miss], ['habit', 'Stretch', 1, 0]);
    await context.close();
  });
});
