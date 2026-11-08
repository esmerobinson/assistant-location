// Swipe left on an open to-do of mine to ignore it: row hides + undo toast, nothing written until the toast fades,
// Undo writes nothing, a vertical drag or a partner's row never swipes. Real app in headless WebKit against seeded
// localStorage, backend aborted so writes are read from the store's own persistence. Needs GL_WEBKIT_PW / GL_WEBKIT_EXEC.
// IGNORE_SHOTS=<dir> also writes 390px screenshots.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_WK = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = HAS_WK ? await import(process.env.GL_WEBKIT_PW) : null;
const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const SHOTS = process.env.IGNORE_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ME = 'u-me', HER = 'u-her';
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60 };
const MEMBERS = [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Esme', checkin_time: '21:00' }];
const td = (id, o = {}) => ({ id, couple_id: 'c1', owner_id: ME, created_by: HER, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null, declined_at: null, decline_note: null,
  created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, ...o });

function seed(todos) {
  const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: ME, email: 'x@x.test' } },
    ['shared.' + ME]: { couple: COUPLE, members: MEMBERS,
      rows: { items: {}, todos: byId(todos), todo_events: {}, checkins: {}, fight_markers: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {} },
      cursors: {}, outbox: [] },
    ['priv.' + ME]: { fights: [], affirmations: [], prefs: {} },
  };
}

