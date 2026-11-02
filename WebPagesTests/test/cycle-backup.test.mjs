// Backup privacy: the private tier must never be PUT to the box unless a cheap GET /backup said
// this user is the owner. Loads cycle-store.js the way the browser does, with fakes for the globals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './cycle-load.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web');
function loadStore(getStatus) {
  const calls = [];
  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, key: i => Object.keys(store)[i], get length() { return Object.keys(store).length; } };
  globalThis.window = globalThis;
  globalThis.window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: 'https://box.test' };
  globalThis.fetch = async (url, o) => { calls.push(o.method + ' ' + url); return { status: o.method === 'GET' ? getStatus : 200, ok: o.method === 'GET' ? getStatus === 200 : true }; };
  vm.runInThisContext(fs.readFileSync(path.join(dir, 'cycle-store.js'), 'utf8') + '\n;globalThis.__store = CycleStore;', { filename: 'cycle-store.js' });
  const st = globalThis.__store;
  st.S.session = { access_token: 't', refresh_token: 'r', expires_at: Date.now() / 1000 + 3600 };
  st.S.priv = { secret: 'vent text' };
  return { st, calls };
}

test('403 from GET /backup: no PUT is ever sent, for any number of saves', async () => {
  const { st, calls } = loadStore(403);
  await st.backup(); await st.backup(); await st.backup();
  assert.deepEqual(calls, ['GET https://box.test/backup']);
});

test('200 from GET /backup: probes once, then PUTs on every backup', async () => {
  const { st, calls } = loadStore(200);
  await st.backup(); await st.backup();
  assert.deepEqual(calls, ['GET https://box.test/backup', 'PUT https://box.test/backup', 'PUT https://box.test/backup']);
});

// Fresh-install guard: an empty device must not overwrite a non-empty box backup.
function loadStoreWithBody(status, body, priv) {
  const calls = [];
  const { st } = loadStore(200);
  globalThis.fetch = async (url, o) => {
    calls.push(o.method + ' ' + url);
    if (o.method === 'GET') return { status, ok: status === 200, text: async () => JSON.stringify(body) };
    return { status: 200, ok: true };
  };
  st.S.priv = priv;
  return { st, calls };
}
const EMPTY = { fights: [], nudges: [], nudge_sends: [], prefs: {}, queued: [], drafts: {} };

test('empty device + non-empty box backup: GET only, never PUT', async () => {
  const { st, calls } = loadStoreWithBody(200, { ...EMPTY, fights: [{ at: 1, intensity: 3 }] }, { ...EMPTY });
  await st.backup(); await st.backup();
  assert.deepEqual(calls, ['GET https://box.test/backup', 'GET https://box.test/backup']);
});

test('empty device + empty or missing box backup: PUT goes through', async () => {
  let r = loadStoreWithBody(200, EMPTY, { ...EMPTY });
  await r.st.backup();
  assert.deepEqual(r.calls, ['GET https://box.test/backup', 'PUT https://box.test/backup']);
  r = loadStoreWithBody(404, {}, { ...EMPTY });
  await r.st.backup();
  assert.deepEqual(r.calls, ['GET https://box.test/backup', 'PUT https://box.test/backup']);
});

test('non-empty device always PUTs over an existing backup', async () => {
  const { st, calls } = loadStoreWithBody(200, { ...EMPTY, fights: [{ at: 1 }] }, { ...EMPTY, fights: [{ at: 2 }] });
  await st.backup();
  assert.deepEqual(calls, ['GET https://box.test/backup', 'PUT https://box.test/backup']);
});
