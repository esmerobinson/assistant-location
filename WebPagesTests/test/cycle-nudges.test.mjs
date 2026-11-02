// Nudges UI: the 8 pm send label and "?" popover, library sections (no duplicates), pin / archive, the reply
// thread round trip between two devices, the Send composer without Focus/Kudos, and the private tier staying off
// the network. Runs the real app in headless Chromium against seeded localStorage; the backend is aborted
// (offline) so every write is observed in the store's own persistence (outbox + rows), not a mock.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
shotsDir();
function shotsDir() { if (process.env.NUDGE_SHOTS) fs.mkdirSync(process.env.NUDGE_SHOTS, { recursive: true }); }

const ME = 'u-me', HER = 'u-her';
// 11:00 am New York (before the 8 pm cutoff) and 9:00 pm New York (after it), same day.
const MORNING = '2026-10-26T15:00:00Z', NIGHT = '2026-10-27T01:00:00Z';
const nd = (id, body, o = {}) => ({ id, couple_id: 'c1', author_id: ME, body, tag: 'Calm', pinned: false, sort_order: 0,
  archived_at: null, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', deleted_at: null, ...o });

function seed(who, { nudges = [], sends = [], replies = [], awards = [], privNudges = [], privSends = [] } = {}) {
  const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: who, email: who + '@x.test' } },
    ['shared.' + who]: {
      couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z' },
      members: [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Her', checkin_time: '21:00' }],
      rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, rewards: {}, redemptions: {},
        nudges: byId(nudges), nudge_sends: byId(sends), nudge_replies: byId(replies), nudge_awards: byId(awards) },
      cursors: {}, outbox: [],
    },
    ['priv.' + who]: { fights: [], affirmations: [], prefs: {}, nudges: privNudges, nudge_sends: privSends },
  };
}

