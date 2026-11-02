// fight_ratings through the offline store: a rating goes out as a merge-upsert with only the grantable columns, and the
// intensities already on this phone (S.priv.fights) upload exactly once. Chromium, fake Supabase that records every request.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const UID = 'u-me', PID = 'u-her';
const iso = (h) => new Date(Date.now() - h * 36e5).toISOString();
const marker = (id, by, h) => ({ id, couple_id: 'c1', logged_by: by, at: iso(h), repaired_at: null, hit_self: null, hit_related: null, summary: null });

describe('fight_ratings store', () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  // A pull drops local rows the server does not return, so the fake server serves the seeded markers back.
  // `existing`: rating rows the fake server already holds (the upload must skip those fights).
  async function open({ priv = [], existing = [] } = {}) {
    const sh = {
      couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
      members: [{ user_id: UID, name: 'Alex', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Sam', checkin_time: '21:00', hits_self: true }],
      rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: { m1: marker('m1', UID, 30), m2: marker('m2', UID, 20), m3: marker('m3', PID, 10) }, fight_notes: {}, fight_ratings: {}, rewards: {}, redemptions: {}, challenges: {}, challenge_days: {}, challenge_breaks: {} },
      cursors: {}, outbox: [],
    };
    const seed = { session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } }, ['shared.' + UID]: sh, ['priv.' + UID]: { fights: priv, affirmations: [], prefs: {} } };
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript((sd) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
    }, seed);
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    const sent = [];
    await context.route('https://x.test/**', (route) => {
      const req = route.request(), u = new URL(req.url());
      const rec = { method: req.method(), path: u.pathname.replace('/rest/v1/', ''), search: u.search, prefer: req.headers().prefer, body: req.postData() ? JSON.parse(req.postData()) : null };
      sent.push(rec);
      if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rec.path === 'fight_ratings' ? existing : rec.path === 'fight_markers' ? Object.values(sh.rows.fight_markers) : rec.path === 'couples' ? [sh.couple] : rec.path === 'members' ? sh.members : []) });
      return route.fulfill({ status: req.method() === 'POST' ? 201 : 204, body: '' });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    return { context, page, sent };
  }
  const posts = (sent) => sent.filter((r) => r.method === 'POST' && r.path.startsWith('fight_ratings'));

  test('a rating is sent as a merge-upsert carrying only fight, user and intensity', async () => {
    const { context, page, sent } = await open();
    await page.waitForSelector('.rows .row, .tabs, nav');
    await page.evaluate(() => CycleStore.upsert('fight_ratings', { id: 'm3:u-me', fight_marker_id: 'm3', user_id: 'u-me', intensity: 4, updated_at: new Date().toISOString() }, 'fight_marker_id,user_id'));
    await page.waitForFunction(() => true); await page.waitForTimeout(1200);
    const p = posts(sent).find((r) => r.body.fight_marker_id === 'm3');
    assert.ok(p, 'upsert sent');
    assert.match(p.search, /on_conflict=fight_marker_id(,|%2C)user_id/);
    assert.match(p.prefer, /resolution=merge-duplicates/);
    assert.deepEqual(Object.keys(p.body).sort(), ['fight_marker_id', 'intensity', 'user_id']);
    await context.close();
  });

  test('re-rating before the first send replaces the queued upsert instead of queueing two', async () => {
    const { context, page } = await open();
    const n = await page.evaluate(() => {
      const row = (i) => ({ id: 'm3:u-me', fight_marker_id: 'm3', user_id: 'u-me', intensity: i, updated_at: new Date().toISOString() });
      CycleStore.S.outbox.length = 0; CycleStore.S.syncing = true; // hold the queue so nothing is in flight
      CycleStore.upsert('fight_ratings', row(2), 'fight_marker_id,user_id'); CycleStore.upsert('fight_ratings', row(5), 'fight_marker_id,user_id');
      return CycleStore.S.outbox.filter((o) => o.table === 'fight_ratings').map((o) => o.row.intensity);
    });
    assert.deepEqual(n, [5]);
    await context.close();
  });

  test('on-device intensities upload once for my own fights only, skipping fights already rated', async () => {
    const priv = [{ id: 'm1', at: Date.now() - 30 * 36e5, intensity: 4 }, { id: 'm2', at: Date.now() - 20 * 36e5, intensity: 2 }, { id: 'm3', at: Date.now() - 10 * 36e5, intensity: 5 }];
    const existing = [{ id: 'm2:u-me', fight_marker_id: 'm2', user_id: UID, intensity: 3, updated_at: iso(1) }];
    const { context, page, sent } = await open({ priv, existing });
    await page.waitForTimeout(2500);
    const got = posts(sent).map((r) => [r.body.fight_marker_id, r.body.intensity]);
    assert.deepEqual(got, [['m1', 4]], 'm2 already has my rating, m3 is not my fight');
    assert.equal(await page.evaluate(() => CycleStore.S.priv.ratingsUploaded), true);
    // a second load does not upload again
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    assert.equal(posts(sent).length, 1, 'no repeat upload');
    await context.close();
  });
});
