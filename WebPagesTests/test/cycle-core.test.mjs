import test from 'node:test';
import assert from 'node:assert/strict';
import C from './cycle-load.mjs';

const TZ = 'America/New_York'; // EDT (UTC-4) through 2026-11-01
// 2026-10-19 is a Monday. at('2026-10-20', 14) = Tue 14:00 New York time.
const at = (day, h = 12, m = 0) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`);
const iso = (day, h, m) => new Date(at(day, h, m)).toISOString();
const ME = 'u-me', YOU = 'u-you';
const members = [{ user_id: ME, name: 'Alex' }, { user_id: YOU, name: 'Sam' }];
const rows = (o = {}) => ({ members, items: [], todos: [], todo_events: [], fight_markers: [], redemptions: [], nudge_sends: [], nudge_awards: [], challenges: [{ id: 'no-hit', name: 'No hitting', start: '2026-10-26', for_user: 'u1', accepted_at: '2026-10-25T12:00:00Z' }], ...o });
const L = (r, now, since = '2026-10-19') => C.computeLedger(r, { tz: TZ, now, since });
const kudo = (id, sender, d, h) => ({ id, kind: 'kudos', status: 'delivered', sender_id: sender, recipient_id: sender === ME ? YOU : ME, delivered_at: iso(d, h), created_at: iso(d, h), deleted_at: null });
const todo = (o) => ({ id: 't1', type: 'task', title: 'Book flight', due_date: null, done_at: null, fight_marker_id: null, deleted_at: null, ...o });

test('week runs Monday to Sunday in the couple tz', () => {
  assert.equal(C.weekStart('2026-10-25'), '2026-10-19'); // Sunday -> Monday before
  assert.equal(C.weekStart('2026-10-26'), '2026-10-26');
  // 23:30 Sunday NY is already Monday in UTC: it must still count for the old week.
  const r = rows({ items: [kudo('a', ME, '2026-10-25', 23), kudo('b', ME, '2026-10-26', 0)] });
  const l = L(r, at('2026-10-26', 12), '2026-10-26'); // since = Monday so no calm days before
  assert.equal(l.weeks['2026-10-19'].days['2026-10-25'].lines.filter((x) => x.label === 'Kudos').length, 1);
  assert.equal(l.weeks['2026-10-26'].days['2026-10-26'].lines.filter((x) => x.label === 'Kudos').length, 1);
});

test('kudos cap is 3 per sender per day, other sender counts separately', () => {
  const items = [1, 2, 3, 4, 5].map((i) => kudo('m' + i, ME, '2026-10-20', 8 + i)).concat([kudo('y1', YOU, '2026-10-20', 9)]);
  const l = L(rows({ items }), at('2026-10-20', 22), '2026-10-20');
  const lines = l.weeks['2026-10-19'].days['2026-10-20'].lines.filter((x) => x.label === 'Kudos');
  assert.equal(lines.length, 4); // 3 from me + 1 from you
});

test('overdue applies once and replaces the on-time bonus when done late', () => {
  const t = todo({ due_date: '2026-10-20' });
  const l = L(rows({ todos: [t] }), at('2026-10-23', 10), '2026-10-23');
  const all = Object.values(l.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'To do overdue');
  assert.equal(all.length, 1);
  assert.equal(all[0].pts, -3);
  // Recomputing later (same rows, later now) must not add a second penalty.
  const l2 = L(rows({ todos: [t] }), at('2026-10-30', 10), '2026-10-23');
  const all2 = Object.values(l2.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'To do overdue');
  assert.equal(all2.length, 1);
  const late = todo({ due_date: '2026-10-20', done_at: iso('2026-10-22', 9) });
  const l3 = L(rows({ todos: [late] }), at('2026-10-23', 10), '2026-10-23');
  const labels = Object.values(l3.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).map((x) => x.label);
  assert.ok(labels.includes('To do overdue'));
  assert.ok(!labels.includes('To do on time'));
});

test('to do not yet due is neutral, done on the due day is +3', () => {
  const l = L(rows({ todos: [todo({ due_date: '2026-10-23' })] }), at('2026-10-23', 10), '2026-10-23');
  assert.equal(l.balance, 0);
  const done = todo({ due_date: '2026-10-23', done_at: iso('2026-10-23', 9) });
  assert.equal(L(rows({ todos: [done] }), at('2026-10-23', 10), '2026-10-23').balance, 3);
});

test('a fight week can go negative; fight is -5 plus 1 for logging, no calm day on it', () => {
  const r = rows({ fight_markers: [{ id: 'f1', at: iso('2026-10-19', 21), logged_by: ME }] });
  const l = L(r, at('2026-10-20', 12), '2026-10-19');
  assert.equal(l.weeks['2026-10-19'].net, -4);
  assert.equal(l.balance, -4);
  assert.equal(l.current.net, -4);
});

test('calm day only after the day fully elapsed, never on a fight day', () => {
  const l = L(rows(), at('2026-10-21', 12), '2026-10-19'); // Mon, Tue elapsed; Wed is today
  assert.equal(l.balance, 6);
  assert.ok(!l.weeks['2026-10-19'].days['2026-10-21']);
});

test('approved redemptions subtract, pending and declined do not; balance may go negative', () => {
  const base = rows({ items: [kudo('k', ME, '2026-10-19', 9)] }); // +1
  const red = (id, status, price) => ({ id, status, price, reward_id: 'r', decided_at: iso('2026-10-20', 9), requested_by: ME });
  const now = at('2026-10-19', 22);
  assert.equal(L({ ...base, redemptions: [red('a', 'pending', 50), red('b', 'declined', 50)] }, now).balance, 1);
  const l = L({ ...base, redemptions: [red('a', 'approved', 50)] }, now);
  assert.equal(l.balance, -49);
  assert.equal(l.spent, 50);
  assert.equal(l.current.net, 1); // redemptions are not part of the week's net
});

test('no check-in points exist: rows with a checkins list change nothing', () => {
  const base = L(rows(), at('2026-10-21', 9));
  const withCk = L(rows({ checkins: [{ user_id: ME, day: '2026-10-20' }, { user_id: YOU, day: '2026-10-20' }] }), at('2026-10-21', 9));
  assert.deepEqual(withCk, base);
  assert.ok(!JSON.stringify(withCk).includes('heck-in'));
});

test('partner nudge: opened same day +1, unopened after its day -1, today pending and future are neutral', () => {
  const f = (id, d, opened, h = 9) => ({ id, nudge_id: 'n', sender_id: YOU, recipient_id: ME, deliver_at: iso(d, h), opened_at: opened, deleted_at: null });
  const now = at('2026-10-22', 12);
  assert.equal(L(rows({ nudge_sends: [f('a', '2026-10-20', iso('2026-10-20', 20))] }), now, '2026-10-22').balance, 1);
  assert.equal(L(rows({ nudge_sends: [f('a', '2026-10-20', null)] }), now, '2026-10-22').balance, -1);
  assert.equal(L(rows({ nudge_sends: [f('a', '2026-10-22', null)] }), now, '2026-10-22').balance, 0);
  assert.equal(L(rows({ nudge_sends: [f('a', '2026-10-22', null, 18)] }), at('2026-10-23', 12), '2026-10-23').balance, -1); // queued for later today, then unopened by midnight
  assert.equal(L(rows({ nudge_sends: [f('a', '2026-10-23', null, 8)] }), now, '2026-10-22').balance, 0); // not delivered yet
});

// ---- nudges: 8 pm rule and library sections -------------------------------------
test('deliverAt: before 20:00 is immediate, at/after 20:00 is 08:00 next day in the recipient tz', () => {
  const LA = 'America/Los_Angeles';
  const t1959 = at('2026-10-20', 19, 59), t2000 = at('2026-10-20', 20, 0);
  assert.equal(C.deliverAt(t1959, TZ, TZ), t1959);
  assert.equal(C.deliverAt(t2000, TZ, TZ), at('2026-10-21', 8));
  assert.equal(C.deliverAt(t2000, TZ, LA), Date.parse('2026-10-21T08:00:00-07:00'));
  assert.equal(C.deliverAt(at('2026-10-20', 23, 59), TZ, TZ), at('2026-10-21', 8));
  assert.equal(C.deliverAt(at('2026-10-21', 0, 5), TZ, TZ), at('2026-10-21', 0, 5)); // past midnight, new day, before 20:00
});

test('deliverAt: DST change day (fall back 2026-11-01 in New York)', () => {
  // Sat 20:30 EDT -> Sunday 08:00 is already EST (UTC-5); Sunday 20:30 EST -> Monday 08:00 EST.
  assert.equal(C.deliverAt(Date.parse('2026-10-31T20:30:00-04:00'), TZ, TZ), Date.parse('2026-11-01T08:00:00-05:00'));
  assert.equal(C.deliverAt(Date.parse('2026-11-01T20:30:00-05:00'), TZ, TZ), Date.parse('2026-11-02T08:00:00-05:00'));
  assert.equal(C.deliverAt(Date.parse('2026-11-01T19:59:00-05:00'), TZ, TZ), Date.parse('2026-11-01T19:59:00-05:00'));
  // Spring forward 2026-03-08: Sat 21:00 EST -> Sunday 08:00 EDT (UTC-4)
  assert.equal(C.deliverAt(Date.parse('2026-03-07T21:00:00-05:00'), TZ, TZ), Date.parse('2026-03-08T08:00:00-04:00'));
});

test('sectionNudges: Pinned / Recent (4, unpinned) / All with no nudge in two sections; archived hidden', () => {
  const mk = (id, d, o = {}) => ({ id, created_at: iso(d, 9), sort_order: +id.slice(1), pinned: false, archived_at: null, deleted_at: null, ...o });
  const ns = [mk('n1', '2026-10-01', { pinned: true }), mk('n2', '2026-10-02'), mk('n3', '2026-10-03'), mk('n4', '2026-10-04'),
    mk('n5', '2026-10-05'), mk('n6', '2026-10-06'), mk('n7', '2026-10-07', { archived_at: iso('2026-10-08', 9) }), mk('n8', '2026-10-01', { pinned: true })];
  const sends = [{ nudge_id: 'n2', created_at: iso('2026-10-20', 9), deleted_at: null }];
  const s = C.sectionNudges(ns, sends);
  assert.deepEqual(s.pinned.map((n) => n.id), ['n1', 'n8']);
  assert.deepEqual(s.recent.map((n) => n.id), ['n2', 'n6', 'n5', 'n4']); // n2 resurfaces because it was sent last
  assert.deepEqual(s.all.map((n) => n.id), ['n3']);
  const ids = [...s.pinned, ...s.recent, ...s.all].map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('n7'));
});

test('repair: response to do done within 48h of its marker is +5, later is nothing', () => {
  const m = { id: 'f1', at: iso('2026-10-20', 21), logged_by: ME };
  const resp = (done) => todo({ id: 'r1', type: 'response', fight_marker_id: 'f1', done_at: done });
  const now = at('2026-10-23', 12);
  const withRepair = L(rows({ fight_markers: [m], todos: [resp(iso('2026-10-22', 20))] }), now, '2026-10-23');
  const late = L(rows({ fight_markers: [m], todos: [resp(iso('2026-10-22', 22))] }), now, '2026-10-23');
  assert.equal(withRepair.balance - late.balance, 5);
});

test('habit tally is +1 per event', () => {
  const t = todo({ id: 'h', type: 'habit', target: 10 });
  const ev = [1, 2, 3].map((i) => ({ id: 'e' + i, todo_id: 'h', kind: 'tally', at: iso('2026-10-22', 8 + i) }));
  assert.equal(L(rows({ todos: [t], todo_events: ev }), at('2026-10-22', 20), '2026-10-22').balance, 3);
});

test('computeLedger refuses to guess missing options', () => {
  assert.throws(() => C.computeLedger(rows(), { tz: TZ, now: 1 }), /needs tz, now, since/);
});

test('both phones compute an identical ledger from the same rows', () => {
  const r = rows({ items: [kudo('a', ME, '2026-10-20', 10)] });
  assert.deepEqual(L(r, at('2026-10-22', 9)), L(JSON.parse(JSON.stringify(r)), at('2026-10-22', 9)));
});

test('groupWeek sums by label and splits earned / lost', () => {
  const r = rows({ items: [kudo('k1', ME, '2026-10-19', 9), kudo('k2', YOU, '2026-10-19', 9)], fight_markers: [{ id: 'f', at: iso('2026-10-20', 20), logged_by: ME }] });
  const g = C.groupWeek(L(r, at('2026-10-21', 9)).weeks['2026-10-19']);
  assert.deepEqual(g.earned.find((x) => x.label === 'Kudos'), { label: 'Kudos', pts: 2 });
  assert.deepEqual(g.lost, [{ label: 'Fight', pts: -5 }]);
});

// ---- holds ------------------------------------------------------------------
test('dueInfo: late, today, tomorrow, later', () => {
  const f = (d) => 'F' + d;
  assert.deepEqual(C.dueInfo('2026-10-29', '2026-10-30', f), { text: '1 day late', state: 'late' });
  assert.deepEqual(C.dueInfo('2026-09-30', '2026-10-30', f), { text: '30 days late', state: 'late' });
  assert.deepEqual(C.dueInfo('2026-10-30', '2026-10-30', f), { text: 'Due today', state: 'soon' });
  assert.deepEqual(C.dueInfo('2026-10-31', '2026-10-30', f), { text: 'Due tomorrow', state: 'soon' });
  assert.deepEqual(C.dueInfo('2026-11-02', '2026-10-30', f), { text: 'Due F2026-11-02', state: '' });
  // DST changes that fall inside the span must not shift the day count (dates parse as UTC, so they can't).
  assert.equal(C.dueInfo('2026-11-02', '2026-11-01', f).text, 'Due tomorrow');
});

test('hold math: held_until, countdown text, Held label', () => {
  const now = at('2026-10-20', 9);
  assert.equal(C.heldUntil(now, 720), now + 12 * 3600000);
  assert.equal(C.countdown(now + (11 * 60 + 42) * 60000, now), '11h 42m');
  assert.equal(C.countdown(now + (11 * 60 + 5) * 60000, now), '11h 05m');
  assert.equal(C.countdown(now + 52 * 60000, now), '52m');
  assert.equal(C.countdown(now + 30000, now), '1m');
  assert.equal(C.countdown(now, now), 'Ready');
  assert.equal(C.heldLabel({ held_until: iso('2026-10-21', 9), created_at: iso('2026-10-20', 9) }), 'Held 24h');
  assert.equal(C.heldLabel({ held_until: new Date(now + 720 * 60000).toISOString(), created_at: new Date(now).toISOString() }), 'Held 12h');
  assert.equal(C.heldLabel({ held_until: new Date(now + 60000).toISOString(), created_at: new Date(now).toISOString() }), 'Held 1m');
  assert.equal(C.heldLabel({ held_until: null, created_at: iso('2026-10-20', 9) }), null);
});

test('buildItem: held when the couple hold is > 0, delivered at once when 0', () => {
  const couple = { id: 'c', hold_focus_min: 60, hold_truth_min: 720, hold_ask_min: 720, hold_kudos_min: 0 };
  const now = at('2026-10-20', 9);
  const t = C.buildItem({ id: 'i1', couple, me: ME, to: YOU, kind: 'truth', body: 'x', now });
  assert.equal(t.status, 'held');
  assert.equal(Date.parse(t.held_until), now + 720 * 60000);
  assert.equal(t.delivered_at, null);
  const k = C.buildItem({ id: 'i2', couple, me: ME, to: YOU, kind: 'kudos', body: 'x', now });
  assert.equal(k.status, 'delivered');
  assert.equal(k.held_until, null);
  assert.equal(Date.parse(k.delivered_at), now);
  assert.throws(() => C.holdMinutes(couple, 'nope'), /unknown item kind/);
});

test('askToTodo: recipient owns it, sender created it, item linked', () => {
  const couple = { id: 'c', hold_ask_min: 0, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
  const item = C.buildItem({ id: 'i', couple, me: ME, to: YOU, kind: 'ask', ask_type: 'habit', target: 5, body: 'Stretch', now: 1000 });
  const td = C.askToTodo(item, 'td', 1000);
  assert.deepEqual([td.owner_id, td.created_by, td.item_id, td.type, td.target, td.title], [YOU, ME, 'i', 'habit', 5, 'Stretch']);
  assert.equal(td.fight_marker_id, null);
});

test('askToTodo: a fight ask becomes a response todo on the fight marker', () => {
  const couple = { id: 'c', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
  const item = C.buildItem({ id: 'i', couple, me: ME, to: YOU, kind: 'ask', ask_type: 'task', body: 'Apologize', origin: 'fight', response_type: 'apologize', fight_marker_id: 'fm1', now: 1000 });
  assert.equal(item.status, 'held'); // the ask hold still applies
  assert.equal(item.fight_marker_id, 'fm1');
  const td = C.askToTodo(item, 'td', 1000);
  assert.deepEqual([td.type, td.fight_marker_id, td.owner_id], ['response', 'fm1', YOU]);
});

test('askToTodo carries the ask description; non-ask items never get one', () => {
  const couple = { id: 'c', hold_ask_min: 0, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
  const item = C.buildItem({ id: 'i', couple, me: ME, to: YOU, kind: 'ask', body: 'Call mom', description: 'About Sunday', now: 1000 });
  assert.equal(C.askToTodo(item, 'td', 1000).description, 'About Sunday');
  assert.equal(C.askToTodo(C.buildItem({ id: 'j', couple, me: ME, to: YOU, kind: 'ask', body: 'x', now: 1000 }), 'td', 1000).description, null);
  assert.equal(C.buildItem({ id: 'k', couple, me: ME, to: YOU, kind: 'kudos', body: 'x', description: 'y', now: 1000 }).description, null);
});

// ---- phase ------------------------------------------------------------------
test('phase: Fight / Cool / Warm / Tension from the fight log', () => {
  // fights Oct 1 and Oct 11 -> avg cycle 10 days, Warm until 6
  const fights = [{ at: at('2026-10-01', 20) }, { at: at('2026-10-11', 20) }];
  const P = (d) => C.phase(fights, at(d, 12), TZ);
  assert.equal(P('2026-10-11').name, 'Fight');
  assert.equal(P('2026-10-12').name, 'Cool');
  assert.equal(P('2026-10-13').name, 'Cool');
  assert.equal(P('2026-10-14').name, 'Warm');
  assert.equal(P('2026-10-16').name, 'Warm');
  assert.equal(P('2026-10-17').name, 'Tension');
  assert.equal(P('2026-10-13').day, 3);
  assert.equal(P('2026-10-13').avg, 10);
  assert.equal(C.phase([], 0, TZ), null);
});

// ---- needs you ----------------------------------------------------------------
test('needsYou: ready held, approvals for the non-requester, unread partner focus/kudos', () => {
  const now = at('2026-10-22', 21);
  const items = [
    { id: 'h1', kind: 'truth', sender_id: ME, recipient_id: YOU, status: 'held', held_until: iso('2026-10-22', 20), deleted_at: null },
    { id: 'h2', kind: 'truth', sender_id: ME, recipient_id: YOU, status: 'held', held_until: iso('2026-10-23', 20), deleted_at: null },
    { id: 'tr', kind: 'truth', sender_id: YOU, recipient_id: ME, status: 'delivered', delivered_at: iso('2026-10-22', 9), opened_at: null, deleted_at: null }
  ];
  const redemptions = [{ id: 'r1', status: 'pending', requested_by: YOU }, { id: 'r2', status: 'pending', requested_by: ME }];
  const sends = [
    { id: 's1', sender_id: YOU, recipient_id: ME, deliver_at: iso('2026-10-22', 9), opened_at: null, deleted_at: null },
    { id: 's2', sender_id: YOU, recipient_id: ME, deliver_at: iso('2026-10-22', 9), opened_at: iso('2026-10-22', 10), deleted_at: null },
    { id: 's3', sender_id: YOU, recipient_id: ME, deliver_at: iso('2026-10-23', 8), opened_at: null, deleted_at: null }, // not delivered yet
    { id: 's4', sender_id: ME, recipient_id: YOU, deliver_at: iso('2026-10-22', 9), opened_at: null, deleted_at: null } // mine, not a card
  ];
  const replies = [
    { id: 'p1', send_id: 's4', author_id: YOU, read_at: null, created_at: iso('2026-10-22', 11), deleted_at: null },
    { id: 'p2', send_id: 's4', author_id: YOU, read_at: null, created_at: iso('2026-10-22', 12), deleted_at: null },
    { id: 'p3', send_id: 's2', author_id: ME, read_at: null, created_at: iso('2026-10-22', 12), deleted_at: null },
    { id: 'p4', send_id: 's2', author_id: YOU, read_at: iso('2026-10-22', 13), created_at: iso('2026-10-22', 12), deleted_at: null }
  ];
  const n = C.needsYou({ me: ME, now, tz: TZ, items, redemptions, nudge_sends: sends, nudge_replies: replies, fight_markers: [], fight_notes: [], todos: [], seen: [], since: 0 });
  assert.deepEqual(n.map((x) => x.type), ['ready', 'approve', 'nudge', 'reply']);
  assert.equal(n[0].count, 1);
  assert.equal(n[1].redemption.id, 'r1');
  assert.equal(n[2].send.id, 's1');
  assert.equal(n[3].reply.id, 'p2'); // newest unread reply, one card per thread
  assert.ok(!n.some((x) => x.type === 'checkin')); // there is no check-in card, ever
});

test('needsYou: a partner-logged unrepaired fight needs my version until I write a note', () => {
  const now = at('2026-10-22', 21);
  const base = { me: ME, now, tz: TZ, items: [], redemptions: [], nudge_sends: [], nudge_replies: [], todos: [], seen: [], since: 0 };
  const mk = (id, by, extra) => ({ id, logged_by: by, at: iso('2026-10-22', 9), repaired_at: null, ...extra });
  const fights = [mk('f1', YOU), mk('f2', ME), mk('f3', YOU, { repaired_at: iso('2026-10-22', 10) }), mk('f4', YOU)];
  const note = (id, by) => ({ id: 'n' + id, fight_marker_id: id, author_id: by });
  const types = (notes) => C.needsYou({ ...base, fight_markers: fights, fight_notes: notes }).filter((x) => x.type === 'fight').map((x) => x.marker.id);
  assert.deepEqual(types([]), ['f1', 'f4']); // not my own (f2), not repaired (f3)
  assert.deepEqual(types([note('f1', ME)]), ['f4']); // my note clears it
  assert.deepEqual(types([note('f1', YOU)]), ['f1', 'f4']); // their own note does not
});

test('monthGrid is Monday-first', () => {
  const g = C.monthGrid(2026, 10); // Oct 1 2026 is a Thursday
  assert.equal(g.blanks, 3);
  assert.equal(g.days.length, 31);
});

test('isStillHeld: only a live held item may offer Send/Edit/Drop', () => {
  assert.equal(C.isStillHeld({ status: 'held', deleted_at: null }), true);
  assert.equal(C.isStillHeld({ status: 'delivered', deleted_at: null }), false);
  assert.equal(C.isStillHeld({ status: 'dropped', deleted_at: null }), false);
  assert.equal(C.isStillHeld({ status: 'held', deleted_at: '2026-10-20T00:00:00Z' }), false);
  assert.equal(C.isStillHeld(undefined), false);
});

test('hitText: the four outputs, named for the logger', () => {
  assert.equal(C.hitText({ hit_self: null, hit_related: null }, 'Alex'), null);
  assert.equal(C.hitText({ hit_self: false, hit_related: null }, 'Alex'), null);
  assert.equal(C.hitText({ hit_self: true, hit_related: null }, 'Alex'), 'Hit herself');
  assert.equal(C.hitText({ hit_self: true, hit_related: true }, 'Alex'), 'Hit herself, related to Alex');
  assert.equal(C.hitText({ hit_self: true, hit_related: false }, 'Alex'), 'Hit herself, not related to Alex');
});

test('ledger Fight line carries hitText as who, using the logger\'s name', () => {
  const fightLine = (m) => {
    const l = L(rows({ fight_markers: [{ id: 'f', at: iso('2026-10-20', 20), logged_by: YOU, ...m }] }), at('2026-10-21', 12), '2026-10-20');
    return l.weeks['2026-10-19'].days['2026-10-20'].lines.find((x) => x.label === 'Fight');
  };
  assert.equal(fightLine({ hit_self: true, hit_related: true }).who, 'Hit herself, related to Sam');
  assert.equal(fightLine({ hit_self: true, hit_related: false }).who, 'Hit herself, not related to Sam');
  assert.equal(fightLine({ hit_self: true, hit_related: null }).who, 'Hit herself');
  assert.equal(fightLine({ hit_self: null, hit_related: null }).who, null);
  assert.equal(fightLine({ hit_self: false, hit_related: null }).who, null);
});

// ---- Done, with points: payout schedule + ledger ----
test('splitPayout: all now is one row; 3mo puts the remainder on the earliest', () => {
  assert.deepEqual(C.splitPayout(20, 'now', '2026-10-25'), [{ day: '2026-10-25', points: 20 }]);
  const pts = (n) => C.splitPayout(n, '3mo', '2026-10-25').map((x) => x.points);
  assert.deepEqual(pts(20), [7, 7, 6]);
  assert.deepEqual(pts(10), [4, 3, 3]);
  assert.deepEqual(pts(30), [10, 10, 10]);
  assert.deepEqual(pts(50), [17, 17, 16]);
  assert.deepEqual(C.splitPayout(20, '3mo', '2026-10-25').map((x) => x.day), ['2026-10-25', '2026-11-25', '2027-01-25']);
  assert.deepEqual(pts(1), [1], 'zero-point parts are dropped');
});
test('splitPayout: month steps clamp to the last day of the month', () => {
  assert.deepEqual(C.splitPayout(9, '3mo', '2027-01-31').map((x) => x.day), ['2027-01-31', '2027-02-28', '2027-04-30']);
  assert.deepEqual(C.splitPayout(9, '3mo', '2028-01-31').map((x) => x.day), ['2028-01-31', '2028-02-29', '2028-04-30']);
});
const award = (o = {}) => ({ id: 'a', recipient_id: 'her', points: 30, payout: '3mo', done_at: iso('2026-10-01', 14), stopped_at: null, deleted_at: null, ...o });
test('ledger: only installments due by today count', () => {
  const total = (day) => L(rows({ nudge_awards: [award()] }), at(day, 12), '2026-10-01').balance;
  const base = (day) => L(rows(), at(day, 12), '2026-10-01').balance;
  assert.equal(total('2026-10-15') - base('2026-10-15'), 10);
  assert.equal(total('2026-11-01') - base('2026-11-01'), 20);
  assert.equal(total('2026-12-31') - base('2026-12-31'), 20, 'third installment (1 Jan) not due yet');
  assert.equal(total('2027-01-02') - base('2027-01-02'), 30);
});
test('ledger: Stop the rest cuts installments dated on or after the stop day, keeps earlier ones', () => {
  const stopped = award({ stopped_at: iso('2026-11-15', 12) }); // between the 1 Nov and 1 Jan installments
  const d = (day) => L(rows({ nudge_awards: [stopped] }), at(day, 12), '2026-10-01').balance - L(rows(), at(day, 12), '2026-10-01').balance;
  assert.equal(d('2027-02-01'), 20, 'later installment never paid');
  const st = C.awardStatus(stopped, '2027-02-01', TZ);
  assert.deepEqual([st.paid, st.stopped, st.complete, st.next], [20, true, false, null]);
  const sameDay = award({ stopped_at: iso('2026-11-01', 20) }); // the 1 Nov installment is dated the stop day: cut
  assert.equal(C.awardStatus(sameDay, '2027-02-01', TZ).paid, 10);
});

// ---- per-todo points, habit goals (N per day / week / month), notes, edited tag ----
const hab = (o) => todo({ id: 'h', type: 'habit', target: 2, period: 'week', created_at: iso('2026-10-05', 12), ...o });
const logs = (...stamps) => stamps.map((s, i) => ({ id: 'e' + i, todo_id: 'h', kind: 'tally', user_id: ME, at: s }));
const misses = (t, ev, day) => C.habitMisses(t, ev, day, TZ).map((p) => p.start);

test('per-todo points replace the constants, null keeps the defaults, 0 makes no line', () => {
  const bal = (t, now) => L(rows({ todos: [t] }), at(now, 10), now).balance;
  assert.equal(bal(todo({ due_date: '2026-10-23', done_at: iso('2026-10-23', 9), points_earn: 5 }), '2026-10-23'), 5);
  assert.equal(bal(todo({ due_date: '2026-10-23', done_at: iso('2026-10-23', 9), points_earn: null }), '2026-10-23'), 3);
  assert.equal(bal(todo({ due_date: '2026-10-20', points_miss: 2 }), '2026-10-23'), -2);
  assert.equal(bal(todo({ due_date: '2026-10-20', points_miss: 0 }), '2026-10-23'), 0);
  assert.equal(bal(todo({ due_date: '2026-10-20' }), '2026-10-23'), -3);
  const h = hab({ points_earn: 2 }), ev = logs(iso('2026-10-22', 9), iso('2026-10-22', 10));
  assert.equal(L(rows({ todos: [h], todo_events: ev }), at('2026-10-22', 20), '2026-10-22').balance, 4);
});

test('a weekly habit that closes under target is a miss, once per missed week; the open week never counts', () => {
  // created Mon 10-05; week of 10-05 hit (2), week of 10-12 missed (1), week of 10-19 is open and empty.
  const ev = logs(iso('2026-10-06', 9), iso('2026-10-07', 9), iso('2026-10-13', 9));
  assert.deepEqual(misses(hab(), ev, '2026-10-21'), ['2026-10-12']);
  const l = L(rows({ todos: [hab({ points_miss: 4 })], todo_events: ev }), at('2026-10-21', 10), '2026-10-21');
  const line = l.weeks['2026-10-19'].days['2026-10-19'].lines.filter((x) => x.label === 'Habit missed');
  assert.deepEqual(line.map((x) => x.pts), [-4]);
  assert.equal(l.balance, 3 - 4); // 3 tally points (default 1 each) minus the one miss
  // default habit miss is 0: same rows, no miss line
  const l0 = L(rows({ todos: [hab()], todo_events: ev }), at('2026-10-21', 10), '2026-10-21');
  assert.equal(l0.balance, 3);
});

test('periods before the habit existed never count; the period it was created in is skipped unless it began that day', () => {
  const t = hab({ created_at: iso('2026-10-14', 12) }); // Wed of the week starting 10-12
  assert.deepEqual(misses(t, [], '2026-10-26'), ['2026-10-19']); // 10-12 week skipped, 10-19 week closed and empty
  assert.deepEqual(misses(t, [], '2026-10-25'), []); // 10-19 week still open on its last day
  assert.deepEqual(misses(hab({ created_at: iso('2026-10-12', 8) }), [], '2026-10-19'), ['2026-10-12']); // created on the Monday: counts
});

test('daily habit: a log at 23:30 New York belongs to that day, not the next UTC day', () => {
  const t = hab({ period: 'day', target: 1, created_at: iso('2026-10-19', 9) });
  const ev = logs(iso('2026-10-19', 12), iso('2026-10-20', 23, 30), iso('2026-10-22', 0, 30));
  assert.deepEqual(misses(t, ev, '2026-10-22'), ['2026-10-21']); // 10-20 23:30 is 10-21 03:30Z: counted for the 20th only
});

test('monthly habit: calendar months, partial creation month skipped, Feb leap end', () => {
  const t = hab({ period: 'month', target: 3, created_at: iso('2026-08-15', 12) });
  const ev = logs(iso('2026-09-10', 9));
  assert.deepEqual(misses(t, ev, '2026-10-25'), ['2026-09-01']); // Aug partial, Sep under, Oct open
  assert.deepEqual(C.periodOf('month', '2028-02-10'), { start: '2028-02-01', end: '2028-02-29' });
  assert.deepEqual(C.periodOf('week', '2026-10-25'), { start: '2026-10-19', end: '2026-10-25' });
});

test('a habit with no target or period (pre-goal row) has no misses; deleted habits add nothing', () => {
  assert.deepEqual(misses(hab({ target: null }), [], '2026-12-01'), []);
  assert.deepEqual(misses(hab({ period: null }), [], '2026-12-01'), []);
  const l = L(rows({ todos: [hab({ points_miss: 4, deleted_at: iso('2026-10-10', 9) })] }), at('2026-12-01', 9), '2026-12-01');
  assert.equal(l.balance - l.challenges.reduce((a, c) => a + c.earned, 0), 0); // challenges pay from their own start
});

test('Edited shows for the owner until they next log it', () => {
  const t = todo({ owner_id: ME, created_by: YOU, edited_at: iso('2026-10-22', 12) });
  const ev = (h) => [{ todo_id: 't1', user_id: ME, kind: 'tally', at: iso('2026-10-22', h) }];
  assert.equal(C.isEdited(t, [], ME), true);
  assert.equal(C.isEdited(t, ev(9), ME), true); // logged before the edit
  assert.equal(C.isEdited(t, ev(15), ME), false); // logged after
  assert.equal(C.isEdited(t, [], YOU), false); // the editor never sees it
  assert.equal(C.isEdited(todo({ owner_id: ME, created_by: ME, edited_at: iso('2026-10-22', 12) }), [], ME), false);
});
test('a to do that needs a note refuses an empty one', () => {
  const t = todo({ needs_note: true });
  for (const n of ['', '   ', undefined, null]) assert.throws(() => C.requireNote(t, n), /Note needed/);
  C.requireNote(t, 'booked it');
  C.requireNote(todo({ needs_note: false }), '');
});

test('askToTodo carries an ownup ask through as an ownup to do, and the ledger scores 0 points as 0, not the task default', () => {
  const couple = { id: 'c', hold_ask_min: 0, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
  const item = C.buildItem({ id: 'i', couple, me: ME, to: YOU, kind: 'ask', ask_type: 'ownup', body: 'I go meta', description: 'It escalates', needs_note: true, now: 1000 });
  const t = C.askToTodo(item, 't1', 1000);
  assert.deepEqual([t.type, t.owner_id, t.created_by, t.item_id, t.needs_note, t.title], ['ownup', YOU, ME, 'i', true, 'I go meta']);
  // Default (null) points score like a task; an explicit 0 / 0 (a migrated acknowledgment) stays 0.
  assert.deepEqual([C.earnPts(t), C.missPts(t)], [3, 3]);
  assert.deepEqual([C.earnPts({ ...t, points_earn: 0, points_miss: 0 }), C.missPts({ ...t, points_earn: 0, points_miss: 0 })], [0, 0]);
  const done = { ...t, owner_id: ME, due_date: '2026-10-20', done_at: iso('2026-10-22', 10), created_at: iso('2026-10-19', 9) };
  const run = (todo) => C.computeLedger({ members: [{ user_id: ME, name: 'Me' }], items: [], todos: [todo], todo_events: [], fight_markers: [], redemptions: [], nudge_sends: [], nudge_awards: [], challenges: [] }, { tz: TZ, now: at('2026-10-23', 12), since: '2026-10-22' });
  const lines = (l) => Object.values(l.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => /To do/.test(x.label));
  assert.deepEqual(lines(run(done)).map((x) => [x.label, x.pts]), [['To do overdue', -3]], 'late ownup pays the task miss, no on-time earn');
  assert.deepEqual(lines(run({ ...done, due_date: '2026-10-22' })).map((x) => [x.label, x.pts]), [['To do on time', 3]]);
  assert.deepEqual(lines(run({ ...done, points_earn: 0, points_miss: 0 })).map((x) => x.pts), [], 'migrated 0 / 0 scores nothing');
});

test('needsYou: a card for an ownup the partner finished and I have not opened; own, open, seen, deleted, pre-install and scheduled excluded', () => {
  const now = at('2026-10-22', 21);
  const ownup = (id, owner, extra) => ({ id, type: 'ownup', owner_id: owner, created_by: owner, created_at: iso('2026-10-22', 9), done_at: iso('2026-10-22', 10), deleted_at: null, title: id, ...extra });
  const todos = [
    ownup('in1', YOU), ownup('in2', YOU, { done_at: iso('2026-10-22', 12) }),
    ownup('open', YOU, { done_at: null }), ownup('mine', ME), ownup('seen', YOU), ownup('del', YOU, { deleted_at: iso('2026-10-22', 11) }),
    ownup('old', YOU, { done_at: iso('2026-10-20', 10) }), ownup('later', YOU, { created_at: iso('2026-10-25', 9), done_at: iso('2026-10-25', 9) }),
    { ...ownup('task', YOU), type: 'task' },
  ];
  const n = C.needsYou({ me: ME, now, tz: TZ, items: [], redemptions: [], nudge_sends: [], nudge_replies: [], fight_markers: [], fight_notes: [], todos, seen: ['seen'], since: Date.parse(iso('2026-10-21', 0)) });
  assert.deepEqual(n.map((x) => x.type + ':' + x.todo.id), ['ownup:in2', 'ownup:in1']);
});

test('no-hitting challenge pays its streak day number; only a hit resets it', () => {
  const fm = (id, d, hit = false, h = 15) => ({ id, at: iso(d, h), logged_by: ME, hit_self: hit });
  const ch = (l) => l.challenges.find((c) => c.id === 'no-hit');
  const pays = (l) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === 'No hitting').map((x) => [d.day, x.pts, x.who]))).sort((a, b) => a[0].localeCompare(b[0]));

  // Start day still in progress: nothing paid yet, today is day 1.
  let l = L(rows(), at('2026-10-26', 20));
  assert.deepEqual(pays(l), []);
  assert.deepEqual(ch(l), { archived: false, id: 'no-hit', name: 'No hitting', for_user: 'u1', breaks_on: 'hit', broken_today: false, accepted: true, start: '2026-10-26', day: 1, best: 0, earned: 0, tonight: 1, days: [{ d: '2026-10-26', n: 1, bonus: false }], next: { week: 6, month: 29 } });

  // Three clean days: +1, +2, +3; a fight without a hit does not reset.
  l = L(rows({ fight_markers: [fm('f1', '2026-10-27')] }), at('2026-10-29', 9));
  assert.deepEqual(pays(l), [['2026-10-26', 1, 'Day 1'], ['2026-10-27', 2, 'Day 2'], ['2026-10-28', 3, 'Day 3']]);
  assert.equal(ch(l).day, 4); assert.equal(ch(l).earned, 6);

  // Hit on the 28th: that day pays nothing, the 29th is day 1 again, best stays 2.
  l = L(rows({ fight_markers: [fm('f1', '2026-10-28', true)] }), at('2026-10-30', 9));
  assert.deepEqual(pays(l), [['2026-10-26', 1, 'Day 1'], ['2026-10-27', 2, 'Day 2'], ['2026-10-29', 1, 'Day 1']]);
  assert.deepEqual(ch(l), { archived: false, id: 'no-hit', name: 'No hitting', for_user: 'u1', breaks_on: 'hit', broken_today: false, accepted: true, start: '2026-10-26', day: 2, best: 2, earned: 4, tonight: 2, next: { week: 5, month: 28 },
    days: [['2026-10-26', 1], ['2026-10-27', 2], ['2026-10-28', 0], ['2026-10-29', 1], ['2026-10-30', 2]].map(([d, n]) => ({ d, n, bonus: false })) });

  // Hit today: day 0, and hits before the start date never count.
  l = L(rows({ fight_markers: [fm('f0', '2026-10-20', true), fm('f2', '2026-10-27', true)] }), at('2026-10-27', 18));
  assert.equal(ch(l).day, 0); assert.deepEqual(pays(l), [['2026-10-26', 1, 'Day 1']]);
});

test('a hit costs 10 for the first of the day and 5 for each after; fights without a hit cost nothing extra', () => {
  const fm = (id, d, h, hit) => ({ id, at: iso(d, h), logged_by: YOU, hit_self: hit });
  const hits = (l) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === 'Hit').map((x) => [d.day, x.pts, x.fight])));
  const l = L(rows({ fight_markers: [fm('c', '2026-10-21', 20, true), fm('a', '2026-10-21', 9, true), fm('n', '2026-10-21', 12, false), fm('b', '2026-10-21', 14, true), fm('d', '2026-10-22', 9, true)] }), at('2026-10-23', 9));
  // Ordered by time, not row order: a (9:00) is the first hit of the 21st.
  assert.deepEqual(hits(l).sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]), [['2026-10-21', -10, 'a'], ['2026-10-21', -5, 'b'], ['2026-10-21', -5, 'c'], ['2026-10-22', -10, 'd']]);
});

test('hit_count: each hit is a ledger line, the day\'s first -10 and the rest -5, across fights', () => {
  const fm = (id, d, h, hit, hit_count) => ({ id, at: iso(d, h), logged_by: YOU, hit_self: hit, hit_count });
  const hits = (l) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === 'Hit').map((x) => [d.day, x.pts, x.fight])));
  const key = (a, b) => a[0].localeCompare(b[0]) || a[1] - b[1];
  // Two hits in one fight: -10 -5.
  let l = L(rows({ fight_markers: [fm('a', '2026-10-21', 9, true, 2)] }), at('2026-10-23', 9));
  assert.deepEqual(hits(l), [['2026-10-21', -10, 'a'], ['2026-10-21', -5, 'a']]);
  // A later fight the same day with 2 hits: -5 each.
  l = L(rows({ fight_markers: [fm('a', '2026-10-21', 9, true, 2), fm('b', '2026-10-21', 14, true, 2)] }), at('2026-10-23', 9));
  assert.deepEqual(hits(l).sort(key), [['2026-10-21', -10, 'a'], ['2026-10-21', -5, 'a'], ['2026-10-21', -5, 'b'], ['2026-10-21', -5, 'b']]);
  // Legacy row (null count) is one hit; a no-hit row with a count contributes nothing.
  l = L(rows({ fight_markers: [fm('a', '2026-10-21', 9, true, null), fm('n', '2026-10-21', 10, false, null)] }), at('2026-10-23', 9));
  assert.deepEqual(hits(l), [['2026-10-21', -10, 'a']]);
});

test('hit_count 0.5: one light hit at half cost, rounded up, and it still breaks the no-hitting streak', () => {
  const fm = (id, h, hit_count) => ({ id, at: iso('2026-10-28', h), logged_by: YOU, hit_self: true, hit_count });
  const hits = (l) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === 'Hit').map((x) => [x.pts, x.who])));
  assert.deepEqual(hits(L(rows({ fight_markers: [fm('a', 9, 0.5)] }), at('2026-10-30', 9))), [[-5, 'Light']]);
  assert.deepEqual(hits(L(rows({ fight_markers: [fm('a', 9, 1), fm('b', 14, 0.5)] }), at('2026-10-30', 9))), [[-10, null], [-3, 'Light']]);
  const l = L(rows({ fight_markers: [fm('a', 9, 0.5)] }), at('2026-10-30', 9));
  assert.equal(l.challenges[0].days.find((x) => x.d === '2026-10-28').n, 0);
});

test('no-hitting pays min(day, 10) while the day number keeps counting', () => {
  const l = L(rows(), at('2026-11-08', 9)); // 26 Oct..7 Nov finished = days 1..13
  const pays = Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === 'No hitting').map((x) => [x.who, x.pts])));
  const by = Object.fromEntries(pays);
  assert.equal(by['Day 9'], 9); assert.equal(by['Day 10'], 10); assert.equal(by['Day 12'], 10); assert.equal(by['Day 13'], 10);
});

test('no-hitting bonuses: +10 on every 7th day, +100 on every 30th, both on day 210; earned includes them', () => {
  const lines = (l, label) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === label).map((x) => [d.day, x.pts])));
  const ch = (l) => l.challenges.find((c) => c.id === 'no-hit');
  // Day n finishes on 2026-10-25 + n. At 2026-11-10 days 1..15 are finished.
  let l = L(rows(), at('2026-11-10', 9));
  assert.deepEqual(lines(l, 'Week without hitting'), [['2026-11-01', 10], ['2026-11-08', 10]]); // days 7 and 14
  assert.deepEqual(lines(l, 'Month without hitting'), []);
  assert.equal(ch(l).earned, 55 + 10 * 5 + 20); // days 1..10 = 55, days 11..15 = 50, two week bonuses
  // Day 30 (2026-11-24) gets the month bonus only; day 28 the week bonus only.
  l = L(rows(), at('2026-11-25', 9));
  assert.deepEqual(lines(l, 'Month without hitting'), [['2026-11-24', 100]]);
  assert.deepEqual(lines(l, 'Week without hitting').map((x) => x[0]), ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22']);
  assert.equal(ch(l).earned, 55 + 10 * 20 + 40 + 100);
  // Day 210: both. Finished 2027-05-23.
  l = L(rows(), at('2027-05-24', 9));
  assert.deepEqual(lines(l, 'Week without hitting').filter((x) => x[0] === '2027-05-23'), [['2027-05-23', 10]]);
  assert.deepEqual(lines(l, 'Month without hitting').filter((x) => x[0] === '2027-05-23'), [['2027-05-23', 100]]);
  // next: today is day 211 -> week bonus at day 217 (6 days), month at day 240 (29 days).
  assert.deepEqual(ch(l).next, { week: 6, month: 29 });
});

test('challenge days: per-day streak numbers, hit gaps, today in progress, tonight payout, bonus days', () => {
  const fm = (id, d, hit = true) => ({ id, at: iso(d, 15), logged_by: ME, hit_self: hit });
  const ch = (l) => l.challenges.find((c) => c.id === 'no-hit');
  // No challenge rows, no challenges.
  assert.deepEqual(L(rows({ challenges: undefined }), at('2026-10-30', 9)).challenges, []);
  // Before the start: no days, day 0.
  let c = ch(L(rows(), at('2026-10-20', 9)));
  assert.deepEqual([c.days, c.day, c.tonight], [[], 0, 0]);
  // 26-27 clean, 28 hit, 29-30 clean, today the 31st: today carries the in-progress number.
  c = ch(L(rows({ fight_markers: [fm('h', '2026-10-28')] }), at('2026-10-31', 9)));
  assert.deepEqual(c.days.map((x) => [x.d, x.n]), [['2026-10-26', 1], ['2026-10-27', 2], ['2026-10-28', 0], ['2026-10-29', 1], ['2026-10-30', 2], ['2026-10-31', 3]]);
  assert.deepEqual([c.day, c.tonight], [3, 3]);
  // Hit today: today's cell is a gap and tonight pays nothing.
  c = ch(L(rows({ fight_markers: [fm('h', '2026-10-31')] }), at('2026-10-31', 18)));
  assert.deepEqual([c.days[c.days.length - 1], c.day, c.tonight], [{ d: '2026-10-31', n: 0, bonus: false }, 0, 0]);
  // Tonight caps at 10 and adds the bonus on the 7th / 30th streak day; paid bonus days are flagged, today's is not yet.
  c = ch(L(rows(), at('2026-11-01', 9))); // today = day 7
  assert.deepEqual([c.day, c.tonight, c.days.filter((x) => x.bonus).length], [7, 17, 0]);
  c = ch(L(rows(), at('2026-11-03', 9))); // day 9: day 7 paid its bonus
  assert.deepEqual(c.days.filter((x) => x.bonus).map((x) => x.d), ['2026-11-01']);
  assert.equal(ch(L(rows(), at('2026-11-05', 9))).tonight, 10); // day 11
  assert.equal(ch(L(rows(), at('2026-11-24', 9))).tonight, 10 + 100); // day 30
  // A renamed challenge is the name on its ledger lines.
  const l = L(rows({ challenges: [{ id: 'no-hit', name: 'No yelling', start: '2026-10-26', accepted_at: '2026-10-25T12:00:00Z' }] }), at('2026-10-28', 9));
  assert.equal(Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === 'No yelling'))).length, 2);
});

test('an unaccepted challenge pays nothing; acceptance starts the streak on its local day, hits stay separate', () => {
  const ch = (l) => l.challenges.find((c) => c.id === 'no-hit');
  const row = (accepted_at) => ({ id: 'no-hit', name: 'No hitting', start: '2026-10-26', for_user: 'u1', accepted_at });
  const hit = (id, d) => ({ id, at: iso(d, 15), logged_by: ME, hit_self: true });
  const lines = (l, label) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === label)));
  const paid = (l) => lines(l, 'No hitting');
  // Unaccepted, days later: no pay, day 0, no days; a hit still costs.
  let l = L(rows({ challenges: [row(null)], fight_markers: [hit('f1', '2026-10-28')] }), at('2026-10-30', 9));
  assert.deepEqual(ch(l), { archived: false, id: 'no-hit', name: 'No hitting', for_user: 'u1', breaks_on: 'hit', broken_today: false, accepted: false, start: null, day: 0, best: 0, earned: 0, tonight: 0, days: [], next: { week: 7, month: 30 } });
  assert.equal(paid(l).length, 0);
  assert.deepEqual(lines(l, 'Hit').map((x) => x.pts), [-10]);
  // Accepted today: today is day 1, nothing earlier pays.
  l = L(rows({ challenges: [row(new Date(at('2026-10-30', 8)).toISOString())] }), at('2026-10-30', 9));
  assert.equal(ch(l).day, 1); assert.equal(ch(l).earned, 0); assert.equal(paid(l).length, 0);
  assert.deepEqual(ch(l).days, [{ d: '2026-10-30', n: 1, bonus: false }]);
  assert.equal(ch(l).start, '2026-10-30');
  // Accepted on the 28th, viewed on the 30th: +1 (28th), +2 (29th); the 26th and 27th never pay.
  l = L(rows({ challenges: [row(new Date(at('2026-10-28', 22)).toISOString())] }), at('2026-10-30', 9));
  assert.deepEqual(paid(l).map((x) => x.pts).sort(), [1, 2]); assert.equal(ch(l).day, 3);
  // A hit on the accept day gives day 0, and the penalty is its own line.
  l = L(rows({ challenges: [row(new Date(at('2026-10-30', 8)).toISOString())], fight_markers: [hit('f2', '2026-10-30')] }), at('2026-10-30', 18));
  assert.equal(ch(l).day, 0); assert.equal(ch(l).tonight, 0); assert.deepEqual(lines(l, 'Hit').map((x) => x.pts), [-10]);
});

test('tap challenge: a break row resets the streak with no penalty; hits do not break it; tap breaks do not break a hit challenge', () => {
  const row = (id, breaks_on) => ({ id, name: id === 'tap' ? 'No yelling' : 'No hitting', start: '2026-10-26', for_user: 'u1', accepted_at: iso('2026-10-25', 12), breaks_on });
  const hit = { id: 'f1', at: iso('2026-10-27', 15), logged_by: ME, hit_self: true };
  const brk = (d) => ({ challenge_id: 'tap', day: d });
  const ch = (l, id) => l.challenges.find((c) => c.id === id);
  const lines = (l, label) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines.filter((x) => x.label === label)));
  // Break on the 28th, viewed on the 30th: days 26,27 = 1,2; 28 broken (0, no penalty); 29 = day 1; today (30) = day 2.
  let l = L(rows({ challenges: [row('tap', 'tap')], challenge_breaks: [brk('2026-10-28')] }), at('2026-10-30', 9));
  assert.deepEqual(ch(l, 'tap').days.map((x) => x.n), [1, 2, 0, 1, 2]);
  assert.equal(ch(l, 'tap').day, 2); assert.equal(ch(l, 'tap').earned, 1 + 2 + 0 + 1);
  assert.equal(ch(l, 'tap').broken_today, false); assert.equal(ch(l, 'tap').breaks_on, 'tap');
  assert.equal(Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines)).filter((x) => x.pts < 0).length, 0);
  // Broken today: day 0, tonight 0, broken_today.
  l = L(rows({ challenges: [row('tap', 'tap')], challenge_breaks: [brk('2026-10-30')] }), at('2026-10-30', 9));
  assert.equal(ch(l, 'tap').day, 0); assert.equal(ch(l, 'tap').tonight, 0); assert.equal(ch(l, 'tap').broken_today, true);
  // A tap challenge ignores hits; a hit challenge ignores tap breaks.
  l = L(rows({ challenges: [row('tap', 'tap'), row('no-hit', 'hit')], fight_markers: [hit], challenge_breaks: [brk('2026-10-28')] }), at('2026-10-30', 9));
  assert.deepEqual(ch(l, 'tap').days.map((x) => x.n), [1, 2, 0, 1, 2]);
  assert.deepEqual(ch(l, 'no-hit').days.map((x) => x.n), [1, 0, 1, 2, 3]);
  assert.equal(ch(l, 'no-hit').broken_today, false);
  // Missing breaks_on behaves as a hit challenge.
  l = L(rows({ challenges: [row('no-hit', undefined)], fight_markers: [hit] }), at('2026-10-30', 9));
  assert.deepEqual(ch(l, 'no-hit').days.map((x) => x.n), [1, 0, 1, 2, 3]);
});

test('bonus lines: tap challenges use the challenge name with Week / Month, hit challenges keep the hitting wording', () => {
  const row = (id, breaks_on, name) => ({ id, name, start: '2026-10-01', for_user: 'u1', accepted_at: iso('2026-09-30', 12), breaks_on });
  const lines = (l) => Object.values(l.weeks).flatMap((w) => Object.values(w.days).flatMap((d) => d.lines));
  const l = L(rows({ challenges: [row('tap', 'tap', 'No yelling'), row('hit', 'hit', 'No hitting')] }), at('2026-11-01', 9), '2026-10-01');
  const tap = lines(l).filter((x) => x.label === 'No yelling' && ['Week', 'Month'].includes(x.who)).map((x) => [x.who, x.pts]);
  assert.deepEqual(tap.sort(), [['Month', 100], ['Week', 10], ['Week', 10], ['Week', 10], ['Week', 10]].sort());
  assert.deepEqual(lines(l).filter((x) => /without hitting/.test(x.label)).map((x) => x.label).filter((v, i, a) => a.indexOf(v) === i).sort(), ['Month without hitting', 'Week without hitting']);
});

test('kudos with points false scores 0; rows without the field still score +1', () => {
  const off = { ...kudo('off', ME, '2026-10-20', 9), points: false };
  const l = L(rows({ items: [off, kudo('on', ME, '2026-10-20', 10)] }), at('2026-10-20', 22), '2026-10-20');
  assert.equal(l.weeks['2026-10-19'].days['2026-10-20'].lines.filter((x) => x.label === 'Kudos').length, 1);
  // A points-off kudos does not use up one of the 3 daily slots.
  const four = [1, 2, 3].map((i) => kudo('p' + i, ME, '2026-10-20', 8 + i)).concat([{ ...kudo('z', ME, '2026-10-20', 7), points: false }]);
  assert.equal(L(rows({ items: four }), at('2026-10-20', 22), '2026-10-20').weeks['2026-10-19'].days['2026-10-20'].lines.filter((x) => x.label === 'Kudos').length, 3);
});

test('buildItem carries gift_points only on a kudos', () => {
  const couple = { id: 'c', hold_ask_min: 0, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 3 };
  const b = (o) => C.buildItem({ id: 'k', couple, me: ME, to: YOU, body: 'x', now: 1000, ...o });
  assert.equal(b({ kind: 'kudos', gift_points: 5 }).gift_points, 5);
  assert.equal(b({ kind: 'kudos', gift_points: 0 }).gift_points, 0);
  assert.equal(b({ kind: 'kudos', gift_points: 5 }).status, 'held', 'gift_points rides through the hold unchanged');
  assert.ok(!('gift_points' in b({ kind: 'kudos' })));
  assert.ok(!('gift_points' in b({ kind: 'truth', gift_points: 5 })));
});

test('kudos gift_points: scores exactly that, outside the daily cap; 0 scores nothing', () => {
  const kudoRow = (id, h) => kudo(id, ME, '2026-10-20', h);
  const g = (id, n, h) => ({ ...kudoRow(id, h), gift_points: n });
  const lines = (items) => Object.values(L(rows({ items }), at('2026-10-20', 22), '2026-10-20').weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'Kudos');
  assert.deepEqual(lines([g('a', 5, 9)]).map((x) => x.pts), [5]);
  assert.deepEqual(lines([g('z', 0, 9)]), [], 'gift 0 has no ledger entry');
  // Five gifts exceed the 3-per-day cap, and three legacy kudos still all score after them (gifts use no slots).
  const gifts = [1, 2, 3, 4, 5].map((i) => g('g' + i, 2, 5 + i));
  const legacy = [1, 2, 3, 4].map((i) => kudoRow('l' + i, 10 + i));
  assert.deepEqual(lines(gifts.concat(legacy)).map((x) => x.pts), [2, 2, 2, 2, 2, 1, 1, 1]);
});

test('legacy kudos (gift_points null): points false scores 0, otherwise +1 with the cap of 3', () => {
  const off = { ...kudo('off', ME, '2026-10-20', 9), points: false, gift_points: null };
  const four = [1, 2, 3, 4].map((i) => ({ ...kudo('p' + i, ME, '2026-10-20', 9 + i), gift_points: null }));
  const lines = (items) => Object.values(L(rows({ items }), at('2026-10-20', 22), '2026-10-20').weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'Kudos');
  assert.equal(lines([off]).length, 0);
  assert.equal(lines(four.concat([off])).length, 3);
  assert.equal(lines([kudo('plain', ME, '2026-10-20', 9)]).length, 1, 'row without the field still +1');
});

// ---- goal challenges (breaks_on 'goal'): log goal_days distinct days within goal_window_days ----
// Accepted Mon 2026-10-26 noon, window 10 days: deadline Wed 2026-11-04. Earn +150, miss -50, goal 3 days.
const goalRow = (o = {}) => ({ id: 'g', name: 'BPD research', start: '2026-10-26', for_user: ME, breaks_on: 'goal', goal_days: 3, goal_window_days: 10, goal_earn: 150, goal_miss: 50, rule: 'r', accepted_at: iso('2026-10-26', 12), ...o });
const gd = (...days) => days.map((d, i) => ({ id: 'd' + i, challenge_id: 'g', day: d }));
const goalL = (days, now, ch = goalRow()) => { const l = L(rows({ challenges: [ch], challenge_days: gd(...days) }), now, now >= at('2026-11-01', 0) ? '2026-11-05' : '2026-10-30'); return { l, g: l.challenges[0], lines: Object.values(l.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'BPD research') }; };

test('goal: pays goal_earn once, on the day the count reaches goal_days, and never again', () => {
  let r = goalL(['2026-10-27', '2026-10-29'], at('2026-10-30', 9));
  assert.deepEqual(r.lines, []); assert.equal(r.g.count, 2); assert.equal(r.g.status, 'active');
  r = goalL(['2026-10-27', '2026-10-29', '2026-10-30'], at('2026-10-30', 9));
  assert.deepEqual(r.lines.map((x) => [x.day, x.pts]), [['2026-10-30', 150]]); assert.equal(r.g.status, 'done'); assert.equal(r.g.earned, 150);
  r = goalL(['2026-10-27', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-02'], at('2026-11-03', 9));
  assert.deepEqual(r.lines.map((x) => [x.day, x.pts]), [['2026-10-30', 150]], 'still exactly one payout');
});

test('goal: non-consecutive days count, duplicate days do not double count', () => {
  assert.equal(goalL(['2026-10-27', '2026-10-30', '2026-11-03'], at('2026-11-03', 9)).g.count, 3);
  const r = goalL(['2026-10-27', '2026-10-27', '2026-10-27'], at('2026-10-30', 9));
  assert.equal(r.g.count, 1); assert.deepEqual(r.lines, []);
});

test('goal: a row on the deadline day counts; rows after it are ignored', () => {
  let r = goalL(['2026-10-27', '2026-10-28', '2026-11-04'], at('2026-11-04', 20));
  assert.equal(r.g.count, 3); assert.equal(r.g.deadline, '2026-11-04'); assert.deepEqual(r.lines.map((x) => [x.day, x.pts]), [['2026-11-04', 150]]);
  r = goalL(['2026-10-27', '2026-10-28', '2026-11-05'], at('2026-11-06', 9));
  assert.equal(r.g.count, 2); assert.equal(r.g.status, 'failed');
  assert.deepEqual(r.lines.map((x) => [x.day, x.pts]), [['2026-11-05', -50]]);
});

test('goal: penalty only after the deadline day ends, once, and not when complete', () => {
  let r = goalL(['2026-10-27'], at('2026-11-04', 20));
  assert.deepEqual(r.lines, []); assert.equal(r.g.status, 'active', 'deadline day still in progress');
  r = goalL(['2026-10-27'], at('2026-11-05', 9));
  assert.deepEqual(r.lines.map((x) => [x.day, x.pts]), [['2026-11-05', -50]]); assert.equal(r.g.status, 'failed');
  r = goalL(['2026-10-27'], at('2026-11-20', 9));
  assert.equal(r.lines.length, 1, 'penalty is a single line');
  r = goalL(['2026-10-27', '2026-10-28', '2026-10-29'], at('2026-11-20', 9));
  assert.deepEqual(r.lines.map((x) => x.pts), [150], 'complete: earn only, no penalty');
});

test('goal: unaccepted pays nothing; the window is fixed from start, acceptance only shortens it; shape has what renderers need', () => {
  let r = goalL(['2026-10-27', '2026-10-28', '2026-10-29'], at('2026-11-20', 9), goalRow({ accepted_at: null }));
  assert.deepEqual(r.lines, []); assert.equal(r.g.accepted, false); assert.equal(r.g.count, 0);
  assert.deepEqual([r.g.days, r.g.broken_today, r.g.day], [[], false, 0]);
  r = goalL(['2026-10-26', '2026-10-27'], at('2026-10-30', 9), goalRow({ accepted_at: iso('2026-10-27', 12) }));
  assert.deepEqual([r.g.start, r.g.deadline, r.g.count], ['2026-10-27', '2026-11-04', 1], 'a row before acceptance is outside the window; the deadline does not move');
  r = goalL(['2026-10-30'], at('2026-10-30', 9), goalRow({ start: '2026-11-01', goal_window_days: 62, accepted_at: iso('2026-10-30', 8) }));
  assert.deepEqual([r.g.accepted, r.g.opens, r.g.start, r.g.deadline, r.g.count, r.g.status, r.lines], [true, '2026-11-01', '2026-11-01', '2027-01-01', 0, 'active', []], 'accepted before it opens: nothing counts yet');
  assert.equal(goalL([], at('2026-10-30', 9), goalRow({ start: '2026-11-01', goal_window_days: 62, accepted_at: null })).g.deadline, '2027-01-01');
  r = goalL(['2026-10-30'], at('2026-10-30', 9));
  assert.deepEqual([r.g.breaks_on, r.g.logged_today, r.g.goal_days, r.g.goal_earn, r.g.goal_miss, r.g.rule, r.g.days.map((x) => x.d)], ['goal', true, 3, 150, 50, 'r', ['2026-10-30']]);
});

test('goal: no streak pay, no week or month bonus at day 7, hits and fights do not matter', () => {
  const hit = { id: 'f1', at: iso('2026-10-28', 20), logged_by: YOU, hit_self: true, hit_count: 1 };
  const l = L(rows({ challenges: [goalRow({ goal_days: 30, goal_window_days: 40 })], challenge_days: gd('2026-10-27', '2026-10-28'), fight_markers: [hit] }), at('2026-11-03', 9), '2026-11-03');
  const all = Object.values(l.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines);
  assert.deepEqual(all.filter((x) => x.label === 'BPD research' || /Week|Month/.test(x.label)), []);
  assert.equal(l.challenges[0].count, 2); assert.equal(l.challenges[0].status, 'active');
});

test('calmStats: streak ends yesterday, best is the longest run, last28 counts calm days', () => {
  // since 10-01, today 10-10: days 10-01..10-09 are scored. Fights on 10-03 and 10-07.
  const s = C.calmStats(['2026-10-03', '2026-10-07', '2026-10-07'], '2026-10-10', '2026-10-01');
  assert.deepEqual(s, { streak: 2, best: 3, last28: 7 });
  assert.equal(C.calmStats([], '2026-10-10', '2026-10-01').streak, 9);
  assert.deepEqual(C.calmStats(['2026-10-09'], '2026-10-10', '2026-10-01').streak, 0, 'a fight yesterday ends it');
  assert.deepEqual(C.calmStats([], '2026-10-10', '2026-10-10'), { streak: 0, best: 0, last28: 0 }, 'couple created today');
});

// ---- fights chart value: my rating, else my partner's, else unrated (counts 1) ----
const R = (f, u, n) => ({ fight_marker_id: f, user_id: u, intensity: n });
test('chartValue: own rating beats the partner\'s, the partner\'s beats unrated', () => {
  assert.deepEqual(C.chartValue('f', 'me', [R('f', 'her', 5), R('f', 'me', 2)]), { value: 2, unrated: false });
  assert.deepEqual(C.chartValue('f', 'me', [R('f', 'her', 5)]), { value: 5, unrated: false });
  assert.deepEqual(C.chartValue('f', 'me', [R('g', 'me', 4)]), { value: 1, unrated: true }, 'a rating of another fight does not count');
});

test('dailyTotals: sums chart values per local day, counts unrated, omits empty days', () => {
  const at = (iso) => new Date(iso).toISOString();
  const fights = [{ id: 'a', at: at('2026-11-01T15:00:00Z') }, { id: 'b', at: at('2026-11-01T20:00:00Z') }, { id: 'c', at: at('2026-11-03T15:00:00Z') }];
  const t = C.dailyTotals(fights, 'me', [R('a', 'me', 3), R('b', 'her', 4)], 'America/New_York');
  assert.deepEqual(t, { '2026-11-01': { sum: 7, n: 2, unrated: 0 }, '2026-11-03': { sum: 1, n: 1, unrated: 1 } });
});

test('rollingAvg: 7 days ending on the day, zero days included', () => {
  const t = { '2026-11-01': { sum: 7 }, '2026-11-03': { sum: 7 } };
  assert.equal(C.rollingAvg(t, '2026-11-03'), 2);
  assert.equal(C.rollingAvg(t, '2026-11-08'), 1, 'the 1st has aged out of the window');
});

test('niceAxis: starts at 0 with clean steps and a top that covers the max', () => {
  assert.deepEqual(C.niceAxis(0), { step: 1, top: 1 });
  assert.deepEqual(C.niceAxis(5), { step: 1, top: 5 });
  assert.deepEqual(C.niceAxis(9), { step: 2, top: 10 });
  assert.deepEqual(C.niceAxis(13), { step: 5, top: 15 });
  assert.deepEqual(C.niceAxis(41), { step: 10, top: 50 });
});

test('inEditWindow: open for the window after creation, shut at and after it', () => {
  assert.equal(C.inEditWindow(0, 14 * 60000, 15), true);
  assert.equal(C.inEditWindow(0, 15 * 60000, 15), false);
});

// ---- goal challenge logs soft-deleted by either partner (challenge_days.deleted_at) ----
const goalDel = (days, deleted, now, ch = goalRow()) => {
  const cd = gd(...days).map((x) => (deleted.includes(x.day) ? { ...x, deleted_at: iso('2026-10-30', 8) } : x));
  const l = L(rows({ challenges: [ch], challenge_days: cd }), now, now >= at('2026-11-01', 0) ? '2026-11-05' : '2026-10-30');
  return { g: l.challenges[0], lines: Object.values(l.weeks).flatMap((w) => Object.values(w.days)).flatMap((d) => d.lines).filter((x) => x.label === 'BPD research') };
};

test('goal: deleted rows never count, and a deleted today is not logged_today', () => {
  const r = goalDel(['2026-10-27', '2026-10-29', '2026-10-30'], ['2026-10-30'], at('2026-10-30', 9));
  assert.equal(r.g.count, 2); assert.equal(r.g.logged_today, false); assert.deepEqual(r.g.days.map((x) => x.d), ['2026-10-27', '2026-10-29']);
});

test('goal: deleting the log that reached goal_days removes the reward', () => {
  const days = ['2026-10-27', '2026-10-29', '2026-10-30'];
  assert.deepEqual(goalDel(days, [], at('2026-10-30', 9)).lines.map((x) => x.pts), [150]);
  const r = goalDel(days, ['2026-10-29'], at('2026-10-30', 9));
  assert.deepEqual(r.lines, []); assert.equal(r.g.status, 'active'); assert.equal(r.g.earned, 0);
});

test('goal: deleting a log after the deadline applies the miss', () => {
  const days = ['2026-10-27', '2026-10-29', '2026-10-30'];
  assert.deepEqual(goalDel(days, [], at('2026-11-20', 9)).lines.map((x) => x.pts), [150]);
  const r = goalDel(days, ['2026-10-30'], at('2026-11-20', 9));
  assert.equal(r.g.status, 'failed'); assert.deepEqual(r.lines.map((x) => [x.day, x.pts]), [['2026-11-05', -50]]);
});

// ---- Raise issue ----
test('issueHeldUntil: 08:00 the next calendar day in the sender tz, whatever the time of day', () => {
  const next = at('2026-10-21', 8);
  assert.equal(C.issueHeldUntil(at('2026-10-20', 7), TZ), next, '7 am still waits for the next morning, not this one');
  assert.equal(C.issueHeldUntil(at('2026-10-20', 19, 59), TZ), next);
  assert.equal(C.issueHeldUntil(at('2026-10-20', 23), TZ), next);
});
test('issueHeldUntil: DST days resolve the wall time, not now + 24h', () => {
  // US fall back: Sun 2026-11-01 is 25 h long, so 08:00 that morning is EST (UTC-5).
  assert.equal(C.issueHeldUntil(Date.parse('2026-10-31T23:00:00-04:00'), TZ), Date.parse('2026-11-01T08:00:00-05:00'));
  // US spring forward: Sun 2027-03-14 is 23 h long, 08:00 is EDT (UTC-4).
  assert.equal(C.issueHeldUntil(Date.parse('2027-03-13T20:00:00-05:00'), TZ), Date.parse('2027-03-14T08:00:00-04:00'));
  // The sender's calendar decides: 23:00 New York is already the next UTC day, but the answer is still Oct 21 08:00 New York.
  assert.equal(C.issueHeldUntil(Date.parse('2026-10-21T03:00:00Z'), TZ), at('2026-10-21', 8));
});
test('buildItem: held_until overrides the Ask hold, even when the couple holds asks for 0 minutes', () => {
  const now = at('2026-10-20', 22), until = C.issueHeldUntil(now, TZ);
  for (const hold_ask_min of [0, 60]) {
    const couple = { id: 'c', hold_ask_min, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 };
    const it = C.buildItem({ id: 'i', couple, me: ME, to: YOU, kind: 'ask', body: 'x', origin: 'issue', response_type: 'apologize', ask_type: 'ownup', needs_note: true, held_until: until, now });
    assert.deepEqual([it.status, it.held_until, it.delivered_at, it.origin, it.response_type, it.ask_type], ['held', new Date(until).toISOString(), null, 'issue', 'apologize', 'ownup']);
  }
  const couple = { id: 'c', hold_ask_min: 0 };
  assert.throws(() => C.buildItem({ id: 'i', couple, me: ME, to: YOU, kind: 'ask', body: 'x', held_until: until, at: until, now }), /exclusive/);
});

// ---- fightActions: per-viewer chips on a fight row ----
const FA_ME = { user_id: 'u-me', name: 'Alex' }, FA_YOU = { user_id: 'u-you', name: 'Sam' };
const mk = (o = {}) => ({ id: 'f1', logged_by: 'u-me', repaired_at: null, ...o });
const note = (author, o = {}) => ({ id: 'n-' + author, fight_marker_id: 'f1', author_id: author, ...o });
const ftodo = (o) => ({ id: 't1', title: 'Apologize', fight_marker_id: 'f1', owner_id: 'u-me', created_by: 'u-you', done_at: null, deleted_at: null, ...o });
const fa = (o, who = FA_ME) => C.fightActions({ me: who.user_id, partner: who === FA_ME ? FA_YOU : FA_ME, marker: mk(), notes: [], todos: [], ...o }).map((a) => a.kind + (a.title ? ':' + a.title : '') + (a.name ? ':' + a.name : ''));

test('fightActions: no note from me and unrepaired -> Add your side; once I wrote, gone', () => {
  assert.deepEqual(fa({ notes: [note('u-you')] }), ['add']);
  assert.deepEqual(fa({ notes: [note('u-you'), note('u-me')] }), []);
});

test('fightActions: Waiting on partner when they have no note, suppressed once they wrote', () => {
  assert.deepEqual(fa({ notes: [note('u-me')] }), ['wait:Sam']);
  assert.deepEqual(fa({ notes: [note('u-me'), note('u-you')] }), []);
});

test('fightActions: repaired suppresses Add your side and Waiting for missing notes', () => {
  assert.deepEqual(fa({ marker: mk({ repaired_at: '2026-10-20T00:00:00Z' }) }), []);
});

test('fightActions: my open to-do for this fight shows its title; done, deleted, other-fight and partner-owned do not', () => {
  const notes = [note('u-me'), note('u-you')];
  assert.deepEqual(fa({ notes, todos: [ftodo({ title: 'Reflect' })] }), ['todo:Reflect']);
  assert.deepEqual(fa({ notes, todos: [ftodo({ done_at: '2026-10-20T00:00:00Z' })] }), []);
  assert.deepEqual(fa({ notes, todos: [ftodo({ deleted_at: '2026-10-20T00:00:00Z' })] }), []);
  assert.deepEqual(fa({ notes, todos: [ftodo({ fight_marker_id: 'other' })] }), []);
});

test('fightActions: a partner-owned open to-do I created shows Waiting; one she created for herself does not', () => {
  const notes = [note('u-me'), note('u-you')];
  assert.deepEqual(fa({ notes, todos: [ftodo({ owner_id: 'u-you', created_by: 'u-me' })] }), ['wait:Sam']);
  assert.deepEqual(fa({ notes, todos: [ftodo({ owner_id: 'u-you', created_by: 'u-you' })] }), []);
  assert.deepEqual(fa({ notes, todos: [ftodo({ owner_id: 'u-you', created_by: 'u-me', done_at: '2026-10-20T00:00:00Z' })] }), []);
});

test('fightActions: Waiting is one chip even when she has no note and owes a to-do I asked for; repaired fight with her to-do still waits', () => {
  assert.deepEqual(fa({ notes: [note('u-me')], todos: [ftodo({ owner_id: 'u-you', created_by: 'u-me' })] }), ['wait:Sam']);
  assert.deepEqual(fa({ marker: mk({ repaired_at: 'x' }), notes: [note('u-me')], todos: [ftodo({ owner_id: 'u-you', created_by: 'u-me' })] }), ['wait:Sam']);
});

test('fightActions: same fight from both phones is symmetric', () => {
  const o = { notes: [note('u-me')], todos: [ftodo({ owner_id: 'u-you', created_by: 'u-me', title: 'Reflect' })] };
  assert.deepEqual(fa(o, FA_ME), ['wait:Sam']);
  assert.deepEqual(fa(o, FA_YOU), ['add', 'todo:Reflect']);
});

// ---- fightGap / Add details chip ----
const T_EV = '2026-10-20T12:00:00Z', T_OLD = '2026-10-20T10:00:00Z', T_NEW = '2026-10-20T13:00:00Z';
const gm = (o = {}) => mk({ gaps: { 'u-me': 'Add more detail.', 'u-you': 'Partner message.' }, summary_notes_at: T_EV, ...o });
const gn = (author, at = T_OLD) => note(author, { created_at: at, updated_at: at });
test('fightActions: Add details when my gap is set and I have a note; Add your side never pairs with it', () => {
  assert.deepEqual(fa({ marker: gm(), notes: [gn('u-me'), gn('u-you')] }), ['details']);
  assert.deepEqual(fa({ marker: gm(), notes: [gn('u-you')] }), ['add']);
});
test('fightActions: Add details viewer symmetry, each person only sees their own gap', () => {
  const marker = gm({ gaps: { 'u-you': 'Only hers.' } }), notes = [gn('u-me'), gn('u-you')];
  assert.deepEqual(fa({ marker, notes }), []);
  assert.deepEqual(fa({ marker, notes }, FA_YOU), ['details']);
});
test('fightActions: no Add details when gaps null, {} , empty message, repaired, or deleted', () => {
  const notes = [gn('u-me'), gn('u-you')];
  for (const marker of [gm({ gaps: null }), gm({ gaps: {} }), gm({ gaps: { 'u-me': '' } }), gm({ repaired_at: T_OLD }), gm({ deleted_at: T_OLD }), mk()]) assert.deepEqual(fa({ marker, notes }), []);
});
test('fightActions: Add details waits until the evaluation has seen my newest note', () => {
  assert.deepEqual(fa({ marker: gm(), notes: [gn('u-me', T_OLD), gn('u-me', T_NEW), gn('u-you')] }), []);
  assert.deepEqual(fa({ marker: gm(), notes: [gn('u-me', T_OLD), gn('u-you', T_NEW)] }), ['details']); // partner's newer note is not mine
});
test('fightGap: shows with no note of mine (even a newer partner note), is the string for me only', () => {
  assert.equal(C.fightGap({ me: 'u-me', marker: gm(), notes: [gn('u-you', T_NEW)] }), 'Add more detail.');
  assert.equal(C.fightGap({ me: 'u-you', marker: gm(), notes: [gn('u-you')] }), 'Partner message.');
  assert.equal(C.fightGap({ me: 'u-me', marker: gm({ repaired_at: T_OLD }), notes: [] }), '');
  assert.equal(C.fightGap({ me: 'u-me', marker: gm({ summary_notes_at: null }), notes: [gn('u-me')] }), '');
});

test('homeList: own open to-dos incl. undated; no partner, done, deleted or scheduled; overdue, due today, cards, dated, undated', () => {
  const now = at('2026-10-20', 12), today = '2026-10-20';
  const td = (id, o = {}) => ({ id, title: id, owner_id: ME, due_date: null, created_at: iso('2026-10-01', 9), ...o });
  const todos = [
    td('undated'), td('later', { due_date: '2026-10-25' }), td('soon', { due_date: '2026-10-22' }), td('now', { due_date: today }),
    td('late', { due_date: '2026-10-18' }), td('theirs', { owner_id: YOU, due_date: '2026-10-18' }), td('done', { done_at: iso('2026-10-19', 9) }),
    td('declined', { declined_at: iso('2026-10-19', 9) }), td('gone', { deleted_at: iso('2026-10-19', 9) }), td('sched', { created_at: iso('2026-10-25', 9) }),
  ];
  const cards = [{ type: 'approve', redemption: { id: 'r1' } }, { type: 'nudge', send: { id: 's1' } }];
  const out = C.homeList({ me: ME, now, today, todos, cards, week: { type: 'week', net: 5 } })
    .map((e) => (e.kind === 'todo' ? e.todo.id : e.card.type));
  assert.deepEqual(out, ['late', 'now', 'approve', 'nudge', 'week', 'soon', 'later', 'undated']);
  assert.deepEqual(C.homeList({ me: ME, now, today, todos: [], cards: [], week: null }), []);
});

test('speechReset: a recognizer restart is a reset, a growing or rewritten partial is not', () => {
  assert.equal(C.speechReset('A minute ago I went home', 'She starts to hit herself'), true);
  assert.equal(C.speechReset('I went to the store and bought milk', 'Then'), true);
  assert.equal(C.speechReset('', 'Hello'), false);
  assert.equal(C.speechReset('A minute ago', 'A minute ago I went'), false);
  assert.equal(C.speechReset('I want to go', 'I wanna go'), false);
  assert.equal(C.speechReset('I want to go home now', 'I wanna go home'), false);
  assert.equal(C.speechReset('I went to the store and bought some bread', 'I said no'), true);
  assert.equal(C.speechReset('I want to go', 'Hi want to go'), false);
  assert.equal(C.speechReset('their dog ran', 'there dog ran'), false);
  assert.equal(C.speechReset('hello there my friend', 'Hello there my'), false);
});
