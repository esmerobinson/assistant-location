// Generic layout sweep: every Cycle screen and the main sheets, seeded with realistic content and a 14-char partner
// name ("Alexandria Rae"), at 375 and 430px. Each one is checked for the CLASS of bug that keeps shipping one at a time
// (see CycleApp/web/LAYOUT.md): glyphs spilling out of their control, overlapping sibling controls, horizontal overflow,
// content jammed under the pink band, undersized tap targets. Add every new screen or sheet to SCENARIOS below.
// WebKit only (WKWebView parity): needs GL_WEBKIT_PW / GL_WEBKIT_EXEC. LAYOUT_SHOTS=<dir> writes <screen>-<width>.png.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_WK = !!(process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC);
const pw = HAS_WK ? await import(process.env.GL_WEBKIT_PW) : null;
const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const SHOTS = process.env.LAYOUT_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Minimum distance (px) from the bottom of the header (.hd) to the top of the first content under it.
// Measured on the existing screens at 375 and 430: Auth, Setup, Fight detail, Nudge screens, Acks use 22 (the .p2 main gap);
// Home and Points 28, Cycle 24. Tap-target height is deliberately not swept: tags, plus and points chips are small by design.
const BAND_GAP = 22;
const PILL_INSET = 4; // min px between a pill's glyphs and its left/right edge
// Min vertical px between stacked blocks, measured ink to ink. A frame is any bordered/filled box at least CTRL_H tall
// (text boxes, pills, cards; smaller tags and badges count as text). A rule is a one-sided border line. Text to text is
// unchecked (headings and their meta lines sit tight on purpose). Set after Oliver flagged the same cramped look on the
// intensity rule, the When row and the to-do sheet rows; stacked cards and buttons use 10 by design.
const MIN_V = { frame: 10, rule: 10 };
const CTRL_H = 30;

const ME = 'u-me', HER = 'u-her', PARTNER = 'Alexandria Rae';
const NOW = '2026-10-21T15:00:00Z'; // Wed 11:00 New York
const iso = (hoursAgo) => new Date(Date.parse(NOW) - hoursAgo * 36e5).toISOString();
const base = { couple_id: 'c1', created_at: iso(72), updated_at: iso(72), deleted_at: null };
const td = (id, o) => ({ ...base, id, owner_id: ME, created_by: ME, item_id: null, fight_marker_id: null, title: id, description: null, type: 'task',
  due_date: null, target: null, period: null, points_earn: null, points_miss: null, needs_note: false, edited_at: null, tally: 0, done_at: null, ...o });
const item = (id, o) => ({ ...base, id, sender_id: ME, recipient_id: HER, kind: 'ask', body: id, ask_type: 'task', description: null, due_date: null, target: null,
  period: null, points_earn: null, points_miss: null, needs_note: false, origin: null, response_type: null, fight_marker_id: null,
  held_until: new Date(Date.parse(NOW) + 45 * 6e4).toISOString(), status: 'held', delivered_at: null, opened_at: null, kept: null, ...o });
const nudge = (id, body, o) => ({ ...base, id, author_id: ME, body, tag: 'Calm', pinned: false, sort_order: 0, archived_at: null, ...o });

