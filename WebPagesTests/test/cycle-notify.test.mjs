// Notifications: the daily 09:00 reminder for an unaccepted challenge (derived by wanted(), rescheduled on change)
// and the "Notifications are off" sheet shown when iOS permission is denied.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it. The native bridge is a page-side stub:
// kv lives in localStorage (survives reload like the native file), calls are recorded in window.__calls.
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
const SHOTS = process.env.SHOTS;

const UID = 'u-me', PID = 'u-her', TZ = 'America/New_York';
const challenge = (forUser, accepted) => ({ id: 'ch1', couple_id: 'c1', name: 'No hitting', start: C.localDay(Date.now(), TZ), for_user: forUser, breaks_on: 'tap', accepted_at: accepted ? '2026-01-01T00:00:00Z' : null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
const seed = (ch) => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: TZ, created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Her', checkin_time: '21:00', hits_self: true }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_notes: {}, rewards: {}, redemptions: {}, acks: {}, fight_markers: {}, challenges: ch ? { [ch.id]: ch } : {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // status: what notify.status answers ('denied' | 'granted' | 'notDetermined'); null = no native bridge (web build).
  async function open({ ch, status = 'granted' } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript(({ sd, status, native }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
      window.__status = status;
      window.__calls = [];
      if (!native) return;
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        window.__calls.push({ cmd, args });
        let r = null;
        if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
        else if (cmd === 'store.set') { if (args.value === null) localStorage.removeItem('cycle:' + args.key); else localStorage.setItem('cycle:' + args.key, args.value); }
        else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.indexOf('cycle:' + args.prefix) === 0).map((k) => k.slice(6));
        else if (cmd === 'notify.status') r = window.__status;
        else if (cmd === 'lock.get') r = false;
        else if (cmd === 'notify.permission') r = true;
        else if (!['ready', 'notify.schedule', 'notify.cancel', 'app.openSettings'].includes(cmd)) throw new Error('unexpected bridge cmd ' + cmd);
        setTimeout(() => window.__cycleReply(id, r, null), 0);
      } } } };
    }, { sd: seed(ch), status, native: status !== null });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => {
      const rq = route.request();
      if (rq.method() === 'PATCH' || rq.method() === 'POST') return route.fulfill({ status: rq.method() === 'POST' ? 201 : 204, body: '' });
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tabbar, [data-a^="tab:"]');
    return { context, page };
  }
  const calls = (page, cmd) => page.evaluate((c) => window.__calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);
  const waitCalls = async (page, cmd, n) => { await page.waitForFunction(([c, n]) => window.__calls.filter((x) => x.cmd === c).length >= n, [cmd, n]); return calls(page, cmd); };
  const foreground = (page) => page.evaluate(() => window.cycleNative.foreground());
  const sheetTitle = (page) => page.$eval('.sheetlayer .bsh h3', (e) => e.textContent).catch(() => null);

  test('an unaccepted challenge for me schedules 7 daily 09:00 reminders that open it', async () => {
    const { context, page } = await open({ ch: challenge(UID, false) });
    const sched = (await waitCalls(page, 'notify.schedule', 7)).filter((a) => a.id.startsWith('chal-'));
    const now = Date.now(), today = C.localDay(now, TZ);
    const first = C.zonedMs(today, 9, 0, TZ) > now ? today : C.addDays(today, 1);
    assert.deepEqual(sched.map((a) => a.id), Array.from({ length: 7 }, (_, i) => 'chal-ch1-' + C.addDays(first, i)));
    sched.forEach((a, i) => {
      assert.equal(a.at, C.zonedMs(C.addDays(first, i), 9, 0, TZ));
      assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(a.at)), '09:00');
      assert.equal(a.title, 'Challenge'); assert.equal(a.body, 'No hitting'); assert.equal(a.route, 'challenge/ch1');
    });
    await context.close();
  });

  test('the route opens that challenge; a challenge for her schedules nothing', async () => {
    const { context, page } = await open({ ch: challenge(UID, false) });
    if (SHOTS) { await page.click('[data-a="tab:todo"]'); await page.waitForSelector('.ach[data-a^="challenge:"]'); await page.screenshot({ path: path.join(SHOTS, 'actions-unaccepted.png') }); }
    await page.evaluate(() => window.cycleNative.route('challenge/ch1'));
    assert.equal(await page.textContent('.hd h2'), 'No hitting');
    await context.close();
    const her = await open({ ch: challenge(PID, false) });
    await her.page.waitForFunction(() => window.__calls.some((x) => x.cmd === 'notify.status'));
    await her.page.waitForTimeout(800); // past the 200ms reschedule debounce
    assert.deepEqual((await calls(her.page, 'notify.schedule')).filter((a) => a.id.startsWith('chal-')), []);
    await her.context.close();
  });

  test('accepting cancels the reminders', async () => {
    const { context, page } = await open({ ch: challenge(UID, false) });
    const ids = (await waitCalls(page, 'notify.schedule', 7)).map((a) => a.id).filter((id) => id.startsWith('chal-'));
    await page.evaluate(() => window.cycleNative.route('challenge/ch1'));
    await page.click('[data-a="chaccept"]');
    const cancelled = (await waitCalls(page, 'notify.cancel', 7)).map((a) => a.id);
    assert.deepEqual(ids.filter((id) => !cancelled.includes(id)), []);
    await context.close();
  });

  const logFight = async (page, note) => {
    await page.click('[data-a="go:fight"]');
    await page.waitForSelector('[data-a="fightsave"]');
    if (note) await page.fill('textarea[data-d="note"]', note);
    await page.click('[data-a="fightsave"]');
  };
  const fnotes = async (page) => (await calls(page, 'notify.schedule')).filter((a) => a.id.startsWith('fnote-'));

  test('a fight logged with no note asks 3 times, 30 min then daily, 22-08 moved to 08:00, last one says so; opens that fight, and a note cancels them all', async () => {
    const { context, page } = await open();
    const t0 = Date.now();
    await logFight(page);
    await page.waitForFunction(() => window.__calls.filter((x) => x.cmd === 'notify.schedule' && x.args.id.startsWith('fnote-')).length >= 3);
    await page.waitForTimeout(800); // past the 200ms reschedule debounce, so a 4th would have shown
    const ns = await fnotes(page);
    const hm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    assert.equal(new Set(ns.map((n) => n.id)).size, 3);
    const logged = await page.evaluate(() => JSON.parse(localStorage.getItem('cycle:priv.u-me')).fights[0].logged_at);
    assert.ok(logged >= t0 && logged <= Date.now());
    const uniq = [...new Map(ns.map((n) => [n.id, n])).values()];
    uniq.forEach((n, k) => {
      const raw = logged + 30 * 60000 + k * 24 * 3600000, h = +hm(raw).slice(0, 2);
      if (h >= 22 || h < 8) { assert.equal(hm(n.at), '08:00'); assert.ok(n.at > raw && n.at - raw < 10 * 3600000); }
      else assert.equal(n.at, raw);
    });
    assert.deepEqual(uniq.map((n) => n.body), ['What happened?', 'Still want to note what happened?', 'Last reminder: what happened?']);
    ns.splice(0, ns.length, ...uniq);
    const id = await page.evaluate(() => JSON.parse(localStorage.getItem('cycle:priv.u-me')).fights[0].id);
    ns.forEach((n) => assert.equal(n.route, 'fight/' + id));
    await page.evaluate((r) => window.cycleNative.route(r), ns[0].route);
    assert.equal(await page.textContent('.hd h2'), 'Fight');
    await page.fill('textarea[data-d="more"]', 'It was the dishes');
    await page.click('[data-a="notesave"]');
    // Wait for these ids, not a count: a launch also cancels the old build's leftover ids (-3 and up) once.
    await page.waitForFunction((o) => o.every((x) => window.__calls.some((c) => c.cmd === 'notify.cancel' && c.args.id === x)), ns.map((n) => n.id));
    await context.close();
  });

  test('a fight whose marker was deleted stops asking', async () => {
    const { context, page } = await open();
    await logFight(page);
    await page.waitForFunction(() => window.__calls.filter((x) => x.cmd === 'notify.schedule' && x.args.id.startsWith('fnote-')).length >= 3);
    const ns = await fnotes(page);
    await page.evaluate(() => { const S = CycleStore.S; delete S.rows.fight_markers[S.priv.fights[0].id]; CycleStore.reschedule(); });
    // Wait for these ids, not a count: a launch also cancels the old build's leftover ids (-3 and up) once.
    await page.waitForFunction((o) => o.every((x) => window.__calls.some((c) => c.cmd === 'notify.cancel' && c.args.id === x)), ns.map((n) => n.id));
    await context.close();
  });

  test('after an update, a launch cancels the 2-hourly asks the old build left scheduled (ids past -2)', async () => {
    const { context, page } = await open();
    await logFight(page);
    await page.waitForFunction(() => window.__calls.some((x) => x.cmd === 'notify.schedule' && x.args.id.startsWith('fnote-')));
    // Backdate the log 14h, as for the fight logged at 00:06 whose old-build asks were still firing at 14:36, then relaunch.
    const id = await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem('cycle:priv.u-me'));
      p.fights[0].logged_at = Date.now() - 14 * 3600000;
      localStorage.setItem('cycle:priv.u-me', JSON.stringify(p));
      return p.fights[0].id;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tabbar, [data-a^="tab:"]');
    // Old build: k = 7 was the 14:36 ask, 8..12 the ones it had topped up after it.
    const old = [3, 7, 8, 12].map((k) => 'fnote-' + id + '-' + k);
    await page.waitForFunction((o) => o.every((x) => window.__calls.some((c) => c.cmd === 'notify.cancel' && c.args.id === x)), old);
    const kept = (await fnotes(page)).map((n) => n.id);
    assert.ok(kept.every((x) => /-[012]$/.test(x)), 'new policy still schedules only ids -0..-2: ' + kept);
    await context.close();
  });

  test('a fight logged with a note asks nothing', async () => {
    const { context, page } = await open();
    await logFight(page, 'It was the dishes');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('cycle:priv.u-me')).fights.length === 1);
    await page.waitForTimeout(800); // past the 200ms reschedule debounce
    assert.deepEqual(await fnotes(page), []);
    await context.close();
  });

  test('denied: the sheet shows on load and again on every foreground; the X closes it for this open only', async () => {
    const { context, page } = await open({ status: 'denied' });
    await page.waitForSelector('.sheetlayer');
    assert.equal(await sheetTitle(page), 'Notifications are off');
    assert.deepEqual(await page.$$eval('.sheetlayer .acts > div', (e) => e.map((x) => x.textContent.trim())), ['Turn on', 'Don’t remind me']);
    const gap = await page.evaluate(() => document.querySelector('.sheetlayer .save').getBoundingClientRect().top - document.querySelector('.sheetlayer .bsh').getBoundingClientRect().bottom);
    assert.ok(gap > 0 && gap < 60, 'gap between title and Turn on is ' + gap + 'px');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'notif-off.png') });
    await page.click('.sheetlayer .xb');
    assert.equal(await page.$('.sheetlayer'), null);
    await foreground(page);
    await page.waitForSelector('.sheetlayer');
    assert.equal(await sheetTitle(page), 'Notifications are off');
    await context.close();
  });

  test('"Turn on" opens iOS Settings', async () => {
    const { context, page } = await open({ status: 'denied' });
    await page.click('.sheetlayer .save');
    assert.equal((await waitCalls(page, 'app.openSettings', 1)).length, 1);
    await context.close();
  });

  test('"Don’t remind me" is permanent: not on foreground, not after a reload', async () => {
    const { context, page } = await open({ status: 'denied' });
    await page.click('.sheetlayer .tdrop');
    assert.equal(await page.$('.sheetlayer'), null);
    await foreground(page);
    await page.waitForFunction(() => window.__calls.filter((x) => x.cmd === 'notify.status').length >= 2);
    assert.equal(await page.$('.sheetlayer'), null);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__calls.some((x) => x.cmd === 'notify.status'));
    await page.waitForTimeout(500);
    assert.equal(await page.$('.sheetlayer'), null);
    await context.close();
  });

  test('granted: no sheet; enabling in Settings while backgrounded keeps it away; web build never shows it', async () => {
    const { context, page } = await open({ status: 'granted' });
    await page.waitForFunction(() => window.__calls.some((x) => x.cmd === 'notify.status'));
    await page.waitForTimeout(300);
    assert.equal(await page.$('.sheetlayer'), null);
    await context.close();
    const web = await open({ status: null });
    await foreground(web.page);
    await web.page.waitForTimeout(300);
    assert.equal(await web.page.$('.sheetlayer'), null);
    await web.context.close();
  });

  test('the sheet stops once permission is granted', async () => {
    const { context, page } = await open({ status: 'denied' });
    await page.waitForSelector('.sheetlayer');
    await page.evaluate(() => { window.__status = 'granted'; });
    await foreground(page);
    await page.waitForFunction(() => !document.querySelector('.sheetlayer'));
    await context.close();
  });
});
