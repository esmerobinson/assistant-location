// Raise issue: an ask item (origin 'issue') held until 08:00 the next day, never auto-delivered, sent only when its
// sender confirms the Still send? card. WebKit only (set GL_WEBKIT_PW/GL_WEBKIT_EXEC); skipped without it.
// ISSUE_SHOTS=<dir> saves phone-size screenshots of the list, the compose screen and the still sheet.
// The native bridge is a page-side stub (kv in localStorage, calls recorded in window.__calls) so the local
// notifications the app schedules can be read back. The backend is aborted: every write is read from the store itself.
// The partner's RLS (held items invisible to the recipient) is a server rule and is covered in supabase/rls.test.mjs;
// here the partner's device is given the sender's rows to prove the CLIENT shows the recipient nothing either.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const haveWebkit = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = haveWebkit ? await import(process.env.GL_WEBKIT_PW) : null;
const SHOTS = process.env.ISSUE_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ME = 'u-me', HER = 'u-her';
// Tue 26 Oct 21:00 New York (EDT), so the hold ends Wed 27 Oct 08:00 EDT = 12:00Z.
const NIGHT = '2026-10-27T01:00:00Z', HELD_UNTIL = '2026-10-27T12:00:00.000Z', LATER = '2026-10-27T18:00:00Z';

const seed = (who) => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: who, email: who + '@x.test' } },
  ['shared.' + who]: {
    // hold_ask_min 0: an ordinary ask is delivered at once, so only the issue override can explain a hold.
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 0, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: 'Alexandria Rae', checkin_time: '21:00' }],
    rows: { items: {}, todos: {}, todo_events: {}, checkins: {}, fight_markers: {}, fight_notes: {}, rewards: {}, redemptions: {}, nudges: {}, nudge_sends: {}, nudge_replies: {}, nudge_awards: {}, acks: {}, challenges: {} },
    cursors: {}, outbox: [],
  },
  ['priv.' + who]: { fights: [], affirmations: [], prefs: {}, nudges: [], nudge_sends: [] },
});