const TODOS = [
  td('t-mine', { title: 'Book the dentist appointment', description: 'Ask about the Tuesday slot', due_date: '2026-10-23' }),
  td('t-habit', { title: 'Stretch for ten minutes every morning', type: 'habit', target: 3, period: 'week' }),
  td('t-month', { title: 'Call mum', type: 'habit', target: 20, period: 'month' }),
  td('t-from-her', { title: 'Take the bins out', created_by: HER }),
  td('t-resp', { title: 'Apologise', type: 'response', created_by: HER }),
  td('t-note', { title: 'Water the plants', needs_note: true }),
  td('t-late-mine', { title: 'Sort out the whole of the paperwork for the car before the end of the month', due_date: '2026-10-15' }),
  td('t-late-long', { title: 'Can you tell me what you are doing for the whole of next weekend so that I can plan around it please', owner_id: HER, created_by: ME, due_date: '2026-10-15' }),
  td('t-hers', { title: 'Renew the car insurance', owner_id: HER, created_by: ME, due_date: '2026-10-25' }),
  td('t-hers-h', { title: 'Run', owner_id: HER, created_by: ME, type: 'habit', target: 2, period: 'day' }),
  // Owning up: one open of mine, one she finished with a long note (Home card + view page).
  td('t-ownup-open', { title: 'I went quiet when you asked about Friday and left the room', type: 'ownup', needs_note: true, points_earn: 0, points_miss: 0 }),
  td('t-ownup-done', { title: 'I interrupted you at dinner and brushed off what you said', type: 'ownup', owner_id: HER, created_by: HER, needs_note: true, done_at: iso(6) }),
  // Scheduled: stamped with a future time, so they show only under the To do screen's "Scheduled" section until then.
  // Raise issue: one delivered each way (apologize owed by her, change owed by me) plus one she finished.
  td('t-iss-mine', { title: 'You went quiet at dinner and I did not know whether I had done something wrong', owner_id: HER, created_by: ME, type: 'ownup', needs_note: true, item_id: 'i-iss-sent', created_at: iso(30) }),
  td('t-iss-done', { title: 'Please text when you are running late', owner_id: HER, created_by: ME, item_id: 'i-iss-done', created_at: iso(60), done_at: iso(40) }),
  td('t-iss-hers', { title: 'You promised to call the landlord about the heating and it is still not done', type: 'task', created_by: HER, item_id: 'i-iss-hers', created_at: iso(20) }),
  td('t-sched-me', { title: 'Renew the passport before the trip in March', created_at: iso(-44) }),
  td('t-sched-her', { title: 'Take the recycling out', owner_id: HER, created_by: ME, item_id: 'i-sched', created_at: iso(-20) }),
];
const SHARED = {
  couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60 },
  members: [{ user_id: ME, name: 'Me', checkin_time: '21:00' }, { user_id: HER, name: PARTNER, checkin_time: '21:00' }],
  rows: {
    items: Object.fromEntries([item('i-kg', { kind: 'kudos', ask_type: null, body: 'Thank you for cooking when I was exhausted this week', gift_points: 5, status: 'delivered', delivered_at: iso(30), held_until: null }),
      item('i-kr', { kind: 'kudos', ask_type: null, sender_id: HER, recipient_id: ME, body: 'You listened', points: false, status: 'delivered', delivered_at: iso(10), held_until: null }),
      item('i-iss-held', { body: 'You said you would plan the weekend and then left it all to me again, and I would like that to change', origin: 'issue', response_type: 'change', held_until: iso(-10) }),
      item('i-iss-ready', { body: 'You brushed me off in front of your friends', origin: 'issue', response_type: 'apologize', ask_type: 'ownup', needs_note: true, held_until: iso(1) }),
      item('i-iss-sent', { body: 'You went quiet at dinner', origin: 'issue', response_type: 'apologize', ask_type: 'ownup', needs_note: true, status: 'delivered', delivered_at: iso(30), held_until: iso(31) }),
      item('i-iss-done', { body: 'Please text when you are running late', origin: 'issue', response_type: 'change', status: 'delivered', delivered_at: iso(60), held_until: iso(61) }),
      item('i-iss-hers', { body: 'You promised to call the landlord', origin: 'issue', response_type: 'change', sender_id: HER, recipient_id: ME, status: 'delivered', delivered_at: iso(20), held_until: iso(21) }),
      item('i-held', { body: 'Clean the kitchen before Sunday dinner' }),
      item('i-drop', { body: 'Stop leaving the washing up until the morning', status: 'dropped', held_until: iso(5) }),
      item('i-ready', { body: 'Pick up the parcel', held_until: iso(1) }),
      item('i-sched', { body: 'Take the recycling out', held_until: null, status: 'delivered', delivered_at: iso(-20) })].map((r) => [r.id, r])),
    todos: Object.fromEntries(TODOS.map((r) => [r.id, r])),
    // View-page thread: a long unbroken word and a long sentence from the partner so wrapping is exercised.
    todo_comments: Object.fromEntries([
      { ...base, id: 'tc1', todo_id: 't-hers', author_id: ME, body: 'Can you do this before Friday, the quote runs out then and the price goes up again', created_at: iso(30) },
      { ...base, id: 'tc3', todo_id: 't-hers', author_id: ME, body: 'Removed text', created_at: iso(20), deleted_at: iso(19) },
      { ...base, id: 'tc2', todo_id: 't-hers', author_id: HER, body: 'Supercalifragilisticexpialidocious_policy_number_1234567890_ok', created_at: iso(5) },
    ].map((r) => [r.id, r])),
    // Nudged today already, so the habit's view page shows the disabled "Nudged" state.
    todo_nudges: { tn1: { ...base, id: 'tn1', todo_id: 't-hers-h', sender_id: ME, created_at: iso(1) } },
    todo_events: { e2: { ...base, id: 'e2', todo_id: 't-ownup-done', user_id: HER, kind: 'done', at: iso(6), note: 'I went quiet because I felt judged, and next time I will say so instead of leaving' }, e1: { ...base, id: 'e1', todo_id: 't-habit', user_id: ME, kind: 'tally', at: iso(2), note: null } },
    checkins: {},
    fight_markers: { fm4: { ...base, id: 'fm4', logged_by: ME, at: iso(0.1), created_at: iso(0.1), repaired_at: null, hit_self: false, hit_related: false }, fm1: { ...base, id: 'fm1', logged_by: ME, at: iso(30), repaired_at: null, hit_self: false, hit_related: false, intensity: 3 },
      fm2: { ...base, id: 'fm2', logged_by: HER, at: iso(5), repaired_at: null, hit_self: null, hit_related: null, intensity: 2 },
      fm3: { ...base, id: 'fm3', logged_by: HER, at: iso(29), repaired_at: iso(20), hit_self: true, hit_related: false, hit_count: 1, intensity: 4 } },
    // One challenge per card state, with a long partner name and a long title so the card row is swept at its worst.
    challenges: Object.fromEntries([
      { ...base, id: 'c-new', name: 'No snacking', start: '2026-10-01', for_user: HER, breaks_on: 'tap', accepted_at: null, rule: 'r' },
      { ...base, id: 'c-goal', name: 'BPD research', start: '2026-10-19', for_user: ME, breaks_on: 'goal', goal_days: 10, goal_window_days: 14, goal_earn: 150, goal_miss: 50, accepted_at: iso(48), rule: 'r' },
      { ...base, id: 'c-done', name: 'Sleep early', start: '2026-10-05', for_user: ME, breaks_on: 'goal', goal_days: 1, goal_window_days: 14, goal_earn: 10, goal_miss: 5, accepted_at: iso(400), rule: 'r' },
      { ...base, id: 'c-fail', name: 'Stretch', start: '2026-10-05', for_user: ME, breaks_on: 'goal', goal_days: 10, goal_window_days: 3, goal_earn: 10, goal_miss: 5, accepted_at: iso(400), rule: 'r' },
    ].map((r) => [r.id, r])),
    challenge_days: Object.fromEntries([
      { ...base, id: 'cd1', challenge_id: 'c-goal', day: '2026-10-20', note: 'chapter 2', by: ME },
      { ...base, id: 'cd2', challenge_id: 'c-done', day: '2026-10-12', note: 'ok', by: ME },
    ].map((r) => [r.id, r])),
    fight_notes: { fn1: { ...base, id: 'fn1', fight_marker_id: 'fm1', author_id: ME, created_at: iso(30), body: 'I raised my voice about the dishes' } },
    rewards: { r1: { ...base, id: 'r1', name: 'Breakfast in bed', price: 40, archived: false, art: null }, r2: { ...base, id: 'r2', name: 'Pick the next film', price: 120, archived: false, art: null }, r3: { ...base, id: 'r3', name: 'Breast implants', price: 5, archived: false, art: 'upgrading' }, r4: { ...base, id: 'r4', name: 'Breast implants', price: 10000, archived: false, art: 'cupid' }, r5: { ...base, id: 'r5', name: 'Plain', price: 5, archived: false, art: null }, r6: { ...base, id: 'r6', name: 'Shopping', price: 5, archived: false, art: 'shopper' } },
    redemptions: { rd2: { ...base, id: 'rd2', reward_id: 'r2', requested_by: ME, status: 'pending', price: 120, decided_by: null, decided_at: null }, rd1: { ...base, id: 'rd1', reward_id: 'r1', requested_by: HER, status: 'pending', price: 40, decided_by: null, decided_at: null } },
    nudges: { n1: nudge('n1', 'You are doing fine, take a breath'), n2: nudge('n2', 'Done one', { done_at: iso(20) }), n3: nudge('n3', 'Archived reminder about water', { archived_at: iso(40) }) },
    nudge_sends: { s1: { ...base, id: 's1', nudge_id: 'n1', sender_id: HER, recipient_id: ME, body: 'You are doing fine', deliver_at: iso(3), opened_at: null },
      s2: { ...base, id: 's2', nudge_id: 'n1', sender_id: ME, recipient_id: HER, body: 'You are doing fine, take a breath', deliver_at: iso(26), opened_at: iso(25) },
      s3: { ...base, id: 's3', nudge_id: 'n1', sender_id: ME, recipient_id: HER, body: 'Tomorrow morning reminder', deliver_at: iso(-14), opened_at: null } },
    nudge_replies: { rp1: { ...base, id: 'rp1', send_id: 's2', author_id: ME, body: 'Removed reply', created_at: iso(24), deleted_at: iso(23) }, rp2: { ...base, id: 'rp2', send_id: 's2', author_id: HER, body: 'Thank you', created_at: iso(23) } },
    nudge_awards: { aw1: { ...base, id: 'aw1', author_id: ME, recipient_id: HER, nudge_id: 'n2', body: 'Done one', points: 30, payout: '3mo', done_at: iso(20), stopped_at: null } },
  },
  cursors: {}, outbox: [],
};
const seed = (couple) => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: ME, email: 'me@x.test' } },
  ['shared.' + ME]: couple ? SHARED : { couple: null, members: [], rows: {}, cursors: {}, outbox: [] },
  ['priv.' + ME]: { fights: [{ id: 'fm4', at: Date.parse(NOW) - 0.1 * 36e5, logged_at: Date.parse(NOW) - 0.1 * 36e5, intensity: 3 }, { id: 'f1', at: iso(30), intensity: 3 }, { id: 'f2', at: iso(24 * 20), intensity: 2 }], affirmations: [], prefs: {}, ownupSeen: [], ownupSince: 0,
    queued: [{ body: 'Pick up milk on the way home' }], nudges: [], nudge_sends: [], kudos: [{ id: 'pk1', body: 'I walked away instead of arguing', created_at: iso(8) }] },
});

