// Talk (was Acknowledge): rename, Kudos subsection, kudos form with gift points.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it. TALK_SHOTS=<dir> saves screenshots.
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

const UID = 'u-me', PID = 'u-her', TZ = 'America/New_York';
const HOUR = 36e5;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const members = [{ user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Her', checkin_time: '21:00', hits_self: true }];
const seed = () => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: TZ, created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members,
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});
const item = (id, o) => ({ id, couple_id: 'c1', sender_id: PID, recipient_id: UID, kind: 'kudos', body: id, ask_type: null, status: 'delivered', delivered_at: ago(5), created_at: ago(5), updated_at: ago(5), deleted_at: null, opened_at: null, kept: null, ...o });
const ledgerRows = (items) => ({ members, items, todos: [], todo_events: [], fight_markers: [], redemptions: [], nudge_sends: [], nudge_awards: [], challenges: [] });
// Total Kudos points the ledger pays for these item rows.
const kudosPts = (items) => {
  const l = C.computeLedger(ledgerRows(items), { tz: TZ, now: Date.now() + HOUR, since: C.localDay(Date.now() - 48 * HOUR, TZ) });
  return Object.values(l.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'Kudos').reduce((n, x) => n + x.pts, 0);
};

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(tweak) {
    const s = seed();
    if (tweak) tweak(s['shared.' + UID], s['priv.' + UID]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    const writes = [];
    await context.route('https://x.test/**', (route) => { if (route.request().method() !== 'GET') writes.push(route.request().method() + ' ' + route.request().url()); route.abort(); });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rows .row');
    return { context, page, writes };
  }
  const read = async (page, key) => { await page.waitForTimeout(500); return page.evaluate((k) => JSON.parse(localStorage.getItem('cycle:' + k)), key); };
  const rowsOf = async (page, t) => Object.values((await read(page, 'shared.' + UID)).rows[t]);
  const openKudos = async (page) => { await page.click('[data-a="row:ack"]'); await page.click('[data-a="kudosnew"]'); };

  test('Acknowledge is renamed Talk everywhere, with Kudos only', async () => {
    const { context, page } = await open();
    assert.match(await page.textContent('[data-id="ack"]'), /Talk/);
    await page.click('[data-a="row:ack"]');
    assert.equal(await page.textContent('h2'), 'Talk');
    assert.deepEqual(await page.$$eval('main > section > .lab', (els) => els.map((e) => e.textContent.replace('Add', ''))), ['Kudos']);
    await page.click('[data-a="kudosnew"]');
    await page.click('[data-a="back"]');
    assert.match(await page.textContent('.hd .back'), /Today/);
    assert.doesNotMatch(await page.textContent('body'), /Acknowledge|Owning up/);
    await context.close();
  });

  test('kudos form has no To or Private control and sends gift points to the partner', async () => {
    const { context, page } = await open();
    await openKudos(page);
    assert.equal(await page.$$eval('[data-a^="kudosto"], [data-a^="kudospriv"], [data-a^="kudospts"]', (e) => e.length), 0, 'no To / Private / Points toggle');
    assert.deepEqual(await page.$$eval('main .lab, main .lab0', (els) => els.map((e) => e.textContent)), ['Gift points']);
    assert.equal(await page.$eval('input[data-d="kgift"]', (e) => e.getAttribute('inputmode')), 'numeric');
    await page.fill('input[data-d="ktext"]', 'Thanks for dinner');
    await page.click('[data-a="kudossave"]');
    await page.waitForSelector('.nd .rem');
    const [empty] = await rowsOf(page, 'items');
    assert.deepEqual([empty.kind, empty.sender_id, empty.recipient_id, empty.gift_points], ['kudos', UID, PID, 0], 'empty = 0 points');
    assert.doesNotMatch(await page.textContent('.nd .rem small'), /point/);
    await page.click('[data-a="kudosnew"]');
    await page.fill('input[data-d="ktext"]', 'Nice parking');
    await page.fill('input[data-d="kgift"]', '5');
    await page.click('[data-a="kudossave"]');
    await page.waitForFunction(() => document.querySelectorAll('.nd .rem').length === 2);
    const items = await rowsOf(page, 'items');
    const five = items.find((i) => i.body === 'Nice parking');
    assert.equal(five.gift_points, 5);
    assert.equal(kudosPts([five]), 5, 'gift 5 scores exactly +5 through the real ledger');
    assert.equal(kudosPts([empty]), 0);
    assert.match(await page.textContent('.nd'), /To Her · 5 points/);
    await context.close();
  });

  test('negative and non-integer gift points are rejected at the form', async () => {
    const { context, page } = await open();
    await openKudos(page);
    await page.fill('input[data-d="ktext"]', 'Thanks');
    for (const bad of ['-3', '1.5']) {
      await page.fill('input[data-d="kgift"]', bad);
      await page.click('[data-a="kudossave"]');
      await page.waitForTimeout(300);
      assert.equal((await rowsOf(page, 'items')).length, 0, bad + ' saved nothing');
      assert.equal(await page.$('[data-d="kgift"]') !== null, true, 'still on the form');
    }
    await page.fill('input[data-d="kgift"]', '1');
    await page.click('[data-a="kudossave"]');
    await page.waitForSelector('.nd .rem');
    assert.match(await page.textContent('.nd'), /To Her · 1 point(?!s)/);
    await context.close();
  });

  test('Kudos lists received and given kudos with gift points; legacy No points kept; her old shared self-kudos is not shown', async () => {
    const { context, page } = await open((sh, priv) => {
      sh.rows.items = Object.fromEntries([item('You were patient'), item('Thanks for the soup', { sender_id: UID, recipient_id: PID, points: false }), item('Great job', { sender_id: UID, recipient_id: PID, gift_points: 5 })].map((r) => [r.id, r]));
      priv.kudos = [{ id: 'p1', body: 'I got up and went for a walk', created_at: ago(1) }];
    });
    await page.click('[data-a="row:ack"]');
    const kud = await page.$$eval('main > section:nth-of-type(1) .rem', (els) => els.map((e) => e.textContent));
    assert.equal(kud.length, 3, 'old stored priv.kudos is ignored without crashing');
    assert.ok(kud.some((t) => /You were patient.*From Her/.test(t)));
    assert.ok(kud.some((t) => /Thanks for the soup.*To Her · No points/.test(t)));
    assert.ok(kud.some((t) => /Great job.*To Her · 5 points/.test(t)));
    assert.equal(await page.$('main > section:nth-of-type(2)'), null, 'Kudos is the only section');
    if (process.env.TALK_SHOTS) {
      await page.screenshot({ path: path.join(process.env.TALK_SHOTS, '1-talk.png') });
      await page.click('[data-a="kudosnew"]');
      await page.fill('input[data-d="ktext"]', 'Thanks for the soup');
      await page.fill('input[data-d="kgift"]', '5');
      await page.screenshot({ path: path.join(process.env.TALK_SHOTS, '2-kudos-form.png') });
      await page.click('[data-a="back"]');
    }
    await context.close();
  });
});
