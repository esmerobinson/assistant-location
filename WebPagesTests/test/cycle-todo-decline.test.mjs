// Decline a response to-do instead of Done, with an optional note. Real app in headless WebKit against seeded
// localStorage; backend aborted so writes are read from the store's own persistence. Needs GL_WEBKIT_PW / GL_WEBKIT_EXEC.
// DECLINE_SHOTS=<dir> also writes 390px screenshots.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_WK = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = HAS_WK ? await import(process.env.GL_WEBKIT_PW) : null;
const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const SHOTS = process.env.DECLINE_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ME = 'u-me', HER = 'u-her';
const NOW = '2026-10-21T15:00:00Z';
const COUPLE = { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60 };
const MEMBERS = [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Esme', checkin_time: '21:00' }];
const MK = { id: 'mk1', couple_id: 'c1', logged_by: HER, at: '2026-10-20T12:00:00Z', repaired_at: null, deleted_at: null, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' };
const td = (id, o = {}) => ({ id, couple_id: 'c1', owner_id: ME, created_by: HER, item_id: null, fight_marker_id: 'mk1', title: id, description: null, type: 'response',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null, declined_at: null, decline_note: null,
  created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, ...o });

function seed(me, todos) {
  const byId = (a) => Object.fromEntries(a.map((r) => [r.id, r]));
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: me, email: 'x@x.test' } },
    ['shared.' + me]: { couple: COUPLE, members: MEMBERS,
      rows: { items: {}, todos: byId(todos), todo_events: {}, checkins: {}, fight_markers: { mk1: MK }, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {} },
      cursors: {}, outbox: [] },
    ['priv.' + me]: { fights: [], affirmations: [], prefs: {} },
  };
}

describe('decline a response to-do (webkit)', { skip: !HAS_WK && 'needs GL_WEBKIT_PW and GL_WEBKIT_EXEC' }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(me, todos) {
    const s = seed(me, todos);
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
    await page.click('[data-a="tab:todo"]');
    await page.waitForSelector('[data-a="addpick"]');
    return { context, page, key: 'cycle:shared.' + me };
  }
  async function stored(page, key, ok) {
    await page.waitForFunction(`(() => { const s = JSON.parse(localStorage.getItem('${key}')); return (${ok.toString()})(s); })()`);
    return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  }
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

  test('decline with a note: row leaves Open, shows Declined in Done, fight not repaired, no done_at, no event; undo restores Open', async () => {
    const { page, context, key } = await open(ME, [td('apo', { title: 'Apologize' })]);
    await page.click('[data-a="tdecline:apo"]');
    await page.waitForSelector('[data-a="tdeclinego"]');
    await page.fill('.bs textarea', 'Not ready yet');
    await shot(page, 'decline-sheet');
    await page.click('[data-a="tdeclinego"]');
    const s = await stored(page, key, (x) => !!x.rows.todos.apo.declined_at);
    assert.equal(s.rows.todos.apo.decline_note, 'Not ready yet');
    assert.equal(s.rows.todos.apo.done_at, null);
    assert.equal(s.rows.fight_markers.mk1.repaired_at, null);
    assert.equal(s.outbox.filter((o) => o.table === 'todo_events').length, 0);
    assert.equal(await page.$('[data-a="tdecline:apo"]'), null);
    // Open is empty; Done holds it as Declined.
    assert.equal(await page.$('[data-todo="apo"]'), null);
    await page.click('[data-a="doneopen"]');
    assert.equal(await page.$eval('.td-row.dn .hv', (e) => e.textContent), 'Declined');
    await shot(page, 'declined-row');
    // View page: Declined + note, Undo decline, no Decline button.
    await page.click('.td-row.dn');
    await page.waitForSelector('.tdd2');
    const facts = await page.$$eval('.frow', (es) => es.map((e) => e.textContent));
    assert.ok(facts.some((f) => f.startsWith('Declined')), facts.join('|'));
    assert.ok(facts.includes('NoteNot ready yet'), facts.join('|'));
    await shot(page, 'declined-view');
    await page.click('[data-a="tundecline:apo"]');
    const u = await stored(page, key, (x) => !x.rows.todos.apo.declined_at);
    assert.equal(u.rows.todos.apo.decline_note, null);
    await page.click('.back, [data-a="back"]');
    await page.waitForSelector('[data-todo="apo"]');
    assert.ok(await page.$('[data-a="tdecline:apo"]'));
    await context.close();
  });

  test('decline without a note works and the view page shows Declined with no Note row', async () => {
    const { page, context, key } = await open(ME, [td('ref', { title: 'Reflect' })]);
    await page.click('[data-a="tdecline:ref"]');
    await page.click('[data-a="tdeclinego"]');
    const s = await stored(page, key, (x) => !!x.rows.todos.ref.declined_at);
    assert.equal(s.rows.todos.ref.decline_note, null);
    await page.click('[data-a="doneopen"]');
    await page.click('.td-row.dn');
    await page.waitForSelector('.tdd2');
    const facts = await page.$$eval('.frow', (es) => es.map((e) => e.textContent));
    assert.ok(facts.some((f) => f.startsWith('Declined')));
    assert.ok(!facts.some((f) => f.startsWith('Note')));
    await context.close();
  });

  test('the partner who asked sees Declined and the note; no Decline, Done, Ping or Undo for her', async () => {
    const { page, context } = await open(HER, [td('apo', { title: 'Apologize', declined_at: '2026-10-21T14:00:00Z', decline_note: 'Not ready yet' }), td('open1', { title: 'Reflect' })]);
    // Her open ask of me: Open still, no Decline/Done buttons for her.
    assert.equal(await page.$('[data-a="tdecline:open1"]'), null);
    await page.click('[data-a="doneopen"]');
    assert.equal(await page.$eval('.td-row.dn .hv', (e) => e.textContent), 'Declined');
    await page.click('.td-row.dn');
    await page.waitForSelector('.tdd2');
    const facts = await page.$$eval('.frow', (es) => es.map((e) => e.textContent));
    assert.ok(facts.includes('NoteNot ready yet'), facts.join('|'));
    assert.equal(await page.$('[data-a="tundecline:apo"]'), null);
    assert.equal(await page.$('[data-a^="tnudge:"]'), null);
    await context.close();
  });

  test('a task (not a response) has no Decline', async () => {
    const { page, context } = await open(ME, [td('tk', { title: 'Task', type: 'task', fight_marker_id: null })]);
    assert.ok(await page.$('[data-a="done:tk"]'));
    assert.equal(await page.$('[data-a="tdecline:tk"]'), null);
    await context.close();
  });
});