// Each scenario is a sequence of data-a actions fired from the Today tab. `signedOut`/`setup` use their own seed.
const SCENARIOS = [
  ['auth', { seed: 'auth' }], ['setup', { seed: 'setup' }],
  ['home', []], ['todo', ['tab:todo']],
  ['todo-add-picker', ['tab:todo', 'addpick']], ['challenge-detail-goal', ['tab:progress', 'challenge:c-goal']], ['challenge-detail-new', ['tab:progress', 'challenge:c-new']],
  ['challenge-new', ['tab:progress', 'newch']],
  ['todo-new-task', ['tab:todo', 'addpick', 'newtodo:task']], ['todo-new-task-me', ['tab:todo', 'addpick', 'newtodo:task', 'nfor:me']],
  ['todo-new-habit', ['tab:todo', 'addpick', 'newtodo:task', 'nkind:habit']], ['todo-new-habit-month', ['tab:todo', 'addpick', 'newtodo:task', 'nkind:habit', 'nper:month']],
  ['todo-edit', ['tab:todo', 'etodo:t-mine']], ['todo-edit-habit', ['tab:todo', 'etodo:t-habit']],
  ['todo-note', ['tab:todo', 'done:t-note']], ['todo-still', ['tab:todo', 'still:i-held']],
  ['todo-detail-hers', ['tab:todo', 'tview:t-hers']], ['todo-detail-hers-habit', ['tab:todo', 'tview:t-hers-h']],
  ['todo-detail-from-her', ['tab:todo', 'tview:t-from-her']], ['todo-detail-habit', ['tab:todo', 'tview:t-habit']],
  ['todo-detail-edit', ['tab:todo', 'tview:t-hers', 'etodo:t-hers']],
  ['todo-detail-long-title', ['tab:todo', 'tview:t-late-long']],
  ['fight', ['go:fight']], ['fight-custom', ['go:fight', 'chip:custom']], ['fight-detail', ['go:fight', 'openfight:fm1']], ['fight-detail-own-editable', ['go:fight', 'openfight:fm4']], ['fight-edit', ['go:fight', 'openfight:fm4', 'fightedit']], ['fight-delete-ask', ['go:fight', 'openfight:fm4', 'fightdelq']], ['shop-cancel-ask', ['go:points', 'go:shop', 'reward:r2']],
  ['more', ['go:more']], ['settings', ['go:more', 'go:settings']], ['points', ['go:points']], ['shop', ['go:points', 'go:shop']],
  ['shop-redeem', ['go:points', 'go:shop', 'reward:r1']], ['shop-redeem-art', ['go:points', 'go:shop', 'reward:r3']], ['shop-redeem-null-art', ['go:points', 'go:shop', 'reward:r5']], ['shop-redeem-shopper', ['go:points', 'go:shop', 'reward:r6']], ['shop-add', ['go:points', 'go:shop', 'addreward']],
  ['week', ['go:week']], ['cycle', ['go:more', 'go:cycle']],
  ['nudges', ['tab:todo', 'todoseg:rem']], ['nudge', ['tab:todo', 'todoseg:rem', 'nudge:n1']], ['nudge-done', ['tab:todo', 'todoseg:rem', 'nudge:n1', 'nudgedone']],
  ['nudge-incoming', ['nudgein:s1']], ['nudge-new', ['tab:todo', 'todoseg:rem', 'nudgenew']],
  ['todo-new-later', ['tab:todo', 'addpick', 'newtodo:task', 'nwhen:later']], ['todo-new-later-me', ['tab:todo', 'addpick', 'newtodo:task', 'nfor:me', 'nwhen:later']],
  ['ownup-new', ['tab:todo', 'addpick', 'newtodo:ownup']], ['ownup-new-later', ['tab:todo', 'addpick', 'newtodo:ownup', 'nwhen:later']], ['ownup-edit', ['tab:todo', 'etodo:t-ownup-open']],
  ['ownup-note', ['tab:todo', 'done:t-ownup-open']], ['ownup-detail-hers', ['tview:t-ownup-done']],
  ['fights', ['tab:fights']], ['fights-16w', ['tab:fights', 'frange:16w']], ['progress', ['tab:progress']], ['dropped', ['go:more', 'go:dropped']],
  ['todo-done-all', ['tab:todo', 'doneall']], ['rem-sent', ['tab:todo', 'todoseg:rem', 'remview:sent']], ['rem-recv', ['tab:todo', 'todoseg:rem', 'remview:recv']],
  ['rem-arch', ['tab:todo', 'todoseg:rem', 'remview:arch']], ['shop-edit', ['go:points', 'go:shop', 'shopedit']], ['shop-edit-sheet', ['go:points', 'go:shop', 'shopedit', 'reward:r1']],
  ['issues', ['go:issues']], ['issue-still', ['go:issues', 'still:i-iss-held']], ['issue-still-ready', ['go:issues', 'still:i-iss-ready']],
  ['issue-new', ['go:issues', 'issuenew']], ['issue-new-long', ['go:issues', 'issuenew', 'fill:ibody=You said you would plan the weekend and then left it all to me again, and I would like that to change because it keeps happening', 'itype:change']]
];

