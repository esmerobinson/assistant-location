// Every notification route the Cycle app can emit opens the right screen through window.cycleNative.route(r).
// Local routes come from the notifications wanted() schedules (captured from notify.schedule, never hardcoded, so a scheduler
// that emits a route the router cannot open fails here); remote-push routes are the ones cycle-tracker/server/push.mjs
// messageFor() builds ('todo', 'todo/<id>', 'challenge/<id>'); legacy routes are 'today' and 'acks'.
// Assertions are on the visible DOM of the target screen (heading + the specific row's text) and its back target.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it. The native bridge is a page-side stub as in cycle-notify.test.mjs.
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
const iso = (ms) => new Date(ms).toISOString();
const ago = (h) => iso(Date.now() - h * 36e5), ahead = (h) => iso(Date.now() + h * 36e5);
const base = { couple_id: 'c1', created_at: ago(5), updated_at: ago(5), deleted_at: null };
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));

// One fixture holding a row for every kind of route. Titles/bodies are unique strings so each screen's content proves WHICH row opened.
const item = { ...base, id: 'i1', sender_id: ME, recipient_id: HER, kind: 'ask', ask_type: null, body: 'ITEM-HELD-BODY', description: null, due_date: null, target: null, period: null,
  points_earn: null, points_miss: null, needs_note: false, origin: null, status: 'held', held_until: ahead(1), delivered_at: null };
const todo = (id, o) => ({ ...base, id, owner_id: ME, created_by: HER, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task', due_date: null, target: null,
  period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null, ...o });
// A to do I scheduled for myself, appearing in the future: wanted() emits 'sched-<id>' with route 'todo'.
const schedTodo = todo('ts1', { title: 'TODO-SCHEDULED', created_by: ME, created_at: ahead(2) });
const pushTodo = todo('tp1', { title: 'TODO-PUSHED' });
const send = (id, o) => ({ ...base, id, nudge_id: 'n-' + id, sender_id: HER, recipient_id: ME, body: 'SEND-' + id, deliver_at: ahead(3), opened_at: null, ...o });
const marker = (id) => ({ ...base, id, logged_by: ME, at: ago(1), repaired_at: null, hit_self: null, hit_related: null });
const challenge = { id: 'ch1', couple_id: 'c1', name: 'CHALLENGE-ONE', start: C.localDay(Date.now(), TZ), for_user: ME, breaks_on: 'tap', accepted_at: null, created_at: ago(5), updated_at: ago(5) };

