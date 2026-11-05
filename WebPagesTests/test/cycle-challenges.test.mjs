// Challenges: Points chip -> detail (stats, streak-band calendar, hit gap, no x marks) -> Edit sheet rename, sent as a PATCH.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it. SHOTS=<dir> also writes 390px screenshots.
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
const SHOTS = process.env.SHOTS;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UID = 'u-me', PID = 'u-her', TZ = 'America/New_York';
const today = C.localDay(Date.now(), TZ);
const day = (n) => C.addDays(today, n); // n days from today
// Start 30 days ago, hits 18 and 5 days ago: run of 12 (week bonus on day 7), gap, run of 12, gap, current run of 5 (today = day 5).
const START = day(-30), HITS = [day(-18), day(-5)];
const fight = (d) => ({ id: 'f-' + d, couple_id: 'c1', at: new Date(C.addDays(d, 0) + 'T16:00:00Z').toISOString(), logged_by: PID, hit_self: true, hit_count: 1 });
const seed = () => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: TZ, created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Her', checkin_time: '21:00', hits_self: true }],
    rows: {
      items: {}, todos: {}, todo_events: {}, checkins: {}, fight_notes: {}, rewards: {}, redemptions: {}, acks: {},
      fight_markers: Object.fromEntries(HITS.map((d) => [fight(d).id, fight(d)])),
      challenges: { 'no-hit': { id: 'no-hit', couple_id: 'c1', name: 'No hitting', start: START, for_user: PID, accepted_at: '2026-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' } },
    },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  let said = ''; // what the box transcribes the next clip as ('' = 422 no speech)
  async function open(tweak, nativeOpts) {
    said = '';
    const s = seed();
    if (tweak) tweak(s['shared.' + UID]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, s);
    if (nativeOpts) await context.addInitScript((o) => {
      // The shell's bridge: store.* passes through to localStorage (the seed lives there); speech.* is logged.
      window.__bridge = []; window.__speechDenied = o.denied;
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        window.__bridge.push({ cmd, args });
        setTimeout(() => {
          let r = null, e = null;
          if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
          else if (cmd === 'store.set') { if (args.value == null) localStorage.removeItem('cycle:' + args.key); else localStorage.setItem('cycle:' + args.key, args.value); }
          else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.startsWith('cycle:' + args.prefix)).map((k) => k.slice(6));
          else if (cmd === 'notify.status') r = 'granted';
          else if (cmd === 'lock.get') r = false;
          else if (cmd === 'speech.start' && window.__speechDenied) e = 'Mic off';
          else if (cmd === 'speech.stop') r = { audio: 'QVVESU8=', mime: 'audio/mp4' }; // base64 'AUDIO'
          window.__cycleReply(id, r, e);
        }, 0);
      } } } };
    }, nativeOpts);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    const sent = [];
    await context.route('https://box.test/**', (route) => route.abort());
    await context.route('https://box.test/transcribe', (route) => said ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: said }) }) : route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"no speech"}' }));

    await context.route('https://x.test/**', (route) => {
      const rq = route.request();
      if (rq.method() === 'PATCH' && /\/rest\/v1\/challenge/.test(rq.url())) { sent.push({ url: rq.url(), body: rq.postDataJSON() }); return route.fulfill({ status: 204, body: '' }); }
      if (rq.method() === 'POST' && /\/rest\/v1\/challenge/.test(rq.url())) { sent.push({ url: rq.url(), body: rq.postDataJSON() }); return route.fulfill({ status: 201, body: '' }); }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rows .row');
    await page.click('[data-a="tab:progress"]');
    return { context, page, sent };
  }
  // A card's name and big status, as the phone shows them ("No hitting Day 5").
  const cardText = (page, sel = '.ach[data-a^="challenge:"]') => page.$eval(sel, (e) => [e.querySelector('.nm').textContent, e.querySelector('.big').textContent].join(' '));
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

  test('Progress is the points hub: summary opens Points, Shop row opens Shop, back returns to Us', async () => {
    const { context, page } = await open();
    assert.equal(await page.textContent('.hd h2'), 'Progress');
    assert.deepEqual(await page.$$eval('.ur .sum .lab', (e) => e.map((x) => x.textContent)), ['Balance', 'This week']);
    await shot(page, 'us');
    for (const [sel, title] of [['.ur .sum', 'Points'], ['.ur [data-a="go:shop"]', 'Shop']]) {
      await page.click(sel);
      assert.equal(await page.textContent('.hd h2'), title);
      assert.equal((await page.textContent('.hd .back')).trim(), 'Progress');
      await page.click('.hd .back');
      assert.equal(await page.textContent('.hd h2'), 'Progress');
    }
    await context.close();
  });

  test('Shop: every reward row has a 112x112 art tile (null art shows the fallback arrow-through-heart), the sheet shows big art, dimming skips the art', async () => {
    const mk = (id, name, price, art) => ({ id, couple_id: 'c1', name, price, archived: false, art, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
    const { context, page } = await open((sd) => { sd.rows.rewards = { a: mk('a', 'Breast implants', 10000, 'upgrading'), b: mk('b', 'Plain', 5, null), c: mk('c', 'Shopping', 6, 'shopper'), d: mk('d', 'Cupid', 7, 'cupid'), e: mk('e', 'Upgrade', 8, 'upgrading') }; });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.click('[data-a="go:shop"]');
    const tile = (id) => page.$eval(`[data-a="reward:${id}"] .rthumb`, (e) => { const r = e.getBoundingClientRect(), v = e.querySelector('svg').getBoundingClientRect(), cs = getComputedStyle(e); return { w: r.width, h: r.height, bg: cs.backgroundColor, rad: cs.borderTopLeftRadius, sv: Math.max(v.width, v.height) / r.width, svg: e.innerHTML }; });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const t = await tile(id);
      assert.deepEqual([t.w, t.h, t.bg, t.rad], [112, 112, 'rgb(20, 20, 20)', '18px'], 'tile ' + id);
      assert.ok(Math.abs(t.sv - 0.94) < 0.01, `svg is ${t.sv} of the tile`);
    }
    const ser = (k, kind) => page.evaluate(([k, kind]) => { const d = document.createElement('div'); d.innerHTML = artSvg(k, kind); return d.innerHTML; }, [k, kind]); // same serialisation as the DOM
    const FALLBACK = await ser(null, 'row');
    assert.match(FALLBACK, /viewBox="0 0 40 56"/);
    assert.equal((await tile('b')).svg, FALLBACK);
    assert.notEqual((await tile('a')).svg, FALLBACK);
    // Row order: tile, name (fills), price; 16px gap; 14px padding
    const row = await page.$eval('[data-a="reward:a"]', (e) => { const cs = getComputedStyle(e), k = [...e.children].map((x) => x.getBoundingClientRect()); return { cls: [...e.children].map((x) => x.className), pt: cs.paddingTop, pb: cs.paddingBottom, g1: k[1].left - k[0].right, g2: k[2].left - k[1].right, nmFlex: getComputedStyle(e.children[1]).flexGrow }; });
    assert.deepEqual(row.cls, ['rthumb', 'nm', 'pr']);
    assert.deepEqual([row.pt, row.pb, row.g1, row.nmFlex], ['14px', '14px', 16, '1']);
    assert.ok(row.g2 >= 15.99, 'name to price ' + row.g2);
    // No horizontal overflow at 375px, including the 10000 row
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, [...document.querySelectorAll('.shop .it')].every((e) => e.getBoundingClientRect().right <= innerWidth && e.scrollWidth <= e.clientWidth)]), [true, true]);
    // Out of reach: name and price dim, the art does not
    const dim = await page.$eval('[data-a="reward:a"]', (e) => [e.className, getComputedStyle(e).opacity, getComputedStyle(e.querySelector('.rthumb')).opacity, getComputedStyle(e.querySelector('.nm')).opacity, getComputedStyle(e.querySelector('.pr')).opacity]);
    assert.deepEqual(dim, ['it no', '1', '1', '0.5', '0.5']);
    assert.equal(await page.$eval('[data-a="reward:c"]', (e) => getComputedStyle(e.querySelector('.nm')).opacity), '1');
    await shot(page, 'shop-art');
    // Redeem sheet: big art for every reward (null shows the fallback); buttons on screen at 375x667
    for (const [id, key] of [['e', 'upgrading'], ['b', null], ['c', 'shopper'], ['d', 'cupid']]) {
      await page.click(`[data-a="reward:${id}"]`);
      const inner = await page.$eval('.rart', (e) => e.innerHTML);
      assert.equal(inner, await ser(key, 'big'), 'sheet art ' + id);
      if (id === 'e') assert.match(inner, /UPGRADING/);
      if (id === 'b') assert.equal(inner, FALLBACK);
      const fit = await page.evaluate(() => [...document.querySelectorAll('.bs [data-a^="redeem:"], .bs [data-a="sheet:close"]')].map((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }));
      assert.deepEqual(fit, [true, true, true], 'sheet buttons on screen for ' + id);
      assert.ok(await page.$eval('.bs', (e) => e.getBoundingClientRect().top >= 0), 'sheet top on screen for ' + id);
      if (id === 'd') await shot(page, 'redeem-art');
      await page.click('.bs .xb');
    }
    // An unknown non-null key still throws
    assert.equal(await page.evaluate(() => { try { artSvg('nope', 'row'); return 'no throw'; } catch (e) { return e.message; } }), 'Unknown reward art: nope');
    await context.close();
  });

  test('Progress shows a card per challenge; tapping it opens the detail with stats and calendar', async () => {
    const { context, page } = await open();
    assert.equal(await cardText(page), 'No hitting Day 5');
    await shot(page, 'actions');
    await page.click('.ach[data-a^="challenge:"]');
    assert.equal(await page.textContent('.hd h2'), 'No hitting');
    assert.deepEqual(await page.$$eval('.four .lab', (e) => e.map((x) => x.textContent)), ['Day', 'Tonight', 'Best', 'Earned']);
    const big = await page.$$eval('.four .big', (e) => e.map((x) => x.textContent));
    assert.deepEqual(big, ['5', '+5', '12', '180']); // a 12-day run = 55 (days 1-10) + 20 (days 11-12) + 10 week bonus = 85, twice = 170, plus days 1-4 of the current run = 10
    assert.equal(await page.$$eval('.ccal .wl', (e) => e.length), 5);
    assert.deepEqual(await page.$$eval('.ccal .wk', (e) => e.map((x) => x.textContent).join('')), 'MTWTFSS');
    const rules = await page.$$eval('.rule', (e) => e.map((x) => x.textContent));
    assert.deepEqual(rules, ['+1, +2, +3… up to +10 a day, plus +10 every week and +100 every month!', 'A hit: −10, then −5 for each more that day. A .5 is half.']);
    await shot(page, 'detail');
    await context.close();
  });

  test('a hit day is an empty gap, runs are connected bands, no x marks anywhere', async () => {
    const { context, page } = await open();
    await page.click('.ach[data-a^="challenge:"]');
    const cells = await page.$$eval('.ccal .cx', (e) => e.map((x) => ({ c: x.className.replace('cx ', ''), t: x.textContent })));
    // Last cell of the 5th row may be a future dot; today's cell is the one with .t and the in-progress number.
    assert.equal(cells.length, 35);
    const todayCell = cells.filter((x) => /\bt\b/.test(x.c));
    assert.equal(todayCell.length, 1);
    assert.equal(todayCell[0].t, '5');
    // Exactly two hit gaps inside the window or before it; gaps hold no text.
    const gaps = cells.filter((x) => /\bg\b/.test(x.c));
    assert.ok(gaps.length >= 1 && gaps.length <= 2);
    gaps.forEach((g) => assert.equal(g.t, ''));
    assert.equal((await page.textContent('.ccal')).includes('×'), false);
    assert.equal((await page.textContent('main')).includes('×'), false);
    // Band cells carry their streak number; a band never spans a gap: a cell right after a gap starts a run.
    cells.forEach((x, i) => { if (/\bb\b/.test(x.c) && i % 7 !== 0 && /\bg\b/.test(cells[i - 1].c)) assert.match(x.c, /\bs\b/); });
    // Computed shape: a mid-run cell has square corners, a run end is rounded on its right only.
    const radii = await page.$$eval('.ccal .cx.b', (e) => e.map((x) => [x.className, getComputedStyle(x).borderTopLeftRadius, getComputedStyle(x).borderTopRightRadius]));
    const mid = radii.find(([c]) => !/\bs\b/.test(c) && !/\be\b/.test(c));
    assert.deepEqual([mid[1], mid[2]], ['0px', '0px']);
    const end = radii.find(([c]) => /\be\b/.test(c) && !/\bs\b/.test(c) && !/\bt\b/.test(c));
    assert.deepEqual([end[1], end[2]], ['0px', '20px']);
    await context.close();
  });

  test('a hit today renders today as an outlined gap with day 0', async () => {
    const { context, page } = await open((sh) => { sh.rows.fight_markers['f-today'] = fight(today); });
    await page.click('.ach[data-a^="challenge:"]');
    assert.deepEqual(await page.$$eval('.four .big', (e) => e.map((x) => x.textContent).slice(0, 2)), ['0', '0']);
    const t = await page.$eval('.ccal .cx.t', (e) => [e.className, e.textContent]);
    assert.match(t[0], /\bg\b/); assert.equal(t[1], '');
    await context.close();
  });

  test('the calendar starts at the challenge start week, and week labels clear the first column', async () => {
    const { context, page } = await open((sh) => { sh.rows.challenges['no-hit'].start = today; sh.rows.fight_markers = {}; });
    await page.click('.ach[data-a^="challenge:"]');
    assert.equal(await page.$$eval('.ccal .wl', (e) => e.length), 1);
    const [l, c] = await page.$$eval('.ccal .wl, .ccal .cx', (e) => e.slice(0, 2).map((x) => x.getBoundingClientRect()));
    const w = await page.$eval('.ccal .wl', (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().right; });
    assert.ok(w + 4 <= c.left, `label text ends at ${w}, first cell starts at ${c.left}`);
    await shot(page, 'detail-new');
    await context.close();
  });

  test('Edit renames: sheet shows the name, Save updates chip, title and the PATCH sent', async () => {
    const { context, page, sent } = await open();
    await page.click('.ach[data-a^="challenge:"]');
    await page.click('[data-a="chedit"]');
    assert.equal(await page.inputValue('.bs input[data-d="chname"]'), 'No hitting');
    await shot(page, 'edit');
    await page.fill('.bs input[data-d="chname"]', '  No yelling ');
    await page.click('[data-a="chsave"]');
    assert.equal(await page.textContent('.hd h2'), 'No yelling');
    assert.equal(await page.$('.bs'), null, 'sheet closed');
    for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /challenges\?id=eq\.no-hit$/);
    assert.deepEqual(sent[0].body, { name: 'No yelling' });
    await page.click('[data-a="back"]');
    assert.equal(await cardText(page), 'No yelling Day 5');
    // Blank name is refused and nothing is sent.
    await page.click('.ach[data-a^="challenge:"]'); await page.click('[data-a="chedit"]');
    await page.fill('.bs input[data-d="chname"]', '   ');
    await page.click('[data-a="chsave"]');
    assert.match(await page.textContent('.errbar'), /Name needed/);
    assert.equal(sent.length, 1);
    await context.close();
  });

  test('Add > Challenge opens the form; it defaults to Her + Tap, blank name cannot save, Save inserts and opens the detail as Not started', async () => {
    const { context, page, sent } = await open();
    await page.click('[data-a="newch"]');
    assert.equal(await page.textContent('.hd h2'), 'New');
    assert.equal((await page.textContent('.hd .back')).trim(), 'Progress');
    assert.equal(await page.$eval('.tabbar .tab.on b', (e) => e.textContent), 'Progress');
    assert.deepEqual(await page.$$eval('.tile', (e) => e.map((x) => [x.textContent, x.classList.contains('on')])), [['HHer', true], ['MMe', false]]);
    assert.deepEqual(await page.$$eval('.orow', (e) => e.map((x) => [x.textContent, x.classList.contains('on')])), [['Hit', false], ['Tap', true]]);
    assert.equal(await page.$eval('#chnew', (e) => e.classList.contains('dis')), true);
    await shot(page, 'new');
    await page.fill('[data-d="chname"]', '   ');
    assert.equal(await page.$eval('#chnew', (e) => e.classList.contains('dis')), true);
    await page.fill('[data-d="chname"]', '  No yelling ');
    assert.equal(await page.$eval('#chnew', (e) => e.classList.contains('dis')), false);
    await page.click('.tile:nth-child(2)');
    assert.equal(await page.$eval('.tile.on', (e) => e.textContent), 'MMe');
    assert.equal(await page.inputValue('[data-d="chname"]'), '  No yelling ', 'typed name survives a selection');
    await page.click('.tile:nth-child(1)'); await page.click('.orow:nth-child(1)');
    await page.click('.orow:nth-child(2)');
    await page.click('#chnew');
    assert.equal(await page.textContent('.hd h2'), 'No yelling');
    assert.equal((await page.textContent('.hd .back')).trim(), 'Progress', 'back skips the form');
    assert.equal(await page.$eval('.tabbar .tab.on b', (e) => e.textContent), 'Progress');
    assert.equal(await page.$('.four'), null);
    assert.equal(await page.textContent('.pts main .lab'), 'Waiting for Her');
    for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
    assert.equal(sent.length, 1);
    const b = sent[0].body;
    assert.match(sent[0].url, /\/rest\/v1\/challenges$/);
    assert.deepEqual([b.name, b.for_user, b.breaks_on, b.start, b.accepted_at], ['No yelling', PID, 'tap', today, null]);
    assert.ok(b.id && b.id !== 'no-hit');
    // Both cards show on Progress, the new one as Not started.
    await page.click('.hd .back');
    assert.equal(await page.textContent('.hd h2'), 'Progress');
    assert.deepEqual(await page.$$eval('.ach', (e) => e.map((x) => x.querySelector('.nm').textContent + ' ' + x.querySelector('.big').textContent)), ['No hitting Day 5', 'No yelling Not started']);
    await context.close();
  });

  test('New screen back returns to where it was opened from, and a blank Save sends nothing', async () => {
    const { context, page, sent } = await open();
    await page.click('[data-a="newch"]');
    assert.equal((await page.textContent('.hd .back')).trim(), 'Progress');
    await page.click('#chnew', { force: true });
    assert.equal(await page.textContent('.hd h2'), 'New');
    await page.click('.hd .back');
    assert.equal(await page.textContent('.hd h2'), 'Progress');
    await page.waitForTimeout(300);
    assert.equal(sent.length, 0);
    await context.close();
  });

  const TAP = { id: 'tap1', couple_id: 'c1', name: 'No yelling', start: START, for_user: UID, breaks_on: 'tap', accepted_at: '2026-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  const openTap = (tweak) => open((sh) => { sh.rows.challenges.tap1 = TAP; sh.rows.fight_markers = {}; if (tweak) tweak(sh); });

  test('accepted tap challenge: only the first rule, Broke it sheet with note inserts a break; the cell turns into a hit-day cell and the button goes', async () => {
    const { context, page, sent } = await openTap();
    await page.click('.ach[data-a="challenge:tap1"]');
    assert.equal((await page.$$('.rule')).length, 1);
    assert.equal(await page.textContent('.pin .ghost'), 'Broke it');
    const before = await page.$eval('.ccal .cx.t', (e) => e.className);
    assert.match(before, /\bb\b/);
    await shot(page, 'tap-detail');
    await page.click('[data-a="broke"]');
    assert.equal(await page.textContent('.bs h3'), 'Broke it');
    await shot(page, 'broke');
    await page.fill('.bs [data-d="brnote"]', ' snapped at dinner ');
    await page.click('[data-a="brsave"]');
    assert.equal(await page.$('.bs'), null, 'sheet closed');
    assert.equal(await page.$('[data-a="broke"]'), null, 'button gone');
    const t = await page.$eval('.ccal .cx.t', (e) => [e.className, e.textContent]);
    assert.match(t[0], /\bg\b/); assert.match(t[0], /\bk\b/); assert.equal(t[1], '');
    assert.equal(await page.$eval('.ccal .cx.t', (e) => getComputedStyle(e, '::after').content), '"×"');
    assert.deepEqual(await page.$$eval('.four .big', (e) => e.map((x) => x.textContent).slice(0, 2)), ['0', '0']);
    for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/rest\/v1\/challenge_breaks$/);
    const b = sent[0].body;
    assert.deepEqual([b.challenge_id, b.day, b.note, b.by], ['tap1', today, 'snapped at dinner', UID]);
    await context.close();
  });

  test('tap challenge: a break from the partner today hides the button; hits do not break it; hit challenge shows no Broke it', async () => {
    const { context, page } = await openTap((sh) => {
      sh.rows.challenge_breaks = { b1: { id: 'b1', couple_id: 'c1', challenge_id: 'tap1', day: today, note: null, by: PID } };
      sh.rows.fight_markers = { fx: fight(day(-1)) };
    });
    await page.click('.ach[data-a="challenge:tap1"]');
    assert.equal(await page.$('[data-a="broke"]'), null);
    assert.equal((await page.$$('.cx.g.k')).length, 1, 'only the break day is broken; yesterday hit is ignored');
    await page.click('.hd .back');
    await page.click('.ach[data-a="challenge:no-hit"]');
    assert.equal(await page.$('[data-a="broke"]'), null);
    assert.equal((await page.$$('.rule')).length, 2);
    await context.close();
  });

  test('unaccepted: for_user sees Accept, which sends accepted_at and shows day 1; no stats before', async () => {
    const { context, page, sent } = await open((sh) => { Object.assign(sh.rows.challenges['no-hit'], { for_user: UID, accepted_at: null }); sh.rows.fight_markers = {}; });
    assert.equal(await cardText(page), 'No hitting Not started');
    await page.click('.ach[data-a^="challenge:"]');
    assert.equal(await page.$('.four'), null); assert.equal(await page.$('.ccal'), null);
    assert.equal((await page.$$('.rule')).length, 2);
    assert.equal(await page.textContent('[data-a="chaccept"]'), 'Accept');
    await shot(page, 'accept');
    await page.click('[data-a="chaccept"]');
    assert.deepEqual(await page.$$eval('.four .big', (e) => e.map((x) => x.textContent).slice(0, 2)), ['1', '+1']);
    assert.equal(await page.$('[data-a="chaccept"]'), null);
    assert.equal(await page.$$eval('.ccal .wl', (e) => e.length), 1);
    for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /challenges\?id=eq\.no-hit$/);
    assert.deepEqual(Object.keys(sent[0].body), ['accepted_at']);
    assert.ok(Math.abs(Date.now() - Date.parse(sent[0].body.accepted_at)) < 60000);
    await context.close();
  });

  test('unaccepted: the partner sees Waiting for <name> and no button', async () => {
    const { context, page } = await open((sh) => { sh.rows.challenges['no-hit'].accepted_at = null; });
    assert.equal(await cardText(page), 'No hitting Not started');
    await page.click('.ach[data-a^="challenge:"]');
    assert.equal(await page.textContent('.pts main .lab'), 'Waiting for Her');
    assert.equal(await page.$('[data-a="chaccept"]'), null);
    assert.equal(await page.$('.four'), null);
    await shot(page, 'waiting');
    await context.close();
  });

  const RULE = "At least 20 minutes a day, explicitly for BPD. Therapy doesn't count. Therapy exercises don't count unless they're specifically for BPD.";
  const GOAL = { id: 'bpd', couple_id: 'c1', name: 'BPD research', start: today, for_user: UID, breaks_on: 'goal', goal_days: 10, goal_window_days: 14, goal_earn: 150, goal_miss: 50, rule: RULE, accepted_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  const openGoal = (tweak) => open((sh) => { sh.rows.challenges.bpd = { ...GOAL }; sh.rows.fight_markers = {}; if (tweak) tweak(sh); });
  const chipOf = (page) => cardText(page, '.ach[data-a="challenge:bpd"]');

  test('goal challenge: accept, Log today needs a note, insert bumps the count and hides the button; partner has no button', async () => {
    const { context, page, sent } = await openGoal();
    assert.equal(await chipOf(page), 'BPD research Not started');
    await page.click('.ach[data-a="challenge:bpd"]');
    assert.equal(await page.textContent('.pts main .rule'), RULE);
    assert.equal(await page.$('[data-a="chlog"]'), null, 'nothing to log before accepting');
    await page.click('[data-a="chaccept"]');
    assert.deepEqual(await page.$$eval('.four .big', (e) => e.map((x) => x.textContent)), ['0/10', MON[+C.addDays(today, 13).split('-')[1] - 1] + ' ' + +C.addDays(today, 13).split('-')[2], '+150', '−50']);
    assert.equal(await page.$('[data-a="broke"]'), null, 'no Broke it');
    assert.equal(await page.textContent('[data-a="chlog"]'), 'Log today');
    await page.click('[data-a="chlog"]');
    assert.equal(await page.textContent('.bs h3'), 'Log today');
    assert.equal(await page.getAttribute('.bs [data-d="chlognote"]', 'placeholder'), 'What did you do?');
    await page.click('[data-a="chlogsave"]');
    await page.waitForTimeout(300);
    assert.notEqual(await page.$('.bs'), null, 'empty note keeps the sheet open');
    await page.fill('.bs [data-d="chlognote"]', '   ');
    await page.click('[data-a="chlogsave"]');
    await page.waitForTimeout(300);
    assert.notEqual(await page.$('.bs'), null, 'blank note rejected');
    assert.equal(sent.filter((x) => /challenge_days/.test(x.url)).length, 0, 'nothing sent for an empty note');
    await page.fill('.bs [data-d="chlognote"]', ' read a paper on DBT ');
    await shot(page, 'goal-log');
    await page.click('[data-a="chlogsave"]');
    assert.equal(await page.$('.bs'), null);
    assert.equal(await page.$('[data-a="chlog"]'), null, 'hidden once logged today');
    assert.equal(await page.$eval('.four > div .big', (e) => e.textContent), '1/10');
    assert.match(await page.textContent('.pts main'), /read a paper on DBT/);
    assert.equal(await chipOf(page).catch(() => null), null, 'card is on Progress, not the detail');
    await page.click('.hd .back');
    assert.equal(await chipOf(page), 'BPD research 1/10');
    for (let i = 0; i < 50 && !sent.some((x) => /challenge_days/.test(x.url)); i++) await page.waitForTimeout(100);
    const ins = sent.filter((x) => /challenge_days$/.test(x.url));
    assert.equal(ins.length, 1);
    assert.deepEqual([ins[0].body.challenge_id, ins[0].body.day, ins[0].body.note, ins[0].body.by], ['bpd', today, 'read a paper on DBT', UID]);
    await context.close();
  });

  test('goal challenge opening later: accept early shows Starts and Due with no undefined, stats are spaced, no Log today until it opens', async () => {
    const opens = day(2), due = day(63);
    const label = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const { context, page } = await openGoal((sh) => { Object.assign(sh.rows.challenges.bpd, { start: opens, goal_window_days: 62 }); });
    await page.click('[data-a="challenge:bpd"]');
    const stats = () => page.$$eval('.four.g > *', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: e.textContent.replace(/\s+/g, ' ').trim() }; }));
    const check = async () => {
      const s = await stats();
      assert.equal(s.length, 4);
      assert.ok(!(await page.textContent('.four.g')).includes('undefined'));
      assert.equal(s[0].t, 'Starts' + label(opens)); assert.equal(s[1].t, 'Due' + label(due));
      for (let i = 1; i < 4; i++) assert.ok(s[i].l - s[i - 1].r >= 16, 'gap ' + (s[i].l - s[i - 1].r) + ' after ' + s[i - 1].t);
    };
    await check();
    await page.click('[data-a="chaccept"]');
    await page.waitForSelector('[data-a="chaccept"]', { state: 'detached' });
    await check();
    assert.equal(await page.$('[data-a="chlog"]'), null);
    await shot(page, 'goal-upcoming');
    await context.close();
  });

  test('goal challenge: partner sees rule, progress and notes but no Log today; Done and Failed chips', async () => {
    const days = { d1: { id: 'd1', couple_id: 'c1', challenge_id: 'bpd', day: day(-1), note: 'chapter 2', by: UID } };
    const acc = new Date(Date.now() - 3 * 86400000).toISOString();
    let { context, page } = await openGoal((sh) => { Object.assign(sh.rows.challenges.bpd, { for_user: PID, accepted_at: acc, start: day(-3) }); sh.rows.challenge_days = days; });
    assert.equal(await chipOf(page), 'BPD research 1/10');
    await page.click('.ach[data-a="challenge:bpd"]');
    assert.equal(await page.$('[data-a="chlog"]'), null);
    assert.equal(await page.$('[data-a="broke"]'), null);
    assert.match(await page.textContent('.pts main'), /chapter 2/);
    assert.equal(await page.$eval('.four > div .big', (e) => e.textContent), '1/10');
    await shot(page, 'goal-partner');
    await context.close();
    ({ context, page } = await openGoal((sh) => { Object.assign(sh.rows.challenges.bpd, { goal_days: 1, accepted_at: acc, start: day(-3) }); sh.rows.challenge_days = days; }));
    assert.equal(await chipOf(page), 'BPD research Done');
    await page.click('.ach[data-a="challenge:bpd"]');
    assert.equal(await page.$('[data-a="chlog"]'), null, 'finished: no button');
    await context.close();
    ({ context, page } = await openGoal((sh) => { Object.assign(sh.rows.challenges.bpd, { goal_window_days: 2, accepted_at: new Date(Date.now() - 5 * 86400000).toISOString(), start: day(-5) }); }));
    assert.equal(await chipOf(page), 'BPD research Failed');
    await page.click('.ach[data-a="challenge:bpd"]');
    assert.equal(await page.$('[data-a="chlog"]'), null);
    await context.close();
  });

  test('no challenge rows: Progress has no Challenges section, and still offers New challenge', async () => {
    const { context, page } = await open((sh) => { sh.rows.challenges = {}; });
    assert.equal(await page.$('.deck'), null);
    assert.equal(await page.$$eval('.td .empty', (e) => e.length), 1, 'Challenges section shows None');
    assert.equal(await page.$$eval('[data-a="newch"]', (e) => e.length), 1);
    await context.close();
  });

  test('challenges are gone from Points and To-dos: no chips, no Challenges label, no New chip', async () => {
    const { context, page } = await open();
    assert.equal(await page.$$eval('.ach', (e) => e.length), 1, 'sanity: the challenge exists and shows on Progress');
    await page.click('.ur .sum');
    assert.equal(await page.textContent('.hd h2'), 'Points');
    assert.equal(await page.$$eval('[data-a^="challenge:"], [data-a="newch"], .chip, .ent', (e) => e.length), 0);
    assert.ok(!(await page.textContent('main')).includes('Challenges'));
    await page.click('.hd .back');
    await page.click('.tabbar [data-a="tab:todo"]');
    assert.equal(await page.$$eval('[data-a^="challenge:"], [data-a="newch"]', (e) => e.length), 0);
    await context.close();
  });

  test('challenge detail belongs to Progress: tab bar, Back label and Back target, also when opened from a notification route', async () => {
    const { context, page } = await open();
    await page.click('.ach[data-a^="challenge:"]');
    assert.equal(await page.textContent('.hd h2'), 'No hitting');
    assert.equal((await page.textContent('.hd .back')).trim(), 'Progress');
    assert.equal(await page.$eval('.tabbar .tab.on b', (e) => e.textContent), 'Progress');
    await page.click('.hd .back');
    assert.equal(await page.textContent('.hd h2'), 'Progress');
    await page.evaluate(() => window.cycleNative.route('challenge/no-hit'));
    assert.equal(await page.textContent('.hd h2'), 'No hitting');
    assert.equal(await page.$eval('.tabbar .tab.on b', (e) => e.textContent), 'Progress');
    assert.equal((await page.textContent('.hd .back')).trim(), 'Progress');
    await page.click('.hd .back');
    assert.equal(await page.textContent('.hd h2'), 'Progress');
    await context.close();
  });

  // ---- voice input and editing/deleting goal logs ----
  const iso = (d) => d + 'T12:00:00.000Z';
  const logRow = (id, d, note, by = UID) => ({ id, couple_id: 'c1', challenge_id: 'bpd', day: d, note, by, created_at: iso(d), updated_at: iso(d), deleted_at: null });
  // Accepted 3 days ago; logs 2 days ago and (optionally) today. forUser: who the challenge is for.
  const openLogs = (o = {}) => open((sh) => {
    sh.rows.challenges.bpd = { ...GOAL, start: day(-3), accepted_at: iso(day(-3)), for_user: o.forUser || UID };
    sh.rows.fight_markers = {};
    const by = o.forUser || UID;
    sh.rows.challenge_days = { a: logRow('a', day(-2), 'first paper', by), ...(o.today === false ? {} : { b: logRow('b', today, 'second paper', by) }) };
  }, o.native === false ? undefined : { denied: !!o.denied });
  const bridgeCmds = (page) => page.evaluate(() => window.__bridge.map((x) => x.cmd).filter((c) => c.startsWith('speech')));
  const field = (page) => page.inputValue('.bs [data-d="chlognote"]');
  const dayReq = (sent, method) => sent.filter((x) => /challenge_days/.test(x.url) && (method === 'PATCH' ? /id=eq/.test(x.url) : !/id=eq/.test(x.url)));
  const flush = async (page, sent, n) => { for (let i = 0; i < 60 && dayReq(sent, 'PATCH').length + dayReq(sent, 'POST').length < n; i++) await page.waitForTimeout(100); };

  test('voice: mic sends speech.start, the tap stops, uploads and appends the transcript to typed text; busy while it transcribes', async () => {
    const { context, page } = await openLogs({ today: false });
    await page.click('.ach[data-a="challenge:bpd"]');
    await page.click('[data-a="chlog"]');
    assert.equal(await page.$$eval('.bs .mic', (e) => e.length), 1);
    await page.fill('.bs [data-d="chlognote"]', 'read intro');
    await shot(page, 'voice-idle');
    await page.click('.bs .mic');
    assert.deepEqual(await bridgeCmds(page), ['speech.start']);
    assert.equal(await page.$eval('.bs .mic', (e) => e.classList.contains('rec')), true, 'recording state shown');
    said = 'and a paper on DBT';
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); // forces render()
    assert.equal(await field(page), 'read intro', 'nothing is inserted while recording');
    assert.equal(await page.$eval('.bs .mic', (e) => e.classList.contains('rec')), true, 'still recording after re-render');
    await shot(page, 'voice-recording');
    await page.click('.bs .mic');
    await page.waitForFunction(() => document.querySelector('.bs [data-d="chlognote"]').value === 'read intro and a paper on DBT');
    assert.deepEqual(await bridgeCmds(page), ['speech.start', 'speech.stop']);
    assert.equal(await page.$('.bs .mic.rec, .bs .mic.busy'), null);
    await context.close();
  });

  test('voice: Save while recording drops the clip and saves the current text; closing the sheet, a dim tap and typing drop it too', async () => {
    let { context, page, sent } = await openLogs({ today: false });
    await page.click('.ach[data-a="challenge:bpd"]');
    await page.click('[data-a="chlog"]');
    await page.fill('.bs [data-d="chlognote"]', 'typed note');
    await page.click('.bs .mic');
    await page.click('[data-a="chlogsave"]');
    assert.deepEqual(await bridgeCmds(page), ['speech.start', 'speech.cancel']);
    assert.equal(await page.$('.bs'), null);
    await flush(page, sent, 1);
    assert.equal(dayReq(sent, 'POST')[0].body.note, 'typed note');
    await context.close();
    ({ context, page } = await openLogs({ today: false }));
    await page.click('.ach[data-a="challenge:bpd"]');
    await page.click('[data-a="chlog"]');
    await page.click('.bs .mic');
    await page.click('.bs .xb');
    assert.deepEqual(await bridgeCmds(page), ['speech.start', 'speech.cancel'], 'close cancels');
    assert.equal(await page.$('.bs'), null);
    await page.click('[data-a="chlog"]');
    await page.click('.bs .mic');
    await page.click('.bs .dim, .dim', { position: { x: 5, y: 5 } });
    assert.deepEqual(await bridgeCmds(page), ['speech.start', 'speech.cancel', 'speech.start', 'speech.cancel'], 'dim tap cancels');
    await page.click('[data-a="chlog"]');
    await page.click('.bs .mic');
    await page.fill('.bs [data-d="chlognote"]', 'typed instead');
    assert.deepEqual((await bridgeCmds(page)).slice(-2), ['speech.start', 'speech.cancel'], 'typing cancels');
    assert.equal(await field(page), 'typed instead');
    await context.close();
  });

  test('voice: a recorder error clears the recording state; denied shows Mic off; no bridge means no mic button', async () => {
    let { context, page } = await openLogs({ today: false });
    await page.click('.ach[data-a="challenge:bpd"]');
    await page.click('[data-a="chlog"]');
    await page.click('.bs .mic');
    await page.evaluate(() => window.cycleNative.speechSilence()); // not a Talk turn: a dictated field waits for its own mic tap
    assert.equal(await page.$eval('.bs .mic', (e) => e.classList.contains('rec')), true);
    await page.evaluate(() => window.cycleNative.speechError('Speech failed'));
    assert.equal(await page.textContent('.errbar'), 'Speech failed');
    assert.equal(await page.$eval('.bs .mic', (e) => e.classList.contains('rec')), false);
    await context.close();
    ({ context, page } = await openLogs({ today: false, denied: true }));
    await page.click('.ach[data-a="challenge:bpd"]');
    await page.click('[data-a="chlog"]');
    await page.click('.bs .mic');
    await page.waitForSelector('.errbar');
    assert.equal(await page.textContent('.errbar'), 'Mic off');
    assert.equal(await page.$eval('.bs .mic', (e) => e.classList.contains('rec')), false);
    await context.close();
    ({ context, page } = await openLogs({ today: false, native: false }));
    await page.click('.ach[data-a="challenge:bpd"]');
    await page.click('[data-a="chlog"]');
    assert.equal(await page.$('.mic'), null);
    assert.notEqual(await page.$('.bs [data-d="chlognote"]'), null);
    await context.close();
  });

  test('edit log: tap opens a dated, prefilled sheet with a mic; Save patches the note only; empty is rejected; unchanged sends nothing', async () => {
    const { context, page, sent } = await openLogs({ today: false });
    await page.click('.ach[data-a="challenge:bpd"]');
    await page.click('[data-a="chlogedit:a"]');
    assert.equal(await page.textContent('.bs h3'), `${+day(-2).split('-')[2]} ${MON[+day(-2).split('-')[1] - 1]}`);
    assert.equal(await field(page), 'first paper');
    assert.equal(await page.$$eval('.bs .mic', (e) => e.length), 1);
    await shot(page, 'edit-sheet');
    await page.fill('.bs [data-d="chlognote"]', '  ');
    await page.click('[data-a="chlogeditsave"]');
    await page.waitForTimeout(200);
    assert.notEqual(await page.$('.bs'), null, 'empty rejected');
    await page.click('.bs .mic');
    said = 'plus a podcast';
    await page.click('.bs .mic');
    await page.waitForFunction(() => document.querySelector('.bs [data-d="chlognote"]').value === 'plus a podcast'); // blank base: no leading space
    await page.fill('.bs [data-d="chlognote"]', 'first paper, revised');
    await page.click('[data-a="chlogeditsave"]');
    assert.equal(await page.$('.bs'), null);
    assert.match(await page.textContent('.pts main'), /first paper, revised/);
    await flush(page, sent, 1);
    const p = dayReq(sent, 'PATCH');
    assert.equal(p.length, 1); assert.match(p[0].url, /id=eq\.a/);
    assert.deepEqual(p[0].body, { note: 'first paper, revised' }, 'note only: never by, day or updated_at');
    assert.equal(dayReq(sent, 'POST').length, 0);
    await context.close();
  });

  test('delete log: confirm, then the count drops and Log today returns; re-logging the same day revives the row; cancel deletes nothing', async () => {
    const { context, page, sent } = await openLogs();
    await page.click('.ach[data-a="challenge:bpd"]');
    assert.equal(await page.$eval('.four > div .big', (e) => e.textContent), '2/10');
    assert.equal(await page.$('[data-a="chlog"]'), null, 'logged today: no button');
    await page.click('[data-a="chlogedit:b"]');
    await page.click('[data-a="chlogdelq"]');
    assert.match(await page.textContent('.bs h3'), /^Delete .*\?$/);
    await shot(page, 'delete-confirm');
    await page.click('.bs .tdrop');
    assert.equal(await page.$eval('.four > div .big', (e) => e.textContent), '2/10', 'cancel keeps the log');
    await page.click('[data-a="chlogedit:b"]');
    await page.click('[data-a="chlogdelq"]');
    await page.click('[data-a="chlogdel"]');
    assert.equal(await page.$('.bs'), null);
    assert.equal(await page.$eval('.four > div .big', (e) => e.textContent), '1/10');
    assert.doesNotMatch(await page.textContent('.pts main'), /second paper/);
    assert.equal(await page.textContent('[data-a="chlog"]'), 'Log today', 'Log today is back');
    await page.click('[data-a="chlog"]');
    await page.fill('.bs [data-d="chlognote"]', 'second try');
    await page.click('[data-a="chlogsave"]');
    assert.equal(await page.$eval('.four > div .big', (e) => e.textContent), '2/10');
    assert.match(await page.textContent('.pts main'), /second try/);
    assert.equal(await page.$('[data-a="chlog"]'), null);
    await flush(page, sent, 1);
    await page.waitForTimeout(500);
    assert.equal(dayReq(sent, 'POST').length, 0, 're-log never inserts a second (challenge, day) row');
    const p = dayReq(sent, 'PATCH');
    assert.ok(p.length >= 1 && p.every((x) => /id=eq\.b/.test(x.url)));
    assert.deepEqual(p[p.length - 1].body, { note: 'second try', deleted_at: null });
    await context.close();
  });

  test('delete log: the delete is sent as deleted_at; the partner (challenge is for the other user) can edit and delete but has no Log today', async () => {
    const { context, page, sent } = await openLogs({ forUser: PID, today: false });
    await page.click('.ach[data-a="challenge:bpd"]');
    assert.equal(await page.$('[data-a="chlog"]'), null, 'partner never logs');
    await page.click('[data-a="chlogedit:a"]');
    await page.fill('.bs [data-d="chlognote"]', 'edited by partner');
    await page.click('[data-a="chlogeditsave"]');
    assert.match(await page.textContent('.pts main'), /edited by partner/);
    await page.click('[data-a="chlogedit:a"]');
    await page.click('[data-a="chlogdelq"]');
    await page.click('[data-a="chlogdel"]');
    assert.doesNotMatch(await page.textContent('.pts main'), /edited by partner/);
    assert.equal(await page.$('[data-a="chlog"]'), null, 'still no Log today for the partner');
    await flush(page, sent, 2);
    const p = dayReq(sent, 'PATCH');
    const merged = Object.assign({}, ...p.map((x) => x.body));
    assert.equal(merged.note, 'edited by partner');
    assert.match(merged.deleted_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(Object.keys(merged).sort().join(), 'deleted_at,note');
    await context.close();
  });
  // ---- Ping: the partner's challenge only, once per local day, until it is done or failed ----
  const stored = (page, ok = () => true) => page.waitForFunction(`(() => { const s = JSON.parse(localStorage.getItem('cycle:shared.${UID}')); return (${ok.toString()})(s); })()`)
    .then(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), 'cycle:shared.' + UID));
  const pingBtn = (page) => page.$eval('.pts main', (m) => { const b = [...m.querySelectorAll('.ghost')].filter((e) => /^Ping/.test(e.textContent)); return b.length ? b.map((e) => e.textContent) : null; });

  test('Ping shows on the partner\'s challenge (accepted, not started) and never on mine, nor on a done or failed one', async () => {
    const acc = new Date(Date.now() - 3 * 86400000).toISOString();
    // [seed tweak, card selector, expected]
    const cases = [
      ['partner accepted (hit)', (sh) => {}, 'no-hit', ['Ping']],
      ['partner tap', (sh) => { sh.rows.challenges.tap1 = { ...TAP, for_user: PID }; }, 'tap1', ['Ping']],
      ['mine tap', (sh) => { sh.rows.challenges.tap1 = TAP; }, 'tap1', null],
      ['mine hit', (sh) => { sh.rows.challenges['no-hit'].for_user = UID; }, 'no-hit', null],
      ['partner not started (unaccepted)', (sh) => { sh.rows.challenges['no-hit'].accepted_at = null; }, 'no-hit', ['Ping']],
      ['mine not started', (sh) => { sh.rows.challenges['no-hit'].accepted_at = null; sh.rows.challenges['no-hit'].for_user = UID; }, 'no-hit', null],
      ['partner goal not started', (sh) => { sh.rows.challenges.bpd = { ...GOAL, for_user: PID }; }, 'bpd', ['Ping']],
      ['partner goal active', (sh) => { sh.rows.challenges.bpd = { ...GOAL, for_user: PID, accepted_at: acc, start: day(-3) }; }, 'bpd', ['Ping']],
      ['mine goal active', (sh) => { sh.rows.challenges.bpd = { ...GOAL, accepted_at: acc, start: day(-3) }; }, 'bpd', null],
      ['partner goal done', (sh) => { sh.rows.challenges.bpd = { ...GOAL, for_user: PID, goal_days: 1, accepted_at: acc, start: day(-3) };
        sh.rows.challenge_days = { d1: { id: 'd1', couple_id: 'c1', challenge_id: 'bpd', day: day(-1), note: 'x', by: PID } }; }, 'bpd', null],
      ['partner goal failed', (sh) => { sh.rows.challenges.bpd = { ...GOAL, for_user: PID, goal_window_days: 2, accepted_at: new Date(Date.now() - 5 * 86400000).toISOString(), start: day(-5) }; }, 'bpd', null],
    ];
    for (const [label, tweak, id, want] of cases) {
      const { context, page } = await open((sh) => { sh.rows.fight_markers = {}; tweak(sh); });
      await page.click(`.ach[data-a="challenge:${id}"]`);
      assert.deepEqual(await pingBtn(page), want, label);
      if (want) assert.ok(await page.$(`[data-a="chping:${id}"]`), label + ': actionable');
      else assert.equal(await page.$('[data-a^="chping:"]'), null, label + ': no action');
      await context.close();
    }
  });

  test('Ping sits beside the pinned Broke it without overlap, inside the screen', async () => {
    const { context, page } = await open((sh) => { sh.rows.challenges.tap1 = { ...TAP, for_user: PID }; sh.rows.fight_markers = {}; });
    await page.click('.ach[data-a="challenge:tap1"]');
    const r = await page.$$eval('.pin .ghost', (els) => els.map((e) => { const b = e.getBoundingClientRect(); return { t: e.textContent, top: b.top, bottom: b.bottom }; }));
    assert.deepEqual(r.map((x) => x.t), ['Broke it', 'Ping']);
    assert.ok(r[1].top - r[0].bottom >= 8, 'gap between the buttons ' + (r[1].top - r[0].bottom));
    assert.ok(r[1].bottom <= 844, 'inside the viewport');
    await shot(page, 'ping-with-broke');
    await context.close();
  });

  test('Ping writes the row and queues it; becomes a disabled Pinged; the partner\'s ping or yesterday\'s does not count; the next day allows another', async () => {
    const { context, page, sent } = await open((sh) => { sh.rows.fight_markers = {}; });
    await page.click('.ach[data-a="challenge:no-hit"]');
    await shot(page, 'ping');
    await page.click('[data-a="chping:no-hit"]');
    const st = await stored(page, (x) => Object.keys(x.rows.challenge_nudges || {}).length === 1);
    const n = Object.values(st.rows.challenge_nudges)[0];
    assert.deepEqual([n.challenge_id, n.sender_id, n.couple_id, n.deleted_at], ['no-hit', UID, 'c1', null]);
    assert.ok(st.outbox.some((o) => o.op === 'insert' && o.table === 'challenge_nudges' && o.id === n.id) || sent.some((x) => /challenge_nudges$/.test(x.url)), 'queued or sent');
    assert.deepEqual(await pingBtn(page), ['Pinged']);
    assert.equal(await page.$eval('.pts main .ghost', (e) => e.classList.contains('dis')), true);
    assert.equal(await page.$('[data-a^="chping:"]'), null, 'no action left');
    await shot(page, 'pinged');
    await page.click('.pts main .ghost', { force: true }).catch(() => {});
    await page.waitForTimeout(200);
    assert.equal(Object.keys((await stored(page)).rows.challenge_nudges).length, 1, 'second tap writes nothing');
    await context.close();
    const base = { couple_id: 'c1', challenge_id: 'no-hit', deleted_at: null };
    const o2 = await open((sh) => { sh.rows.fight_markers = {}; sh.rows.challenge_nudges = {
      y: { ...base, id: 'y', sender_id: UID, created_at: new Date(Date.now() - 86400000).toISOString(), updated_at: new Date(Date.now() - 86400000).toISOString() },
      p: { ...base, id: 'p', sender_id: PID, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }; });
    await o2.page.click('.ach[data-a="challenge:no-hit"]');
    assert.deepEqual(await pingBtn(o2.page), ['Ping'], 'yesterday\'s and the partner\'s ping do not block today');
    await o2.context.close();
    const o3 = await open((sh) => { sh.rows.fight_markers = {}; sh.rows.challenge_nudges = { t: { ...base, id: 't', sender_id: UID, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }; });
    await o3.page.click('.ach[data-a="challenge:no-hit"]');
    assert.deepEqual(await pingBtn(o3.page), ['Pinged'], 'already pinged today survives a reload');
    await o3.context.close();
  });
});