// Runs in the page. Returns violation strings: "<selector> <what> <numbers>".
function sweepInPage({ bandGap, pillInset: PILL_INSET, minV: MIN_V, ctrlH: CTRL_H, probe }) {
  const vw = window.innerWidth, out = [];
  const TEXT = 'button, .seg span, .chip, .pick, .save, .ghost, .tdrop, .done, .go, .pillb, .usb, .bal, .fight, .txtbtn, .back, .cd, .p1b, .hv, ' +
    '.tab b, .tab i, .lab, .lab0, h1, h2, h3, .dl, .tag, .eb, .it .nm, .it .pr, .nc .s, .nc .x, .stp b, .stp span, .tg, .ln .am, .big, .cl .t, small, .frow > span';
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0' && !e.closest('.band'); };
  const name = (e) => { let s = e.tagName.toLowerCase(); if (e.className && typeof e.className === 'string') s += '.' + e.className.trim().split(/\s+/).join('.'); const a = e.getAttribute('data-a'); if (a) s += `[data-a="${a}"]`;
    const t = (e.textContent || '').trim().slice(0, 18); return s + (t ? ` "${t}"` : ''); };
  const f = (n) => Math.round(n * 10) / 10;
  // A node inside an ellipsised ancestor (a truncated name) is deliberately cut, not overflowing.
  const clipped = (n) => { for (let p = n.parentElement; p && !p.classList.contains('phone'); p = p.parentElement) if (getComputedStyle(p).textOverflow === 'ellipsis') return true; return false; };
  const textRect = (e) => {
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), rs = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim() || clipped(n)) continue; const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.width > 0) rs.push(q); }
    return rs.length ? { left: Math.min(...rs.map((q) => q.left)), right: Math.max(...rs.map((q) => q.right)), top: Math.min(...rs.map((q) => q.top)), bottom: Math.max(...rs.map((q) => q.bottom)) } : null;
  };
  // 1. glyphs inside their own element and inside the nearest rounded, bordered or filled ancestor control.
  const box = (e) => e.getBoundingClientRect();
  const frame = (e) => { for (let p = e.parentElement; p && !p.classList.contains('phone'); p = p.parentElement) {
    const s = getComputedStyle(p), bordered = ['Top', 'Right', 'Bottom', 'Left'].some((d) => parseFloat(s['border' + d + 'Width']) > 0 && s['border' + d + 'Style'] !== 'none');
    if (parseFloat(s.borderTopLeftRadius) > 0 && (bordered || s.backgroundColor !== 'rgba(0, 0, 0, 0)') && !p.classList.contains('bs') && !p.classList.contains('scr')) return p; } return null; };
  for (const e of document.querySelectorAll(TEXT)) {
    if (!vis(e)) continue;
    const s = getComputedStyle(e);
    if (s.overflow !== 'visible' || s.textOverflow === 'ellipsis') continue; // deliberate clipping / ellipsis
    const t = textRect(e); if (!t) continue;
    const b = box(e), fr = frame(e);
    // A pill (rounded and filled/bordered) needs breathing room: glyphs touching its left/right edge read as clipped (MONTH in a 52px cell).
    const bordered = ['Top', 'Right', 'Bottom', 'Left'].some((d) => parseFloat(s['border' + d + 'Width']) > 0 && s['border' + d + 'Style'] !== 'none');
    if (parseFloat(s.borderTopLeftRadius) > 0 && (bordered || s.backgroundColor !== 'rgba(0, 0, 0, 0)') && s.display !== 'block') {
      const inL = t.left - b.left, inR = b.right - t.right;
      if (Math.min(inL, inR) < PILL_INSET) out.push(`glyphs of ${name(e)} sit ${f(Math.min(inL, inR))}px from the edge of their own pill (needs >= ${PILL_INSET}px; text ${f(t.left)}..${f(t.right)}, box ${f(b.left)}..${f(b.right)})`);
    }
    for (const [who, r] of [['own box', b], ['ancestor ' + (fr ? name(fr) : ''), fr && box(fr)]]) {
      if (!r) continue;
      const over = { left: r.left - t.left, right: t.right - r.right, top: r.top - t.top, bottom: t.bottom - r.bottom };
      const bad = Object.entries(over).filter(([, v]) => v > 1);
      if (bad.length) out.push(`glyphs of ${name(e)} extend outside ${who} by ${bad.map(([k, v]) => `${k} ${f(v)}px`).join(', ')} (text ${f(t.left)}..${f(t.right)}, box ${f(r.left)}..${f(r.right)})`);
    }
  }
  // 2. sibling controls in a row do not overlap.
  const CTRL = '.seg span, .chip, .pick, .save, .ghost, .tdrop, .done, .go, .pillb, .usb, .bal, .fight, .txtbtn, .p1b, .tab, .stp span, .tg, .it, .hact > *';
  for (const parent of new Set([...document.querySelectorAll(CTRL)].map((e) => e.parentElement))) {
    const kids = [...parent.children].filter((k) => k.matches(CTRL) && vis(k) && getComputedStyle(k).position !== 'absolute');
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = box(kids[i]), c = box(kids[j]), ox = Math.min(a.right, c.right) - Math.max(a.left, c.left), oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (ox > 1 && oy > 1) out.push(`siblings ${name(kids[i])} and ${name(kids[j])} overlap by ${f(ox)}x${f(oy)}px`);
    }
  }
  // 3. no horizontal overflow (the page itself and every element, bar the rotated band, the sheet's dim layer and the Actions card row, which scrolls sideways on purpose; its bleed past the page is covered by the page scrollWidth check).
  const de = document.documentElement;
  if (de.scrollWidth > vw) out.push(`page scrollWidth ${de.scrollWidth} > viewport ${vw}`);
  for (const e of document.querySelectorAll('.phone *')) {
    if (!vis(e) || clipped(e) || e.closest('.dim, svg, .errbar, .deck') || e.tagName === 'INPUT' && e.type === 'date') continue;
    const r = box(e); if (r.right > vw + 1 || r.left < -1) out.push(`${name(e)} spans x ${f(r.left)}..${f(r.right)}, viewport 0..${vw}`);
  }
  // 4. the first content under the header clears the pink band.
  const band = document.querySelector('.band'), hd = document.querySelector('main > .hd');
  if (band && hd && !document.querySelector('.bs')) {
    const first = [...hd.parentElement.children].filter((k) => k !== hd && vis(k))[0];
    if (first) { const gap = box(first).top - box(hd).bottom; if (probe) out.push('PROBE-GAP ' + f(gap) + ' ' + name(first)); if (gap < bandGap) out.push(`first content ${name(first)} is ${f(gap)}px under the header (needs >= ${bandGap}px)`); }
  }
  // 5. vertical gaps between stacked blocks, measured between what is actually drawn (ink): a framed or filled box's
  // border box, a one-sided rule's line, else the union of glyphs and drawn children.
  const sides = (s) => ['Top', 'Right', 'Bottom', 'Left'].filter((d) => parseFloat(s['border' + d + 'Width']) > 0 && s['border' + d + 'Style'] !== 'none');
  const framed = (e) => { const s = getComputedStyle(e), sd = sides(s); return sd.length > 1 || s.backgroundColor !== 'rgba(0, 0, 0, 0)'; };
  // Ink rects carry the kind of what forms their top edge (tk) and bottom edge (bk): a gap is judged by the two edges that face it.
  const U = (a, c) => !a ? c : !c ? a : { left: Math.min(a.left, c.left), right: Math.max(a.right, c.right), top: Math.min(a.top, c.top), bottom: Math.max(a.bottom, c.bottom),
    tk: a.top <= c.top ? a.tk : c.tk, bk: a.bottom >= c.bottom ? a.bk : c.bk };
  const K = (rect, k) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, tk: k, bk: k });
  const worst = (x, y) => [x, y].includes('frame') ? 'frame' : [x, y].includes('rule') ? 'rule' : 'text';
  const inkCache = new Map();
  function ink(e) {
    if (inkCache.has(e)) return inkCache.get(e);
    let r = null;
    if (vis(e) && getComputedStyle(e).position !== 'absolute' && getComputedStyle(e).position !== 'fixed') {
      if (e.tagName.toLowerCase() === 'svg') r = K(box(e), 'text');
      else if (framed(e)) r = K(box(e), box(e).height >= CTRL_H ? 'frame' : 'text');
      else {
        for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { const g = document.createRange(); g.selectNodeContents(n); for (const q of g.getClientRects()) if (q.width > 0) r = U(r, K(q, 'text')); }
        for (const k of e.children) r = U(r, ink(k));
        const sd = sides(getComputedStyle(e)), b = box(e);
        if (sd[0] === 'Bottom') { if (r) gaps.push([b.bottom - r.bottom, 'rule', name(e) + ' content -> its bottom rule']); r = U(r, K({ left: b.left, right: b.right, top: b.bottom - 2, bottom: b.bottom }, 'rule')); }
        if (sd[0] === 'Top') { if (r) gaps.push([r.top - b.top, 'rule', name(e) + ' top rule -> its content']); r = U(r, K({ left: b.left, right: b.right, top: b.top, bottom: b.top + 2 }, 'rule')); }
      }
    }
    inkCache.set(e, r); return r;
  }
  const gaps = [];
  const root = document.querySelector('.bs') || document.querySelector('main');
  for (const p of [root, ...root.querySelectorAll('*')]) {
    if (p.closest('svg') || framed(p) && p !== root) continue;
    const kids = [...p.children].filter((k) => !k.matches('.grab') && ink(k));
    for (let i = 1; i < kids.length; i++) {
      const a = ink(kids[i - 1]), c = ink(kids[i]);
      if (c.top < a.bottom - 1 || Math.min(a.right, c.right) - Math.max(a.left, c.left) < -400) continue; // side by side, not stacked
      // Repeated rows of one kind (a list, wrapped chips) are spaced by their own rule; only unlike neighbours are checked.
      // A field label sits on the control it names at the shared .lab margin (8px), so label -> control is not checked.
      if (kids[i].className === kids[i - 1].className && kids[i].tagName === kids[i - 1].tagName || kids[i - 1].matches('.lab, .lab0, .hl0')) continue;
      gaps.push([c.top - a.bottom, worst(a.bk, c.tk), name(kids[i - 1]) + ' -> ' + name(kids[i])]);
    }
  }
  if (probe) for (const [g, k, w] of gaps) if (g < 20) out.push(`PROBE-V ${f(g)} ${k} ${w}`);
  for (const [g, k, w] of gaps) if (k !== 'text' && g < MIN_V[k]) out.push(`${w}: ${f(g)}px apart (a ${k} needs >= ${MIN_V[k]}px)`);
  return out;
}

