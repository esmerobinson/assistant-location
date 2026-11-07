// Session robustness: single-flight refresh, persist-before-proceed, Keychain password fallback.
// Loads cycle-store.js the way the browser does, with a fake native bridge for kv + creds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './cycle-load.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web');
const user = { id: 'u1', email: 'a@b.test' };
const tokens = (n) => ({ access_token: 'at' + n, refresh_token: 'rt' + n, expires_in: 3600, user });

// opts.refresh: 'ok' | 'reject'; opts.creds: stored {email,password} or null
function load({ refresh = 'ok', creds = null } = {}) {
  const posts = [], kvw = [], cancelled = [], native = { creds, kv: {} };
  globalThis.window = globalThis;
  globalThis.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k' };
  globalThis.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
    queueMicrotask(() => {
      let r = null;
      if (cmd === 'store.get') r = native.kv[args.key] ?? null;
      else if (cmd === 'store.set') { native.kv[args.key] = args.value; kvw.push(args.key); }
      else if (cmd === 'creds.get') r = native.creds;
      else if (cmd === 'creds.set') native.creds = { email: args.email, password: args.password };
      else if (cmd === 'creds.clear') native.creds = null;
      else if (cmd === 'notify.cancel') cancelled.push(args.id);
      else throw new Error('unexpected bridge cmd ' + cmd);
      globalThis.__cycleReply(id, r, null);
    });
  } } } };
  let n = 0;
  globalThis.fetch = async (url, o) => {
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
      posts.push('refresh'); await new Promise(r => setTimeout(r, 20));
      if (refresh === 'reject') return { ok: false, status: 400, json: async () => ({ error_description: 'Invalid Refresh Token' }) };
      return { ok: true, status: 200, json: async () => tokens('R' + ++n) };
    }
    if (url.includes('/auth/v1/token?grant_type=password')) { posts.push('password'); return { ok: true, status: 200, json: async () => tokens('P' + ++n) }; }
    // api() now reads text() and requires a JSON content-type on a real answer, so the fake carries both.
    if (url.includes('/rest/v1/')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '[]', json: async () => [] };
    throw new Error('unexpected fetch ' + url);
  };
  vm.runInThisContext(fs.readFileSync(path.join(dir, 'cycle-store.js'), 'utf8') + '\n;globalThis.__store = CycleStore;', { filename: 'cycle-store.js' });
  const st = globalThis.__store;
  st.S.session = { access_token: 'old', refresh_token: 'rtOld', expires_at: Date.now() / 1000 + 5, user };
  return { st, posts, kvw, native };
}

test('N concurrent api() calls near expiry cause exactly one refresh POST', async () => {
  const { st, posts } = load();
  await Promise.all([1, 2, 3, 4, 5].map(() => st.api('GET', 'items?select=*')));
  assert.deepEqual(posts, ['refresh']);
  assert.equal(st.S.session.refresh_token, 'rtR1');
});

test('refresh is persisted before api() proceeds', async () => {
  const { st, native } = load();
  await st.api('GET', 'items?select=*');
  assert.equal(JSON.parse(native.kv.session).refresh_token, 'rtR1');
});

test('refresh rejected + stored creds: one password grant, session replaced and persisted', async () => {
  const { st, posts, native } = load({ refresh: 'reject', creds: { email: 'a@b.test', password: 'pw' } });
  await Promise.all([1, 2, 3].map(() => st.api('GET', 'items?select=*')));
  assert.deepEqual(posts, ['refresh', 'password']);
  assert.equal(st.S.session.refresh_token, 'rtP1');
  assert.equal(JSON.parse(native.kv.session).refresh_token, 'rtP1');
});

test('refresh rejected + no creds (web): the error surfaces and the dead session is signed out', async () => {
  const { st, posts, native } = load({ refresh: 'reject', creds: null });
  await assert.rejects(st.api('GET', 'items?select=*'), /Invalid Refresh Token/);
  assert.deepEqual(posts, ['refresh']);
  assert.equal(st.S.session, null);
  assert.equal(native.kv.session, null);
});

test('offline (fetch TypeError) does not fall back to the password', async () => {
  const { st, posts } = load({ creds: { email: 'a@b.test', password: 'pw' } });
  globalThis.fetch = async () => { posts.push('fetch'); throw new TypeError('Failed to fetch'); };
  await assert.rejects(st.api('GET', 'items?select=*'), TypeError);
  assert.deepEqual(posts, ['fetch']);
});

test('signIn stores creds, signOut clears them', async () => {
  const { st, native } = load();
  await st.signIn('a@b.test', 'pw').catch(() => {}); // post-login sync has no couple fixtures; only auth matters here
  assert.deepEqual(native.creds, { email: 'a@b.test', password: 'pw' });
  await st.signOut();
  assert.equal(native.creds, null);
});