const seed = () => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: ME, email: 'me@x.test' } },
  ['shared.' + ME]: {
    couple: { id: 'c1', tz: TZ, created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: ME, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: HER, name: 'Her', checkin_time: '21:00', hits_self: true }],
    rows: { items: { i1: { ...item } }, todos: byId([schedTodo, pushTodo]), todo_events: {}, checkins: {}, fight_notes: {}, rewards: {}, redemptions: {}, acks: {},
      fight_markers: byId([marker('f1'), marker('f2')]), challenges: { ch1: challenge }, nudge_sends: byId([send('s1')]) },
    cursors: {}, outbox: [],
  },
  // f1/f2 carry distinct `about` text (shown on the fight page); logged_at makes them ask for a note (fnote-*); at + 24h is still ahead so 'fu-*' is emitted.
  ['priv.' + ME]: { fights: [{ id: 'f1', at: Date.now() - 36e5, logged_at: Date.now() - 36e5, intensity: 3, about: 'FIGHT-ONE-ABOUT' }, { id: 'f2', at: Date.now() - 36e5, logged_at: Date.now() - 36e5, intensity: 3, about: 'FIGHT-TWO-ABOUT' }],
    affirmations: [], prefs: {}, nudges: [], nudge_sends: [send('ps1', { sender_id: ME, body: 'SEND-ps1' })], ownupSeen: [], ownupSince: 0 },
});

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // holdBoot: lock.get (the first bridge call after the store boots) is not answered until window.__release(), so ui.ready stays false.
  async function open({ holdBoot = false, tweak } = {}) {
    const sd = seed();
    if (tweak) tweak(sd);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript(({ sd, holdBoot }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
      window.__calls = [];
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        window.__calls.push({ cmd, args });
        let r = null;
        if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
        else if (cmd === 'store.set') { if (args.value === null) localStorage.removeItem('cycle:' + args.key); else localStorage.setItem('cycle:' + args.key, args.value); }
        else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.indexOf('cycle:' + args.prefix) === 0).map((k) => k.slice(6));
        else if (cmd === 'notify.status') r = 'granted';
        else if (cmd === 'lock.get') r = false;
        else if (cmd === 'notify.permission') r = true;
        else if (!['ready', 'notify.schedule', 'notify.cancel', 'app.openSettings'].includes(cmd)) throw new Error('unexpected bridge cmd ' + cmd);
        if (cmd === 'lock.get' && holdBoot) { window.__release = () => window.__cycleReply(id, r, null); return; }
        setTimeout(() => window.__cycleReply(id, r, null), 0);
      } } } };
    }, { sd, holdBoot });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    // The backend is a read-only mirror of the seed: every GET answers with the seeded rows of that table (couples/members from the
    // seed too), so a sync, including the one a stale-link route triggers, finds exactly what is already on the phone and no more.
    const shared = sd['shared.' + ME];
    await context.route('https://x.test/**', (route) => {
      const m = route.request().method();
      if (m !== 'GET') return route.fulfill({ status: m === 'POST' ? 201 : 204, body: '' });
      const table = new URL(route.request().url()).pathname.split('/').pop();
      const rows = table === 'couples' ? [shared.couple] : table === 'members' ? shared.members : Object.values(shared.rows[table] || {});
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    if (!holdBoot) await page.waitForSelector('.tabbar, [data-a^="tab:"]');
    return { context, page, errors };
  }
  const h2 = (page) => page.textContent('.hd h2');
  const route = (page, r) => page.evaluate((r) => window.cycleNative.route(r), r);
  // The route a scheduled notification carries, read from the notify.schedule call whose id matches.
  async function scheduled(page, idRe) {
    await page.waitForFunction((s) => window.__calls.some((x) => x.cmd === 'notify.schedule' && new RegExp(s).test(x.args.id)), idRe.source);
    return page.evaluate((s) => window.__calls.find((x) => x.cmd === 'notify.schedule' && new RegExp(s).test(x.args.id)).args, idRe.source);
  }

  // ---- local routes: taken from the scheduled notification itself ----
  const screens = {
    todo: async (page) => { assert.equal(await h2(page), 'To-dos'); },
    held: async (page) => {
      assert.equal(await h2(page), 'To-dos');
      assert.equal(await page.textContent('.sheetlayer .bsh h3'), 'Still send?');
      assert.equal(await page.textContent('.sheetlayer .ask'), 'ITEM-HELD-BODY');
    },
  };
  const local = [
    ['held-i1', 'held/i1', screens.held],
    ['sched-ts1', 'todo', screens.todo],
    ['fu-f1', 'log-followup', screens.todo],
    ['nudge-s1', 'nudge/s1', async (page) => { assert.equal(await h2(page), 'From Her'); assert.equal(await page.textContent('.quote'), 'SEND-s1'); }],
    ['nudge-ps1', 'nudge/ps1', async (page) => { assert.equal(await h2(page), 'Reminder'); assert.equal(await page.textContent('.quote'), 'SEND-ps1'); }],
    [/^fnote-f2-/, 'fight/f2', async (page) => {
      assert.equal(await h2(page), 'Fight');
      assert.match(await page.textContent('.fn'), /FIGHT-TWO-ABOUT/); // that fight, not f1
      await page.click('[data-a="back"]');
      assert.equal(await h2(page), 'Fights'); // back stack = fights
    }],
    [/^chal-ch1-/, 'challenge/ch1', async (page) => {
      assert.equal(await h2(page), 'CHALLENGE-ONE');
      await page.click('[data-a="back"]');
      assert.equal(await h2(page), 'Progress');
    }],
  ];
  for (const [id, expectRoute, check] of local) {
    test('scheduled ' + (id instanceof RegExp ? id.source : id) + ' carries ' + expectRoute + ' and it opens the right screen', async () => {
      const { context, page, errors } = await open();
      const args = await scheduled(page, id instanceof RegExp ? id : new RegExp('^' + id));
      assert.equal(args.route, expectRoute);
      await route(page, args.route);
      await check(page);
      assert.deepEqual(errors, []);
      await context.close();
    });
  }

  test('held route whose item is no longer held opens the To-do tab with no sheet', async () => {
    const { context, page, errors } = await open({ tweak: (sd) => { sd['shared.' + ME].rows.items.i1.status = 'delivered'; } });
    await route(page, 'held/i1');
    assert.equal(await h2(page), 'To-dos');
    assert.equal(await page.$('.sheetlayer .bsh'), null);
    assert.deepEqual(errors, []);
    await context.close();
  });

  // ---- remote push routes (push.mjs messageFor) ----
  test('remote todo opens the To-do tab', async () => {
    const { context, page } = await open();
    await route(page, 'todo');
    await screens.todo(page);
    await context.close();
  });

  test('remote todo/<id> opens that to-do\'s page, back goes to the To-do tab', async () => {
    const { context, page } = await open();
    await route(page, 'todo/tp1');
    assert.equal(await h2(page), 'TODO-PUSHED');
    await page.click('[data-a="back"]');
    assert.equal(await h2(page), 'To-dos');
    await context.close();
  });

  test('remote challenge/<id> opens that challenge', async () => {
    const { context, page } = await open();
    await route(page, 'challenge/ch1');
    assert.equal(await h2(page), 'CHALLENGE-ONE');
    await context.close();
  });

  // ---- legacy ----
  for (const r of ['today', 'acks']) {
    test('legacy ' + r + ' opens Home', async () => {
      const { context, page } = await open();
      await route(page, 'todo/tp1'); // leave Home first so the route has to bring us back
      await route(page, r);
      assert.equal(await h2(page), 'Home');
      await context.close();
    });
  }

  // ---- stale ids: row still missing after one sync lands on Home, never throws ----
  for (const r of ['todo/gone', 'nudge/gone', 'challenge/gone', 'fight/gone']) {
    test('stale ' + r + ' lands on Home without throwing', async () => {
      const { context, page, errors } = await open();
      await route(page, 'todo/tp1'); // start somewhere else
      await route(page, r);
      await page.waitForFunction(() => document.querySelector('.hd h2') && document.querySelector('.hd h2').textContent === 'Home');
      assert.equal(await h2(page), 'Home');
      assert.deepEqual(errors, []);
      assert.equal(await page.$('.err, .errbar'), null);
      await context.close();
    });
  }

  test('an unknown route leaves the current screen alone', async () => {
    const { context, page } = await open();
    await route(page, 'bogus/xyz');
    assert.equal(await h2(page), 'Home');
    await context.close();
  });

  // ---- cold start: route delivered before the page is ready ----
  for (const [r, check] of [['fight/f2', async (page) => { assert.equal(await h2(page), 'Fight'); assert.match(await page.textContent('.fn'), /FIGHT-TWO-ABOUT/); }],
    ['held/i1', screens.held]]) {
    test('route ' + r + ' delivered before boot finishes is queued and opens the screen once ready', async () => {
      const { context, page, errors } = await open({ holdBoot: true });
      await page.waitForFunction(() => window.__release); // boot has reached lock.get, so ui.ready is still false
      assert.equal(await page.evaluate(() => typeof window.cycleNative.route), 'function');
      await route(page, r);
      assert.equal(await page.$('.hd h2'), null, 'nothing rendered while not ready');
      await page.evaluate(() => window.__release());
      await page.waitForSelector('.tabbar, [data-a^="tab:"]');
      await page.waitForFunction(() => { const h = document.querySelector('.hd h2'); return h && h.textContent !== 'Home'; });
      await check(page);
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
});