describe('layout sweep (webkit)', { skip: !HAS_WK && 'needs GL_WEBKIT_PW and GL_WEBKIT_EXEC' }, () => {
  let browser;
  before(async () => { browser = await pw.webkit.launch({ headless: true, executablePath: process.env.GL_WEBKIT_EXEC }); });
  after(async () => { await browser.close(); });

  async function open(w, kind) {
    const context = await browser.newContext({ viewport: { width: w, height: 844 }, hasTouch: true });
    await context.clock.setFixedTime(new Date(NOW));
    await context.addInitScript((s) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: '' };
      if (!localStorage.getItem('cycle:session')) for (const k in s) localStorage.setItem('cycle:' + k, JSON.stringify(s[k]));
    }, kind === 'auth' ? {} : seed(kind !== 'setup'));
    await context.route('**/cycle.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (r) => r.abort()); // offline: everything comes from the seed
    const page = await context.newPage();
    const errors = []; // a thrown render leaves the previous screen up, which would be swept as if it were the target
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/config\.js/.test(m.text()) && errors.push('console: ' + m.text()));
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(kind === 'auth' ? '[data-a="signin"], input[type="email"]' : kind === 'setup' ? 'input[data-d="name"]' : '[data-a="go:fight"]');
    return { context, page, errors };
  }
  // Fires the action through the app's own delegated click handler from an injected [data-a] element (no tab bar needed,
  // and a sheet covering the page cannot intercept it).
  async function act(page, a) {
    if (a.startsWith('fill:')) { const [k, v] = a.slice(5).split('='); return page.evaluate(([k, v]) => { const el = document.querySelector(`[data-d="${k}"]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [k, v]); }
    await page.evaluate((a) => { const m = document.querySelector('main'); m.insertAdjacentHTML('beforeend', `<span id="sweep-nv" data-a="${a}">x</span>`); const el = document.getElementById('sweep-nv'); el.click(); el.remove(); }, a);
  }

  for (const w of [375, 430]) {
    describe(`${w}px`, () => {
      let main;
      before(async () => { main = await open(w, 'couple'); });
      after(async () => { await main.context.close(); });
      for (const [screen, spec] of SCENARIOS) test(`${screen} at ${w}px`, { timeout: 20000 }, async () => {
        const solo = !Array.isArray(spec);
        const { context, page, errors } = solo ? await open(w, spec.seed) : main;
        try {
          if (!solo) { await act(page, 'tab:home'); for (const a of spec) { await act(page, a); } }
          await page.waitForTimeout(60);
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${screen}-${w}.png`) });
          assert.deepEqual(errors.splice(0), [], `${screen} @ ${w}px threw`);
          const v = await page.evaluate(sweepInPage, { bandGap: BAND_GAP, pillInset: PILL_INSET, minV: MIN_V, ctrlH: CTRL_H, probe: !!process.env.PROBE });
          assert.deepEqual(v, [], `${screen} @ ${w}px:\n  ` + v.join('\n  '));
        } finally { if (solo) await context.close(); }
      });
    });
  }
  test('shop-redeem-art: 112px art tile on every row, no overflow at 375px, sheet and its buttons fit 375x667', { timeout: 20000 }, async () => {
    const { context, page, errors } = await open(375, 'couple');
    try {
      await page.setViewportSize({ width: 375, height: 667 });
      await act(page, 'tab:home'); await act(page, 'go:points'); await act(page, 'go:shop');
      await page.waitForFunction(() => document.styleSheets.length > 1 && document.querySelector('.shop .rthumb').offsetWidth > 0); // stylesheet arrives async
      assert.deepEqual(await page.$$eval('.shop .it:not(.add) .rthumb', (e) => e.map((x) => { const r = x.getBoundingClientRect(); return [r.width, r.height]; })), Array(6).fill([112, 112]));
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, [...document.querySelectorAll('.shop .it')].every((e) => e.getBoundingClientRect().right <= innerWidth && e.scrollWidth <= e.clientWidth)]), [true, true]);
      assert.equal(await page.$eval('[data-a="reward:r5"] .rthumb', (e) => e.innerHTML), await page.evaluate(() => { const d = document.createElement('div'); d.innerHTML = artSvg(null, 'row'); return d.innerHTML; }));
      for (const id of ['r3', 'r5', 'r6']) {
        await act(page, 'reward:' + id);
        const fit = await page.evaluate(() => [document.querySelectorAll('.rart svg').length, ...[...document.querySelectorAll('.bs [data-a^="redeem:"], .bs [data-a="sheet:close"]')].map((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })]);
        assert.deepEqual(fit, [1, true, true, true], 'sheet ' + id);
        await act(page, 'sheet:close');
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
