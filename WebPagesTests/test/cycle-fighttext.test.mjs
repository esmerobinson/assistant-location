// "Also over text" on a fight: the box on Log a fight and the edit sheet, the Over text chip, and the box's question (logger only).
// Runs in WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC, e.g. via ~/.claude/bin/cycle-webkit.sh); skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const engines = {};
if (process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC) {
  const pw = await import(process.env.GL_WEBKIT_PW);
  engines.webkit = { launch: (o) => pw.webkit.launch({ ...o, executablePath: process.env.GL_WEBKIT_EXEC }) };
}

const UID = 'u-me', PID = 'u-her', HOUR = 36e5;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const marker = (id, o = {}) => ({ id, couple_id: 'c1', logged_by: UID, at: ago(5), repaired_at: null, hit_self: null, hit_related: null, summary: null, summary_notes_at: null, ...o });
const seed = (fill) => {
  const sh = {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Alex', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Sam', checkin_time: '21:00', hits_self: true }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, fight_ratings: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {}, todo_comments: {}, todo_nudges: {}, challenges: {}, challenge_breaks: {}, challenge_days: {}, challenge_nudges: {} }, cursors: {}, outbox: [],
  };
  fill(sh.rows);
  return { session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } }, ['shared.' + UID]: sh, ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} } };
};

for (const [name, type] of Object.entries(engines)) describe(name, () => {
  let browser;
  before(async () => { browser = await type.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  async function open(fill = () => {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, seed(fill));
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    return { context, page };
  }
  const shared = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')));
  const present = async (page, sel) => (await page.$(sel)) !== null;
  async function openFight(page, id) { await page.click('[data-a="tab:fights"]'); await page.click(`.rf[data-a="openfight:${id}"]`); await page.waitForSelector('.fd'); }

  test('Log a fight: ticking Also over text shows the note field; saving writes text_on and text_note to the marker and its outbox insert', async () => {
    const { context, page } = await open();
    await page.click('[data-a="go:fight"]');
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await present(page, 'textarea[data-d="tnote"]'), false);
    assert.equal((await page.textContent('[data-a="texton"]')).trim(), 'Also over text');
    await page.click('[data-a="texton"]');
    assert.equal((await page.textContent('.lab:has(+ .ta textarea[data-d="tnote"])')).replace(/\s+/g, ' ').trim(), 'About the texts Optional');
    await page.fill('textarea[data-d="tnote"]', "it's in the heart group");
    await page.click('[data-a="fightsave"]');
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_markers).length > 0);
    const sh = await shared(page);
    const [m] = Object.values(sh.rows.fight_markers);
    assert.equal(m.text_on, true);
    assert.equal(m.text_note, "it's in the heart group");
    const ins = sh.outbox.find((o) => o.op === 'insert' && o.table === 'fight_markers');
    assert.equal(ins.row.text_on, true);
    assert.equal(ins.row.text_note, "it's in the heart group");
    await context.close();
  });

  test('Log a fight: unticked saves text_on false and no note, even if a note was typed before unticking', async () => {
    const { context, page } = await open();
    await page.click('[data-a="go:fight"]');
    await page.click('[data-a="texton"]');
    await page.fill('textarea[data-d="tnote"]', 'typed then dropped');
    await page.click('[data-a="texton"]');
    await page.click('[data-a="fightsave"]');
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_markers).length > 0);
    const [m] = Object.values((await shared(page)).rows.fight_markers);
    assert.equal(m.text_on, false);
    assert.equal(m.text_note, null);
    await context.close();
  });

  test('edit sheet: tick + note patches the marker through the outbox, and the fight page shows the Over text chip', async () => {
    const { context, page } = await open((r) => { r.fight_markers.f1 = marker('f1'); });
    await openFight(page, 'f1');
    assert.equal(await page.$$eval('.rcs .rc', (e) => e.some((c) => c.textContent.trim() === 'Over text')), false);
    await page.click('[data-a="fightedit"]');
    await page.click('[data-a="texton"]');
    await page.fill('textarea[data-d="tnote"]', 'went on till Tuesday');
    await page.click('[data-a="fighteditsave"]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_markers.f1.text_on === true);
    const sh = await shared(page);
    assert.equal(sh.rows.fight_markers.f1.text_note, 'went on till Tuesday');
    const patch = sh.outbox.filter((o) => o.op === 'patch' && o.table === 'fight_markers' && o.id === 'f1').reduce((a, o) => ({ ...a, ...o.patch }), {});
    assert.equal(patch.text_on, true);
    assert.equal(patch.text_note, 'went on till Tuesday');
    assert.equal(await page.$$eval('.rcs .rc', (e) => e.some((c) => c.textContent.trim() === 'Over text')), true);
    await context.close();
  });

  test('question: shown to the logger only; answering appends Q/A to text_note via a queued patch and spends the question', async () => {
    const { context, page } = await open((r) => {
      r.fight_markers.f1 = marker('f1', { text_on: true, text_note: 'in the heart group', text_question: 'Which Tuesday do you mean?' });
      r.fight_markers.f2 = marker('f2', { logged_by: PID, text_on: true, text_note: 'hers', text_question: 'Partner must not see this?' });
    });
    await openFight(page, 'f2');
    assert.equal(await present(page, '[data-a="qsave"]'), false);
    assert.doesNotMatch(await page.textContent('body'), /Partner must not see this/);
    await page.click('[data-a="back"]');
    await openFight(page, 'f1');
    const sec = await page.$eval('[data-a="qsave"]', (e) => e.parentElement.textContent.replace(/\s+/g, ' ').trim());
    assert.match(sec, /^QuestionWhich Tuesday do you mean\?/);
    await page.fill('textarea[data-d="qans"]', 'the 4th');
    await page.click('[data-a="qsave"]');
    await page.waitForFunction(() => /A: the 4th/.test(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_markers.f1.text_note));
    const sh = await shared(page);
    assert.equal(sh.rows.fight_markers.f1.text_note, 'in the heart group\n\nQ: Which Tuesday do you mean?\nA: the 4th');
    assert.deepEqual(sh.outbox.filter((o) => o.table === 'fight_markers' && o.op === 'patch').map((o) => Object.keys(o.patch)), [['text_note']]);
    assert.equal(await present(page, '[data-a="qsave"]'), false);
    await context.close();
  });
});
