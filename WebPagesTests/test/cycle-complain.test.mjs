// Shake to complain: CycleViewController hands the page a PNG snapshot through cycleNative.shake; for Esme only, the page
// opens a Complain sheet showing it, and Send POSTs {text, screenshot, context} to the box's /complain (cycle-tracker
// server/complaints.mjs), which starts a Claude session for Oliver. The complaint is queued in the store first, so a
// failed POST keeps it for the next foreground instead of losing what she wrote.
// Runs the page in plain web mode (localStorage store, no native bridge): cycleNative.shake is what the shell calls either way.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
// The #fx particle layer hangs headless WebKit on software GL (see cycle-push-register); hide it.
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;

const UID = 'u-me';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const seedFor = (myName) => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: myName, checkin_time: '21:00', hits_self: false }, { user_id: 'u-other', name: 'Partner', checkin_time: '21:00', hits_self: true }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_notes: {}, rewards: {}, redemptions: {}, acks: {}, fight_markers: {}, challenges: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' };

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // boxStatus: what POST /complain answers. Returns the page plus every complaint body the box received.
  async function open(myName, status = 200) {
    let boxStatus = status;
    const sd = seedFor(myName);
    const context = await browser.newContext();
    await context.addInitScript(({ sd }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test/cycle' };
      for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, { sd });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    const shared = sd['shared.' + UID];
    await context.route('https://x.test/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      const body = p.endsWith('/couples') ? [shared.couple] : p.endsWith('/members') ? shared.members : [];
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const complaints = [];
    await context.route('https://box.test/**', (route) => {
      const rq = route.request();
      if (rq.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (rq.url().endsWith('/complain')) {
        complaints.push(rq.postDataJSON());
        return route.fulfill({ status: boxStatus, headers: cors, contentType: 'application/json', body: '{}' });
      }
      // 404 for the rest: a 200 on GET /backup would be restored as this phone's private store and blank the app.
      return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('[data-a]'));
    return { page, context, complaints, setBox: (st) => { boxStatus = st; } };
  }
  const queued = (page) => page.evaluate((uid) => JSON.parse(localStorage.getItem('cycle:complaints.' + uid) || '[]'), UID);

  test('Esme: a shake opens Complain with the screenshot, Send posts text, screenshot and context and clears the queue', async () => {
    const { page, context, complaints } = await open('Esme Smith');
    await page.evaluate((png) => window.cycleNative.shake(png), PNG);
    await page.waitForSelector('.bs.gp');
    assert.equal(await page.getAttribute('.bs.gp .gshot', 'src'), 'data:image/png;base64,' + PNG);
    await page.fill('.bs.gp textarea', 'the to do list is confusing');
    await page.click('[data-a="gripesend"]');
    await page.waitForSelector('.bs.gp', { state: 'detached' });
    for (let i = 0; i < 50 && !complaints.length; i++) await page.waitForTimeout(100);
    assert.equal(complaints.length, 1);
    const c = complaints[0];
    assert.equal(c.text, 'the to do list is confusing');
    assert.equal(c.screenshot, 'data:image/png;base64,' + PNG);
    assert.equal(typeof c.context.route, 'string');
    assert.match(c.opId, /^[\w-]{8,64}$/, 'the box rejects any other opId shape');
    assert.deepEqual(await queued(page), []);
    await context.close();
  });

  test('anyone but Esme: a shake does nothing', async () => {
    const { page, context } = await open('Oliver');
    await page.evaluate((png) => window.cycleNative.shake(png), PNG);
    await page.waitForTimeout(300);
    assert.equal(await page.$('.bs.gp'), null);
    await context.close();
  });

  test('a box failure keeps the complaint queued for the next foreground', async () => {
    const { page, context, complaints } = await open('Esme', 502);
    await page.evaluate(() => window.cycleNative.shake(null));
    await page.waitForSelector('.bs.gp');
    await page.fill('.bs.gp textarea', 'broken');
    await page.click('[data-a="gripesend"]');
    for (let i = 0; i < 50 && !complaints.length; i++) await page.waitForTimeout(100);
    const q = await queued(page);
    assert.equal(q.length, 1);
    assert.equal(q[0].text, 'broken');
    assert.equal(q[0].screenshot, null);
    await context.close();
  });

  test('a queued complaint goes out on the next foreground; one the box rejects as bad is dropped', async () => {
    const { page, context, complaints, setBox } = await open('Esme', 502);
    await page.evaluate(() => window.cycleNative.shake(null));
    await page.waitForSelector('.bs.gp');
    await page.fill('.bs.gp textarea', 'later');
    await page.click('[data-a="gripesend"]');
    for (let i = 0; i < 50 && !complaints.length; i++) await page.waitForTimeout(100);
    assert.equal((await queued(page)).length, 1);
    setBox(200);
    await page.evaluate(() => window.cycleNative.foreground());
    for (let i = 0; i < 50 && (await queued(page)).length; i++) await page.waitForTimeout(100);
    assert.deepEqual(await queued(page), []);
    assert.equal(complaints.at(-1).text, 'later');
    assert.equal(complaints.at(-1).opId, complaints[0].opId, 'a resend keeps its opId so the box dedupes it');
    // A 400 means the box will never take it: dropped, so it cannot block the queue head forever.
    setBox(400);
    await page.evaluate(() => window.cycleNative.shake(null));
    await page.waitForSelector('.bs.gp');
    await page.fill('.bs.gp textarea', 'bad');
    await page.click('[data-a="gripesend"]');
    for (let i = 0; i < 50 && complaints.at(-1).text !== 'bad'; i++) await page.waitForTimeout(100);
    for (let i = 0; i < 20 && (await queued(page)).length; i++) await page.waitForTimeout(100);
    assert.deepEqual(await queued(page), []);
    await context.close();
  });
});
