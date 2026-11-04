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
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, fight_ratings: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {}, todo_comments: {}, todo_nudges: {}, challenges: {}, challenge_breaks: {}, challenge_days: {}, challenge_nudges: {} }, cursors: {}, outbox: [],
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

  // ---- story beats, analysis cards, hide, ratings, chart ----
  const BEATS = [{ lead: 'Dishes', text: 'FIRST-BEAT text.', after: [] }, { lead: 'Tone', text: 'SECOND-BEAT text.', after: ['a1'] }];
  const anote = (id, fm, author, body, extra = {}) => ({ ...fnote(id, fm, author, body), kind: 'analysis', linked_fight_ids: [], ...extra });
  const beatFill = (o = {}, more = () => {}) => (r) => {
    add(r, 'fight_markers', marker('f1', { summary: 'S.', summary_beats: BEATS, summary_notes_at: ago(3), gaps: { [UID]: 'MINE-GAP add more.' }, ...o }));
    add(r, 'fight_notes', fnote('n1', 'f1', PID, 'her raw note'));
    add(r, 'fight_notes', fnote('n2', 'f1', UID, 'my raw note'));
    add(r, 'fight_notes', anote('a1', 'f1', PID, 'Line one verbatim.\nLine two verbatim.', { linked_fight_ids: ['f0'] }));
    add(r, 'fight_markers', marker('f0', { at: new Date(Date.now() - 9 * 24 * HOUR).toISOString() }));
    more(r);
  };
  const detail = async (fill) => { const h = await open(fill); await h.page.click('.rf[data-a="openfight:f1"] .meta'); await h.page.waitForSelector('[data-a="notesave"]'); return h; };
  // The outbox is persisted asynchronously after a write; wait until `n` ops for `table` are stored, then return them.
  const outbox = async (page, table, n) => { await page.waitForFunction(([t, k]) => JSON.parse(localStorage.getItem('cycle:shared.u-me')).outbox.filter((o) => o.table === t).length >= k, [table, n]); return page.evaluate((t) => JSON.parse(localStorage.getItem('cycle:shared.u-me')).outbox.filter((o) => o.table === t), table); };
  const order = (page, sels) => page.evaluate((ss) => { const els = ss.map((q) => document.querySelector(q)); return els.every(Boolean) && els.every((e, i) => i === 0 || !!(els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)); }, sels);

  test('detail: beats in order, analysis card right after its beat, Missing, collapsed notes row, Add more', async () => {
    const { context, page } = await detail(beatFill());
    assert.deepEqual(await page.$$eval('.bt', (e) => e.map((x) => x.textContent)), ['Dishes. FIRST-BEAT text.', 'Tone. SECOND-BEAT text.']);
    const card = await page.$eval('.pcard', (e) => ({ who: e.querySelector('.who').textContent, ps: [...e.querySelectorAll('p:not(.who)')].map((p) => p.textContent), prev: e.previousElementSibling.textContent }));
    assert.equal(card.prev, 'Tone. SECOND-BEAT text.');
    assert.match(card.who, /^Sam/); assert.deepEqual(card.ps, ['Line one verbatim.', 'Line two verbatim.']);
    assert.ok(await order(page, ['.bt', '.pcard', '.fgap', '.srow[data-a="notestoggle"]', '[data-a="notesave"]']));
    assert.match(await page.$eval('.srow[data-a="notestoggle"]', (e) => e.textContent), /3 notes/);
    assert.equal(await page.$('.fns'), null, 'raw notes collapsed');
    await page.click('.srow[data-a="notestoggle"]');
    const list = await page.$eval('.fns', (e) => e.textContent);
    assert.match(list, /her raw note/); assert.match(list, /Analysis/);
    await context.close();
  });

  test('detail: an unplaced analysis goes after the last beat; a deleted one never shows', async () => {
    const { context, page } = await detail(beatFill({ summary_beats: [BEATS[0]] }, (r) => add(r, 'fight_notes', anote('a2', 'f1', UID, 'gone one', { deleted_at: ago(1) }))));
    assert.equal(await page.$$eval('.pcard', (e) => e.length), 1);
    assert.equal(await page.$eval('.pcard', (e) => e.previousElementSibling.textContent), 'Dishes. FIRST-BEAT text.');
    assert.doesNotMatch(await page.$eval('.fd', (e) => e.textContent), /gone one/);
    await context.close();
  });

  test('detail: the link chip opens the earlier fight', async () => {
    const { context, page } = await detail(beatFill());
    assert.match(await page.$eval('.pcard .lk', (e) => e.textContent), /^Also \w{3} \d+ \w{3}/i);
    await page.click('.pcard .lk');
    await page.waitForFunction(() => /Fight/.test(document.querySelector('h2').textContent) && !document.querySelector('.pcard'));
    await context.close();
  });

  test('detail: hide swaps beats for the raw notes, Missing stays, show brings them back', async () => {
    const { context, page } = await detail(beatFill());
    await page.click('[data-a="sumhide"]');
    await page.waitForSelector('.fns');
    assert.equal(await page.$('.bt'), null);
    assert.match(await page.$eval('.fgap', (e) => e.textContent), /MINE-GAP/);
    assert.match(await page.$eval('.fns', (e) => e.textContent), /her raw note/);
    const op = (await outbox(page, 'fight_markers', 1)).at(-1);
    assert.deepEqual([op.op, Object.keys(op.patch)], ['patch', ['summary_hidden_at']]);
    await page.click('[data-a="sumshow"]'); await page.waitForSelector('.bt');
    await context.close();
  });

  test('detail: only my own gap shows, and it comes after the summary and before the notes row', async () => {
    const { context, page } = await detail(beatFill({ gaps: { [UID]: 'MINE-GAP add more.', [PID]: 'HERS-GAP' } }));
    assert.doesNotMatch(await page.$eval('.fd', (e) => e.innerHTML), /HERS-GAP/);
    assert.ok(await order(page, ['.bt', '.fgap', '.srow']));
    await context.close();
  });

  test('detail: Note|Analysis choice saves an analysis with the picked earlier fight; plain note stays a note', async () => {
    const { context, page } = await detail(beatFill());
    await page.click('[data-a="fnkind:analysis"]');
    await page.click('[data-a="nlink:f0"]');
    await page.fill('textarea[data-d="more"]', 'My analysis text');
    await page.click('[data-a="notesave"]');
    const row = (await outbox(page, 'fight_notes', 1)).at(-1).row;
    assert.equal(row.kind, 'analysis'); assert.deepEqual(row.linked_fight_ids, ['f0']); assert.equal(row.body, 'My analysis text');
    await page.click('[data-a="fnkind:note"]'); await page.fill('textarea[data-d="more"]', 'Plain'); await page.click('[data-a="notesave"]');
    const plain = (await outbox(page, 'fight_notes', 2)).at(-1).row;
    assert.equal(plain.kind, undefined); assert.equal(plain.linked_fight_ids, undefined);
    await context.close();
  });

  test('detail: the author can delete their analysis card, the other person cannot', async () => {
    const { context, page } = await detail(beatFill({}, (r) => add(r, 'fight_notes', anote('a3', 'f1', UID, 'MY-ANALYSIS'))));
    const dels = await page.$$eval('.pcard', (c) => c.map((x) => [x.textContent.includes('Delete'), x.textContent.includes('MY-ANALYSIS')]));
    assert.deepEqual(dels.sort(), [[false, false], [true, true]].sort());
    await context.close();
  });

  test('detail: the intensity control shows only my own rating', async () => {
    const { context, page } = await detail(beatFill({}, (r) => { add(r, 'fight_ratings', { id: 'f1:u-her', fight_marker_id: 'f1', user_id: PID, intensity: 5 }); }));
    assert.equal(await page.$('.arrows .sel'), null, 'partner\'s 5 is not shown as mine');
    await context.close();
    const h = await detail(beatFill({}, (r) => { add(r, 'fight_ratings', { id: 'f1:u-me', fight_marker_id: 'f1', user_id: UID, intensity: 2 }); }));
    assert.match(await h.page.$eval('.arrows .sel', (e) => e.textContent), /2/);
    await h.page.click('.arrows [data-a="fightint:4"]');
    const op = (await outbox(h.page, 'fight_ratings', 1)).at(-1);
    assert.deepEqual([op.op, op.table, op.row.intensity, op.row.user_id], ['upsert', 'fight_ratings', 4, 'u-me']);
    await h.context.close();
  });

  // chart: x of a day index in page pixels
  const dayX = (page, idx, n = 14) => page.$eval('.fcv svg', (s, [i, nn]) => { const r = s.getBoundingClientRect(), pw = 342 - 26 - 8; return { x: r.left + (26 + (i + 0.5) * pw / nn) / 342 * r.width, y: r.top + r.height * 0.5 }; }, [idx, n]);
  const drag = async (page, i1, i2) => { const a = await dayX(page, i1), b = await dayX(page, i2); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, a.y); await page.mouse.move(b.x, b.y); await page.mouse.up(); };
  const chartFill = (r) => {
    add(r, 'fight_markers', marker('t1', { at: ago(0.01) }));
    add(r, 'fight_markers', marker('t2', { at: ago(0.02), logged_by: UID }));
    // Midday in the couple's tz (America/New_York), 8 calendar days back. "now - 8×24h" fell on the next day late in the
    // evening across the 1 Nov DST change, moving the fight off index 5 and failing the tap test.
    const nyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()), old = new Date(nyToday + 'T17:00:00Z');
    old.setUTCDate(old.getUTCDate() - 8);
    add(r, 'fight_markers', marker('old', { at: old.toISOString() }));
    add(r, 'fight_ratings', { id: 'old:u-her', fight_marker_id: 'old', user_id: PID, intensity: 4 });
    add(r, 'fight_ratings', { id: 'old:u-me', fight_marker_id: 'old', user_id: UID, intensity: 2 });
  };

  test('chart: no range chips; legend says Daily total and 7-day avg', async () => {
    const { context, page } = await open(chartFill);
    assert.equal(await page.$('[data-a^="frange"]'), null);
    assert.match(await page.$eval('.leg', (e) => e.textContent), /Daily total.*7-day avg/);
    assert.equal(await page.$$eval('.zoomchart .dot', (e) => e.length), 2, 'one dot per day with fights');
    await context.close();
  });

  test('chart: dragging 3+ days zooms and filters the list; the chip resets', async () => {
    const { context, page } = await open(chartFill);
    assert.equal(await page.$$eval('.rf', (e) => e.length), 3);
    await drag(page, 4, 6); // the 8-days-ago fight sits at index 5 of 14
    await page.waitForSelector('.zc');
    assert.deepEqual(await page.$$eval('.rf', (e) => e.map((x) => x.dataset.a)), ['openfight:old']);
    await page.click('.zc'); await page.waitForFunction(() => !document.querySelector('.zc'));
    assert.equal(await page.$$eval('.rf', (e) => e.length), 3);
    await context.close();
  });

  test('chart: a short drag does not zoom (tooltip instead)', async () => {
    const { context, page } = await open(chartFill);
    await drag(page, 5, 6);
    assert.equal(await page.$('.zc'), null);
    assert.equal(await page.$$eval('.rf', (e) => e.length), 3);
    await context.close();
  });

  // The real-iPhone bug: a vertical swipe starting on the chart didn't scroll the page, because pointerdown swapped the SVG
  // under the finger. Playwright can't show native iOS scroll, so this pins the cause: the SVG must survive pointerdown.
  test('chart: touching the chart leaves its SVG in place, and a vertical move neither zooms nor redraws', async () => {
    const { context, page } = await open(chartFill);
    const a = await dayX(page, 4);
    await page.$eval('.fcv svg', (s) => { s.dataset.orig = '1'; });
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    assert.ok(await page.$('.fcv svg[data-orig]'), 'pointerdown must not replace the SVG under the finger');
    await page.mouse.move(a.x + 2, a.y + 40); await page.mouse.move(a.x + 3, a.y + 80);
    assert.ok(await page.$('.fcv svg[data-orig]'), 'a vertical move must not redraw the chart');
    await page.mouse.up();
    assert.equal(await page.$('.zc'), null);
    await context.close();
  });

  test('chart: tapping a day shows count and total; unrated says Unrated; a rated day does not', async () => {
    const { context, page } = await open(chartFill);
    let p = await dayX(page, 13); await page.mouse.click(p.x, p.y);
    const t1 = await page.$eval('.zoomchart .tipt', (e) => e.textContent);
    assert.match(t1, /2 fights · Total 2 · Unrated$/);
    p = await dayX(page, 5); await page.mouse.click(p.x, p.y);
    const t2 = await page.$eval('.zoomchart .tipt', (e) => e.textContent);
    assert.match(t2, /1 fight · Total 2$/, 'my 2 beats her 4');
    await context.close();
  });


  const GAPS = { [UID]: 'MINE-GAP add what you said.', [PID]: 'HERS-GAP add more.' };
  const gapFill = (o = {}, mine = true) => (r) => {
    add(r, 'fight_markers', marker('f1', { summary: 'S.', summary_notes_at: ago(3), gaps: GAPS, ...o }));
    add(r, 'fight_notes', fnote('n1', 'f1', PID, 'her note'));
    if (mine) add(r, 'fight_notes', fnote('n2', 'f1', UID, 'my note'));
  };
  const gapView = async (fill) => {
    const { context, page } = await open(fill);
    const chips = (await rowText(page, 'f1')).chips;
    await page.click('.rf .meta'); await page.waitForSelector('[data-a="notesave"]');
    const html = await page.$eval('.fd', (e) => e.innerHTML);
    const gap = await page.$('.fgap');
    const out = { chips, html, gap: gap ? await gap.innerText() : null, above: gap ? await page.$eval('.fgap', (e) => !!(e.compareDocumentPosition(document.querySelector('[data-a="notesave"]')) & Node.DOCUMENT_POSITION_FOLLOWING)) : null };
    await context.close();
    return out;
  };

  test('gaps: Add details chip on the row and a Missing section with only my message, above the note input', async () => {
    const v = await gapView(gapFill());
    assert.deepEqual(v.chips, ['Add details']);
    assert.match(v.gap, /^MISSING\s+MINE-GAP add what you said\.\s*$/i);
    assert.ok(v.above); assert.doesNotMatch(v.html, /HERS-GAP/);
  });

  test('gaps: with no note from me the chip stays Add your side (no Add details) and Missing still shows', async () => {
    const v = await gapView(gapFill({}, false));
    assert.deepEqual(v.chips, ['Add your side']);
    assert.match(v.gap, /MINE-GAP/);
  });

  test('gaps: nothing for null gaps, empty message, repaired, or my note newer than the evaluation', async () => {
    for (const o of [{ gaps: null }, { gaps: { [UID]: '' } }, { gaps: {} }, { repaired_at: ago(1) }, { summary_notes_at: ago(6) }]) {
      const v = await gapView(gapFill(o));
      assert.equal(v.gap, null, JSON.stringify(o)); assert.doesNotMatch(v.chips.join(), /Add details/, JSON.stringify(o));
    }
  });

  test('gaps: the message is escaped', async () => {
    const v = await gapView(gapFill({ gaps: { [UID]: '<i>x</i> & y' } }));
    assert.match(v.html, /&lt;i&gt;x&lt;\/i&gt; &amp; y/);
  });
});
