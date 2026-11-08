// The "New version" bar: shown only when the box's install page carries a newer NATIVE build (manifest.native) than the
// installed app reports through app.info; web-only changes never move that number. Quiet on every failure.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it. The native bridge is a page-side stub.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;
const SHOTS = process.env.SHOTS;

const UID = 'u-me', PID = 'u-her';
const seed = () => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Her', checkin_time: '21:00', hits_self: true }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_notes: {}, rewards: {}, redemptions: {}, acks: {}, fight_markers: {}, challenges: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // info: what app.info answers (an object), or null for an app too old to know the command (it answers with an error).
  // manifest: the box's /app/manifest.json body, or null to fail the fetch (offline).
  async function open({ info, manifest }) {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
    await context.addInitScript(({ sd, info }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test/cycle' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
      window.__calls = [];
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        window.__calls.push({ cmd, args });
        let r = null, err = null;
        if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
        else if (cmd === 'store.set') { if (args.value === null) localStorage.removeItem('cycle:' + args.key); else localStorage.setItem('cycle:' + args.key, args.value); }
        else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.indexOf('cycle:' + args.prefix) === 0).map((k) => k.slice(6));
        else if (cmd === 'notify.status') r = 'granted';
        else if (cmd === 'lock.get') r = false;
        else if (cmd === 'notify.permission') r = true;
        else if (cmd === 'app.info') { if (info) r = info; else err = 'unsupported bridge command app.info'; }
        else if (!['ready', 'notify.schedule', 'notify.cancel', 'app.openURL'].includes(cmd)) throw new Error('unexpected bridge cmd ' + cmd);
        setTimeout(() => window.__cycleReply(id, r, err), 0);
      } } } };
    }, { sd: seed(), info });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    // Anything else the app asks the box for (backup, push register) gets a quiet 404 so it cannot fail the run.
    await context.route('https://box.test/cycle/backup', (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }));
    await context.route('https://box.test/cycle/app/manifest.json', (route) => manifest ? route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(manifest) }) : route.abort());
    await context.route('https://box.test/cycle/install', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ url: 'https://box.test/cycle/get/tok/' }) }));
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tabbar');
    // The check is async after boot: wait for the app.info call, then let the manifest fetch and render settle.
    if (manifest !== undefined) await page.waitForFunction(() => window.__calls.some((x) => x.cmd === 'app.info')).catch(() => {});
    await page.waitForTimeout(400);
    return { context, page };
  }
  const bar = (page) => page.$('.updbar');

  test('a newer native build on the install page shows the bar with New version and Install on every tab', async () => {
    const { context, page } = await open({ info: { shell: 3, native: 100 }, manifest: { version: 1, native: 200 } });
    const el = await bar(page);
    assert.ok(el, 'bar shown');
    assert.equal((await el.textContent()).replace(/\s+/g, ' ').trim(), 'New versionInstall');
    for (const tab of ['fights', 'progress']) { await page.click(`[data-a="tab:${tab}"]`); assert.ok(await bar(page), 'bar on ' + tab); }
    if (SHOTS) { await page.click('[data-a="tab:home"]'); await page.screenshot({ path: path.join(SHOTS, 'banner-home.png') }); }
    await context.close();
  });

  test('Install asks the box for the install page url and opens it through the bridge', async () => {
    const { context, page } = await open({ info: { shell: 3, native: 100 }, manifest: { version: 1, native: 200 } });
    // Taps the label, not the pill: the whole bar is the target (a 32px pill alone is under the 44px minimum).
    await page.click('.updbar > span:first-child');
    await page.waitForFunction(() => window.__calls.some((x) => x.cmd === 'app.openURL'), null, { timeout: 3000 });
    assert.deepEqual(await page.evaluate(() => window.__calls.filter((x) => x.cmd === 'app.openURL').map((x) => x.args)), [{ url: 'https://box.test/cycle/get/tok/' }]);
    assert.ok(await bar(page), 'the bar stays until the app is updated');
    await context.close();
  });

  for (const [name, o] of [
    ['an equal native build', { info: { shell: 3, native: 200 }, manifest: { version: 1, native: 200 } }],
    ['an older native build on the box', { info: { shell: 3, native: 300 }, manifest: { version: 1, native: 200 } }],
    ['a web-only change (newer web version, same native)', { info: { shell: 3, native: 200 }, manifest: { version: 999, native: 200 } }],
    ['a manifest with no native field', { info: { shell: 3, native: 100 }, manifest: { version: 1 } }],
    ['an unstamped dev build (native 0)', { info: { shell: 3, native: 0 }, manifest: { version: 1, native: 200 } }],
    ['an app too old for app.info', { info: null, manifest: { version: 1, native: 200 } }],
    ['a failed manifest fetch', { info: { shell: 3, native: 100 }, manifest: null }],
  ]) test('no bar for ' + name, async () => {
    const { context, page } = await open(o);
    assert.equal(await bar(page), null);
    await context.close();
  });

  test('foreground re-checks: a build that lands while the app is open shows the bar', async () => {
    const { context, page } = await open({ info: { shell: 3, native: 100 }, manifest: { version: 1, native: 100 } });
    assert.equal(await bar(page), null);
    await context.unroute('https://box.test/cycle/app/manifest.json');
    await context.route('https://box.test/cycle/app/manifest.json', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ version: 1, native: 200 }) }));
    await page.evaluate(() => window.cycleNative.foreground());
    await page.waitForSelector('.updbar');
    await context.close();
  });
});