describe('swipe left to ignore a to-do (webkit)', { skip: !HAS_WK && 'needs GL_WEBKIT_PW and GL_WEBKIT_EXEC' }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(todos, home = false) {
    const s = seed(todos);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (r) => r.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    if (home) { await page.waitForSelector('.pts .nd'); return { context, page }; }
    await page.click('[data-a="tab:todo"]');
    await page.waitForSelector('[data-a="addpick"]');
    return { context, page };
  }
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')));
  const patches = async (page, id) => (await stored(page)).outbox.filter((o) => o.table === 'todos' && o.id === id).length;
  const shot = (page, name, clip) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png'), clip });

  // One touch gesture on the row in 8 touchmoves; returns whether any touchmove was preventDefault()ed (claimed as a swipe).
  // hold=true leaves the finger down (no touchend).
  async function drag(page, id, dx, dy = 0, hold = false) {
    const sel = '[data-todo="' + id + '"] :is(.tx, .mid)';
    const box = await page.locator(sel).boundingBox();
    return page.evaluate(async ([sel, x0, y0, dx, dy, hold]) => {
      const target = document.querySelector(sel);
      const fire = (type, x, y) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        const t = [{ identifier: 0, target, clientX: x, clientY: y }];
        ev.touches = type === 'touchend' ? [] : t; ev.changedTouches = t;
        return target.dispatchEvent(ev);
      };
      let prevented = false;
      fire('touchstart', x0, y0);
      for (let i = 1; i <= 8; i++) { if (!fire('touchmove', x0 + dx * i / 8, y0 + dy * i / 8)) prevented = true; await new Promise((r) => setTimeout(r, 16)); }
      if (!hold) { fire('touchend', x0 + dx, y0 + dy); await new Promise((r) => setTimeout(r, 300)); }
      return prevented;
    }, [sel, box.x + box.width - 20, box.y + box.height / 2, dx, dy, hold]);
  }
  const hidden = (page, id) => page.$('[data-todo="' + id + '"]').then((e) => !e);

  test('swipe hides the row and shows the toast with nothing written; the toast fading writes declined_at exactly once', async () => {
    const { page, context } = await open([td('a', { title: 'Alpha' }), td('b', { title: 'Beta' })]);
    assert.equal(await drag(page, 'a', -200), true, 'touchmoves are claimed by the swipe');
    assert.ok(await hidden(page, 'a'));
    assert.ok(await page.$('[data-todo="b"]'));
    assert.equal(await page.$eval('.ign-toast span', (e) => e.textContent), 'Ignored');
    assert.equal(await page.$eval('.ign-toast b', (e) => e.textContent), 'Undo');
    await shot(page, 'toast');
    await page.waitForTimeout(2500);
    const mid = await stored(page);
    assert.equal(mid.rows.todos.a.declined_at, null);
    assert.equal(await patches(page, 'a'), 0);
    await page.waitForSelector('.ign-toast', { state: 'detached', timeout: 6000 });
    const s = await stored(page);
    assert.ok(s.rows.todos.a.declined_at);
    assert.equal(s.rows.todos.a.decline_note, null);
    assert.equal(await patches(page, 'a'), 1);
    await page.waitForTimeout(800);
    assert.equal(await patches(page, 'a'), 1, 'still one patch later');
    assert.equal(s.rows.todos.b.declined_at, null);
    // Closed as Ignored, not Declined, since it is not a response.
    await page.click('[data-a="doneopen"]');
    assert.equal(await page.$eval('.td-row.dn .hv', (e) => e.textContent), 'Ignored');
    await page.click('.td-row.dn');
    await page.waitForSelector('.tdd2');
    assert.equal(await page.$eval('[data-a="tundecline:a"]', (e) => e.textContent), 'Undo ignore');
    await context.close();
  });

  test('Undo brings the row back and writes nothing, even after the toast time passes', async () => {
    const { page, context } = await open([td('a', { title: 'Alpha' })]);
    await drag(page, 'a', -200);
    assert.ok(await hidden(page, 'a'));
    await page.click('.ign-toast b');
    await page.waitForSelector('[data-todo="a"]');
    assert.equal(await page.$('.ign-toast'), null);
    await page.waitForTimeout(6000);
    const s = await stored(page);
    assert.equal(s.rows.todos.a.declined_at, null);
    assert.equal(await patches(page, 'a'), 0);
    await context.close();
  });

  test('a second swipe commits the first at once and shows a new toast', async () => {
    const { page, context } = await open([td('a'), td('b')]);
    await drag(page, 'a', -200);
    assert.equal(await patches(page, 'a'), 0);
    await drag(page, 'b', -200);
    assert.equal(await patches(page, 'a'), 1);
    assert.equal(await patches(page, 'b'), 0);
    assert.equal(await page.$$eval('.ign-toast', (e) => e.length), 1);
    await context.close();
  });

  test('leaving the screen while pending commits immediately', async () => {
    const { page, context } = await open([td('a'), td('b')]);
    await drag(page, 'a', -200);
    // The ignore starts only after the 180 ms slide-out; under load that can outlast drag()'s 300 ms wait.
    await page.waitForSelector('.ign-toast');
    assert.equal(await patches(page, 'a'), 0);
    await page.click('[data-a="tview:b"]');
    await page.waitForSelector('.tdd2');
    // The store saves to localStorage asynchronously, so poll briefly rather than read once.
    for (let i = 0; i < 20 && (await patches(page, 'a')) === 0; i++) await page.waitForTimeout(100);
    assert.equal(await patches(page, 'a'), 1);
    assert.equal(await page.$('.ign-toast'), null);
    await context.close();
  });

  test('a short drag snaps back, a vertical drag does not swipe, a tap still opens the row, partner and closed rows do not swipe', async () => {
    const { page, context } = await open([td('a'), td('p', { owner_id: HER, created_by: ME }), td('z', { done_at: '2026-10-21T10:00:00Z' })]);
    await drag(page, 'a', -60);
    assert.equal(await page.$('.ign-toast'), null);
    assert.ok(await page.$('[data-todo="a"]'));
    assert.equal(await page.$eval('[data-todo="a"]', (e) => e.style.transform), '');
    // Rightward drag: the wrong direction, never claimed and never ignores.
    assert.equal(await drag(page, 'a', 200), false);
    assert.equal(await page.$('.ign-toast'), null);
    assert.ok(await page.$('[data-todo="a"]'));
    // Vertical drag with a little sideways drift: not claimed by the swipe.
    assert.equal(await drag(page, 'a', -40, 120), false);
    assert.equal(await page.$('.ign-toast'), null);
    assert.equal(await page.$eval('[data-todo="a"]', (e) => e.style.transform), '');
    // Partner's row: no swipe.
    assert.equal(await drag(page, 'p', -250), false);
    assert.equal(await page.$('.ign-toast'), null);
    assert.ok(await page.$('[data-todo="p"]'));
    // Closed row (Done list) carries no swipe hook.
    await page.click('[data-a="doneopen"]');
    assert.equal(await page.$('.td-row.dn[data-sw]'), null);
    // A tap still opens the view page.
    await page.click('[data-todo="a"] .tx');
    await page.waitForSelector('.tdd2');
    assert.equal(await patches(page, 'a'), 0);
    await context.close();
  });

  test('Home: swiping a to-do card left hides it with the toast, and the fade writes declined_at once', async () => {
    const { page, context } = await open([td('a', { title: 'Alpha' }), td('b', { title: 'Beta' })], true);
    assert.equal(await drag(page, 'a', -200), true, 'touchmoves are claimed by the swipe');
    await page.waitForSelector('.ign-toast');
    assert.ok(await hidden(page, 'a'));
    assert.ok(await page.$('.nc[data-todo="b"]'));
    assert.equal(await patches(page, 'a'), 0);
    await page.waitForSelector('.ign-toast', { state: 'detached', timeout: 7000 });
    assert.equal(await patches(page, 'a'), 1);
    assert.ok((await stored(page)).rows.todos.a.declined_at);
    await context.close();
  });

  test('Home mid-swipe shot', { skip: !SHOTS }, async () => {
    const { page, context } = await open([td('a', { title: 'Take out the trash', due_date: '2026-10-22' }), td('b', { title: 'Call the landlord' })], true);
    await drag(page, 'a', -170, 0, true);
    await page.waitForTimeout(100);
    await shot(page, 'home-midswipe');
    await context.close();
  });

  test('mid-swipe shot', { skip: !SHOTS }, async () => {
    const { page, context } = await open([td('a', { title: 'Take out the trash', due_date: '2026-10-22' }), td('b', { title: 'Call the landlord' }), td('p', { title: 'Book the dentist', owner_id: HER, created_by: ME })]);
    await drag(page, 'a', -170, 0, true);
    await page.waitForTimeout(100);
    await shot(page, 'midswipe', { x: 0, y: 120, width: 390, height: 360 });
    await context.close();
  });
});
