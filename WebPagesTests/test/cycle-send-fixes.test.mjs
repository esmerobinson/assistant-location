// Reminder send fixes (2026-11-06): re-send confirm, one tap = one send, the send animation drawn where the button is,
// and a partner's new send reaching an already-open app (incl. after a hung request across a background/foreground).
// Real app + real cycle.css in headless Chromium against a stateful mock Supabase (GET returns server rows, POST stores them).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const ME = 'u-me', HER = 'u-her';
const nd = (id, body) => ({ id, couple_id: 'c1', author_id: ME, body, tag: 'Calm', pinned: false, sort_order: 0, archived_at: null,
  created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', deleted_at: null });
const send = (id, nudgeId, o = {}) => ({ id, couple_id: 'c1', nudge_id: nudgeId, sender_id: ME, recipient_id: HER, body: 'Breathe',
  deliver_at: '2026-10-26T12:00:00Z', opened_at: null, created_at: '2026-10-25T20:00:00Z', updated_at: '2026-10-25T20:00:00Z', deleted_at: null, ...o });

function seed(who) {
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: who, email: who + '@x.test' } },
    ['shared.' + who]: {
      couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z' },
      members: [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Her', checkin_time: '21:00' }],
      rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {} },
      cursors: {}, outbox: [],
    },
    ['priv.' + who]: { fights: [], affirmations: [], prefs: {}, nudges: [], nudge_sends: [] },
  };
}

