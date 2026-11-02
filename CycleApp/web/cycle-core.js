// Cycle core: pure logic, no DOM, no network. Loaded as a classic script (global
// CycleCore) in the app and via vm in the unit tests.
var CycleCore = (function () {
  'use strict';
  var MIN = 60000, DAY = 86400000;

  // ---- time -------------------------------------------------------------
  var fmts = {};
  function localDay(ms, tz) {
    var f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
    return f.format(new Date(ms));
  }
  function utc(day) { var p = day.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(day, n) { return new Date(utc(day) + n * DAY).toISOString().slice(0, 10); }
  function dayDiff(a, b) { return Math.round((utc(b) - utc(a)) / DAY); }
  function dow(day) { return (new Date(utc(day)).getUTCDay() + 6) % 7; } // Mon = 0
  function weekStart(day) { return addDays(day, -dow(day)); }

  // Wall-clock HH:MM on a given YYYY-MM-DD in a tz -> epoch ms. Intl has no inverse, so start from the
  // UTC guess and correct by the difference the tz shows; two passes settle across a DST offset change.
  function zonedMs(day, h, mi, tz) {
    var want = Date.parse(day + 'T' + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':00Z'), guess = want;
    for (var i = 0; i < 2; i++) {
      var f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)), p = {};
      f.forEach(function (x) { p[x.type] = x.value; });
      guess += want - Date.parse(p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':00Z');
    }
    return guess;
  }
  function localHour(ms_, tz) {
    return +new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' }).format(new Date(ms_));
  }

  // ---- nudges -----------------------------------------------------------------
  var NUDGE_CUTOFF_H = 20, NUDGE_MORNING_H = 8;
  // The 8 pm rule. A nudge sent at/after 20:00 on the sender's clock goes out at 08:00 the next day
  // (sender's calendar), read on the recipient's clock; earlier it is delivered at once.
  function deliverAt(now, senderTz, recipientTz) {
    if (localHour(now, senderTz) < NUDGE_CUTOFF_H) return now;
    return zonedMs(addDays(localDay(now, senderTz), 1), NUDGE_MORNING_H, 0, recipientTz);
  }
  // Raise issue: an issue the sender writes tonight reaches the partner no earlier than 08:00 the next calendar day
  // on the sender's clock, and only after the sender confirms it (the "Still send?" card). Pure so the DST days
  // (23 / 25 hour days) are testable; zonedMs resolves the wall time, not now + 24h.
  function issueHeldUntil(now, tz) {
    return zonedMs(addDays(localDay(now, tz), 1), NUDGE_MORNING_H, 0, tz);
  }
  // Library sections. Pinned and All keep the author's manual order (sort_order); Recent is the 4
  // most recently sent-or-added unpinned nudges. A nudge sits in exactly one section: All is what
  // Pinned and Recent leave behind.
  function sectionNudges(nudges, sends) {
    var lastSent = {};
    sends.forEach(function (s) { if (!s.deleted_at) lastSent[s.nudge_id] = Math.max(lastSent[s.nudge_id] || 0, ms(s.created_at)); });
    // A done nudge leaves Pinned / Recent / All and is listed (newest first) in Done instead.
    var live = nudges.filter(function (n) { return !n.deleted_at && !n.archived_at && !n.done_at; });
    var done = nudges.filter(function (n) { return !n.deleted_at && !n.archived_at && n.done_at; })
      .sort(function (a, b) { return ms(b.done_at) - ms(a.done_at) || (a.id < b.id ? -1 : 1); });
    var bySort = function (a, b) { return a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1); };
    var pinned = live.filter(function (n) { return n.pinned; }).sort(bySort);
    var touch = function (n) { return Math.max(ms(n.created_at), lastSent[n.id] || 0); };
    var recent = live.filter(function (n) { return !n.pinned; })
      .sort(function (a, b) { return touch(b) - touch(a) || (a.id < b.id ? -1 : 1); }).slice(0, 4);
    var taken = {};
    recent.forEach(function (n) { taken[n.id] = true; });
    var all = live.filter(function (n) { return !n.pinned && !taken[n.id]; }).sort(bySort);
    return { pinned: pinned, recent: recent, all: all, done: done };
  }

  // ---- "Done, with points": payout schedule for a done nudge ------------------------------------------
  // Calendar-month step that clamps to the month's last day (31 Jan + 1 month = 28/29 Feb), never rolling into March.
  function addMonths(day, n) {
    var p = day.split('-'), y = +p[0], m = +p[1] - 1 + n, d = +p[2];
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return y + '-' + ('0' + (m + 1)).slice(-2) + '-' + ('0' + Math.min(d, last)).slice(-2);
  }
  // [{day, points}] for an award done on doneDay (the sender's local day). 'now' pays everything that day;
  // '3mo' splits into three integer parts with the remainder on the earliest (20 -> 7,7,6; 10 -> 4,3,3), paid
  // on doneDay, +1 calendar month and +3. A part that rounds to 0 (1 or 2 points) is dropped.
  function splitPayout(points, payout, doneDay) {
    if (payout === 'now') return [{ day: doneDay, points: points }];
    if (payout !== '3mo') throw new Error('unknown payout ' + payout);
    var base = Math.floor(points / 3), rem = points % 3, days = [doneDay, addMonths(doneDay, 1), addMonths(doneDay, 3)];
    return days.map(function (d, i) { return { day: d, points: base + (i < rem ? 1 : 0) }; }).filter(function (x) { return x.points > 0; });
  }
  // Installments of one award that actually pay: due on or before `today`, and not cut off by Stop the rest
  // (an installment dated on or after the local day of stopped_at is never paid). Shared by the ledger and the
  // library row so the two cannot disagree.
  function awardInstallments(a, today, tz) {
    var doneDay = localDay(ms(a.done_at), tz), stopDay = a.stopped_at ? localDay(ms(a.stopped_at), tz) : null;
    return splitPayout(a.points, a.payout, doneDay).map(function (x) {
      var cut = stopDay !== null && x.day >= stopDay;
      return { day: x.day, points: x.points, cut: cut, paid: !cut && x.day <= today };
    });
  }
  // {paid, total, next, last, stopped, complete}: next = earliest unpaid, uncut installment day (null when none left);
  // last = day of the latest paid installment; stopped = Stop the rest actually cut something.
  function awardStatus(a, today, tz) {
    var ins = awardInstallments(a, today, tz), paid = 0, last = null, next = null, stopped = false;
    ins.forEach(function (x) {
      if (x.paid) { paid += x.points; last = x.day; }
      else if (x.cut) stopped = true;
      else if (next === null) next = x.day;
    });
    return { paid: paid, total: a.points, next: next, last: last, stopped: stopped, complete: !stopped && next === null };
  }

  // ---- holds ------------------------------------------------------------
  var HOLD_FIELD = { focus: 'hold_focus_min', kudos: 'hold_kudos_min', truth: 'hold_truth_min', ask: 'hold_ask_min' };
  function holdMinutes(couple, kind) {
    var f = HOLD_FIELD[kind];
    if (!f) throw new Error('unknown item kind ' + kind);
    return couple[f];
  }
  function heldUntil(now, minutes) { return now + minutes * MIN; }
  function durText(minutes) {
    var h = Math.floor(minutes / 60), m = minutes % 60;
    return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : '');
  }
  // How a due date reads against today. fmt names a far-off day, since a bare weekday only identifies this coming week.
  function dueInfo(day, today, fmt) {
    var n = Math.round((Date.parse(day) - Date.parse(today)) / 864e5);
    if (n < 0) return { text: -n + (n === -1 ? ' day late' : ' days late'), state: 'late' };
    if (n === 0) return { text: 'Due today', state: 'soon' };
    if (n === 1) return { text: 'Due tomorrow', state: 'soon' };
    return { text: 'Due ' + fmt(day), state: '' };
  }

  // "11h 42m", "52m", "Ready" once due. Minutes round up so it never reads 0m while held.
  function countdown(until, now) {
    var left = until - now;
    if (left <= 0) return 'Ready';
    var mins = Math.ceil(left / MIN);
    var h = Math.floor(mins / 60), m = mins % 60;
    if (!h) return m + 'm';
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }
  // Label the recipient sees: how long the sender held it. null when it was not held.
  function heldLabel(item) {
    if (!item.held_until) return null;
    var mins = Math.round((ms(item.held_until) - ms(item.created_at)) / MIN);
    return mins > 0 ? 'Held ' + durText(mins) : null;
  }
  // Timestamps from Postgres are ISO strings; held_until is normalised to ms by the store.
  // appendSpeech(base, text): the live transcript joined onto what was already typed, one space between, no stray ones.
  function appendSpeech(base, text) {
    var b = String(base || '').replace(/\s+$/, ''), t = String(text || '').trim();
    return b && t ? b + ' ' + t : b || t;
  }

  function ms(v) { return typeof v === 'number' ? v : Date.parse(v); }

  // ---- scheduled rows -----------------------------------------------------
  // A scheduled to do / ask is written at once but stamped with its future time T in its natural timestamp
  // (items: delivered_at, todos: created_at). Until T it is invisible to both partners: every reader of
  // those tables goes through this predicate.
  function isScheduled(row, now) { return ms(row.delivered_at || row.created_at) > now; }
  // A partner-bound schedule cannot beat the hold on that kind of item: T is at least now + hold.
  function scheduleAt(couple, kind, at, now) { return Math.max(at, heldUntil(now, holdMinutes(couple, kind))); }

  function buildItem(o) {
    // o.held_until (ms) is an absolute hold that replaces the couple's per-kind hold. Raise issue relies on it so the
    // Ask hold setting (even 0) can never shorten the next-morning delay. A scheduled item (o.at) is never an issue.
    if (o.held_until != null && o.at != null) throw new Error('held_until and at are exclusive');
    var held = o.held_until != null ? Math.max(1, Math.ceil((o.held_until - o.now) / MIN)) : o.at != null ? 0 : holdMinutes(o.couple, o.kind);
    // o.at (ms): scheduled, born delivered with delivered_at = o.at, no hold.
    var due = o.at != null ? o.at : o.now;
    var item = {
      id: o.id, couple_id: o.couple.id, sender_id: o.me, recipient_id: o.to, kind: o.kind, body: o.body,
      ask_type: o.kind === 'ask' ? (o.ask_type || 'task') : null,
      description: o.kind === 'ask' ? (o.description || null) : null,
      due_date: o.kind === 'ask' ? (o.due_date || null) : null,
      target: o.kind === 'ask' && o.ask_type === 'habit' ? o.target : null,
      period: o.kind === 'ask' && o.ask_type === 'habit' ? o.period : null,
      points_earn: o.kind === 'ask' && o.points_earn != null ? o.points_earn : null, points_miss: o.kind === 'ask' && o.points_miss != null ? o.points_miss : null, needs_note: o.kind === 'ask' && !!o.needs_note,
      origin: o.origin || null, response_type: o.response_type || null, fight_marker_id: o.fight_marker_id || null,
      held_until: o.held_until != null ? new Date(o.held_until).toISOString() : held > 0 ? new Date(heldUntil(o.now, held)).toISOString() : null,
      status: held > 0 ? 'held' : 'delivered',
      delivered_at: held > 0 ? null : new Date(due).toISOString(),
      opened_at: null, kept: null,
      created_at: new Date(o.now).toISOString(), updated_at: new Date(o.now).toISOString(), deleted_at: null
    };
    // Only kudos carry gift_points, so every other item still inserts without the column.
    if (o.kind === 'kudos' && o.gift_points != null) item.gift_points = o.gift_points;
    return item;
  }

  function askToTodo(item, id, now) {
    if (item.kind !== 'ask') throw new Error('askToTodo needs an ask item');
    return {
      id: id, couple_id: item.couple_id, owner_id: item.recipient_id, created_by: item.sender_id, item_id: item.id,
      // A fight ask becomes a 'response' todo on that marker, so finishing it repairs the fight (todoDone).
      fight_marker_id: item.fight_marker_id || null, title: item.body, description: item.description || null, type: item.origin === 'fight' ? 'response' : item.ask_type, due_date: item.due_date, target: item.target, period: item.period,
      points_earn: item.points_earn, points_miss: item.points_miss, needs_note: item.needs_note, edited_at: null,
      tally: 0, done_at: null, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), deleted_at: null
    };
  }

  // ---- points ledger ----------------------------------------------------
  // Log fight's "Did she hit herself?" answer, as the Fight line's detail. Both partners read the same
  // ledger, so the follow-up names whoever logged the fight rather than saying "me" / "you".
  function hitText(m, logger) {
    if (!m.hit_self) return null;
    return 'Hit herself' + (m.hit_related === true ? ', related to ' + logger : m.hit_related === false ? ', not related to ' + logger : '');
  }

  // ---- habit goals: N logs per day / week / month ---------------------------------------------------------------
  // Per-todo points; null = the rule default (task 3 earned / 3 lost, habit 1 / 0). An 'ownup' to do scores like a task;
  // a migrated one stores explicit 0 / 0, which `== null` keeps distinct from the default.
  var DEF_PTS = { task: [3, 3], habit: [1, 0], ownup: [3, 3] };
  function earnPts(t) { return t.points_earn == null ? DEF_PTS[t.type][0] : t.points_earn; }
  function missPts(t) { return t.points_miss == null ? DEF_PTS[t.type][1] : t.points_miss; }
  // {start, end} (inclusive local days) of the day / Mon-first week / calendar month containing `day`.
  function periodOf(period, day) {
    if (period === 'day') return { start: day, end: day };
    if (period === 'week') { var s = weekStart(day); return { start: s, end: addDays(s, 6) }; }
    if (period === 'month') { var m = day.slice(0, 7) + '-01'; return { start: m, end: addDays(addMonths(m, 1), -1) }; }
    throw new Error('unknown period ' + period);
  }
  // Habit logs inside p = {start, end} (local days in tz).
  function habitCount(t, events, p, tz) {
    return events.filter(function (e) {
      if (e.todo_id !== t.id || e.kind !== 'tally') return false;
      var d = localDay(ms(e.at), tz); return d >= p.start && d <= p.end;
    }).length;
  }
  // Closed periods under target. Counting starts at the first period that begins on or after the day the habit was
  // created (the partial period it was created in is skipped); the open period never counts. Same inputs, same answer
  // on both phones: only todo_events, created_at and the couple tz are read.
  function habitMisses(t, events, today, tz) {
    var out = [];
    if (t.type !== 'habit' || !t.target || !t.period) return out; // no goal (legacy row) = no misses
    var created = localDay(ms(t.created_at), tz), p = periodOf(t.period, created);
    if (p.start < created) p = periodOf(t.period, addDays(p.end, 1));
    for (; p.end < today; p = periodOf(t.period, addDays(p.end, 1))) if (habitCount(t, events, p, tz) < t.target) out.push(p);
    return out;
  }
  // A to do that needs a note refuses an empty one (the UI shows this message).
  function requireNote(t, note) { if (t.needs_note && !(note || '').trim()) throw new Error('Note needed'); }
  // Owner sees "Edited" on a to do their partner edited, until they next log it. An edit inside the author's edit window
  // still counts: the partner may already have read the old text, and rows edited before the window existed carry it too.
  function isEdited(t, events, me) {
    return t.owner_id === me && t.created_by !== me && !!t.edited_at && !events.some(function (e) { return e.todo_id === t.id && e.user_id === me && ms(e.at) > ms(t.edited_at); });
  }
  // rows: {members, items, todos, todo_events, fight_markers, redemptions, challenges: [{id, name, start, breaks_on}], challenge_breaks: [{challenge_id, day}], challenge_days: [{challenge_id, day}]}
  // A challenge's start is the first local day that can pay; no rows.challenges means no challenges.
  // opts: {tz, now, since (YYYY-MM-DD, first day calm days can accrue)}
  function computeLedger(rows, opts) {
    if (!opts || !opts.tz || opts.now == null || !opts.since) throw new Error('computeLedger needs tz, now, since');
    var tz = opts.tz, today = localDay(opts.now, tz);
    rows = Object.assign({}, rows, { items: rows.items.filter(function (r) { return !isScheduled(r, opts.now); }), todos: rows.todos.filter(function (r) { return !isScheduled(r, opts.now); }) });
    var nameOf = {};
    rows.members.forEach(function (m) { nameOf[m.user_id] = m.name; });
    var lines = []; // {day, pts, label, who}
    function add(day, pts, label, who, fight) { if (!pts) return; lines.push({ day: day, pts: pts, label: label, who: who || null, fight: fight || null }); }
    var dayOf = function (v) { return localDay(ms(v), tz); };

    // kudos: gift_points scores exactly that, outside the daily cap. Legacy rows (gift_points null): +1 each unless points is false, max 3 per sender per local day.
    var kudos = rows.items.filter(function (i) { return i.kind === 'kudos' && i.status === 'delivered' && !i.deleted_at; })
      .sort(function (a, b) { return ms(a.delivered_at || a.created_at) - ms(b.delivered_at || b.created_at); });
    var kcount = {};
    kudos.forEach(function (i) {
      var d = dayOf(i.delivered_at || i.created_at), k = i.sender_id + '|' + d;
      if (i.gift_points != null) { add(d, i.gift_points, 'Kudos', nameOf[i.recipient_id]); return; }
      if (i.points === false) return;
      kcount[k] = (kcount[k] || 0) + 1;
      if (kcount[k] <= 3) add(d, 1, 'Kudos', nameOf[i.recipient_id]);
    });

    // nudges sent to the partner: opened the day it was delivered +1, else unopened by local midnight -1.
    // (Me nudges are private and never in rows.) Not-yet-delivered sends do not count yet.
    rows.nudge_sends.forEach(function (n) {
      if (n.deleted_at || ms(n.deliver_at) > opts.now) return;
      var d = dayOf(n.deliver_at);
      if (n.opened_at && dayOf(n.opened_at) === d) add(d, 1, 'Reminder opened');
      else if (d < today) add(d, -1, 'Reminder unopened');
    });

    // "Nudge done" installments from the author's awards to the recipient (see awardInstallments for the stop rule).
    rows.nudge_awards.forEach(function (a) {
      if (a.deleted_at) return;
      awardInstallments(a, today, tz).forEach(function (x) { if (x.paid) add(x.day, x.points, 'Reminder done', nameOf[a.recipient_id]); });
    });

    var todoById = {};
    rows.todos.forEach(function (t) { todoById[t.id] = t; });
    var markerById = {};
    rows.fight_markers.forEach(function (m) { markerById[m.id] = m; });

    rows.todos.forEach(function (t) {
      if (t.deleted_at) return;
      var doneDay = t.done_at ? dayOf(t.done_at) : null;
      if (t.type === 'response') {
        var mk = t.fight_marker_id && markerById[t.fight_marker_id];
        if (t.done_at && mk && ms(t.done_at) - ms(mk.at) <= 48 * 60 * MIN) add(doneDay, 5, 'Repair within 48h');
        return;
      }
      if (t.type === 'habit') {
        habitMisses(t, rows.todo_events, today, tz).forEach(function (p) { add(addDays(p.end, 1), -missPts(t), 'Habit missed', t.title); });
        return;
      }
      if (doneDay && (!t.due_date || doneDay <= t.due_date)) add(doneDay, earnPts(t), 'To do on time', t.title);
      if (t.due_date && t.due_date < today && (!doneDay || doneDay > t.due_date)) add(addDays(t.due_date, 1), -missPts(t), 'To do overdue', t.title);
    });

    rows.todo_events.forEach(function (e) {
      var t = todoById[e.todo_id];
      if (e.kind === 'tally' && t && !t.deleted_at) add(dayOf(e.at), earnPts(t), 'Habit tally', t.title);
    });

    var fightDays = {};
    rows.fight_markers.forEach(function (m) {
      var d = dayOf(m.at); fightDays[d] = true;
      add(d, 1, 'Fight logged', null, m.id);
      add(d, -5, 'Fight', hitText(m, nameOf[m.logged_by]), m.id);
    });

    for (var d = opts.since; d < today; d = addDays(d, 1)) if (!fightDays[d]) add(d, 3, 'Calm day');

    // Hits: a fight logged with hit_self = yes counts hit_count hits (null = legacy row, one hit). The first hit of a
    // local day costs 10, each later one that day 5, whether in the same fight or a later one.
    // hit_count 0.5 is one light hit at half that cost, rounded up (-5 first, -3 later); it still breaks hit challenges.
    var hitsByDay = {};
    rows.fight_markers.filter(function (m) { return m.hit_self === true; }).sort(function (a, b) { return ms(a.at) - ms(b.at); }).forEach(function (m) {
      var d = dayOf(m.at);
      for (var i = 0; i < (m.hit_count || 1); i++) {
        hitsByDay[d] = (hitsByDay[d] || 0) + 1;
        var cost = hitsByDay[d] === 1 ? 10 : 5;
        add(d, m.hit_count === 0.5 ? -Math.ceil(cost / 2) : -cost, 'Hit', m.hit_count === 0.5 ? 'Light' : null, m.id);
      }
    });

    // Streak challenges: each finished hit-free day pays its streak number capped at 10 (day 1 +1 ... day 10+ +10);
    // every 7th streak day adds +10 and every 30th +100. A hit day pays nothing and the next day is day 1 again.
    // `day` is today's streak number (0 on a hit day); `next` is the days until the next week / month bonus.
    // A challenge counts only once the person it is for accepts it: until then nothing pays and there are no days;
    // after, the streak begins on the local day of acceptance (day 1 unless that day has a hit).
    // A hit challenge breaks on a day with a logged hit; a tap challenge (breaks_on 'tap') breaks on a day with a
    // challenge_breaks row and carries no point penalty, the streak just resets.
    var tapBreaks = {};
    (rows.challenge_breaks || []).forEach(function (b) { (tapBreaks[b.challenge_id] || (tapBreaks[b.challenge_id] = {}))[b.day] = true; });
    // A goal challenge (breaks_on 'goal') is one-shot: log goal_days distinct days (note rows in challenge_days) within
    // goal_window_days of c.start, a fixed window (acceptance can come before it opens; a later one shortens it). Reaching the count pays goal_earn once, on that day; a window that ends short pays
    // -goal_miss on the day after the deadline. No streak pay, no bonuses; hits and fights do not touch it.
    var goalDays = {};
    (rows.challenge_days || []).forEach(function (b) { if (b.deleted_at) return; (goalDays[b.challenge_id] || (goalDays[b.challenge_id] = {}))[b.day] = true; });
    var challenges = (rows.challenges || []).map(function (c) {
      if (c.breaks_on === 'goal') return goalChallenge(c);
      var tap = c.breaks_on === 'tap', brokenOn = tap ? (tapBreaks[c.id] || {}) : hitsByDay;
      var n = 0, best = 0, earned = 0, days = [], accepted = !!c.accepted_at;
      if (!accepted) return { id: c.id, name: c.name, for_user: c.for_user, breaks_on: tap ? 'tap' : 'hit', broken_today: false, accepted: false, start: null, day: 0, best: 0, earned: 0, tonight: 0, days: [], next: { week: 7, month: 30 } };
      var start = dayOf(c.accepted_at) > c.start ? dayOf(c.accepted_at) : c.start;
      for (var d = start; d < today; d = addDays(d, 1)) {
        if (brokenOn[d]) { n = 0; days.push({ d: d, n: 0, bonus: false }); continue; }
        n++; best = Math.max(best, n);
        days.push({ d: d, n: n, bonus: n % 7 === 0 || n % 30 === 0 });
        var pay = Math.min(n, 10); earned += pay;
        add(d, pay, c.name, 'Day ' + n);
        if (n % 7 === 0) { earned += 10; add(d, 10, tap ? c.name : 'Week without hitting', tap ? 'Week' : null); }
        if (n % 30 === 0) { earned += 100; add(d, 100, tap ? c.name : 'Month without hitting', tap ? 'Month' : null); }
      }
      // next = days from today until the day whose finish pays the bonus (0 = today's finish).
      var day = start > today || brokenOn[today] ? 0 : n + 1;
      // days: start..today, n = streak number that day (0 on a hit day); today's n is the day in progress.
      if (start <= today) days.push({ d: today, n: day, bonus: false });
      var tonight = day ? Math.min(day, 10) + (day % 7 === 0 ? 10 : 0) + (day % 30 === 0 ? 100 : 0) : 0;
      return { id: c.id, name: c.name, for_user: c.for_user, breaks_on: tap ? 'tap' : 'hit', broken_today: !!brokenOn[today], accepted: true, start: start, day: day, best: best, earned: earned, tonight: tonight, days: days,
        next: { week: Math.max(7, Math.ceil(day / 7) * 7) - day, month: Math.max(30, Math.ceil(day / 30) * 30) - day } };
    });

    function goalChallenge(c) {
      var base = { id: c.id, name: c.name, for_user: c.for_user, breaks_on: 'goal', accepted: !!c.accepted_at, start: null, opens: c.start, deadline: addDays(c.start, c.goal_window_days - 1), count: 0, goal_days: c.goal_days, goal_earn: c.goal_earn, goal_miss: c.goal_miss, rule: c.rule,
        logged_today: false, status: 'active', broken_today: false, day: 0, best: 0, earned: 0, tonight: 0, days: [], next: { week: 7, month: 30 } };
      if (!c.accepted_at) return base;
      var start = dayOf(c.accepted_at) > c.start ? dayOf(c.accepted_at) : c.start, deadline = base.deadline;
      var logged = Object.keys(goalDays[c.id] || {}).filter(function (d) { return d >= start && d <= deadline; }).sort();
      logged.forEach(function (d, i) {
        base.days.push({ d: d, n: i + 1, bonus: false });
        if (i + 1 === c.goal_days) { base.earned = c.goal_earn; add(d, c.goal_earn, c.name); }
      });
      var failed = today > deadline && logged.length < c.goal_days;
      if (failed) add(addDays(deadline, 1), -c.goal_miss, c.name);
      return Object.assign(base, { start: start, deadline: deadline, count: logged.length, logged_today: logged.indexOf(today) >= 0,
        status: logged.length >= c.goal_days ? 'done' : failed ? 'failed' : 'active' });
    }

    var weeks = {};
    function wk(day) {
      var s = weekStart(day);
      return weeks[s] || (weeks[s] = { start: s, earned: 0, lost: 0, net: 0, days: {} });
    }
    lines.forEach(function (l) {
      var w = wk(l.day), dd = w.days[l.day] || (w.days[l.day] = { day: l.day, net: 0, lines: [] });
      dd.lines.push(l); dd.net += l.pts; w.net += l.pts;
      if (l.pts > 0) w.earned += l.pts; else w.lost += l.pts;
    });
    var spent = 0, spends = [];
    rows.redemptions.forEach(function (r) {
      if (r.status !== 'approved') return;
      spent += r.price;
      spends.push({ day: dayOf(r.decided_at), pts: -r.price, id: r.id, reward_id: r.reward_id });
    });
    var total = 0;
    Object.keys(weeks).forEach(function (k) { total += weeks[k].net; });
    var cur = weeks[weekStart(today)] || { start: weekStart(today), earned: 0, lost: 0, net: 0, days: {} };
    return { balance: total - spent, spent: spent, spends: spends, weeks: weeks, current: cur, today: today, challenges: challenges };
  }

  // Week close card groups: label -> summed points, earned and lost separately.
  function groupWeek(week) {
    var earned = {}, lost = {};
    Object.keys(week.days).forEach(function (d) {
      week.days[d].lines.forEach(function (l) {
        var tgt = l.pts > 0 ? earned : lost;
        tgt[l.label] = (tgt[l.label] || 0) + l.pts;
      });
    });
    function arr(o) { return Object.keys(o).map(function (k) { return { label: k, pts: o[k] }; }).sort(function (a, b) { return Math.abs(b.pts) - Math.abs(a.pts); }); }
    return { earned: arr(earned), lost: arr(lost) };
  }


  // ---- fight patterns (shared markers, both partners) ---------------------
  // days: local YYYY-MM-DD of every fight either partner logged. Calm days are the days from `since` up to
  // yesterday with no fight, the same rule computeLedger pays +3 for, so the numbers agree with the Points ledger.
  // streak = calm days in a row ending yesterday (today is not over yet); best = longest such run; last28 = calm days
  // among the 28 days before today. A `since` after today yields zeros.
  function calmStats(days, today, since) {
    var fought = {}; days.forEach(function (d) { fought[d] = true; });
    var run = 0, best = 0, last28 = 0;
    for (var d = since; d < today; d = addDays(d, 1)) {
      run = fought[d] ? 0 : run + 1;
      if (run > best) best = run;
      if (!fought[d] && dayDiff(d, today) <= 28) last28++;
    }
    return { streak: run, best: best, last28: last28 };
  }
  // Fights per week for `weeks` weeks ending with the week of `today`: [{start, n}] oldest first.
  function weeklyFights(days, today, weeks) {
    var first = addDays(weekStart(today), -7 * (weeks - 1)), out = [];
    for (var i = 0; i < weeks; i++) out.push({ start: addDays(first, 7 * i), n: 0 });
    days.forEach(function (d) { var k = Math.floor(dayDiff(first, d) / 7); if (k >= 0 && k < weeks) out[k].n++; });
    return out;
  }
  // May the author still change something they just submitted? True for `windowMin` minutes after `createdAtMs`.
  function inEditWindow(createdAtMs, nowMs, windowMin) { return nowMs - createdAtMs < windowMin * MIN; }

  // ---- cycle phase (private fight log) -----------------------------------
  // fights: [{at (ms), intensity}]. Fight = day of fight, Cool = 1-2 days after,
  // Warm = day 3 until 60% of the average cycle length, Tension after that.
  function phase(fights, now, tz, defaultLen) {
    if (!fights.length) return null;
    var days = fights.map(function (f) { return localDay(f.at, tz); }).sort();
    var uniq = days.filter(function (d, i) { return i === 0 || d !== days[i - 1]; });
    var gaps = [];
    for (var i = 1; i < uniq.length; i++) gaps.push(dayDiff(uniq[i - 1], uniq[i]));
    var avg = gaps.length ? gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length : null;
    var len = avg == null ? (defaultLen || 14) : avg;
    var since = dayDiff(uniq[uniq.length - 1], localDay(now, tz));
    var warmEnd = Math.max(3, len * 0.6);
    var name = since === 0 ? 'Fight' : since <= 2 ? 'Cool' : since < warmEnd ? 'Warm' : 'Tension';
    return { name: name, day: since + 1, avg: avg, len: len, warmEnd: warmEnd, last: uniq[uniq.length - 1] };
  }

  // ---- needs you ---------------------------------------------------------
  // s: {me, now, tz, items, redemptions, nudge_sends, nudge_replies, fight_markers, fight_notes, todos, seen, since}
  function needsYou(s) {
    var out = [];
    var ready = s.items.filter(function (i) {
      return i.sender_id === s.me && i.status === 'held' && !i.deleted_at && ms(i.held_until) <= s.now;
    }).sort(function (a, b) { return ms(a.held_until) - ms(b.held_until); });
    if (ready.length) out.push({ type: 'ready', count: ready.length, item: ready[0] });
    s.redemptions.filter(function (r) { return r.status === 'pending' && r.requested_by !== s.me; })
      .forEach(function (r) { out.push({ type: 'approve', redemption: r }); });
    s.nudge_sends.filter(function (n) {
      return n.recipient_id === s.me && !n.opened_at && !n.deleted_at && ms(n.deliver_at) <= s.now;
    }).sort(function (a, b) { return ms(b.deliver_at) - ms(a.deliver_at); })
      .forEach(function (n) { out.push({ type: 'nudge', send: n }); });
    // unread replies from the other person, one card per nudge thread
    var seen = {};
    s.nudge_replies.filter(function (r) { return r.author_id !== s.me && !r.read_at && !r.deleted_at; })
      .sort(function (a, b) { return ms(b.created_at) - ms(a.created_at); })
      .forEach(function (r) { if (!seen[r.send_id]) { seen[r.send_id] = true; out.push({ type: 'reply', reply: r }); } });
    // a fight the other person logged that is unrepaired and where I have written nothing yet
    var mine = {};
    s.fight_notes.forEach(function (n) { if (n.author_id === s.me) mine[n.fight_marker_id] = true; });
    s.fight_markers.filter(function (m) { return m.logged_by !== s.me && !m.repaired_at && !mine[m.id]; })
      .sort(function (a, b) { return ms(b.at) - ms(a.at); })
      .forEach(function (m) { out.push({ type: 'fight', marker: m }); });
    // An owning-up the other person finished that I have not opened yet. `seen` (ids I opened) is private on-device;
    // `since` is when this install first ran, so rows finished before it (e.g. migrated acknowledgments) never pop up.
    s.todos.filter(function (t) {
      return t.type === 'ownup' && t.owner_id !== s.me && t.done_at && !t.deleted_at && !isScheduled(t, s.now) && ms(t.done_at) >= s.since && s.seen.indexOf(t.id) < 0;
    }).sort(function (a, b) { return ms(b.done_at) - ms(a.done_at); })
      .forEach(function (t) { out.push({ type: 'ownup', todo: t }); });
    return out;
  }

  // Month grid for the Cycle screen: leading blanks (Mon-first) and day strings.
  function monthGrid(year, month) { // month 1-12
    var first = year + '-' + String(month).padStart(2, '0') + '-01';
    var n = new Date(Date.UTC(year, month, 0)).getUTCDate();
    var days = [];
    for (var i = 0; i < n; i++) days.push(addDays(first, i));
    return { blanks: dow(first), days: days };
  }

  return {
    localDay: localDay, addDays: addDays, dayDiff: dayDiff, dow: dow, weekStart: weekStart,
    appendSpeech: appendSpeech, dueInfo: dueInfo, holdMinutes: holdMinutes, heldUntil: heldUntil, countdown: countdown, heldLabel: heldLabel, durText: durText, ms: ms,
    isScheduled: isScheduled, scheduleAt: scheduleAt, buildItem: buildItem, askToTodo: askToTodo,
    zonedMs: zonedMs, deliverAt: deliverAt, issueHeldUntil: issueHeldUntil, sectionNudges: sectionNudges,
    addMonths: addMonths, splitPayout: splitPayout, awardStatus: awardStatus,
    earnPts: earnPts, missPts: missPts, periodOf: periodOf, habitCount: habitCount, habitMisses: habitMisses, requireNote: requireNote, isEdited: isEdited,
    computeLedger: computeLedger, hitText: hitText, groupWeek: groupWeek, phase: phase, needsYou: needsYou, calmStats: calmStats, weeklyFights: weeklyFights, inEditWindow: inEditWindow, monthGrid: monthGrid,
    // Only a still-held item may offer Send / Edit / Drop; a stale notification can point at a delivered or dropped one.
    isStillHeld: function (i) { return !!i && i.status === 'held' && !i.deleted_at; }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CycleCore;
