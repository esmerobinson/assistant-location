// Drafts: text typed on any compose surface survives navigating away and a relaunch, and only a real save clears it.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;

const UID = 'u-me', PID = 'u-her';
const HOUR = 36e5;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const seed = () => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [
      { user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false },
      { user_id: PID, name: 'Her', checkin_time: '21:00', hits_self: true },
    ],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {}, acks: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});
const ack = (id, author, extra) => ({ id, couple_id: 'c1', author_id: author, requested_by: author === UID ? PID : null, item_id: null, title: id, description: null, status: 'done', done_at: ago(2), read_at: null, created_at: ago(3), updated_at: ago(2), deleted_at: null, ...extra });

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(tweak, prefs) {
    const s = seed();
    if (tweak) tweak(s['shared.' + UID]);
    if (prefs) s['priv.' + UID].prefs = prefs;
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
    await page.waitForSelector('.rows .row');
    return { context, page };
  }
  const shared = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')));
  // The store persists on a debounce; wait for it, then read the real localStorage copy.
  const rowsOf = async (page, t) => { await page.waitForTimeout(500); return Object.values((await shared(page)).rows[t]); };

  const drafts = async (page) => { await page.waitForTimeout(300); return page.evaluate(() => JSON.parse(localStorage.getItem('cycle:priv.u-me')).drafts); };
  const fieldVal = (page, f) => page.inputValue('[data-d="' + f + '"]');
  const todo = (id) => ({ id, couple_id: 'c1', owner_id: UID, created_by: UID, item_id: null, fight_marker_id: null, type: 'task', title: 'Stored title', description: null, due_date: null, target: null, period: null, points_earn: 3, points_miss: 3, needs_note: false, tally: 0, done_at: null, edited_at: null, created_at: ago(2), updated_at: ago(2), deleted_at: null });

  test('fight: draft survives back, tab and relaunch; saving clears it', async () => {
    const { context, page } = await open();
    await page.click('[data-a="go:fight"]');
    await page.fill('textarea[data-d="note"]', 'She said');
    await page.click('[data-a="chip:apologize"]'); // a change with no input event, after typing
    await page.click('[data-a="back"]');
    await page.click('[data-a="go:fight"]');
    assert.equal(await fieldVal(page, 'note'), 'She said');
    assert.ok(await page.locator('[data-a="chip:apologize"].on').count(), 'chip restored');
    await page.reload(); await page.waitForSelector('.rows .row');
    await page.click('[data-a="go:fight"]');
    assert.equal(await fieldVal(page, 'note'), 'She said', 'survives a relaunch');
    await page.click('.p2.s2 .save');
    await page.waitForSelector('.rows .row');
    assert.deepEqual(await drafts(page), {});
    await page.click('[data-a="go:fight"]');
    assert.equal(await fieldVal(page, 'note'), '');
    await context.close();
  });

  test('owning up: failed validation keeps the draft; For-partner choice and kind are restored; save clears', async () => {
    const { context, page } = await open();
    await page.click('[data-a="tab:todo"]');
    await page.evaluate(() => document.querySelector('[data-a="addpick"]').click());
    await page.click('[data-a="newtodo:ownup"]');
    await page.click('[data-a="nfor:them"]');
    await page.fill('textarea[data-d="desc"]', 'Only description');
    await page.click('[data-a="savetodo"]');
    assert.ok((await drafts(page))['todo:new'], 'kept when the title is missing');
    await page.click('.bsh [data-a="sheet:close"]');
    await page.evaluate(() => document.querySelector('[data-a="addpick"]').click());
    await page.click('[data-a="newtodo:ownup"]');
    assert.equal(await fieldVal(page, 'desc'), 'Only description');
    assert.ok(await page.locator('[data-a="nfor:them"].on').count(), 'still addressed to the partner');
    assert.ok(await page.locator('[data-a="nkind:ownup"].on').count(), 'still Owning up');
    assert.equal(await page.$('[data-a="nnote"]'), null, 'needs-a-note toggle stays hidden');
    await page.fill('input[data-d="title"]', 'Title');
    await page.click('[data-a="savetodo"]');
    assert.deepEqual(await drafts(page), {});
    const items = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('cycle:shared.')))).rows.items));
    assert.deepEqual([items[0].ask_type, items[0].needs_note], ['ownup', true]);
    await context.close();
  });

  test('new to do: X keeps text and choices; save clears; Habit tap beats a drafted Task', async () => {
    const { context, page } = await open();
    await page.click('[data-a="tab:todo"]');
    await page.evaluate(() => document.querySelector('[data-a="addpick"]').click());
    await page.click('[data-a="newtodo:task"]');
    await page.fill('input[data-d="title"]', 'Buy milk');
    await page.click('[data-a="nfor:me"]');
    await page.click('.bsh [data-a="sheet:close"]');
    await page.evaluate(() => document.querySelector('[data-a="addpick"]').click());
    await page.click('[data-a="newtodo:habit"]');
    assert.equal(await fieldVal(page, 'title'), 'Buy milk');
    assert.ok(await page.locator('.on[data-a="nfor:me"]').count(), 'recipient restored');
    assert.ok(await page.locator('.on[data-a="nkind:habit"]').count(), 'tapped kind wins');
    await page.click('[data-a="savetodo"]');
    assert.deepEqual(await drafts(page), {});
    await context.close();
  });

  test('edit to do: unsaved edit beats the stored row, is keyed per row, and empty discards', async () => {
    const { context, page } = await open((sh) => { sh.rows.todos = { t1: todo('t1') }; });
    await page.click('[data-a="tab:todo"]');
    await page.evaluate(() => document.querySelector('[data-a="tview:t1"]').click());
    await page.fill('textarea[data-d="cmt"]', 'half a comment');
    await page.click('[data-a="back"]');
    await page.evaluate(() => document.querySelector('[data-a="tview:t1"]').click());
    assert.equal(await fieldVal(page, 'cmt'), 'half a comment');
    await page.evaluate(() => document.querySelector('[data-a="etodo:t1"]').click());
    assert.equal(await fieldVal(page, 'title'), 'Stored title', 'no draft: the row');
    await page.fill('input[data-d="title"]', 'Edited title');
    await page.click('.bsh [data-a="sheet:close"]');
    assert.equal(await fieldVal(page, 'cmt'), 'half a comment', 'comment back after the sheet closes');
    await page.evaluate(() => document.querySelector('[data-a="etodo:t1"]').click());
    assert.equal(await fieldVal(page, 'title'), 'Edited title');
    await page.fill('input[data-d="title"]', '');
    assert.equal((await drafts(page))['todo:t1'], undefined, 'emptied fields discard');
    await page.click('.bsh [data-a="sheet:close"]');
    await page.click('[data-a="tcomment:t1"]');
    assert.equal((await rowsOf(page, 'todo_comments')).length, 1);
    assert.deepEqual(await drafts(page), {}, 'sending the comment clears it');
    await context.close();
  });

  test('new nudge keeps a draft until sent', async () => {
    const { context, page } = await open();
    const nav = (a) => page.evaluate((x) => { document.querySelector('[data-a="' + x + '"]').click(); }, a);
    await page.click('[data-a="tab:todo"]'); await page.click('[data-a="todoseg:rem"]');
    await nav('nudgenew');
    await page.fill('textarea[data-d="nbody"]', 'Remember this');
    await page.click('[data-a="back"]');
    await nav('nudgenew');
    assert.equal(await fieldVal(page, 'nbody'), 'Remember this');
    await page.click('[data-a="nudgenewsend"]');
    assert.deepEqual(await drafts(page), {});
    await context.close();
  });
  test('a draft belongs to one row, never another', async () => {
    const { context, page } = await open((sh) => { sh.rows.todos = { t1: todo('t1'), t2: todo('t2') }; });
    await page.click('[data-a="tab:todo"]');
    await page.evaluate(() => document.querySelector('[data-a="tview:t1"]').click());
    await page.fill('textarea[data-d="cmt"]', 'for t1');
    await page.click('[data-a="back"]');
    await page.evaluate(() => document.querySelector('[data-a="tview:t2"]').click());
    assert.equal(await fieldVal(page, 'cmt'), '', 't2 must not show the t1 comment');
    await context.close();
  });

  test('nothing typed writes no draft, and auth fields never reach disk', async () => {
    const { context, page } = await open();
    await page.click('[data-a="go:fight"]');
    await page.click('[data-a="back"]');
    assert.deepEqual(await drafts(page), {});
    await context.close();
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(() => { window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' }; });
    await ctx2.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await ctx2.route('https://x.test/**', (route) => route.abort());
    const p2 = await ctx2.newPage();
    await p2.goto(URL_);
    await p2.fill('input[data-d="password"]', 'hunter2');
    await p2.waitForTimeout(300);
    assert.ok(!JSON.stringify(await p2.evaluate(() => ({ ...localStorage }))).includes('hunter2'));
    await ctx2.close();
  });
});
