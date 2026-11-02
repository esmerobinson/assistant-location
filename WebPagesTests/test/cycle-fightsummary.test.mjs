// Fights list rows: neutral shared summary (fallback to the note), per-viewer action chips, chip tap vs row tap; detail summary.
// Runs in Chromium, plus WebKit when GL_WEBKIT_PW/GL_WEBKIT_EXEC are set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const engines = { chromium };
if (process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC) {
  const pw = await import(process.env.GL_WEBKIT_PW);
  engines.webkit = { launch: (o) => pw.webkit.launch({ ...o, executablePath: process.env.GL_WEBKIT_EXEC }) };
}

const UID = 'u-me', PID = 'u-her', HOUR = 36e5;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const marker = (id, o = {}) => ({ id, couple_id: 'c1', logged_by: PID, at: ago(5), repaired_at: null, hit_self: null, hit_related: null, summary: null, summary_notes_at: null, ...o });
const fnote = (id, fm, author, body) => ({ id, couple_id: 'c1', fight_marker_id: fm, author_id: author, body, created_at: ago(4) });
const todo = (id, fm, owner, by, title) => ({ id, couple_id: 'c1', owner_id: owner, created_by: by, item_id: null, fight_marker_id: fm, title, type: 'response', due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, tally: 0, done_at: null, edited_at: null, created_at: ago(3), updated_at: ago(3), deleted_at: null });
const seed = (fill) => {
  const sh = {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Alex', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Sam', checkin_time: '21:00', hits_self: true }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {}, todo_comments: {}, todo_nudges: {}, challenges: {}, challenge_breaks: {}, challenge_days: {}, challenge_nudges: {} }, cursors: {}, outbox: [],
  };
  fill(sh.rows);
  return { session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } }, ['shared.' + UID]: sh, ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} } };
};
const add = (r, kind, row) => { r[kind][row.id] = row; };

for (const [name, type] of Object.entries(engines)) describe(name, () => {
  let browser;
  before(async () => { browser = await type.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  async function open(fill, route = 'tab:fights') {
    const s = seed(fill);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.click(`[data-a="${route}"]`);
    await page.waitForSelector('.rf');
    return { context, page };
  }
  const rowText = (page, id) => page.$eval(`.rf[data-a="openfight:${id}"]`, (e) => ({ sm: e.querySelector('.sm')?.textContent ?? null, chips: [...e.querySelectorAll('.rc')].map((c) => c.textContent.trim()), cls: [...e.querySelectorAll('.rc')].map((c) => c.className) }));

  test('row shows the shared summary instead of the note, and no Hit/Repaired/N notes chips', async () => {
    const { context, page } = await open((r) => {
      add(r, 'fight_markers', marker('f1', { summary: 'Sam felt unheard about the dishes. Alex felt rushed.', hit_self: true, repaired_at: ago(1) }));
      add(r, 'fight_notes', fnote('n1', 'f1', PID, 'RAW NOTE TEXT'));
      add(r, 'fight_notes', fnote('n2', 'f1', UID, 'second raw note'));
    });
    const t = await rowText(page, 'f1');
    assert.equal(t.sm, 'Sam felt unheard about the dishes. Alex felt rushed.');
    assert.deepEqual(t.chips, []);
    await context.close();
  });

  test('row falls back to the note text, clamped to 3 lines, when there is no summary yet', async () => {
    const { context, page } = await open((r) => {
      add(r, 'fight_markers', marker('f1'));
      add(r, 'fight_notes', fnote('n1', 'f1', PID, '<b>x</b> She says it started with the dishes'));
    });
    assert.equal((await rowText(page, 'f1')).sm, '<b>x</b> She says it started with the dishes');
    assert.equal(await page.$eval('.rf .sm', (e) => getComputedStyle(e).webkitLineClamp), '3');
    assert.equal(await page.$('.rf .sm b'), null); // escaped
    await context.close();
  });

  test('a fight with no notes shows just chips', async () => {
    const { context, page } = await open((r) => add(r, 'fight_markers', marker('f1')));
    const t = await rowText(page, 'f1');
    assert.equal(t.sm, null);
    assert.deepEqual(t.chips, ['Add your side', 'Waiting on Sam']);
    await context.close();
  });

  test('chips: to-do chip + Waiting; Add your side is action-styled, Waiting is passive', async () => {
    const { context, page } = await open((r) => {
      add(r, 'fight_markers', marker('f1', { logged_by: UID }));
      add(r, 'fight_notes', fnote('n1', 'f1', UID, 'mine'));
      add(r, 'todos', todo('t1', 'f1', UID, PID, 'Apologize'));
      add(r, 'todos', todo('t2', 'f1', PID, UID, 'Reflect'));
      add(r, 'fight_markers', marker('f2'));
      add(r, 'fight_notes', fnote('n2', 'f2', PID, 'hers'));
    });
    const a = await rowText(page, 'f1');
    assert.deepEqual(a.chips, ['Apologize', 'Waiting on Sam']);
    assert.match(a.cls[0], /\ba\b/); assert.doesNotMatch(a.cls[1], /\ba\b/);
    const b = await rowText(page, 'f2');
    assert.deepEqual(b.chips, ['Add your side']);
    assert.match(b.cls[0], /\ba\b/);
    await context.close();
  });

  test('to-do chip tap opens the to-do; row tap opens the fight', async () => {
    const fill = (r) => {
      add(r, 'fight_markers', marker('f1', { logged_by: UID }));
      add(r, 'fight_notes', fnote('n1', 'f1', UID, 'mine'));
      add(r, 'fight_notes', fnote('n2', 'f1', PID, 'hers'));
      add(r, 'todos', todo('t1', 'f1', UID, PID, 'Apologize'));
    };
    let { context, page } = await open(fill);
    await page.click(".rf .rc.a");
    await page.waitForSelector('[data-a="tcomment:t1"]');
    assert.equal(await page.$('[data-a="notesave"]'), null);
    await context.close();
    ({ context, page } = await open(fill));
    await page.click('.rf .meta');
    await page.waitForSelector('[data-a="notesave"]');
    await context.close();
  });

  test('detail page shows the summary above the notes, only when there is one', async () => {
    const fill = (sum) => (r) => {
      add(r, 'fight_markers', marker('f1', { summary: sum }));
      add(r, 'fight_notes', fnote('n1', 'f1', PID, 'her note'));
    };
    let { context, page } = await open(fill('Sam felt unheard.'));
    await page.click('.rf .meta'); await page.waitForSelector('[data-a="notesave"]');
    assert.equal(await page.$eval('.fsum p', (e) => e.textContent), 'Sam felt unheard.');
    assert.ok(await page.$eval('.fsum', (e) => e.compareDocumentPosition(document.querySelector('.fns')) & Node.DOCUMENT_POSITION_FOLLOWING));
    await context.close();
    ({ context, page } = await open(fill(null)));
    await page.click('.rf .meta'); await page.waitForSelector('[data-a="notesave"]');
    assert.equal(await page.$('.fsum'), null);
    await context.close();
  });
});
