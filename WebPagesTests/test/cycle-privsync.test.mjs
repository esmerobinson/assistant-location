// Private-tier sync: the box backup is the shared copy across devices (pullPriv). Whole-doc last-writer-wins on
// S.priv.savedAt; a pull always finishes before backup() may PUT. WebKit for the UI case (GL_WEBKIT_PW/GL_WEBKIT_EXEC).
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './cycle-load.mjs';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web');

// ---- store-level cases (vm harness as in cycle-backup.test.mjs) ----
function load(getStatus, remote, priv) {
  const calls = [];
  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, key: i => Object.keys(store)[i], get length() { return Object.keys(store).length; } };
  globalThis.window = globalThis;
  globalThis.window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test' };
  globalThis.fetch = async (url, o) => {
    calls.push(o.method + ' ' + url + (o.method === 'PUT' ? ' ' + o.body : ''));
    if (o.method === 'GET') return { status: getStatus, ok: getStatus === 200, text: async () => JSON.stringify(remote) };
    return { status: 200, ok: true };
  };
  vm.runInThisContext(fs.readFileSync(path.join(webDir, 'cycle-store.js'), 'utf8') + '\n;globalThis.__store = CycleStore;', { filename: 'cycle-store.js' });
  const st = globalThis.__store;
  st.S.session = { access_token: 't', refresh_token: 'r', expires_at: Date.now() / 1000 + 3600, user: { id: 'u1' } };
  st.S.priv = priv;
  return { st, calls };
}
const EMPTY = { fights: [], nudges: [], nudge_sends: [], prefs: {}, queued: [], drafts: {} };
const puts = (calls) => calls.filter((c) => c.startsWith('PUT'));

test('local savedAt newer than remote: local kept, PUT sends local', async () => {
  const { st, calls } = load(200, { ...EMPTY, fights: [{ at: 1 }], savedAt: 100 }, { ...EMPTY, fights: [{ at: 2 }], savedAt: 200 });
  await st.pullPriv(); await st.backup();
  assert.deepEqual(st.S.priv.fights, [{ at: 2 }]);
  assert.equal(puts(calls).length, 1);
  assert.match(puts(calls)[0], /"at":2/);
});

test('remote savedAt newer: local replaced', async () => {
  const { st } = load(200, { ...EMPTY, fights: [{ at: 1 }], savedAt: 300 }, { ...EMPTY, fights: [{ at: 2 }], savedAt: 200 });
  await st.pullPriv();
  assert.deepEqual(st.S.priv.fights, [{ at: 1 }]);
  assert.equal(st.S.priv.savedAt, 300);
});

test('403: no PUT ever, local untouched', async () => {
  const { st, calls } = load(403, {}, { ...EMPTY, fights: [{ at: 2 }], savedAt: 200 });
  await st.pullPriv(); await st.backup(); await st.backup();
  assert.deepEqual(calls, ['GET https://box.test/backup']);
  assert.deepEqual(st.S.priv.fights, [{ at: 2 }]);
});

test('privEmpty ignores ownupSince / ratingsUploaded: such a device does not PUT over a non-empty box', async () => {
  const { st, calls } = load(200, { ...EMPTY, fights: [{ at: 1 }] }, { ...EMPTY, ownupSince: 5, ratingsUploaded: true });
  await st.backup();
  assert.deepEqual(calls, ['GET https://box.test/backup']);
});

test('a save before the first pull resolves waits for it, then PUTs the pulled copy', async () => {
  const { st, calls } = load(200, { ...EMPTY, fights: [{ at: 1 }], savedAt: 300 }, { ...EMPTY });
  const pull = st.pullPriv();
  await st.backup(); await pull;
  assert.equal(puts(calls).length, 1);
  assert.match(puts(calls)[0], /"at":1/);
});

// ---- UI case ----
const URL_ = 'file://' + path.join(webDir, 'index.html');
const CSS = fs.readFileSync(path.join(webDir, 'cycle.css'), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  test('fresh web install + box backup with fights: Home Phase tile shows a phase, GET before any PUT', async () => {
    const uid = 'u-me';
    const fightAt = Date.now() - 36e5;
    const seed = {
      session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: uid, email: 'me@x.test' } },
      ['shared.' + uid]: {
        couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
        members: [{ user_id: uid, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: 'u-her', name: 'Her', checkin_time: '21:00', hits_self: true }],
        rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: { f1: { id: 'f1', couple_id: 'c1', logged_by: uid, at: new Date(fightAt).toISOString(), repaired_at: null, hit_self: null, hit_related: null } }, fight_notes: {}, rewards: {}, redemptions: {} },
        cursors: {}, outbox: [],
      },
    };
    const remote = { fights: [{ id: 'f1', at: fightAt, intensity: 3, logged_at: fightAt }], nudges: [], nudge_sends: [], prefs: {}, queued: [], drafts: {}, savedAt: Date.now() };
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, seed);
    const reqs = [];
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    await context.route('https://box.test/**', (route) => { reqs.push(route.request().method()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(remote) }); });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => { const t = [...document.querySelectorAll('.tile2')].find((e) => e.textContent.includes('Phase')); return t && !t.textContent.includes('None'); });
    assert.equal(reqs[0], 'GET');
    await context.close();
  });
});
