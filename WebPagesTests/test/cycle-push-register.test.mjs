// Push registration through the native handshake. The stub below copies CycleBridge.m's gate: the token is held
// until the page sends the `ready` command, and only then handed over via cycleNative.pushToken. The page once
// never sent `ready`, so no phone ever reached POST /push/register and the box had nobody to push to.
// WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
// Same override cycle-notify uses: the #fx particle layer's animation hangs headless WebKit on software GL (the page
// froze after its first request and eventually crashed), so hide it. Not a production concern.
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;

const UID = 'u-me', TOKEN = 'ab'.repeat(32);
const seed = {
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: 'u-her', name: 'Her', checkin_time: '21:00', hits_self: true }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_notes: {}, rewards: {}, redemptions: {}, acks: {}, fight_markers: {}, challenges: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
};

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  test('a signed-in phone hands its token to the box after the page sends ready', async () => {
    const context = await browser.newContext();
    await context.addInitScript(({ sd, token }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test/cycle' };
      for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        let r = null;
        if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
        else if (cmd === 'store.set') { if (args.value === null) localStorage.removeItem('cycle:' + args.key); else localStorage.setItem('cycle:' + args.key, args.value); }
        else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.indexOf('cycle:' + args.prefix) === 0).map((k) => k.slice(6));
        else if (cmd === 'notify.status') r = 'granted';
        else if (cmd === 'lock.get') r = false;
        else if (cmd === 'notify.permission') r = true;
        setTimeout(() => {
          window.__cycleReply(id, r, null);
          // CycleBridge.m: `ready` is the only thing that releases the held token.
          if (cmd === 'ready') window.cycleNative.pushToken(token);
        }, 0);
      } } } };
    }, { sd: seed, token: TOKEN });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    const registered = [];
    // The page is file:// and every fetch is cross-origin, so each fake host must answer CORS (incl. the preflight
    // that apikey/Authorization/Range headers trigger) or fetch rejects with a TypeError that sync() swallows as
    // "offline" and no request after the first ever happens.
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS' };
    // pull() overwrites the seeded couple with whatever GET couples returns, and registerPush only runs once a
    // couple exists, so the fake server must answer with the seeded couple/members and empty tables otherwise.
    const shared = seed['shared.' + UID];
    await context.route('https://x.test/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      const body = p.endsWith('/couples') ? [shared.couple] : p.endsWith('/members') ? shared.members : [];
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.route('https://box.test/**', (route) => {
      const rq = route.request();
      if (rq.method() === 'POST' && rq.url().endsWith('/push/register')) registered.push({ auth: rq.headers().authorization, body: rq.postDataJSON() });
      return route.fulfill({ status: rq.method() === 'OPTIONS' ? 204 : 200, headers: cors, contentType: 'application/json', body: '{"ok":true}' });
    });
    const page = await context.newPage();
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 100 && !registered.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(registered[0], { auth: 'Bearer t', body: { token: TOKEN } });
    await context.close();
  });
});
