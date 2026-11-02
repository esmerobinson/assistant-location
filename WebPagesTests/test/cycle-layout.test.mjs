// Layout regressions at phone widths with a 14-char partner name ("Alexandria Rae"): invite code fit, Log fight
// sticky Save, Settings bottom room, New to do "For" segment. Chromium, plus WebKit when GL_WEBKIT_PW/GL_WEBKIT_EXEC are set.
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
function seed(couple, partner) {
  return {
    session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
    ['shared.' + UID]: {
      couple: couple ? { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z' } : null,
      members: couple ? [{ user_id: UID, name: 'Me', checkin_time: '21:00' }].concat(partner ? [{ user_id: PID, name: partner, checkin_time: '21:00' }] : []) : [],
      rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {} },
      cursors: {}, outbox: [],
    },
    ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
  };
}

for (const [name, type] of Object.entries(engines)) describe(name, () => {
  let browser;
  before(async () => { browser = await type.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  async function open(w, h, couple = true, partner = 'Alexandria Rae') {
    const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
    await context.addInitScript((s) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in s) localStorage.setItem('cycle:' + k, JSON.stringify(s[k]));
    }, seed(couple, partner));
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    // Signed-out-of-couple flow needs the post-create sync to succeed (empty); every other screen treats backend calls as offline.
    await context.route('https://x.test/**', (route) => couple ? route.abort() : route.fulfill({ contentType: 'application/json', body: '[]' }));
    // Playwright tries the most recently registered route first, so the specific one goes last.
    await context.route('https://x.test/rest/v1/rpc/create_couple', (route) => route.fulfill({ contentType: 'application/json', body: '"K7M2QX9A4B7C"' }));
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(couple ? '[data-a="go:fight"]' : 'input[data-d="name"]');
    return { context, page };
  }
  // Tab-bar-less shortcut to a route: the delegated handler only needs a [data-a] element.
  async function nav(page, a) {
    await page.evaluate((a) => document.querySelector('main').insertAdjacentHTML('beforeend', `<span id="nv" data-a="${a}">x</span>`), a);
    await page.click('#nv');
  }
  const maxScroll = (page) => page.evaluate(() => { const s = document.querySelector('.scr'); s.scrollTop = s.scrollHeight; });

  for (const w of [375, 390]) {
    test(`invite code glyphs stay inside the box at ${w}px (12 chars)`, async () => {
      const { context, page } = await open(w, 667, false);
      await page.fill('input[data-d="name"]', 'Me');
      await page.click('[data-a="create"]');
      await page.waitForSelector('#invite-code');
      const m = await page.$eval('#invite-code', (e) => {
        const b = e.getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(e); const t = r.getBoundingClientRect();
        return { text: e.textContent, left: t.left - b.left, right: b.right - t.right, lines: Math.round(t.height / parseFloat(getComputedStyle(e).lineHeight)) };
      });
      assert.equal(m.text, 'K7M2QX9A4B7C');
      assert.ok(m.left >= 4 && m.right >= 4, JSON.stringify(m));
      assert.equal(m.lines, 1);
      await context.close();
    });
  }

  test('Log fight at 375x667: the last field clears the sticky Save pill at max scroll', async () => {
    const { context, page } = await open(375, 667);
    await page.click('[data-a="go:fight"]');
    await page.waitForSelector('[data-a="fightsave"]');
    await page.click('[data-a="chip:custom"]');
    await maxScroll(page);
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const lastInput = [...document.querySelectorAll('.p2.s2 main > section')].pop().querySelector('input').getBoundingClientRect();
      return { save: r('[data-a="fightsave"]'), lastInputBottom: lastInput.bottom, tabTop: r('.tabbar').top };
    });
    assert.ok(m.lastInputBottom <= m.save.top, `last field ${m.lastInputBottom} overlaps Save at ${m.save.top}`);
    assert.ok(m.save.bottom <= m.tabTop);
    await context.close();
  });

  // Real partner names (Esme / Oliver) plus the 14-char stress name: the "Ask <name> to" label and the Save pill must not clip.
  for (const partner of ['Esme', 'Oliver', 'Alexandria Rae']) for (const [w, h] of [[375, 667], [390, 844]]) {
    test(`Log fight label and Save do not clip "${partner}" at ${w}x${h}`, async () => {
      const { context, page } = await open(w, h, true, partner);
      await page.click('[data-a="go:fight"]');
      await page.waitForSelector('[data-a="fightsave"]');
      await maxScroll(page);
      const m = await page.evaluate(() => {
        const c = (e) => [e.scrollWidth, e.clientWidth];
        const lab = [...document.querySelectorAll('.p2.s2 main .lab')].pop();
        return { pn: c(lab.querySelector('.pn')), lab: c(lab), save: c(document.querySelector('[data-a="fightsave"]')) };
      });
      for (const k of ['pn', 'lab', 'save']) assert.ok(m[k][0] <= m[k][1], `${k} clipped: ${JSON.stringify(m)}`);
      await context.close();
    });
  }

  test('no check-in anywhere: Home has no card, Us no strip, Settings no time row, couple setup no time field', async () => {
    const { context, page } = await open(375, 667);
    const text = () => page.evaluate(() => document.querySelector('main').textContent);
    assert.ok(!/check-?in/i.test(await text()), 'Home mentions check-in');
    assert.equal(await page.locator('[data-a="go:today"], [data-a="checkin"]').count(), 0);
    await nav(page, 'go:more');
    assert.ok(!/check-?in/i.test(await text()), 'Us mentions check-ins');
    assert.equal(await page.locator('.wk').count(), 0);
    await nav(page, 'go:settings');
    assert.ok(!/check-?in/i.test(await text()), 'Settings mentions check-in');
    assert.equal(await page.locator('input[type="time"]').count(), 0);
    await context.close();
    const setup = await open(375, 667, false);
    assert.ok(!/check-?in/i.test(await setup.page.evaluate(() => document.querySelector('main').textContent)), 'couple setup mentions check-in');
    assert.equal(await setup.page.locator('input[type="time"]').count(), 0);
    await setup.context.close();
  });

  test('Settings at 375x667: bottom room above the tab bar matches the Us screen', async () => {
    const { context, page } = await open(375, 667);
    // Us no longer fills the screen once Kudos left it, so its free space is not its bottom padding;
    // only compare against Us when Us actually scrolls.
    const gap = () => page.evaluate(() => { const s = document.querySelector('.scr'); s.scrollTop = s.scrollHeight; return { scrolls: s.scrollHeight > s.clientHeight, gap: document.querySelector('.tabbar').getBoundingClientRect().top - [...s.querySelector('main').children].pop().getBoundingClientRect().bottom }; });
    await nav(page, 'go:more');
    const us = await gap();
    await nav(page, 'go:settings');
    const st = await gap();
    assert.ok(st.scrolls, 'Settings scrolls at 375x667');
    assert.ok(st.gap >= 20 && (!us.scrolls || st.gap >= us.gap), `settings ${JSON.stringify(st)} vs us ${JSON.stringify(us)}`);
    await context.close();
  });

  for (const w of [375, 390]) {
    test(`New to do "For" segment shows the full 14-char name at ${w}px`, async () => {
      const { context, page } = await open(w, 667);
      await nav(page, 'tab:todo');
      await nav(page, 'addpick'); await page.click('.bs [data-a="newtodo:task"]');
      await page.waitForSelector('[data-a="nfor:them"]');
      const m = await page.evaluate(() => { const pn = document.querySelector('[data-a="nfor:them"] .pn'); const seg = pn.closest('.seg'); const lab = document.querySelector('.frow .lab0'); return { full: pn.scrollWidth <= pn.clientWidth, segLeft: seg.getBoundingClientRect().left, labRight: lab.getBoundingClientRect().right, segRight: seg.getBoundingClientRect().right, vw: innerWidth }; });
      assert.ok(m.full, JSON.stringify(m));
      assert.ok(m.segLeft > m.labRight && m.segRight <= m.vw - 16, JSON.stringify(m));
      await context.close();
    });
  }

  test('New to do defaults to the partner; Habit adds Per and Times', async () => {
    const { context, page } = await open(390, 844);
    await nav(page, 'tab:todo');
    await nav(page, 'addpick'); await page.click('.bs [data-a="newtodo:task"]');
    await page.waitForSelector('[data-a="nfor:them"]');
    assert.ok(await page.$eval('[data-a="nfor:them"]', (e) => e.classList.contains('on')));
    const labs = () => page.$$eval('.frow .lab0', (l) => l.map((e) => e.textContent));
    assert.ok(!(await labs()).includes('Times'));
    await page.click('[data-a="nkind:habit"]');
    assert.ok((await labs()).includes('Times'));
    await context.close();
  });

  // Partner not joined yet: the For row is still shown (a partner ask is queued); For = You saves straight away.
  test('New to do saves for yourself before the partner has joined', async () => {
    const { context, page } = await open(390, 844, true, null);
    await nav(page, 'tab:todo');
    await nav(page, 'addpick'); await page.click('.bs [data-a="newtodo:task"]');
    await page.fill('input[data-d="title"]', 'Solo task');
    assert.ok(await page.$eval('[data-a="nfor:them"]', (e) => e.classList.contains('on')));
    await page.click('[data-a="nfor:me"]');
    await page.click('[data-a="savetodo"]');
    await page.waitForSelector('[data-todo] >> text=Solo task');
    assert.equal(await page.$('[data-a="savetodo"]'), null);
    await context.close();
  });

  test('New to do: optional description shows under the title; blank saves none', async () => {
    const { context, page } = await open(390, 844, true, null);
    await nav(page, 'tab:todo');
    await nav(page, 'addpick'); await page.click('.bs [data-a="newtodo:task"]');
    await page.click('[data-a="nfor:me"]');
    await page.fill('input[data-d="title"]', 'With desc');
    await page.fill('textarea[data-d="desc"]', '  Bring the receipt  ');
    await page.click('[data-a="savetodo"]');
    await page.waitForSelector('[data-todo] >> text=With desc');
    assert.equal(await page.$eval('[data-todo]:has-text("With desc") .tdd', (e) => e.textContent), 'Bring the receipt');
    await nav(page, 'addpick'); await page.click('.bs [data-a="newtodo:task"]');
    await page.click('[data-a="nfor:me"]');
    assert.equal(await page.$eval('textarea[data-d="desc"]', (e) => e.value), '');
    await page.fill('input[data-d="title"]', 'No desc');
    await page.click('[data-a="savetodo"]');
    await page.waitForSelector('[data-todo] >> text=No desc');
    assert.equal(await page.$('[data-todo]:has-text("No desc") .tdd'), null);
    await context.close();
  });

  test('Log fight sections are 22px apart (cycle.css wins over base.css 10px)', async () => {
    const { context, page } = await open(390, 844);
    await page.click('[data-a="go:fight"]');
    await page.waitForSelector('[data-a="fightsave"]');
    const gaps = await page.evaluate(() => { const s = [...document.querySelectorAll('.p2.s2 main > section')]; return s.slice(1).map((e, i) => e.getBoundingClientRect().top - s[i].getBoundingClientRect().bottom); });
    assert.deepEqual(gaps, gaps.map(() => 22));
    await context.close();
  });

  for (const sel of [3, 1, 5]) test(`Log fight intensity numerals clear the rule by >= 14px (selected ${sel}, 390px)`, async () => {
    const { context, page } = await open(390, 844);
    await page.click('[data-a="go:fight"]');
    await page.waitForSelector('[data-a="fightsave"]');
    await page.click(`[data-a="int:${sel}"]`);
    const gaps = await page.evaluate(() => {
      const rule = document.querySelector('.p2.s2 .arrows').getBoundingClientRect(), r = getComputedStyle(document.querySelector('.p2.s2 .arrows')).borderBottomWidth;
      return [...document.querySelectorAll('.p2.s2 .arrows b')].map((b) => rule.bottom - parseFloat(r) - b.getBoundingClientRect().bottom);
    });
    assert.equal(gaps.length, 5);
    gaps.forEach((g, i) => assert.ok(g >= 14, `numeral ${i + 1} gap ${g}px to the rule`));
    await context.close();
  });

  // Headless browsers report a 0 safe-area inset, so the device case is simulated by swapping env() for a real
  // top inset. The band is rotated -5deg, so its right end is its highest point and must clear the status icons
  // by >= 10px. Icon bottoms: y=32 on Oliver's 428pt notch phone (47px inset, measured from a device screenshot),
  // about y=37 on a Dynamic Island Pro (62px). With +12px padding the 47px phone measured a 2px gap.
  for (const [inset, iconsEnd] of [[47, 32], [62, 37]]) test(`Pink band clears the iOS status icons with a ${inset}px top inset`, async () => {
    const { context, page } = await open(393, 852);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS.replaceAll('env(safe-area-inset-top)', inset + 'px') }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="go:fight"]');
    const top = await page.evaluate(() => document.querySelector('.band').getBoundingClientRect().top);
    assert.ok(top >= iconsEnd + 10, `band top edge at y=${top}, icons end at y=${iconsEnd}`);
    await context.close();
  });

  // Home used to render with tab:false, so the bar vanished on Today; the bar is on every screen except modal flows.
  for (const w of [375, 430]) test(`tab bar stays on Home, To-dos round trip and pushed screens at ${w}px`, async () => {
    const { context, page } = await open(w, 844);
    const on = () => page.$$eval('.tabbar .tab.on', (t) => t.map((e) => e.dataset.a));
    const bar = () => page.evaluate(() => { const r = document.querySelector('.tabbar').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight, shown: r.height > 0 }; });
    assert.deepEqual(await on(), ['tab:home']);
    const b0 = await bar();
    assert.ok(b0.shown && Math.abs(b0.bottom - b0.vh) <= 1, JSON.stringify(b0));
    assert.equal(await page.locator('.usb').count(), 0);
    // Home's last content clears the bar at max scroll.
    await maxScroll(page);
    const gap = await page.evaluate(() => document.querySelector('.tabbar').getBoundingClientRect().top - [...document.querySelector('main').children].pop().getBoundingClientRect().bottom);
    assert.ok(gap >= 0, `Home last child overlaps the tab bar by ${-gap}px`);
    await page.click('.tabbar [data-a="tab:todo"]');
    assert.deepEqual(await on(), ['tab:todo']);
    await page.click('.tabbar [data-a="tab:home"]');
    assert.equal(await page.locator('.tabbar').count(), 1, 'tab bar vanished after To-dos -> Home');
    assert.deepEqual(await on(), ['tab:home']);
    assert.ok((await bar()).shown);
    await page.click('[data-a="tab:todo"]'); await page.click('[data-a="todoseg:rem"]');
    await page.waitForSelector('.nd .hd');
    assert.deepEqual(await on(), ['tab:todo']);
    await page.click('.tabbar [data-a="tab:progress"]');
    assert.deepEqual(await on(), ['tab:progress']);
    const b1 = await bar();
    assert.ok(b1.shown && Math.abs(b1.bottom - b1.vh) <= 1, JSON.stringify(b1));
    await context.close();
  });
});
