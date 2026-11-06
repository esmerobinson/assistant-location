// Detail actions that need server columns (soft deletes, delete requests, archive, cancel): fight edit / delete request / note delete,
// to-do undo, tapped-break undo, challenge archive, redemption cancel. Core rules via vm; UI in headless WebKit against seeded
// localStorage with the backend aborted, asserting on the queued outbox (the real offline path). Needs GL_WEBKIT_PW / GL_WEBKIT_EXEC.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import C from './cycle-load.mjs';

const HAS_WK = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = HAS_WK ? await import(process.env.GL_WEBKIT_PW) : null;
const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';

const ME = 'u-me', HER = 'u-her';
const NOW = '2026-10-21T15:00:00Z'; // Wed 11:00 New York
const NOWMS = Date.parse(NOW);
const MIN = 60000;
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-10-01T00:00:00Z', hold_ask_min: 60 };
const MEMBERS = [{ user_id: ME, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: HER, name: 'Esme', checkin_time: '21:00', hits_self: true }];
const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));
const iso = (ms) => new Date(ms).toISOString();

// ---- core ------------------------------------------------------------------------------------------------------
const TZ = 'America/New_York';
const members = MEMBERS;
const baseRows = (o = {}) => ({ members, items: [], todos: [], todo_events: [], fight_markers: [], redemptions: [], nudge_sends: [], nudge_awards: [], challenges: [], challenge_breaks: [], challenge_days: [], ...o });
const led = (r, now = NOWMS, since = '2026-10-19') => C.computeLedger(r, { tz: TZ, now, since });
const mk = (id, o = {}) => ({ id, logged_by: ME, at: '2026-10-20T14:00:00Z', repaired_at: null, hit_self: null, hit_related: null, hit_count: null, deleted_at: null, ...o });
const net = (l, day) => (l.weeks[C.weekStart(day)].days[day] || { net: 0 }).net;

describe('core: soft-deleted rows leave the ledger', () => {
  test('an approved-deleted fight stops costing points and stops breaking the calm day', () => {
    const live = led(baseRows({ fight_markers: [mk('f1')] }));
    assert.equal(net(live, '2026-10-20'), 1 - 5, 'logged +1, fight -5, no calm +3');
    const gone = led(baseRows({ fight_markers: [mk('f1', { deleted_at: '2026-10-20T18:00:00Z' })] }));
    assert.equal(net(gone, '2026-10-20'), 3, 'the day is calm again');
    assert.equal(gone.balance - live.balance, 7);
  });

  test('a deleted hit fight stops breaking a hit challenge', () => {
    const ch = { id: 'c', name: 'No hitting', start: '2026-10-19', for_user: ME, breaks_on: 'hit', accepted_at: '2026-10-19T12:00:00Z' };
    const hit = mk('f1', { hit_self: true, hit_count: 1 });
    assert.equal(led(baseRows({ challenges: [ch], fight_markers: [hit] })).challenges[0].best, 1);
    assert.equal(led(baseRows({ challenges: [ch], fight_markers: [{ ...hit, deleted_at: '2026-10-20T18:00:00Z' }] })).challenges[0].best, 2);
  });

  test('an undone tally event stops paying', () => {
    const t = { id: 't1', type: 'habit', title: 'Walk', target: 3, period: 'week', owner_id: ME, due_date: null, done_at: null, fight_marker_id: null, deleted_at: null, tally: 1, created_at: '2026-10-19T12:00:00Z' };
    const ev = { id: 'e1', todo_id: 't1', kind: 'tally', at: '2026-10-20T14:00:00Z', deleted_at: null };
    const a = led(baseRows({ todos: [t], todo_events: [ev] })), b = led(baseRows({ todos: [t], todo_events: [{ ...ev, deleted_at: '2026-10-20T15:00:00Z' }] }));
    assert.ok(a.balance - b.balance > 0, 'the tally paid before the undo');
  });

  test('an undone tapped break no longer breaks the streak', () => {
    const ch = { id: 'c', name: 'Phone down', start: '2026-10-19', for_user: ME, breaks_on: 'tap', accepted_at: '2026-10-19T12:00:00Z' };
    const br = { challenge_id: 'c', day: '2026-10-20', deleted_at: null };
    assert.equal(led(baseRows({ challenges: [ch], challenge_breaks: [br] })).challenges[0].day, 1);
    assert.equal(led(baseRows({ challenges: [ch], challenge_breaks: [{ ...br, deleted_at: '2026-10-20T16:00:00Z' }] })).challenges[0].day, 3);
  });

  test('an archived challenge stops accruing on its archive day; unarchiving resumes', () => {
    const ch = { id: 'c', name: 'Phone down', start: '2026-10-14', for_user: ME, breaks_on: 'tap', accepted_at: '2026-10-14T12:00:00Z' };
    const open = led(baseRows({ challenges: [ch] })), arch = led(baseRows({ challenges: [{ ...ch, archived_at: '2026-10-17T12:00:00Z' }] }), NOWMS, '2026-10-14');
    assert.equal(arch.challenges[0].archived, true);
    assert.equal(arch.challenges[0].earned, 1 + 2 + 3, 'Oct 14-16 paid, nothing from the 17th');
    assert.ok(open.challenges[0].earned > arch.challenges[0].earned);
    assert.equal(led(baseRows({ challenges: [{ ...ch, archived_at: null }] })).challenges[0].earned, open.challenges[0].earned);
  });

  test('a cancelled redemption never spends', () => {
    const r = { id: 'r1', status: 'cancelled', price: 50, decided_at: '2026-10-20T14:00:00Z', reward_id: 'w' };
    assert.equal(led(baseRows({ redemptions: [r] })).spent, 0);
    assert.equal(led(baseRows({ redemptions: [{ ...r, status: 'approved' }] })).spent, 50);
  });
});