describe('nudges', () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  // Opens the app at a fixed clock. `requests` collects every backend call the page attempts.
  async function open(s, who, at = MORNING) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(at));
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    const requests = [];
    await context.route('https://x.test/**', (r) => { requests.push(r.request().method() + ' ' + r.request().url() + ' ' + (r.request().postData() || '')); r.abort(); });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="row:nudges"]');
    return { context, page, requests, who };
  }
  const library = async (page) => { await page.click('[data-a="row:nudges"]'); await page.waitForSelector('.nd [data-nid], .nd .empty'); };
  const sections = (page) => page.$$eval('[data-sec]', (els) => Object.fromEntries(els.map((e) => [e.dataset.sec, [...e.querySelectorAll('[data-nid]')].map((r) => r.dataset.nid)])));
  // The store persists on a 50 ms debounce through an async kv, so give a write time to land before reading it back.
  const settle = (page) => page.waitForTimeout(400);
  const shared = async (page, who) => (await settle(page), page.evaluate((w) => JSON.parse(localStorage.getItem('cycle:shared.' + w)), who));
  const priv = async (page, who) => (await settle(page), page.evaluate((w) => JSON.parse(localStorage.getItem('cycle:priv.' + w)), who));
  async function shot(page, name, sel) {
    if (!process.env.NUDGE_SHOTS) return;
    const f = path.join(process.env.NUDGE_SHOTS, name + '.png');
    if (sel) await (await page.$(sel)).screenshot({ path: f }); else await page.screenshot({ path: f });
  }

  test('send label is plain before 8 pm and "Send tomorrow" with a ? popover after', async () => {
    const s = seed(ME, { nudges: [nd('n1', 'Breathe')] });
    for (const [at, late] of [[MORNING, false], [NIGHT, true]]) {
      const { context, page } = await open(s, ME, at);
      await library(page);
      await page.click('[data-a="nudge:n1"]');
      await page.waitForSelector('[data-a="nudgesend"]');
      const label = (await page.textContent('[data-a="nudgesend"]')).replace(/\s+/g, ' ').trim();
      assert.equal(label, late ? 'Send tomorrow?' : 'Send');
      assert.equal(await page.$('.tip'), null, 'popover closed until ? is tapped');
      if (late) {
        await page.click('[data-a="tip"]');
        assert.equal((await page.textContent('.tip')).trim(), 'After 8 pm, it goes out tomorrow at 8 am.');
        await shot(page, '02-row-actions-popover');
      }
      await context.close();
    }
  });

  test('library sections never repeat a nudge', async () => {
    const nudges = [nd('p1', 'Pinned one', { pinned: true })];
    for (let i = 1; i <= 7; i++) nudges.push(nd('n' + i, 'Nudge ' + i, { sort_order: i, created_at: `2026-10-0${i}T12:00:00Z` }));
    const { context, page } = await open(seed(ME, { nudges }), ME);
    await library(page);
    const sec = await sections(page);
    assert.deepEqual(sec.pinned, ['p1']);
    assert.deepEqual(sec.recent, ['n7', 'n6', 'n5', 'n4']);
    assert.deepEqual(sec.all, ['n1', 'n2', 'n3']);
    const flat = Object.values(sec).flat();
    assert.equal(new Set(flat).size, flat.length, 'no nudge in two sections');
    assert.equal(flat.length, 8);
    await shot(page, '01-library');
    await context.close();
  });

  test('pin moves a row to Pinned, archive removes it from the library', async () => {
    const { context, page } = await open(seed(ME, { nudges: [nd('a', 'Alpha', { sort_order: 1 }), nd('b', 'Beta', { sort_order: 2 })] }), ME);
    await library(page);
    await page.click('[data-a="nudge:b"]'); await page.click('[data-a="nudgepin"]');
    assert.equal((await page.textContent('[data-a="nudgepin"]')).trim(), 'Unpin');
    await page.click('[data-a="back"]');
    assert.deepEqual((await sections(page)).pinned, ['b']);
    assert.equal((await shared(page, ME)).outbox.some((o) => o.table === 'nudges'), true, 'pin is queued for sync');
    await page.click('[data-a="nudge:a"]'); await page.click('[data-a="nudgearchive"]');
    await page.waitForSelector('[data-sec]');
    assert.deepEqual(Object.values(await sections(page)).flat(), ['b']);
    await context.close();
  });

  // The keyboard shrinks the viewport to ~400px; the Save/Send pair must stay below the form, never over it.
  test('add form buttons never overlap the form when the keyboard is up', async () => {
    const { context, page } = await open(seed(ME, { nudges: [] }), ME);
    await library(page);
    await page.click('[data-a="nudgenew"]');
    await page.setViewportSize({ width: 390, height: 400 });
    await page.waitForTimeout(100);
    const box = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    const pair = await box('.nd .pair'), seg = await box('.nd .seg');
    assert.ok(pair.top >= seg.bottom, `buttons (top ${pair.top}) sit below the For switch (bottom ${seg.bottom})`);
    assert.equal(await page.$('.nd .tdc'), null, 'no Kind picker');
    await context.close();
  });

  test('Me nudges stay private: saved and sent without any backend call', async () => {
    const { context, page, requests } = await open(seed(ME, { privNudges: [] }), ME);
    await library(page);
    await page.click('[data-a="ntier:me"]');
    await page.click('[data-a="nudgenew"]');
    await page.fill('textarea[data-d="nbody"]', 'Drink water');
    await page.click('[data-a="nudgefor:me"]');
    await shot(page, '03-add-sheet');
    await page.click('[data-a="nudgenewsend"]');
    await page.waitForSelector('[data-nid]');
    const p = await priv(page, ME);
    assert.equal(p.nudges.length, 1); assert.equal(p.nudge_sends.length, 1);
    assert.equal(p.nudge_sends[0].recipient_id, ME);
    const sh = await shared(page, ME);
    assert.deepEqual(Object.keys(sh.rows.nudges), []); assert.deepEqual(Object.keys(sh.rows.nudge_sends), []);
    assert.equal(sh.outbox.length, 0, 'nothing queued for Supabase');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(requests.filter((q) => /nudge|Drink water/.test(q)).length, 0, 'no network call carried the Me nudge');
    await context.close();
  });

  test('reply round trip: recipient replies, sender sees it as a card and in the thread', async () => {
    const nudges = [nd('n1', 'You are doing fine', { author_id: HER })];
    const sends = [{ id: 's1', couple_id: 'c1', nudge_id: 'n1', sender_id: HER, recipient_id: ME, body: 'You are doing fine',
      deliver_at: '2026-10-26T12:00:00Z', opened_at: null, created_at: '2026-10-25T20:00:00Z', updated_at: '2026-10-25T20:00:00Z', deleted_at: null }];
    // Device A: the recipient. Opens the Needs-you card, which stamps opened_at, then replies.
    const a = await open(seed(ME, { nudges, sends }), ME);
    await a.page.click('[data-a="nudgein:s1"]');
    await a.page.waitForSelector('.cmp .in');
    await shot(a.page, '05-recipient-thread');
    await a.page.fill('.cmp .in', 'Thank you');
    await a.page.click('[data-a="nreply"]');
    await a.page.waitForSelector('.bub.me');
    const sa = await shared(a.page, ME);
    const reply = Object.values(sa.rows.nudge_replies)[0];
    assert.equal(reply.body, 'Thank you'); assert.equal(reply.send_id, 's1'); assert.equal(reply.author_id, ME);
    assert.ok(sa.rows.nudge_sends.s1.opened_at, 'opening stamped opened_at');
    assert.equal(sa.outbox.some((o) => o.table === 'nudge_replies'), true, 'reply goes straight to the outbox, no hold');
    await a.context.close();
    // Device B: the sender, whose store now contains what A wrote (what a sync pull delivers).
    const sendOpened = { ...sa.rows.nudge_sends.s1 };
    const b = await open(seed(HER, { nudges, sends: [sendOpened], replies: [reply] }), HER);
    await b.page.click('[data-a="replyopen:s1"]');
    await b.page.waitForSelector('.bub.her');
    assert.equal((await b.page.textContent('.bub.her')).includes('Thank you'), true);
    await b.context.close();
  });

  test('queued Me send shows the Tmrw tag after 8 pm', async () => {
    const { context, page } = await open(seed(ME, { privNudges: [nd('m1', 'Stretch', { author_id: ME })] }), ME, NIGHT);
    await library(page);
    await page.click('[data-a="ntier:me"]');
    await page.click('[data-a="nudge:m1"]'); await page.click('[data-a="nudgesend"]');
    await page.click('[data-a="back"]');
    assert.match((await page.textContent('[data-nid="m1"]')).replace(/\s+/g, ' '), /queued/);
    assert.match(await page.textContent('[data-nid="m1"] .tmr'), /Tmrw/);
    await shot(page, '04-home-queued', null);
    await context.close();
  });

  test('Today has no Send row, even from a saved order that still lists it', async () => {
    // Send was removed from Today; an order saved before that must drop it, keep the user's arrangement
    // and append rows added since instead of rendering a dead Send row.
    const cases = [[undefined, ['issue', 'nudges', 'todo', 'fight']], [['send', 'todo', 'fight'], ['todo', 'fight', 'issue', 'nudges']], [['send', 'nudges', 'todo', 'fight'], ['nudges', 'todo', 'fight', 'issue']], [['ack', 'todo', 'nudges', 'fight'], ['todo', 'nudges', 'fight', 'issue']]];
    for (const [rows, want] of cases) {
      const s = seed(ME);
      if (rows) s['priv.' + ME].prefs.rows = rows;
      const { context, page } = await open(s, ME);
      await page.waitForSelector('.rows .row');
      const ids = await page.$$eval('.rows .row:not(.ovr)', (els) => els.map((e) => e.dataset.id));
      assert.deepEqual(ids, want, 'rows for saved order ' + JSON.stringify(rows));
      await context.close();
    }
  });

  // ---- Done, with points -------------------------------------------------------------------------
  const homeBal = async (page) => +(await page.textContent('.bal'));
  async function toDone(page, id = 'n1') {
    await library(page);
    await page.click('[data-a="nudge:' + id + '"]');
    await page.click('[data-a="nudgedone"]');
    await page.waitForSelector('[data-a="donemark"]');
  }
  const sched = (page) => page.$$eval('.dsch .rem', (els) => els.map((e) => [...e.querySelectorAll('p')].map((p) => p.textContent).join(' ')));

  test('Done: 20 over 3 months pays 7/7/6, row moves to Done, balance +7, award queued', async () => {
    const { context, page } = await open(seed(ME, { nudges: [nd('n1', 'Ten minutes out is allowed'), nd('n2', 'Other')] }), ME);
    const before = await homeBal(page);
    await toDone(page);
    await page.click('[data-a="donepts:20"]');
    assert.deepEqual(await sched(page), ['Now +7', '26 Nov +7', '26 Jan +6']);
    assert.match(await page.textContent('[data-a="donemark"]'), /Mark done . 20/);
    await shot(page, 'd2-done-sheet');
    await page.click('[data-a="donemark"]');
    await page.waitForSelector('[data-sec="done"]');
    assert.deepEqual(await sections(page), { recent: ['n2'], done: ['n1'] });
    assert.equal(await page.$('[data-sec="done"] [data-grip]'), null, 'Done rows are not draggable');
    assert.match(await page.textContent('[data-sec="done"] small'), /^7 of 20 paid . next 26 Nov$/);
    await shot(page, 'd3-library-done');
    const st = await shared(page, ME);
    const aw = Object.values(st.rows.nudge_awards);
    assert.equal(aw.length, 1);
    assert.deepEqual([aw[0].points, aw[0].payout, aw[0].nudge_id, aw[0].recipient_id, aw[0].body], [20, '3mo', 'n1', HER, 'Ten minutes out is allowed']);
    assert.ok(st.rows.nudges.n1.done_at);
    assert.ok(st.outbox.some((o) => o.table === 'nudge_awards'), 'award is in the outbox: ' + JSON.stringify(st.outbox.map((o) => o.table)));
    await page.click('[data-a="back"]');
    assert.equal(await homeBal(page) - before, 7);
    await context.close();
  });

  test('Done: All now is one row; Other takes a positive integer only', async () => {
    const { context, page } = await open(seed(ME, { nudges: [nd('n1', 'A')] }), ME);
    await toDone(page);
    await page.click('[data-a="donepay:now"]');
    await page.click('[data-a="donepts:other"]');
    assert.ok(await page.$('[data-a="donemark"].dis'), 'blocked until a valid number is typed');
    for (const bad of ['0', '-5', '2.5', 'abc']) {
      await page.fill('[data-d="dotherv"]', bad);
      assert.ok(await page.$('[data-a="donemark"].dis'), bad + ' rejected');
    }
    await page.fill('[data-d="dotherv"]', '45');
    assert.deepEqual(await sched(page), ['Now +45']);
    assert.match(await page.textContent('[data-a="donemark"]'), /Mark done . 45/);
    await page.click('[data-a="donemark"]');
    await page.waitForSelector('[data-sec="done"]');
    assert.match(await page.textContent('[data-sec="done"] small'), /^45 paid . 26 Oct$/);
    await context.close();
  });

  test('Done is offered on the partner tier only; Me keeps Archive', async () => {
    const { context, page } = await open(seed(ME, { nudges: [nd('n1', 'A')], privNudges: [nd('m1', 'Mine')] }), ME);
    await library(page);
    await page.click('[data-a="nudge:n1"]');
    await shot(page, 'd1-row-actions', '.card');
    assert.ok(await page.$('[data-a="nudgedone"]'));
    assert.deepEqual(await page.$$eval('.row3:last-of-type .btn', (e) => e.map((x) => x.textContent)), ['Done', 'Archive']);
    await page.click('[data-a="back"]');
    await page.click('[data-a="ntier:me"]');
    await page.click('[data-a="nudge:m1"]');
    await page.waitForSelector('[data-a="nudgearchive"]');
    assert.equal(await page.$('[data-a="nudgedone"]'), null);
    await context.close();
  });

  test('Stop the rest cuts later installments; Send again stays in Done', async () => {
    // Done 25 Oct 10:00 NY, 30 over 3 months: 10 on 25 Oct, 10 on 25 Nov, 10 on 25 Jan.
    const aw = { id: 'a1', couple_id: 'c1', author_id: ME, recipient_id: HER, nudge_id: 'n1', body: 'Ten minutes out is allowed', points: 30, payout: '3mo',
      done_at: '2026-10-25T14:00:00Z', stopped_at: null, created_at: '2026-10-25T14:00:00Z', updated_at: '2026-10-25T14:00:00Z', deleted_at: null };
    const s = seed(ME, { nudges: [nd('n1', 'Ten minutes out is allowed', { done_at: aw.done_at })], awards: [aw] });
    const { context, page } = await open(s, ME);
    await library(page);
    assert.equal((await page.textContent('[data-sec="done"] small')).trim(), '10 of 30 paid \u00b7 next 25 Nov');
    await page.click('[data-a="nudge:n1"]');
    assert.equal((await page.textContent('.meta')).trim(), 'Done 25 Oct \u00b7 10 of 30 paid');
    await shot(page, 'd3-done-card', '.card');
    await page.click('[data-a="nudgesend"]');
    const sent = Object.values((await shared(page, ME)).rows.nudge_sends);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].nudge_id, 'n1');
    await page.click('[data-a="nudgestop"]');
    assert.equal(await page.$('[data-a="nudgestop"]'), null, 'nothing left to stop');
    const st = await shared(page, ME);
    assert.ok(st.rows.nudge_awards.a1.stopped_at);
    assert.ok(st.outbox.some((o) => o.table === 'nudge_awards' && o.op !== 'insert'), 'stop is queued: ' + JSON.stringify(st.outbox));
    await page.click('[data-a="back"]');
    assert.equal((await page.textContent('[data-sec="done"] small')).trim(), '10 of 30 paid \u00b7 stopped');
    assert.deepEqual((await sections(page)).done, ['n1'], 'still in Done after sending again');
    await context.close();
  });

  test("Esme's ledger shows 'Reminder done' entries", async () => {
    const aw = { id: 'a1', couple_id: 'c1', author_id: ME, recipient_id: HER, nudge_id: 'n1', body: 'x', points: 30, payout: 'now',
      done_at: '2026-10-25T14:00:00Z', stopped_at: null, created_at: '2026-10-25T14:00:00Z', updated_at: '2026-10-25T14:00:00Z', deleted_at: null };
    const { context, page } = await open(seed(HER, { nudges: [nd('n1', 'x', { done_at: aw.done_at })], awards: [aw] }), HER);
    await page.click('.bal');
    await page.waitForSelector('#balance');
    assert.ok((await page.content()).includes('Reminder done'));
    await context.close();
  });
});
