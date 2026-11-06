// To-dos tab: open to-dos linked to a live fight group under one parent row naming the fight.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const UID = 'u-me', PID = 'u-her', ISO = new Date(Date.now() - 36e5).toISOString();
const base = { couple_id: 'c1', created_at: ISO, updated_at: ISO, deleted_at: null };
const mkt = (id, o) => ({ ...base, id, logged_by: PID, at: ISO, repaired_at: null, hit_self: null, hit_related: null, ...o });
const td = (id, o) => ({ ...base, id, owner_id: UID, created_by: PID, item_id: null, fight_marker_id: null, title: id, description: null, type: 'response',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null, ...o });
const todos = [
  td('t1', { title: 'Apologize', fight_marker_id: 'fm1' }), td('t2', { title: 'Reflect', fight_marker_id: 'fm1' }),
  td('t3', { title: 'Cool down', owner_id: PID, fight_marker_id: 'fm1' }),
  td('t4', { title: 'Plain chore', type: 'task' }), td('t5', { title: 'Orphan response', fight_marker_id: 'fmx' }),
];
const seed = {
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60 },
    members: [{ user_id: UID, name: 'Me', checkin_time: '21:00' }, { user_id: PID, name: 'Her', checkin_time: '21:00' }],
    rows: { items: {}, todos: Object.fromEntries(todos.map((t) => [t.id, t])), todo_events: {}, checkins: {},
      fight_markers: { fm1: mkt('fm1', { summary: 'The dishes argument' }), fmx: mkt('fmx', { deleted_at: ISO }) }, fight_notes: {}, rewards: {}, redemptions: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
};

describe('fight to-dos group', () => {
  let browser, context, page;
  before(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 375, height: 800 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, seed);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.click('[data-a="tab:todo"]');
    await page.waitForSelector('.td-row');
  });
  after(async () => { await browser.close(); });

  test('groups a live fight\'s open to-dos under one parent row; others stay top-level', async () => {
    assert.equal(await page.locator('.td-fg').count(), 1);
    const g = page.locator('.td-fg');
    assert.match(await g.locator('.fgp').innerText(), /The dishes argument/);
    assert.match(await g.locator('.fgp').innerText(), /fight/i);
    assert.equal(await g.locator('.td-row.sub').count(), 3);
    assert.equal(await g.locator('.tt', { hasText: 'Response' }).count(), 0);
    assert.equal(await g.locator('.om svg').count(), 1, 'only the parent row carries the fight icon');
    for (const t of ['t4', 't5']) assert.equal(await page.locator(`.td-row[data-todo="${t}"]:not(.sub)`).count(), 1);
    assert.equal(await page.locator('.td-fg [data-todo="t4"], .td-fg [data-todo="t5"]').count(), 0);
    assert.equal(await page.locator('[data-todo="t5"] .tt', { hasText: 'Response' }).count(), 1);
  });

  test('Done on a sub row leaves the group; parent opens the fight', async () => {
    await page.click('.td-fg [data-todo="t1"] [data-a="done:t1"]');
    await page.waitForFunction(() => document.querySelectorAll('.td-fg .sub').length === 2);
    assert.equal(await page.locator('.td-fg [data-todo="t1"]').count(), 0);
    await page.click('.td-fg .fgp');
    await page.waitForSelector('.p2 .hd');
    assert.equal(await page.locator('.td-fg').count(), 0);
    assert.match(await page.locator('body').innerText(), /intensity/i); // fight detail is open
  });

  test('Home cards for a fight\'s to-dos name the fight; plain to-dos stay "To-do"', async () => {
    await page.click('[data-a="tab:home"]');
    await page.waitForSelector('[data-a="tview:t2"]');
    assert.match(await page.locator('[data-a="tview:t2"] .s').textContent(), /^Fight · /);
    assert.equal(await page.locator('[data-a="tview:t4"] .s').textContent(), 'To-do');
  });

  test('a throw inside a native entry point is logged with its real message, not "Script error."', async () => {
    const log = await page.evaluate(() => {
      window.CycleStore.retryPush = () => { throw new Error('boom from native'); };
      window.cycleNative.foreground();
      return window.CycleStore.S.errLog.at(-1);
    });
    assert.equal(log.kind, 'native');
    assert.equal(log.msg, 'boom from native');
  });
});
