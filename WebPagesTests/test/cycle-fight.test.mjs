// Log a fight: shared "What happened" note, held asks to the partner, role-aware hit question, and the shared fight detail.
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

const UID = 'u-me', PID = 'u-her';
const HOUR = 36e5;
const seed = (me, her, hitsSelf) => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [
      { user_id: UID, name: me, checkin_time: '21:00', hits_self: hitsSelf },
      { user_id: PID, name: her, checkin_time: '21:00', hits_self: !hitsSelf },
    ],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});
// Partner-logged fight with one note from her, and no note from me yet.
const partnerFight = (sh) => {
  sh.rows.fight_markers.fp = { id: 'fp', couple_id: 'c1', logged_by: PID, at: new Date(Date.now() - 2 * HOUR).toISOString(), repaired_at: null, hit_self: null, hit_related: null };
  sh.rows.fight_notes.n1 = { id: 'n1', couple_id: 'c1', fight_marker_id: 'fp', author_id: PID, body: 'She says it started with the dishes', created_at: new Date(Date.now() - 2 * HOUR).toISOString() };
  return sh;
};

for (const [name, type] of Object.entries(engines)) describe(name, () => {
  let browser;
  before(async () => { browser = await type.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  // opts.who: 'oliver' (default) logs "Did she hit herself?"; 'esme' has hits_self on her member row.
  async function open({ who = 'oliver', tweak, fight = true } = {}) {
    const s = who === 'esme' ? seed('Esme', 'Oliver', true) : seed('Me', 'Her', false);
    if (tweak) tweak(s['shared.' + UID]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    // Backend calls fail like offline; the store treats that as retry-later.
    await context.route('https://x.test/**', (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    if (fight) {
      await page.click('[data-a="go:fight"]');
      await page.waitForSelector('[data-a="fightsave"]');
    }
    return { context, page };
  }
  const on = (page, a) => page.$eval(`[data-a="${a}"]`, (e) => e.classList.contains('on'));
  const present = async (page, a) => (await page.$(`[data-a="${a}"]`)) !== null;
  const shared = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')));
  // Read the real persistence path (localStorage), waiting for the debounced write.
  async function save(page) {
    await page.click('[data-a="fightsave"]');
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_markers).length > 0
      && JSON.parse(localStorage.getItem('cycle:priv.u-me')).fights.length > 0);
    const { markers, fights } = await page.evaluate(() => ({
      markers: Object.values(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_markers),
      fights: JSON.parse(localStorage.getItem('cycle:priv.u-me')).fights,
    }));
    assert.equal(markers.length, 1);
    assert.equal(fights.length, 1);
    assert.equal(fights[0].id, markers[0].id);
    assert.equal('hitSelf' in fights[0], false);
    assert.equal('hitRelated' in fights[0], false);
    return markers;
  }
  async function pointsText(page) {
    await page.click('[data-a="tab:progress"]'); await page.click('[data-a="go:points"]');
    await page.waitForSelector('.ledger', { state: 'attached' });
    return page.$$eval('.ledger .ln', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  }
  async function history(page) {
    await page.click('[data-a="tab:home"]'); // Home carries the gear; Points/other screens do not
    await page.click('[data-a="go:more"]');
    await page.click('[data-a="go:cycle"]');
    await page.waitForSelector('.rcs', { state: 'attached' });
    return page.$$eval('.rcs .rc', (els) => els.map((e) => e.textContent.trim()));
  }
  const notesText = (page) => page.$$eval('.fn', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));

  test('not-related checkbox is hidden until hit is Yes', async () => {
    const { context, page } = await open();
    assert.equal(await present(page, 'hitnot'), false);
    await page.click('[data-a="yn:hit:no"]');
    assert.equal(await present(page, 'hitnot'), false);
    await page.click('[data-a="yn:hit:yes"]');
    assert.equal(await present(page, 'hitnot'), true);
    assert.equal(await on(page, 'hitnot'), false);
    assert.equal((await page.textContent('[data-a="hitnot"]')).trim(), 'Click here if it was not related to you');
    assert.ok((await page.$eval('[data-a="hitnot"]', (e) => e.getBoundingClientRect().height)) >= 44, 'tap target >= 44px');
    await context.close();
  });

  test('yes + checked saves hit_related false and shows "not related to <name>"', async () => {
    const { context, page } = await open();
    await page.click('[data-a="yn:hit:yes"]');
    await page.click('[data-a="hitnot"]');
    assert.equal(await on(page, 'hitnot'), true);
    const fights = await save(page);
    assert.equal(fights[0].hit_self, true);
    assert.equal(fights[0].hit_related, false);
    assert.ok((await pointsText(page)).includes('\u22125Fight \u00b7 Hit herself, not related to Me'), 'Points Fight line');
    assert.ok((await history(page)).includes('Hit herself, not related to me'));
    await context.close();
  });

  test('yes + 2 times saves hit_count 2 and Points shows two Hit lines (-10, -5)', async () => {
    const { context, page } = await open();
    assert.equal(await present(page, 'hitn:1'), false);
    await page.click('[data-a="yn:hit:yes"]');
    assert.equal((await page.textContent('.frow .lab0')).trim(), 'How many times?');
    assert.equal((await page.textContent('.stp b')).trim(), '1');
    await page.click('[data-a="hitn:1"]');
    assert.equal((await page.textContent('.stp b')).trim(), '2');
    const markers = await save(page);
    assert.equal(markers[0].hit_self, true);
    assert.equal(markers[0].hit_count, 2);
    const lines = await pointsText(page);
    assert.deepEqual(lines.filter((t) => /Hit$/.test(t)).sort(), ['\u221210Hit', '\u22125Hit']);
    await context.close();
  });

  test('minus from 1 gives .5, saves hit_count 0.5, and Points shows one light Hit line', async () => {
    const { context, page } = await open();
    await page.click('[data-a="yn:hit:yes"]');
    await page.click('[data-a="hitn:-1"]');
    assert.equal((await page.textContent('.stp b')).trim(), '.5');
    await page.click('[data-a="hitn:-1"]');
    assert.equal((await page.textContent('.stp b')).trim(), '.5', 'floor of .5');
    await page.click('[data-a="hitn:1"]');
    assert.equal((await page.textContent('.stp b')).trim(), '1');
    await page.click('[data-a="hitn:-1"]');
    const markers = await save(page);
    assert.equal(markers[0].hit_count, 0.5);
    assert.deepEqual((await pointsText(page)).filter((t) => /Hit/.test(t) && !/herself/.test(t)), ['\u22125Hit \u00b7 Light']);
    await context.close();
  });

  test('What happened grows to fit long text and shrinks back', async () => {
    const { context, page } = await open();
    const box = '[data-d="note"]';
    const h0 = await page.$eval(box, (t) => t.offsetHeight);
    await page.fill(box, 'line\n'.repeat(30));
    const m = await page.$eval(box, (t) => ({ h: t.offsetHeight, sh: t.scrollHeight }));
    assert.ok(m.h > h0 * 2, `grew: ${h0} -> ${m.h}`);
    assert.ok(m.sh <= m.h, `no inner scroll: ${m.sh} <= ${m.h}`);
    await page.click('[data-a="yn:hit:yes"]'); // re-render keeps the fitted height
    assert.equal(await page.$eval(box, (t) => t.offsetHeight), m.h);
    await page.fill(box, '');
    assert.equal(await page.$eval(box, (t) => t.offsetHeight), h0);
    await context.close();
  });

  test('no / unanswered saves hit_count null', async () => {
    const { context, page } = await open();
    await page.click('[data-a="yn:hit:yes"]');
    await page.click('[data-a="hitn:1"]');
    await page.click('[data-a="yn:hit:no"]');
    assert.equal(await present(page, 'hitn:1'), false);
    const markers = await save(page);
    assert.equal(markers[0].hit_self, false);
    assert.equal(markers[0].hit_count, null);
    await context.close();
  });

  test('yes + unchecked (or checked then unchecked) saves hit_related null, plain "Hit herself"', async () => {
    const { context, page } = await open();
    await page.click('[data-a="yn:hit:yes"]');
    await page.click('[data-a="hitnot"]');
    await page.click('[data-a="hitnot"]');
    assert.equal(await on(page, 'hitnot'), false);
    const fights = await save(page);
    assert.equal(fights[0].hit_self, true);
    assert.equal(fights[0].hit_related, null);
    assert.ok((await pointsText(page)).includes('\u22125Fight \u00b7 Hit herself'), 'Points Fight line');
    assert.ok((await history(page)).includes('Hit herself'));
    await context.close();
  });

  test('checked then hit flipped to No saves hit_related null and hides the checkbox', async () => {
    const { context, page } = await open();
    await page.click('[data-a="yn:hit:yes"]');
    await page.click('[data-a="hitnot"]');
    await page.click('[data-a="yn:hit:no"]');
    assert.equal(await present(page, 'hitnot'), false);
    const fights = await save(page);
    assert.equal(fights[0].hit_self, false);
    assert.equal(fights[0].hit_related, null);
    assert.deepEqual((await history(page)).filter((t) => /Hit herself/.test(t)), []);
    await context.close();
  });

  test('untouched saves both null', async () => {
    const { context, page } = await open();
    const fights = await save(page);
    assert.equal(fights[0].hit_self, null);
    assert.equal(fights[0].hit_related, null);
    await context.close();
  });

  test('tapping the selected chip clears it', async () => {
    const { context, page } = await open();
    await page.click('[data-a="yn:hit:yes"]');
    assert.equal(await on(page, 'yn:hit:yes'), true);
    assert.equal(await present(page, 'hitnot'), true);
    await page.click('[data-a="yn:hit:yes"]');
    assert.equal(await on(page, 'yn:hit:yes'), false);
    assert.equal(await on(page, 'yn:hit:no'), false);
    assert.equal(await present(page, 'hitnot'), false);
    const fights = await save(page);
    assert.equal(fights[0].hit_self, null);
    await context.close();
  });

  test('partner-logged marker shows "not related to <partner>" on Points', async () => {
    const { context, page } = await open();
    // pagehide now flushes the page's own state over storage; stop that (S.loaded = false, in the same
    // evaluate as the seed so no pending debounced persist can overwrite the row) so it survives the reload.
    await page.evaluate(([pid]) => {
      CycleStore.S.loaded = false;
      const k = 'cycle:shared.u-me', sh = JSON.parse(localStorage.getItem(k));
      sh.rows.fight_markers.fp = { id: 'fp', couple_id: 'c1', logged_by: pid, at: new Date(Date.now() - 36e5).toISOString(), repaired_at: null, hit_self: true, hit_related: false };
      localStorage.setItem(k, JSON.stringify(sh));
    }, [PID]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok((await pointsText(page)).includes('\u22125Fight · Hit herself, not related to Her'), 'Points Fight line');
    await context.close();
  });


  test('Vent, Rewrite, About and the Share/Keep private pair are gone; one Save pill and a "What happened" box', async () => {
    const { context, page } = await open();
    assert.equal(await page.$('textarea[data-d="vent"]'), null);
    assert.equal(await page.$('input[data-d="about"]'), null);
    for (const a of ['rewrite', 'fightshare']) assert.equal(await present(page, a), false, a);
    assert.equal(await page.$('.pair'), null);
    assert.equal(await page.locator('text=/Vent|Rewrite|Keep private|Share with/').count(), 0);
    assert.equal(await page.locator('[data-a="fightsave"]').count(), 1);
    assert.equal((await page.textContent('[data-a="fightsave"]')).trim(), 'Save');
    assert.deepEqual(await page.$$eval('main .lab', (els) => els.map((e) => e.textContent.trim())), ['Intensity', 'Did she hit herself?', 'What happened', 'Ask Her to']);
    assert.equal(await page.$$eval('main .tag', (els) => els.length), 0, 'no tags');
    assert.equal(await page.$eval('textarea[data-d="note"]', (e) => e.rows >= 1), true);
    await context.close();
  });

  test('Save inserts the marker and a shared first note, queued for sync, with only intensity kept on the phone', async () => {
    const { context, page } = await open();
    await page.fill('textarea[data-d="note"]', '  Line one\nLine two  ');
    await page.click('[data-a="int:4"]');
    const [mk] = await save(page);
    const sh = await shared(page);
    const notes = Object.values(sh.rows.fight_notes);
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0].body, notes[0].author_id, notes[0].fight_marker_id, notes[0].couple_id], ['Line one\nLine two', UID, mk.id, 'c1']);
    assert.ok(sh.outbox.some((o) => o.table === 'fight_notes' && o.op === 'insert' && o.row.body === 'Line one\nLine two'), 'queued in the outbox');
    assert.ok(sh.outbox.findIndex((o) => o.table === 'fight_markers') < sh.outbox.findIndex((o) => o.table === 'fight_notes'), 'marker is sent before its note');
    const priv = await page.evaluate(() => JSON.parse(localStorage.getItem('cycle:priv.u-me')).fights[0]);
    assert.deepEqual(Object.keys(priv).sort(), ['at', 'id', 'intensity', 'logged_at']);
    assert.equal(priv.intensity, 4);
    assert.equal(Object.keys(sh.rows.items).length, 0, 'no truth/rewrite item');
    await context.close();
  });

  test('When defaults to now; a picked date and time sets the marker, the phone copy and the first note', async () => {
    const { context, page } = await open();
    const before = Date.now();
    assert.match((await page.textContent('.wh label.pick:last-of-type .pv')).trim(), /^\d{1,2}:\d\d (am|pm)$/);
    await page.fill('textarea[data-d="note"]', 'Earlier one');
    await page.fill('input[data-d="whenD"]', '2026-10-20');
    await page.fill('input[data-d="whenT"]', '14:30');
    assert.deepEqual(await page.$$eval('.wh .pv', (els) => els.map((e) => e.textContent.trim())), ['Tue 20 Oct', '2:30 pm']);
    const [mk] = await save(page);
    const want = Date.parse('2026-10-20T18:30:00Z'); // 2:30 pm in New York (EDT)
    assert.equal(Date.parse(mk.at), want);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cycle:priv.u-me')).fights[0].at), want);
    assert.equal(Date.parse(Object.values((await shared(page)).rows.fight_notes)[0].created_at), want);
    assert.ok(before > want);
    await context.close();
  });

  test('untouched When saves now; a time later than now clamps to now', async () => {
    const { context, page } = await open();
    const t0 = Date.now();
    await page.fill('input[data-d="whenT"]', '23:59');
    const [mk] = await save(page);
    const at = Date.parse(mk.at);
    assert.ok(at >= t0 - 60e3 && at <= Date.now(), 'at is now, not the future pick');
    await context.close();
  });

  test('an empty note inserts no fight_notes row', async () => {
    const { context, page } = await open();
    await page.fill('textarea[data-d="note"]', '   ');
    await save(page);
    assert.equal(Object.keys((await shared(page)).rows.fight_notes).length, 0);
    await context.close();
  });

  test('chips send held asks to the partner, linked to the fight; blank Custom sends nothing', async () => {
    const { context, page } = await open();
    await page.click('[data-a="chip:apologize"]');
    await page.click('[data-a="chip:reflect"]');
    await page.click('[data-a="chip:custom"]');
    await page.fill('input[data-d="customTitle"]', 'Make tea');
    const [mk] = await save(page);
    const sh = await shared(page);
    const items = Object.values(sh.rows.items).sort((a, b) => a.body.localeCompare(b.body));
    assert.deepEqual(items.map((i) => i.body), ['Apologize', 'Make tea', 'Reflect']);
    for (const i of items) {
      assert.deepEqual([i.kind, i.origin, i.fight_marker_id, i.recipient_id, i.sender_id, i.status], ['ask', 'fight', mk.id, PID, UID, 'held'], i.body);
      assert.ok(Date.parse(i.held_until) > Date.now() + 50 * 60000, 'ask hold applies');
    }
    assert.deepEqual(items.map((i) => i.response_type), ['apologize', 'custom', 'reflect']);
    assert.equal(Object.keys(sh.rows.todos).length, 0, 'nothing reaches the partner\'s to do until the hold ends');
    await context.close();
    const b = await open();
    await b.page.click('[data-a="chip:custom"]');
    await save(b.page);
    assert.equal(Object.keys((await shared(b.page)).rows.items).length, 0);
    await b.context.close();
  });

  test('Esme sees the first-person hit question and "not related to <partner>"; Oliver keeps his wording', async () => {
    const e = await open({ who: 'esme' });
    assert.equal((await e.page.textContent('main section:nth-of-type(2) .lab')).trim(), 'Did you hit yourself?');
    await e.page.click('[data-a="yn:hit:yes"]');
    assert.equal((await e.page.textContent('[data-a="hitnot"]')).trim(), 'Click here if it was not related to Oliver');
    assert.equal((await e.page.textContent('main section:last-of-type .lab')).trim(), 'Ask Oliver to');
    await e.page.click('[data-a="hitnot"]');
    const [mk] = await save(e.page);
    assert.deepEqual([mk.hit_self, mk.hit_related], [true, false]); // stored semantics unchanged
    await e.context.close();
    const o = await open();
    assert.equal((await o.page.textContent('main section:nth-of-type(2) .lab')).trim(), 'Did she hit herself?');
    await o.page.click('[data-a="yn:hit:yes"]');
    assert.equal((await o.page.textContent('[data-a="hitnot"]')).trim(), 'Click here if it was not related to you');
    await o.context.close();
  });

  test('fight detail: both notes in time order with author and time; the logger can add more', async () => {
    const { context, page } = await open({ fight: false, tweak: (sh) => {
      partnerFight(sh);
      sh.rows.fight_notes.n0 = { ...sh.rows.fight_notes.n1, id: 'n0', author_id: UID, body: 'Mine, earlier', created_at: new Date(Date.now() - 3 * HOUR).toISOString() };
    } });
    // reachable from the Points Fight line
    await page.click('[data-a="tab:progress"]'); await page.click('[data-a="go:points"]');
    await page.click('.ln[data-a="openfight:fp"]');
    await page.waitForSelector('.fn');
    const t = await notesText(page);
    assert.equal(t.length, 2);
    assert.match(t[0], /^Me .*Mine, earlier$/);
    assert.match(t[1], /^Her .*\d:\d\d (am|pm)She says it started with the dishes$/);
    assert.equal((await page.textContent('main section:last-of-type .lab')).trim(), 'Add more');
    await page.fill('textarea[data-d="more"]', 'Later thought');
    await page.click('[data-a="notesave"]');
    await page.waitForFunction(() => document.querySelectorAll('.fn').length === 3);
    assert.match((await notesText(page))[2], /^Me .*Later thought$/);
    assert.equal(await page.$eval('textarea[data-d="more"]', (e) => e.value), '', 'composer clears');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')).outbox.length > 0);
    const sh = await shared(page);
    assert.ok(sh.outbox.some((o) => o.table === 'fight_notes' && o.row.body === 'Later thought' && o.row.author_id === UID));
    await context.close();
  });

  test('Add more with a picked time files the note at that time, in order', async () => {
    const { context, page } = await open({ fight: false, tweak: partnerFight });
    await page.click('[data-a="tab:progress"]'); await page.click('[data-a="go:points"]');
    await page.click('.ln[data-a="openfight:fp"]');
    await page.waitForSelector('.fn');
    await page.fill('textarea[data-d="more"]', 'Before hers');
    await page.fill('input[data-d="mwD"]', '2026-10-20');
    await page.fill('input[data-d="mwT"]', '09:05');
    await page.click('[data-a="notesave"]');
    await page.waitForFunction(() => document.querySelectorAll('.fn').length === 2);
    const t = await notesText(page);
    assert.match(t[0], /^Me .*Tue 20 Oct .*9:05 amBefore hers$/);
    assert.match(t[1], /She says it started with the dishes$/);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')).outbox.some((o) => o.table === 'fight_notes'));
    const n = (await shared(page)).outbox.find((o) => o.table === 'fight_notes').row;
    assert.equal(Date.parse(n.created_at), Date.parse('2026-10-20T13:05:00Z'));
    assert.equal(await page.$eval('input[data-d="mwT"]', (e) => e.value.length), 5, 'picker resets to now');
    assert.notEqual(await page.$eval('input[data-d="mwD"]', (e) => e.value), '2026-10-20');
    await context.close();
  });

  test('the logger reaches the detail from Cycle (recent list), where old on-phone About text still shows', async () => {
    const { context, page } = await open({ fight: false, tweak: (sh) => {
      sh.rows.fight_markers.fm = { id: 'fm', couple_id: 'c1', logged_by: UID, at: new Date(Date.now() - HOUR).toISOString(), repaired_at: null, hit_self: null, hit_related: null };
    } });
    await page.evaluate(() => {
      const k = 'cycle:priv.u-me', p = JSON.parse(localStorage.getItem(k));
      p.fights.push({ id: 'fm', at: Date.now() - 36e5, intensity: 3, about: 'Old private about', vent: '', rewritten: '', shared: false });
      localStorage.setItem(k, JSON.stringify(p));
      CycleStore.S.loaded = false; // pagehide flush must not overwrite the seeded private fight
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-a="go:more"]');
    await page.click('[data-a="go:cycle"]');
    await page.click('.rf[data-a="openfight:fm"]');
    await page.waitForSelector('.fn');
    assert.match((await notesText(page))[0], /Old private about$/);
    await context.close();
  });

  test('partner view: Points Fight line opens her version; "Add your version" saves my note', async () => {
    const { context, page } = await open({ fight: false, tweak: partnerFight });
    await page.click('[data-a="tab:progress"]'); await page.click('[data-a="go:points"]');
    await page.click('.ln[data-a="openfight:fp"]');
    await page.waitForSelector('.fn');
    assert.equal((await page.textContent('main section:last-of-type .lab')).trim(), 'Add your version');
    assert.equal((await notesText(page)).length, 1);
    await page.fill('textarea[data-d="more"]', 'My side');
    await page.click('[data-a="notesave"]');
    await page.waitForFunction(() => document.querySelectorAll('.fn').length === 2);
    assert.match((await notesText(page))[1], /^Me .*My side$/);
    assert.equal((await page.textContent('main section:last-of-type .lab')).trim(), 'Add more');
    await context.close();
  });

  test('Home "Add your version" row for her unrepaired fight, gone once I write a note', async () => {
    const { context, page } = await open({ fight: false, tweak: partnerFight });
    const row = '.nd .nc[data-a="openfight:fp"]';
    assert.match((await page.textContent(row)).replace(/\s+/g, ' ').trim(), /^Fight · \w{3}( \d+ \w{3})? \d+:\d\d[ap]m · Her\s?Add your version/);
    await page.click(row);
    await page.waitForSelector('textarea[data-d="more"]');
    await page.fill('textarea[data-d="more"]', 'My side');
    await page.click('[data-a="notesave"]');
    await page.waitForSelector('.fn >> nth=1');
    await page.click('[data-a="back"]');
    await page.waitForSelector('.rows');
    assert.equal(await page.$(row), null);
    await context.close();
  });

  test('Home row also disappears when the fight is repaired, and finishing a fight ask todo repairs it', async () => {
    const { context, page } = await open({ fight: false, tweak: (sh) => {
      partnerFight(sh);
      sh.rows.todos.rt = { id: 'rt', couple_id: 'c1', owner_id: UID, created_by: PID, item_id: null, fight_marker_id: 'fp', title: 'Apologize', type: 'response', due_date: null, target: null, tally: 0, done_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null };
    } });
    assert.ok(await page.$('.nd .nc[data-a="openfight:fp"]'));
    await page.click('[data-a="tab:todo"]');
    await page.click('[data-a="done:rt"]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_markers.fp.repaired_at);
    await page.click('[data-a="tab:home"]');
    assert.equal(await page.$('.nd .nc[data-a="openfight:fp"]'), null);
    await context.close();
  });

  // Keyboard open (iOS): tapping a non-field control must keep the field focused. If it blurs, the keyboard closes,
  // .scr grows and its scrollTop is clamped (the screen jumps). Keyboard is simulated via visualViewport height + resize.
  async function typeNote(page) {
    await page.fill('textarea[data-d="note"]', 'hello');
    await page.evaluate(() => { const t = document.querySelector('textarea[data-d="note"]'); t.focus(); t.setSelectionRange(2, 4); });
    await page.evaluate(() => { Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 844 - 336 }); window.visualViewport.dispatchEvent(new Event('resize')); });
    await page.evaluate(() => { const s = document.querySelector('.scr'); s.scrollTop = s.scrollHeight; });
  }
  async function tap(page, a) { // real mouse at measured coordinates, no Playwright auto-scroll
    const box = await (await page.$(`[data-a="${a}"]`)).boundingBox();
    const hit = await page.evaluate(([x, y, a]) => document.elementFromPoint(x, y).closest('[data-a]')?.getAttribute('data-a') === a, [box.x + box.width / 2, box.y + box.height / 2, a]);
    assert.ok(hit, a + ' must be tappable without scrolling');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  const focused = (page) => page.evaluate(() => { const a = document.activeElement; return a.getAttribute('data-d') + '|' + a.value + '|' + a.selectionStart + '-' + a.selectionEnd; });
  const scrollTop = (page) => page.evaluate(() => document.querySelector('.scr').scrollTop);

  test('tapping Apologize with the note keyboard open keeps the note focused and .scr still', async () => {
    const { context, page } = await open();
    await typeNote(page);
    const before = await scrollTop(page);
    assert.ok(before > 50, 'precondition: scrolled with keyboard open, got ' + before);
    await tap(page, 'chip:apologize');
    await page.waitForFunction(() => document.querySelector('[data-a="chip:apologize"]').classList.contains('on'));
    // iOS closes the keyboard when no field is focused any more.
    if (await page.evaluate(() => !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))) {
      await page.evaluate(() => { Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 844 }); window.visualViewport.dispatchEvent(new Event('resize')); });
      await page.waitForTimeout(100);
    }
    assert.equal(await scrollTop(page), before);
    assert.equal(await focused(page), 'note|hello|2-4');
    await context.close();
  });

  test('tapping Custom (adds the Title input) keeps the note focused', async () => {
    const { context, page } = await open();
    await typeNote(page);
    await tap(page, 'chip:custom');
    await page.waitForSelector('input[data-d="customTitle"]');
    assert.equal(await focused(page), 'note|hello|2-4');
    await context.close();
  });

  test('Cancel still leaves the screen with the note focused', async () => {
    const { context, page } = await open();
    await typeNote(page);
    await page.evaluate(() => { document.querySelector('.scr').scrollTop = 0; });
    await tap(page, 'back');
    await page.waitForSelector('[data-a="go:fight"]');
    await context.close();
  });
});