describe('webkit', { skip: !haveWebkit }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  // sd: the localStorage dump to start from (a previous session's state, or a fresh seed).
  async function open({ sd, at = NIGHT } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(at));
    await context.addInitScript(({ sd }) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
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
        else if (!['ready', 'notify.schedule', 'notify.cancel', 'app.openSettings', 'haptic'].includes(cmd)) throw new Error('unexpected bridge cmd ' + cmd);
        setTimeout(() => window.__cycleReply(id, r, null), 0);
      } } } };
    }, { sd: sd || seed(ME) });
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="row:issue"]');
    return { context, page };
  }
  const dump = async (page) => { await page.waitForTimeout(500); return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('cycle:')).map((k) => [k.slice(6), JSON.parse(localStorage.getItem(k))]))); };
  const rowsOf = async (page, who, t) => Object.values((await dump(page))['shared.' + who].rows[t]);
  const issues = async (page, who = ME) => (await rowsOf(page, who, 'items')).filter((i) => i.origin === 'issue');
  const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name) });

  async function raise(page, text, type = 'apologize') {
    if (await page.$('[data-a="row:issue"]')) await page.click('[data-a="row:issue"]'); // else already on the list
    await page.click('[data-a="issuenew"]');
    await page.fill('[data-d="ibody"]', text);
    if (type !== 'apologize') await page.click(`[data-a="itype:${type}"]`);
    await page.click('[data-a="issuesave"]');
    await page.waitForSelector('.plus[data-a="issuenew"]');
  }
  // Same couple, other phone: the sender's stored state re-keyed to the partner.
  const asPartner = (d) => ({ ...seed(HER), 'shared.u-her': { ...d['shared.u-me'] } });

  test('raising an issue holds it until 08:00 next day even with Ask hold 0; the partner sees nothing', async () => {
    const { context, page } = await open();
    assert.match(await page.textContent('[data-id="issue"]'), /Raise issue[\s\S]*None/);
    assert.equal((await page.$$eval('.rows .row', (e) => e.map((x) => x.dataset.id)))[0], 'issue', 'first Home row');
    // Empty text: nothing is written.
    await page.click('[data-a="row:issue"]'); await page.click('[data-a="issuenew"]');
    assert.equal(await page.$('.tabbar, [data-a^="tab:"]'), null, 'no tab bar while composing');
    await shot(page, '2-compose.png');
    await page.click('[data-a="issuesave"]');
    assert.deepEqual(await issues(page), []);
    await page.fill('[data-d="ibody"]', 'You dropped the plan and said nothing');
    await page.click('[data-a="issuesave"]');
    await page.waitForSelector('.plus[data-a="issuenew"]');
    const [it] = await issues(page);
    assert.deepEqual([it.kind, it.status, it.origin, it.response_type, it.ask_type, it.needs_note, it.held_until, it.delivered_at, it.recipient_id, it.points_earn, it.due_date],
      ['ask', 'held', 'issue', 'apologize', 'ownup', true, HELD_UNTIL, null, HER, null, null]);
    assert.deepEqual(await rowsOf(page, ME, 'todos'), [], 'no to do for the partner until sent');
    assert.match(await page.textContent('.held'), /You dropped the plan/);
    await shot(page, '1-issues.png');
    // Notification: the issue's own wording, at the end of the hold.
    const sched = (await page.evaluate(() => window.__calls.filter((c) => c.cmd === 'notify.schedule').map((c) => c.args))).filter((a) => a.id === 'held-' + it.id);
    assert.equal(sched.at(-1).title, 'Do you still want to send this?');
    assert.equal(sched.at(-1).body, 'You dropped the plan and said nothing');
    assert.equal(sched.at(-1).route, 'held/' + it.id);
    // Partner's phone: not in her list, no card.
    const d = await dump(page);
    const her = await open({ sd: asPartner(d) });
    assert.match(await her.page.textContent('[data-id="issue"]'), /None/);
    await her.page.click('[data-a="row:issue"]');
    assert.doesNotMatch(await her.page.textContent('main'), /dropped the plan/);
    await her.context.close(); await context.close();
  });

  test('before 08:00 Send is refused; past held_until it stays held, the card shows, Edit then Send delivers an ownup', async () => {
    const a = await open();
    await raise(a.page, 'You dropped the plan', 'apologize');
    const d = await dump(a.page);
    const [it] = await issues(a.page);
    await a.page.click(`[data-a="still:${it.id}"]`);
    assert.match(await a.page.getAttribute(`[data-a="deliver:${it.id}"]`, 'class'), /\bdis\b/, 'Send looks disabled');
    // The CSS blocks taps on a disabled Send; dispatch the click anyway so the action's own guard is what is tested.
    await a.page.dispatchEvent(`[data-a="deliver:${it.id}"]`, 'click');
    assert.equal((await issues(a.page))[0].status, 'held', 'Send before the morning does not deliver');
    assert.deepEqual(await rowsOf(a.page, ME, 'todos'), []);
    await a.context.close();

    const b = await open({ sd: d, at: LATER });
    assert.equal((await issues(b.page))[0].status, 'held', 'nothing auto-delivers once held_until passes');
    assert.match(await b.page.textContent(`[data-a="still:${it.id}"]`), /You dropped the plan/, 'Home card shows the issue text');
    await b.page.click(`[data-a="still:${it.id}"]`);
    assert.equal(await b.page.textContent('.sheetlayer .bsh h3'), 'Still send?');
    await shot(b.page, '3-still.png');
    await b.page.click(`[data-a="edit:${it.id}"]`);
    await b.page.fill('[data-d="edit"]', 'You dropped the plan and said nothing at all');
    await b.page.click(`[data-a="editsave:${it.id}"]`);
    assert.equal((await issues(b.page))[0].body, 'You dropped the plan and said nothing at all');
    await b.page.click(`[data-a="deliver:${it.id}"]`);
    const [sent] = await issues(b.page);
    assert.equal(sent.status, 'delivered');
    const [todo] = await rowsOf(b.page, ME, 'todos');
    assert.deepEqual([todo.type, todo.owner_id, todo.created_by, todo.item_id, todo.needs_note, todo.title], ['ownup', HER, ME, it.id, true, 'You dropped the plan and said nothing at all']);
    await b.context.close();
  });

  test('a Change issue delivers a task; Drop delivers nothing', async () => {
    const a = await open();
    await raise(a.page, 'Please text when late', 'change');
    await raise(a.page, 'Second thought', 'apologize');
    const d = await dump(a.page);
    const [chg, drp] = [(await issues(a.page)).find((i) => i.body === 'Please text when late'), (await issues(a.page)).find((i) => i.body === 'Second thought')];
    await a.context.close();
    const b = await open({ sd: d, at: LATER });
    await b.page.click(`[data-a="still:${chg.id}"]`);
    await b.page.click(`[data-a="deliver:${chg.id}"]`);
    await b.page.click(`[data-a="still:${drp.id}"]`);
    await b.page.click(`[data-a="drop:${drp.id}"]`);
    const todos = await rowsOf(b.page, ME, 'todos');
    assert.deepEqual(todos.map((t) => [t.type, t.item_id, t.needs_note]), [['task', chg.id, false]]);
    assert.deepEqual((await issues(b.page)).map((i) => [i.body, i.status]).sort(), [['Please text when late', 'delivered'], ['Second thought', 'dropped']]);
    await b.page.click('[data-a="row:issue"]');
    assert.doesNotMatch(await b.page.textContent('main'), /Second thought/, 'dropped issues are hidden');
    assert.match(await b.page.textContent('main'), /Please text when late[\s\S]*Change[\s\S]*Open/);
    await b.context.close();
  });
});
