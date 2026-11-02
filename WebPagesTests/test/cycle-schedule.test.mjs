// Scheduled to dos: written at once, stamped with their future time T, invisible to both partners until T.
// Core logic is pure (vm-loaded); the screens, the save flow, Cancel and wanted() run in WebKit
// (set GL_WEBKIT_PW/GL_WEBKIT_EXEC, see ~/.claude/bin/cycle-webkit.sh); skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import C from './cycle-load.mjs';

const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-21T15:00:00Z'); // Wed 11:00 New York
const T = Date.parse('2026-10-23T13:00:00Z'); // Fri 09:00 New York
const iso = (ms) => new Date(ms).toISOString();
const ME = 'u-me', HER = 'u-her';
const couple = { id: 'c1', tz: TZ, created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };

describe('core', () => {
  test('isScheduled: future delivered_at / created_at is scheduled, now and past are not', () => {
    assert.equal(C.isScheduled({ created_at: iso(T) }, NOW), true);
    assert.equal(C.isScheduled({ created_at: iso(NOW) }, NOW), false);
    assert.equal(C.isScheduled({ created_at: iso(NOW - 1000) }, NOW), false);
    assert.equal(C.isScheduled({ created_at: iso(NOW), delivered_at: iso(T) }, NOW), true);
  });

  test('partner-bound schedule: delivered item (no held status) plus a todo stamped T; T clamps to now + hold', () => {
    const at = C.scheduleAt(couple, 'ask', T, NOW);
    assert.equal(at, T);
    const item = C.buildItem({ id: 'i1', couple, me: ME, to: HER, kind: 'ask', body: 'Bins', ask_type: 'task', now: NOW, at });
    assert.equal(item.status, 'delivered');
    assert.equal(item.held_until, null);
    assert.equal(item.delivered_at, iso(T));
    const todo = C.askToTodo(item, 't1', C.ms(item.delivered_at));
    assert.equal(todo.created_at, iso(T));
    assert.equal(todo.owner_id, HER);
    const ownup = C.askToTodo(C.buildItem({ id: 'i2', couple, me: ME, to: HER, kind: 'ask', body: 'Sorry', ask_type: 'ownup', now: NOW, at }), 'a1', T);
    assert.equal(ownup.created_at, iso(T));
    assert.equal(ownup.type, 'ownup');
    const early = C.scheduleAt(couple, 'ask', NOW + 10 * 60000, NOW);
    assert.equal(early, NOW + 60 * 60000);
    assert.equal(C.buildItem({ id: 'i3', couple, me: ME, to: HER, kind: 'ask', body: 'x', now: NOW }).status, 'held');
  });

  test('the ledger does not count a scheduled row before T', () => {
    const members = [{ user_id: ME, name: 'Me' }, { user_id: HER, name: 'Her' }];
    const todo = { id: 't1', type: 'task', title: 'Old', owner_id: ME, due_date: '2026-10-01', done_at: null, fight_marker_id: null, deleted_at: null, created_at: iso(T) };
    const rows = (t) => ({ members, items: [], todos: t, todo_events: [], fight_markers: [], redemptions: [], nudge_sends: [], nudge_awards: [] });
    const run = (t, now) => C.computeLedger(rows(t), { tz: TZ, now, since: '2026-10-21' });
    const overdue = (l) => JSON.stringify(l).split('overdue').length - 1;
    const early = run([todo], NOW);
    assert.equal(overdue(early), overdue(run([], NOW)));
    assert.equal(JSON.stringify(early), JSON.stringify(run([], NOW)));
    assert.notEqual(JSON.stringify(run([todo], T + 1000)), JSON.stringify(run([], T + 1000)));
  });

  test('needsYou hides a scheduled finished owning-up until T', () => {
    const ownup = { id: 'a1', type: 'ownup', owner_id: ME, title: 'x', deleted_at: null, created_at: iso(T), done_at: iso(T) };
    const s = (now) => ({ me: HER, now, items: [], redemptions: [], nudge_sends: [], nudge_replies: [], fight_markers: [], fight_notes: [], todos: [ownup], seen: [], since: 0 });
    const before = JSON.stringify(C.needsYou(s(NOW)));
    const after = JSON.stringify(C.needsYou(s(T + 1)));
    assert.notEqual(before, after);
    assert.ok(!before.includes('a1'));
  });
});

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;