describe('core: needsYou for a fight delete request', () => {
  const s = (o) => ({ me: HER, now: NOWMS, tz: TZ, items: [], redemptions: [], nudge_sends: [], nudge_replies: [], fight_notes: [], todos: [], seen: [], since: '2026-10-01', fight_markers: [], ...o });
  const reqd = mk('f1', { delete_requested_at: '2026-10-20T15:00:00Z' });
  test('the partner gets a fightdel card and no "add your version" card; the logger gets neither', () => {
    const p = C.needsYou(s({ fight_markers: [reqd] }));
    assert.deepEqual(p.map((c) => c.type), ['fightdel']);
    assert.deepEqual(C.needsYou(s({ me: ME, fight_markers: [reqd] })), []);
  });
  test('a declined or approved request is no card', () => {
    assert.equal(C.needsYou(s({ fight_markers: [{ ...reqd, delete_requested_at: null, delete_declined_at: '2026-10-20T16:00:00Z' }] })).filter((c) => c.type === 'fightdel').length, 0);
    assert.equal(C.needsYou(s({ fight_markers: [{ ...reqd, deleted_at: '2026-10-20T16:00:00Z' }] })).length, 0);
  });
});

// ---- UI ----------------------------------------------------------------------------------------------------------
const td = (id, o = {}) => ({ id, couple_id: 'c1', owner_id: ME, created_by: ME, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null,
  created_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:00:00Z', deleted_at: null, ...o });
const chal = (id, o = {}) => ({ id, couple_id: 'c1', name: id, start: '2026-10-01', for_user: ME, breaks_on: 'tap', accepted_at: '2026-10-01T12:00:00Z', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', archived_at: null, ...o });
const fm = (id, o = {}) => ({ id, couple_id: 'c1', logged_by: ME, at: iso(NOWMS - 5 * MIN), created_at: iso(NOWMS - 5 * MIN), repaired_at: null, hit_self: false, hit_related: null, hit_count: null,
  delete_requested_at: null, delete_declined_at: null, deleted_at: null, ...o });

function seed({ todos = [], todo_events = [], fights = [], notes = [], challenges = [], breaks = [], rewards = [], redemptions = [], priv = [] } = {}) {
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: ME, email: 'me@x.test' } },
    ['shared.' + ME]: { couple: COUPLE, members: MEMBERS,
      rows: { items: {}, todos: byId(todos), todo_events: byId(todo_events), checkins: {}, fight_markers: byId(fights), fight_notes: byId(notes), rewards: byId(rewards), redemptions: byId(redemptions), nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {},
        challenges: byId(challenges), challenge_breaks: byId(breaks), challenge_days: {} },
      cursors: {}, outbox: [] },
    ['priv.' + ME]: { fights: priv, affirmations: [], prefs: {} },
  };
}

describe('detail actions (webkit)', { skip: !HAS_WK && 'needs GL_WEBKIT_PW and GL_WEBKIT_EXEC' }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(s, { viewport = { width: 390, height: 844 } } = {}) {
    const context = await browser.newContext({ viewport, hasTouch: true });
    await context.clock.setFixedTime(new Date(NOW));
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (r) => r.abort());
    const page = await context.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tabbar');
    return { context, page, errs };
  }
  const outbox = (page) => page.evaluate(() => window.CycleStore.S.outbox.map((o) => ({ ...o })));
  const patches = async (page, table) => (await outbox(page)).filter((o) => o.table === table && o.op === 'patch').map((o) => o.patch);
  const openFight = async (page, id) => { await page.click('.tabbar [data-a="tab:fights"]'); await page.click(`[data-a="openfight:${id}"]`); await page.waitForSelector('.fd'); };

  test('fight edit: the logger edits shared fields on a fight logged long ago (intensity stays local)', async () => {
    const { context, page } = await open(seed({ fights: [fm('f1'), fm('old', { created_at: iso(NOWMS - 30 * MIN), at: iso(NOWMS - 30 * MIN) })], priv: [{ id: 'f1', at: NOWMS - 5 * MIN, logged_at: NOWMS - 5 * MIN, intensity: 2 }, { id: 'old', at: NOWMS - 30 * MIN, logged_at: NOWMS - 30 * MIN, intensity: 2 }] }));
    // 30 minutes old: past the 15-minute window that used to hide Edit (and with it the hit question).
    await openFight(page, 'old');
    await page.click('[data-a="fightedit"]');
    await page.click('[data-a="yn:hit:yes"]'); await page.click('[data-a="hitn:1"]'); await page.click('[data-a="int:5"]');
    await page.click('[data-a="fighteditsave"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    const p = await patches(page, 'fight_markers');
    assert.deepEqual(p, [{ hit_self: true, hit_count: 2 }]);
    // Intensity is shared only through my fight_ratings row; the marker patch never carries it.
    assert.equal(JSON.stringify(p).includes('intensity'), false, 'intensity never on the marker');
    const priv = await page.evaluate(() => window.CycleStore.S.priv.fights.find((f) => f.id === 'old'));
    assert.equal(priv.intensity, 5, 'intensity changed on the device only');
    assert.equal(await page.$('.bs'), null, 'sheet closed');
    await context.close();
  });

  test('fight delete: the logger asks, only the request is queued, the chip shows, edit goes away', async () => {
    const { context, page } = await open(seed({ fights: [fm('f1')], priv: [{ id: 'f1', at: NOWMS - 5 * MIN, logged_at: NOWMS - 5 * MIN, intensity: 4 }] }));
    await openFight(page, 'f1');
    await page.click('[data-a="fightdelq"]'); await page.click('[data-a="fightdelreq"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    const [p] = await patches(page, 'fight_markers');
    assert.deepEqual(Object.keys(p).sort(), ['delete_declined_at', 'delete_requested_at']);
    assert.equal(p.delete_declined_at, null);
    assert.equal(JSON.stringify(await outbox(page)).includes('intensity'), false);
    assert.match(await page.textContent('.rcs'), /Delete requested/);
    assert.equal(await page.$('[data-a="fightedit"]'), null);
    assert.equal(await page.$('[data-a="fightdelq"]'), null);
    await context.close();
  });

  test('partner side: Home shows the delete request; Approve soft-deletes it and the fight leaves the Fights tab', async () => {
    const { context, page } = await open(seed({ fights: [fm('f1', { logged_by: HER, delete_requested_at: iso(NOWMS - MIN) })] }));
    await page.waitForSelector('.nc.tall');
    assert.match(await page.textContent('.nc.tall'), /Delete fight/);
    assert.equal(await page.$('.nc [data-a="openfight:f1"] >> text=Add your version'), null);
    await page.click('[data-a="fightdelok:f1"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    const [p] = await patches(page, 'fight_markers');
    assert.deepEqual(Object.keys(p), ['deleted_at']);
    assert.equal(await page.$('.nc.tall'), null);
    await page.click('.tabbar [data-a="tab:fights"]');
    assert.equal(await page.$('[data-a="openfight:f1"]'), null, 'gone from the list');
    await context.close();
  });

  test('partner side: Decline clears the request and stamps declined', async () => {
    const { context, page } = await open(seed({ fights: [fm('f1', { logged_by: HER, delete_requested_at: iso(NOWMS - MIN) })] }));
    await page.click('[data-a="fightdeldecl:f1"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    const [p] = await patches(page, 'fight_markers');
    assert.equal(p.delete_requested_at, null);
    assert.ok(p.delete_declined_at);
    await context.close();
  });

  test('fight note: the author deletes their own note and a Deleted marker stays; the partner has no Delete', async () => {
    const notes = [{ id: 'n1', couple_id: 'c1', fight_marker_id: 'f1', author_id: ME, body: 'my side', created_at: iso(NOWMS - 4 * MIN), deleted_at: null },
      { id: 'n2', couple_id: 'c1', fight_marker_id: 'f1', author_id: HER, body: 'her side', created_at: iso(NOWMS - 3 * MIN), deleted_at: null }];
    const { context, page } = await open(seed({ fights: [fm('f1')], notes }));
    await openFight(page, 'f1');
    assert.equal((await page.$$('[data-a^="notedel:"]')).length, 1, 'only my note offers Delete');
    await page.click('[data-a="notedel:n1"]');
    assert.equal(await page.textContent('.bs h3'), 'Delete note?', 'a trash tap opens the confirm sheet');
    assert.deepEqual(await outbox(page), [], 'nothing deleted yet');
    assert.match(await page.textContent('.fns'), /my side/);
    await page.click('.bs [data-a="sheet:close"]');
    assert.equal(await page.$('.bs'), null);
    assert.deepEqual(await outbox(page), [], 'Cancel leaves the note');
    await page.click('[data-a="notedel:n1"]');
    await page.click('[data-a="notedelok"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    assert.equal(await page.$('.bs'), null, 'sheet closed');
    assert.deepEqual((await patches(page, 'fight_notes')).map((p) => Object.keys(p)), [['deleted_at']]);
    assert.equal(await page.$eval('.fn.gone p:last-child', (e) => e.textContent), 'Deleted');
    assert.equal(await page.$('.fns >> text=my side'), null, 'the text is no longer shown');
    await context.close();
  });

  test('fight note edit: the author rewrites their own note (Edit offered only on their own), Edited shows once the server stamps it', async () => {
    const notes = [{ id: 'n1', couple_id: 'c1', fight_marker_id: 'f1', author_id: ME, body: 'my side', created_at: iso(NOWMS - 4 * MIN), edited_at: null, deleted_at: null },
      { id: 'n2', couple_id: 'c1', fight_marker_id: 'f1', author_id: HER, body: 'her side', created_at: iso(NOWMS - 3 * MIN), edited_at: iso(NOWMS - MIN), deleted_at: null }];
    const { context, page } = await open(seed({ fights: [fm('f1')], notes }));
    await openFight(page, 'f1');
    assert.deepEqual(await page.$$eval('[data-a^="notedit:"]', (e) => e.map((x) => x.dataset.a)), ['notedit:n1'], 'only my note offers Edit');
    assert.match(await page.textContent('.fn:nth-of-type(2) .meta'), /Edited/, 'her edited note shows Edited to me');
    // Icon buttons: labelled, and a 32px hit area on each.
    const box = await page.$eval('[data-a="notedit:n1"]', (e) => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label'), r.width, r.height]; });
    assert.deepEqual(box, ['Edit note', 32, 32]);
    assert.equal(await page.getAttribute('[data-a="notedel:n1"]', 'aria-label'), 'Delete note');
    await page.click('[data-a="notedit:n1"]');
    assert.equal(await page.inputValue('.bs textarea'), 'my side', 'prefilled');
    await page.fill('.bs textarea', '  my side, revised ');
    await page.click('[data-a="noteditsave"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    assert.deepEqual(await patches(page, 'fight_notes'), [{ body: 'my side, revised' }]);
    assert.equal(await page.$('.bs'), null, 'sheet closed');
    assert.match(await page.textContent('.fns'), /my side, revised/);
    await context.close();
  });

  // A whole fight story pasted into Edit note grew the sheet past the top of the screen: no scroll and no reachable Save (2026-11-06).
  test('fight note edit: a long note keeps the sheet on screen, Save visible, the text scrolling inside its box', async () => {
    const long = Array.from({ length: 60 }, (_, i) => 'Sentence ' + i + ' of a long story about the charger.').join(' ');
    const notes = [{ id: 'n1', couple_id: 'c1', fight_marker_id: 'f1', author_id: ME, body: long, created_at: iso(NOWMS - 4 * MIN), edited_at: null, deleted_at: null }];
    const { context, page } = await open(seed({ fights: [fm('f1')], notes }), { viewport: { width: 390, height: 664 } });
    await openFight(page, 'f1');
    await page.click('[data-a="notedit:n1"]');
    const m = await page.evaluate(() => {
      const bs = document.querySelector('.bs').getBoundingClientRect(), sv = document.querySelector('[data-a="noteditsave"]').getBoundingClientRect(), ta = document.querySelector('.bs textarea');
      return { top: bs.top, saveBottom: sv.bottom, vh: innerHeight, taScrolls: ta.scrollHeight > ta.clientHeight + 20 };
    });
    assert.ok(m.top >= 0, 'sheet top on screen: ' + m.top);
    assert.ok(m.saveBottom <= m.vh, 'Save above the bottom edge: ' + m.saveBottom + ' > ' + m.vh);
    assert.ok(m.taScrolls, 'the textarea is capped and scrolls its overflow');
    await page.click('[data-a="noteditsave"]');
    assert.equal(await page.$('.bs'), null, 'Save is tappable and closes the sheet');
    await context.close();
  });

  test('to-do undo: done and tally are taken back together with their event', async () => {
    const todos = [td('a', { done_at: iso(NOWMS - 60 * MIN) }), td('h', { type: 'habit', target: 3, period: 'week', tally: 2 })];
    const evs = [{ id: 'ea', couple_id: 'c1', todo_id: 'a', user_id: ME, kind: 'done', at: iso(NOWMS - 60 * MIN), note: null },
      { id: 'eh1', couple_id: 'c1', todo_id: 'h', user_id: ME, kind: 'tally', at: iso(NOWMS - 120 * MIN), note: null }, { id: 'eh2', couple_id: 'c1', todo_id: 'h', user_id: ME, kind: 'tally', at: iso(NOWMS - 30 * MIN), note: null }];
    const { context, page } = await open(seed({ todos, todo_events: evs }));
    await page.click('.tabbar [data-a="tab:todo"]');
    await page.waitForSelector('[data-todo="h"]');
    await page.click('[data-todo="h"]'); await page.waitForSelector('[data-a="tundo:h"]');
    await page.click('[data-a="tundo:h"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length >= 2);
    assert.deepEqual((await patches(page, 'todos')), [{ tally: 1 }]);
    assert.deepEqual((await outbox(page)).filter((o) => o.table === 'todo_events').map((o) => [o.id, Object.keys(o.patch)]), [['eh2', ['deleted_at']]], 'the latest tally event');
    await page.click('.hd .back'); await page.click('[data-a="tview:a"]'); await page.waitForSelector('[data-a="tundo:a"]');
    await page.click('[data-a="tundo:a"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length >= 4);
    assert.deepEqual((await patches(page, 'todos')).pop(), { done_at: null });
    assert.equal(await page.$('[data-a="tundo:a"]'), null, 'no Undo once it is open again');
    await context.close();
  });

  test('tap challenge: Undo break soft-deletes my break; breaking again revives the same row instead of inserting', async () => {
    const br = { couple_id: 'c1', id: 'b1', challenge_id: 'k', day: '2026-10-21', note: 'slip', by: ME, created_at: NOW, updated_at: NOW, deleted_at: null };
    const { context, page } = await open(seed({ challenges: [chal('k')], breaks: [br] }));
    await page.click('.tabbar [data-a="tab:progress"]'); await page.click('[data-a="challenge:k"]');
    await page.waitForSelector('[data-a="brundo"]');
    assert.equal(await page.$('[data-a="broke"]'), null);
    await page.click('[data-a="brundo"]');
    await page.waitForSelector('[data-a="broke"]');
    assert.deepEqual(Object.keys((await patches(page, 'challenge_breaks'))[0]), ['deleted_at']);
    await page.click('[data-a="broke"]'); await page.fill('[data-d="brnote"]', 'again'); await page.click('[data-a="brsave"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.filter((o) => o.table === 'challenge_breaks').length >= 1);
    const ob = (await outbox(page)).filter((o) => o.table === 'challenge_breaks');
    assert.equal(ob.some((o) => o.op === 'insert'), false, 'no second insert for the same day');
    const last = (await patches(page, 'challenge_breaks')).pop();
    assert.equal(last.deleted_at, null);
    assert.equal(last.note, 'again');
    await context.close();
  });

  test('challenge archive: Archive moves it to an Archived section, Unarchive brings it back', async () => {
    const { context, page } = await open(seed({ challenges: [chal('k')] }));
    await page.click('.tabbar [data-a="tab:progress"]'); await page.click('[data-a="challenge:k"]');
    await page.click('[data-a="chedit"]'); await page.click('[data-a="charch"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    const [p] = await patches(page, 'challenges');
    assert.deepEqual(Object.keys(p), ['archived_at']); assert.ok(p.archived_at);
    await page.click('.hd .back');
    assert.equal(await page.$$eval('.deck', (d) => d.length), 1, 'only the Archived deck remains');
    assert.match(await page.textContent('.empty'), /None/, 'Challenges section is empty');
    assert.ok(await page.$('text=Archived'));
    await page.click('[data-a="challenge:k"]'); await page.click('[data-a="chedit"]'); await page.click('[data-a="charch"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    assert.equal((await patches(page, 'challenges')).pop().archived_at, null);
    await context.close();
  });

  test('the Archived card scrolls fully clear of the tab bar', async () => {
    const { context, page } = await open(seed({ challenges: [chal('k', { archived_at: '2026-10-10T12:00:00Z' })] }));
    await page.click('.tabbar [data-a="tab:progress"]'); await page.waitForSelector('.deck .ach');
    await page.evaluate(() => { const s = document.querySelector('.scr'); s.scrollTop = s.scrollHeight; });
    const g = await page.evaluate(() => ({ card: document.querySelector('.deck .ach').getBoundingClientRect().bottom, bar: document.querySelector('.tabbar').getBoundingClientRect().top }));
    assert.ok(g.card <= g.bar - 8, 'card bottom ' + g.card + ' vs tab bar top ' + g.bar);
    await context.close();
  });

  test('error log: bar names what failed, log keeps cause without row data, Settings shows and copies it', async () => {
    const { context, page } = await open(seed({ challenges: [chal('k')] }));
    await context.route('https://x.test/**', (r) => r.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ code: '23514', message: 'new row violates check constraint "x"', details: 'Failing row contains (SECRETNOTE)' }) }));
    await page.evaluate(() => window.CycleStore.syncNow().catch(() => {}));
    await page.waitForSelector('.errbar');
    assert.equal(await page.textContent('.errbar'), "Couldn't sync");
    const log = await page.evaluate(() => window.CycleStore.S.errLog);
    assert.ok(log.length >= 1);
    assert.equal(log[0].kind, 'sync'); assert.equal(log[0].status, 400); assert.match(log[0].where, /^(GET|POST|PATCH) /); assert.match(log[0].msg, /violates check constraint/);
    assert.ok(!JSON.stringify(log).includes('SECRETNOTE'), 'row details are never logged');
    await page.evaluate(() => { for (let i = 0; i < 25; i++) window.CycleStore.logErr('action', new Error('e' + i)); });
    assert.equal(await page.evaluate(() => window.CycleStore.S.errLog.length), 20, 'capped at 20');
    await page.click('.tabbar [data-a="tab:home"]'); await page.click('[data-a="go:more"]');
    await page.click('[data-a="go:settings"]'); await page.click('[data-a="errlog"]');
    assert.match(await page.textContent('.errlog'), /\| action \| - \| - \| e24/, 'newest first, readable in Settings');
    await context.close();
  });

  test('redemption cancel: the requester cancels a pending ask from the shop; nothing spends', async () => {
    const rw = { id: 'w1', couple_id: 'c1', name: 'Massage', price: 30, art: null, archived: false, created_at: NOW, updated_at: NOW };
    const rd = { id: 'r1', couple_id: 'c1', reward_id: 'w1', price: 30, requested_by: ME, status: 'pending', decided_by: null, decided_at: null, created_at: NOW, updated_at: NOW };
    const { context, page } = await open(seed({ rewards: [rw], redemptions: [rd] }));
    await page.click('.tabbar [data-a="tab:progress"]'); await page.click('[data-a="go:shop"]');
    assert.equal(await page.textContent('[data-a="reward:w1"] .pr'), 'Pending');
    await page.click('[data-a="reward:w1"]'); await page.click('[data-a="redcancel:r1"]');
    await page.waitForFunction(() => window.CycleStore.S.outbox.length > 0);
    const [p] = await patches(page, 'redemptions');
    assert.deepEqual([p.status, p.decided_by, !!p.decided_at], ['cancelled', ME, true]);
    assert.notEqual(await page.textContent('[data-a="reward:w1"] .pr'), 'Pending');
    await context.close();
  });
});