describe('reminder send fixes', () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  // server: {nudges:[], nudge_sends:[]}. A recipient never sees a send before its deliver_at (the RLS the store's comment describes).
  async function open(who, server, o = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const sd = seed(who);
    await context.addInitScript((s) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test' };
      if (!localStorage.getItem('cycle:session')) for (const k in s) localStorage.setItem('cycle:' + k, JSON.stringify(s[k]));
    }, sd);
    const ctl = { server, hang: false, hung: 0, posts: [], validToken: o.validToken || null, refreshes: 0, registers: 0 };
    const shared = sd['shared.' + who];
    await context.route('https://box.test/**', (route) => { ctl.registers++; route.fulfill({ status: 401, body: '{}' }); });
    await context.route('https://x.test/**', (route) => {
      const req = route.request(), t = new URL(req.url()).pathname.replace('/rest/v1/', '');
      if (t === '/auth/v1/token') { ctl.refreshes++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: ctl.validToken, refresh_token: 'r2', expires_in: 3600, user: { id: who, email: who + '@x.test' } }) }); }
      if (ctl.validToken && req.headers().authorization !== 'Bearer ' + ctl.validToken) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"JWT expired"}' });
      if (req.method() === 'POST') { ctl.posts.push({ t, body: JSON.parse(req.postData()) }); (server[t] ||= []).push(JSON.parse(req.postData())); return route.fulfill({ status: 201, body: '' }); }
      if (ctl.hang) { ctl.hung++; return; } // never answered: what a request caught by an iOS suspend looks like
      let rows = t === 'couples' ? [shared.couple] : t === 'members' ? shared.members : (server[t] || []);
      if (t === 'nudge_sends' && who === HER) rows = rows.filter((r) => r.recipient_id === HER && Date.parse(r.deliver_at) <= Date.now());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="go:fight"]');
    return { context, page, ctl };
  }
  const nudgeCard = async (page) => {
    await page.click('[data-a="tab:todo"]'); await page.click('[data-a="todoseg:rem"]');
    await page.click('[data-a="nudge:n1"]'); await page.waitForSelector('[data-a="nudgesend"]');
  };
  const sendPosts = (ctl) => ctl.posts.filter((p) => p.t === 'nudge_sends');
  const lib = () => ({ nudges: [nd('n1', 'Breathe')], nudge_sends: [] });

  test('sending a reminder that already has a live send asks first', async () => {
    const { context, page, ctl } = await open(ME, { nudges: [nd('n1', 'Breathe')], nudge_sends: [send('s1', 'n1')] });
    await nudgeCard(page);
    await page.click('[data-a="nudgesend"]');
    await page.waitForSelector('.bs [data-a="nudgeresend"]');
    assert.match(await page.textContent('.bs h3'), /Already sent/);
    await page.waitForTimeout(800);
    assert.equal(sendPosts(ctl).length, 0, 'nothing sent before the confirm');
    await page.click('.bs [data-a="sheet:close"].tdrop');
    assert.equal(await page.$('.bs'), null);
    await page.waitForTimeout(1200);
    await page.click('[data-a="nudgesend"]'); await page.click('[data-a="nudgeresend"]');
    await page.waitForTimeout(1200);
    assert.equal(sendPosts(ctl).length, 1, 'confirmed -> exactly one new send');
    await context.close();
  });

  test('a reminder with only a deleted send sends without asking', async () => {
    const { context, page, ctl } = await open(ME, { nudges: [nd('n1', 'Breathe')], nudge_sends: [send('s1', 'n1', { deleted_at: '2026-10-26T13:00:00Z' })] });
    await nudgeCard(page);
    await page.click('[data-a="nudgesend"]');
    await page.waitForTimeout(1200);
    assert.equal(await page.$('.bs [data-a="nudgeresend"]'), null);
    assert.equal(sendPosts(ctl).length, 1);
    await context.close();
  });

  test('a double tap on Send makes one send row', async () => {
    const { context, page, ctl } = await open(ME, lib());
    await nudgeCard(page);
    const b = await (await page.$('[data-a="nudgesend"]')).boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.click(x, y); await page.waitForTimeout(150); await page.mouse.click(x, y);
    await page.waitForTimeout(1500);
    assert.equal(sendPosts(ctl).length, 1);
    assert.equal(await page.$('.bs [data-a="nudgeresend"]'), null, 'second tap did not open the confirm either');
    await context.close();
  });

  test('a double tap on a new reminder\'s Send makes one send row', async () => {
    const { context, page, ctl } = await open(ME, { nudges: [], nudge_sends: [] });
    await page.click('[data-a="tab:todo"]'); await page.click('[data-a="todoseg:rem"]'); await page.click('[data-a="nudgenew"]');
    await page.fill('textarea[data-d="nbody"]', 'Hello');
    const b = await (await page.$('[data-a="nudgenewsend"]')).boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.click(x, y); await page.waitForTimeout(150); await page.mouse.click(x, y);
    await page.waitForTimeout(1500);
    assert.equal(sendPosts(ctl).length, 1);
    await context.close();
  });

  // The overlay canvas (#fx) is what the animation draws on. Sample it every frame after the tap and require ink near the button.
  async function inkAfterTap(page, selector, then) {
    await page.evaluate(() => {
      const cv = document.getElementById('fx'), c = cv.getContext('2d'); window.__ink = [];
      const t0 = performance.now();
      (function f() {
        const d = c.getImageData(0, 0, cv.width, cv.height).data; let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 40) { const p = (i - 3) / 4, x = p % cv.width, y = (p / cv.width) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 >= 0) window.__ink.push({ t: performance.now() - t0, x0, x1, y0, y1 });
        if (performance.now() - t0 < 700) requestAnimationFrame(f);
      })();
    });
    const b = await (await page.$(selector)).boundingBox();
    await then();
    await page.waitForTimeout(800);
    return { b, ink: await page.evaluate(() => window.__ink) };
  }
  const overlaps = (b, i) => i.x1 >= b.x && i.x0 <= b.x + b.width && i.y1 >= b.y && i.y0 <= b.y + b.height;

  test('the send animation is drawn at the Send button (library card)', async () => {
    const { context, page } = await open(ME, lib());
    await nudgeCard(page);
    const { b, ink } = await inkAfterTap(page, '[data-a="nudgesend"]', () => page.click('[data-a="nudgesend"]'));
    assert.ok(ink.length > 3, 'animation drew frames');
    assert.ok(overlaps(b, ink[0]), 'first frame touches the button: ' + JSON.stringify([b, ink[0]]));
    await context.close();
  });

  test('the send animation is drawn at the Send button (new reminder)', async () => {
    const { context, page } = await open(ME, { nudges: [], nudge_sends: [] });
    await page.click('[data-a="tab:todo"]'); await page.click('[data-a="todoseg:rem"]'); await page.click('[data-a="nudgenew"]');
    await page.fill('textarea[data-d="nbody"]', 'Hello');
    const { b, ink } = await inkAfterTap(page, '[data-a="nudgenewsend"]', () => page.click('[data-a="nudgenewsend"]'));
    assert.ok(ink.length > 3, 'animation drew frames');
    assert.ok(overlaps(b, ink[0]), 'first frame touches the button: ' + JSON.stringify([b, ink[0]]));
    await context.close();
  });

  const openReceived = async (page) => { await page.click('[data-a="tab:todo"]'); await page.click('[data-a="todoseg:rem"]'); await page.click('[data-a="remview:recv"]'); await page.waitForSelector('.empty'); };
  const received = (page, ms) => page.waitForSelector('[data-a^="nudgein:"]', { timeout: ms });

  test('recipient: a send delivered while the app is open appears without a reload', async () => {
    const server = { nudges: [nd('n1', 'Breathe')], nudge_sends: [] };
    const { context, page } = await open(HER, server);
    await openReceived(page);
    server.nudge_sends.push(send('s1', 'n1', { deliver_at: new Date(Date.now() + 3000).toISOString() })); // queued: hidden until due
    await received(page, 12000);
    await context.close();
  });

  test('recipient: a hung request from before a background/foreground does not freeze sync', async () => {
    const server = { nudges: [nd('n1', 'Breathe')], nudge_sends: [] };
    const { context, page, ctl } = await open(HER, server);
    await openReceived(page);
    ctl.hang = true;
    await page.waitForFunction(() => true); // let the next 5 s poll start and stall
    for (let i = 0; i < 40 && !ctl.hung; i++) await page.waitForTimeout(250);
    assert.ok(ctl.hung, 'a poll request stalled');
    server.nudge_sends.push(send('s1', 'n1', { deliver_at: new Date(Date.now() - 1000).toISOString() }));
    ctl.hang = false;
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); }); // app comes back to the foreground
    await received(page, 4000);
    await context.close();
  });

  // The phone's own expiry clock says the token is good, the server says 401: sync must refresh and carry on, not retry the dead token.
  test('recipient: a 401 from the server refreshes the token and sync recovers', async () => {
    const server = { nudges: [nd('n1', 'Breathe')], nudge_sends: [send('s1', 'n1', { deliver_at: new Date(Date.now() - 1000).toISOString() })] };
    const { context, page, ctl } = await open(HER, server, { validToken: 'fresh' });
    await openReceived(page).catch(() => {}); // the first view may already hold the row once refreshed
    await received(page, 8000);
    assert.ok(ctl.refreshes >= 1, 'token was refreshed');
    await context.close();
  });

  test('a rejected push register is not retried every sync', async () => {
    const { context, page, ctl } = await open(HER, { nudges: [], nudge_sends: [] });
    await page.evaluate(() => CycleStore.setPushToken('tok'));
    await page.waitForTimeout(11000); // two 5 s sync ticks
    assert.ok(ctl.registers <= 2, 'register attempts in 11 s: ' + ctl.registers);
    await context.close();
  });
});
