// The shared hold menu (voice-hold.js) on Cycle's dictation mics: hold a recording mic for Cancel / Insert. Native shell
// (bridge + speech) is faked; the field is the Log fight note.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const SHOTS = process.env.VHOLD_SHOTS || '';
const UID = 'u-me';
const seed = () => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Mia Park', checkin_time: '21:00', hits_self: false }, { user_id: 'u-her', name: 'Jo Lee', checkin_time: '21:00', hits_self: true }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, rewards: {}, redemptions: {}, fight_markers: {}, fight_notes: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

async function open() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((sd) => {
    window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k' };
    if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    window.__bridge = [];
    window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
      window.__bridge.push(cmd);
      setTimeout(() => {
        let r = null;
        if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
        else if (cmd === 'store.set') localStorage.setItem('cycle:' + args.key, args.value);
        else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.startsWith('cycle:' + args.prefix)).map((k) => k.slice(6));
        else if (cmd === 'notify.status') r = 'granted';
        else if (cmd === 'lock.get') r = false;
        window.__cycleReply(id, r, null);
      }, 0);
    } } } };
  }, seed());
  await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
  await context.route('https://x.test/**', (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.click('[data-a="go:fight"]');
  await page.waitForSelector('[data-a="mic:note"]');
  await page.fill('[data-d="note"]', 'We argued');
  return { context, page };
}
const hear = (page, text) => page.evaluate((t) => window.cycleNative.speech(t, false), text);
const stops = (page) => page.evaluate(() => window.__bridge.filter((c) => c === 'speech.stop').length);
const note = (page) => page.inputValue('[data-d="note"]');
async function startAndHear(page) {
  await page.click('[data-a="mic:note"]');
  await page.waitForSelector('.mic.rec[data-a="mic:note"]');
  await hear(page, 'at dinner');
}
// Press the mic, wait out the hold, slide to a target (or nowhere) and release.
async function hold(page, target) {
  const m = await page.locator('[data-a="mic:note"]').boundingBox();
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.vhold', { timeout: 1500 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cycle-vhold.png') });
  const labels = await page.$$eval('.vhold-t', (els) => els.map((e) => e.textContent));
  if (target) {
    const t = await page.locator(`.vhold-t[data-t="${target}"]`).boundingBox();
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 4 });
  }
  await page.mouse.up();
  return labels;
}

test('hold on a recording mic offers Cancel and Insert; Cancel puts the box back to before the mic', async () => {
  const { context, page } = await open();
  await startAndHear(page);
  assert.equal(await note(page), 'We argued at dinner');
  assert.deepEqual(await hold(page, 'cancel'), ['Cancel ✕', 'Insert ↵']);
  await page.waitForSelector('.mic:not(.rec)[data-a="mic:note"]');
  assert.equal(await note(page), 'We argued');
  assert.equal(await stops(page), 1);
  await hear(page, 'late words'); // a partial that arrives after the stop is dropped
  assert.equal(await note(page), 'We argued');
  assert.equal(await page.$('.vhold'), null);
  await context.close();
});

test('Insert stops and keeps what was heard; releasing elsewhere keeps recording; a plain tap still stops', async () => {
  const { context, page } = await open();
  await startAndHear(page);
  await hold(page, null);
  assert.equal(await page.$('.vhold'), null);
  assert.ok(await page.$('.mic.rec[data-a="mic:note"]'), 'still recording after releasing off the targets');
  assert.equal(await stops(page), 0);
  await hold(page, 'insert');
  await page.waitForSelector('.mic:not(.rec)[data-a="mic:note"]');
  assert.equal(await note(page), 'We argued at dinner');
  assert.equal(await stops(page), 1, 'one stop: the release click did not also run the tap action');
  await startAndHear(page);
  assert.equal(await note(page), 'We argued at dinner at dinner');
  await page.click('[data-a="mic:note"]');
  await page.waitForSelector('.mic:not(.rec)[data-a="mic:note"]');
  assert.equal(await note(page), 'We argued at dinner at dinner');
  await context.close();
});

test('no hold menu on a mic that is not recording', async () => {
  const { context, page } = await open();
  const m = await page.locator('[data-a="mic:note"]').boundingBox();
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  assert.equal(await page.$('.vhold'), null);
  await page.mouse.up();
  await context.close();
});

test('a recognizer restart after a pause keeps the earlier sentence; Cancel still restores the pre-dictation text', async () => {
  const { context, page } = await open();
  await page.click('[data-a="mic:note"]');
  await page.waitForSelector('.mic.rec[data-a="mic:note"]');
  await hear(page, 'A minute ago I went');
  await hear(page, 'A minute ago I went home');
  await hear(page, 'She starts to hit herself');
  assert.equal(await note(page), 'We argued A minute ago I went home She starts to hit herself');
  await hold(page, 'cancel');
  await page.waitForSelector('.mic:not(.rec)[data-a="mic:note"]');
  assert.equal(await note(page), 'We argued');
  await context.close();
});