const base = { couple_id: 'c1', updated_at: iso(NOW - 864e5), deleted_at: null };
const td = (id, o) => ({ ...base, id, owner_id: ME, created_by: ME, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task', due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null, created_at: iso(NOW - 864e5), ...o });
const item = (id, o) => ({ ...base, id, sender_id: ME, recipient_id: HER, kind: 'ask', body: id, ask_type: 'task', description: null, due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, origin: null, response_type: null, fight_marker_id: null, held_until: null, status: 'delivered', delivered_at: iso(T), opened_at: null, kept: null, created_at: iso(NOW - 6e4), ...o });
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open({ uid = ME, rows = {}, now = NOW, boxUrl = '' } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(now));
    const sd = {
      session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: uid, email: 'x@x.test' } },
      ['shared.' + uid]: { couple, members: [{ user_id: ME, name: 'Me', checkin_time: '21:00', hits_self: false }, { user_id: HER, name: 'Her', checkin_time: '21:00', hits_self: true }],
        rows: { items: byId(rows.items || []), todos: byId(rows.todos || []), todo_events: {}, checkins: {}, fight_markers: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {}, fight_notes: {}, challenges: {} }, cursors: {}, outbox: [] },
      ['priv.' + uid]: { fights: [], affirmations: [], prefs: {}, queued: [], nudges: [], nudge_sends: [] },
    };
    await context.addInitScript(([sd, boxUrl]) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
      window.__calls = [];
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        window.__calls.push({ cmd, args });
        let r = null;
        if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
        else if (cmd === 'store.set') { if (args.value === null) localStorage.removeItem('cycle:' + args.key); else localStorage.setItem('cycle:' + args.key, args.value); }
        else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.indexOf('cycle:' + args.prefix) === 0).map((k) => k.slice(6));
        else if (cmd === 'notify.status') r = 'granted';
        else if (cmd === 'lock.get') r = false;
        else if (cmd === 'notify.permission') r = true;
        setTimeout(() => window.__cycleReply && window.__cycleReply(id, r, null), 0);
      } } } };
    }, [sd, boxUrl]);
    await context.route('https://x.test/**', (r) => r.abort());
    const boxReqs = [];
    await context.route('https://box.test/**', (r) => { const q = r.request(); boxReqs.push({ method: q.method(), url: q.url(), auth: q.headers().authorization, body: q.postData() }); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
    const page = await context.newPage();
    page.boxReqs = boxReqs;
    page.on('pageerror', (e) => console.error('PAGEERROR', String(e)));
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="go:fight"]', { timeout: 8000 });
    return { context, page };
  }
  const act = (page, a) => page.evaluate((a) => { const m = document.querySelector('main'); m.insertAdjacentHTML('beforeend', `<span id="nv" data-a="${a}">x</span>`); const el = document.getElementById('nv'); el.click(); el.remove(); }, a);
  const text = (page) => page.evaluate(() => document.body.textContent);
  const outbox = async (page) => { await page.waitForTimeout(150); return page.evaluate(() => JSON.parse(localStorage.getItem('cycle:shared.' + JSON.parse(localStorage.getItem('cycle:session')).user.id)).outbox); };
  const clockTo = async (context, page, ms) => { await context.clock.setFixedTime(new Date(ms)); await page.evaluate(() => window.cycleNative.foreground()); };

  test('a scheduled self to do is hidden before T and visible after', async () => {
    const { context, page } = await open({ rows: { todos: [td('Plan trip', { created_at: iso(T) })] } });
    await act(page, 'tab:todo');
    let t = await text(page);
    assert.ok(t.includes('Scheduled') && t.includes('Plan trip'), 'sender sees it only under Scheduled');
    await clockTo(context, page, T + 1000);
    await act(page, 'tab:todo');
    t = await text(page);
    assert.ok(t.includes('Plan trip') && !t.includes('Scheduled'));
    await context.close();
  });

  test('a to do scheduled for her is hidden from her until T, listed for me as Scheduled with its time', async () => {
    const rows = { items: [item('i1')], todos: [td('Take bins', { owner_id: HER, item_id: 'i1', created_at: iso(T) })] };
    const her = await open({ uid: HER, rows });
    await act(her.page, 'tab:todo');
    assert.ok(!(await text(her.page)).includes('Take bins'));
    await clockTo(her.context, her.page, T + 1000);
    await act(her.page, 'tab:todo');
    assert.ok((await text(her.page)).includes('Take bins'));
    await her.context.close();
    const me = await open({ uid: ME, rows });
    await act(me.page, 'tab:todo');
    const t = await text(me.page);
    assert.ok(t.includes('Scheduled') && t.includes('Take bins') && t.includes('Fri 9:00am'), t);
    await me.context.close();
  });

  test('saving a to do for her with Later: delivered item (never held) + todo stamped T; early picks clamp to now + hold', async () => {
    const { context, page } = await open({});
    const setWhen = (d, t) => page.evaluate(([d, t]) => { for (const [k, v] of [['schD', d], ['schT', t]]) { const i = document.querySelector(`[data-d=${k}]`); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); } }, [d, t]);
    await act(page, 'tab:todo'); await act(page, 'addpick'); await act(page, 'newtodo:task');
    await page.fill('[data-d=title]', 'Take bins');
    await act(page, 'nwhen:later');
    await setWhen('2026-10-23', '09:00');
    await act(page, 'savetodo');
    let ob = await outbox(page);
    const item1 = ob.find((o) => o.table === 'items').row, todo1 = ob.find((o) => o.table === 'todos').row;
    assert.equal(item1.status, 'delivered'); assert.equal(item1.held_until, null); assert.equal(item1.delivered_at, iso(T));
    assert.equal(todo1.created_at, iso(T)); assert.equal(todo1.owner_id, HER);
    await act(page, 'addpick'); await act(page, 'newtodo:task');
    await page.fill('[data-d=title]', 'Soon');
    await act(page, 'nwhen:later');
    await setWhen('2026-10-21', '11:10');
    await act(page, 'savetodo');
    ob = await outbox(page);
    const soon = ob.filter((o) => o.table === 'todos').map((o) => o.row).find((r) => r.title === 'Soon');
    assert.equal(soon.created_at, iso(NOW + 60 * 60000));
    await context.close();
  });

  test('wanted(): only my own scheduled to do notifies locally; the partner\'s to dos come as remote push', async () => {
    const rows = { todos: [td('My own later', { created_at: iso(T) }), td('From her', { created_by: HER, created_at: iso(T) }), td('Gone', { created_at: iso(T), deleted_at: iso(NOW) })] };
    const { context, page } = await open({ uid: ME, rows });
    await page.waitForTimeout(800);
    const all = await page.evaluate(() => window.__calls.filter((x) => x.cmd.indexOf('notify') === 0).map((x) => ({ cmd: x.cmd, args: x.args })));
    const sched = JSON.stringify(all);
    assert.ok(sched.includes('My own later'), 'own scheduled to do missing in ' + sched);
    for (const b of ['From her', 'Gone']) assert.ok(!sched.includes(b), b + ' present in ' + sched);
    await context.close();
  });

  test('push token handoff: cycleNative.pushToken POSTs it to the box /push/register with the session bearer, once', async () => {
    const { context, page } = await open({ boxUrl: 'https://box.test' });
    await page.waitForTimeout(500);
    assert.deepEqual(page.boxReqs, [], 'nothing is sent before native hands over a token');
    await page.evaluate(() => window.cycleNative.pushToken('ab12cd34'));
    await page.waitForTimeout(500);
    assert.deepEqual(page.boxReqs.map((r) => [r.method, r.url, r.auth, JSON.parse(r.body)]), [['POST', 'https://box.test/push/register', 'Bearer t', { token: 'ab12cd34' }]]);
    await page.evaluate(() => window.cycleNative.pushToken('ab12cd34'));
    await page.waitForTimeout(300);
    assert.equal(page.boxReqs.length, 1, 'the same token for the same account is not re-registered');
    await page.evaluate(() => window.cycleNative.pushToken('ef56'));
    await page.waitForTimeout(300);
    assert.equal(page.boxReqs.length, 2);
    await context.close();
  });

  test('Cancel soft-deletes the todo and its item', async () => {
    const rows = { items: [item('i1')], todos: [td('Take bins', { owner_id: HER, item_id: 'i1', created_at: iso(T) })] };
    const { context, page } = await open({ rows });
    await act(page, 'tab:todo');
    await page.click('[data-a="schedcancel:Take bins"]');
    assert.ok(!(await text(page)).includes('Take bins'));
    const ob = await outbox(page);
    const patched = (table, id) => ob.some((o) => JSON.stringify(o).includes(table) && JSON.stringify(o).includes(id) && JSON.stringify(o).includes('deleted_at'));
    assert.ok(patched('todos', 'Take bins') && patched('items', 'i1'), JSON.stringify(ob));
    await context.close();
  });
});
