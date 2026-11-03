// Talk: the voice-first conversation on the fight note fields (Gemini-Live layout: newest reply on top, a pill, one button
// row). Box /talk is stubbed, the native shell (bridge, speech recognition, speechSynthesis) is faked. Runs in WebKit
// (GL_WEBKIT_PW / GL_WEBKIT_EXEC), and Chromium too.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = 'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), '../../CycleApp/web/index.html');
const CSS = fs.readFileSync(fileURLToPath(new URL('../../CycleApp/web/cycle.css', import.meta.url)), 'utf8') + '\n#fx{display:none}';
const SHOTS = process.env.TALK_SHOTS || '';
const engines = { chromium };
if (process.env.GL_WEBKIT_PW && process.env.GL_WEBKIT_EXEC) {
  const pw = await import(process.env.GL_WEBKIT_PW);
  engines.webkit = { launch: (o) => pw.webkit.launch({ ...o, executablePath: process.env.GL_WEBKIT_EXEC }) };
}

const UID = 'u-me', PID = 'u-her', HOUR = 36e5;
const seed = () => ({
  session: { access_token: 't', refresh_token: 'r', expires_at: 4102444800, user: { id: UID, email: 'me@x.test' } },
  ['shared.' + UID]: {
    couple: { id: 'c1', tz: 'America/New_York', created_at: '2026-01-01T00:00:00Z', hold_ask_min: 60, hold_focus_min: 0, hold_truth_min: 0, hold_kudos_min: 0 },
    members: [{ user_id: UID, name: 'Mia Park', checkin_time: '21:00', hits_self: false }, { user_id: PID, name: 'Jo Lee', checkin_time: '21:00', hits_self: true }],
    rows: {
      items: {}, todos: {}, todo_events: {}, checkins: {}, rewards: {}, redemptions: {},
      fight_markers: { fp: { id: 'fp', couple_id: 'c1', logged_by: PID, at: new Date(Date.now() - 2 * HOUR).toISOString(), repaired_at: null, hit_self: null, hit_related: null } },
      fight_notes: {
        n1: { id: 'n1', couple_id: 'c1', fight_marker_id: 'fp', author_id: PID, body: 'Started with the dishes', created_at: new Date(Date.now() - 2 * HOUR).toISOString() },
        n2: { id: 'n2', couple_id: 'c1', fight_marker_id: 'fp', author_id: PID, body: 'DELETED TEXT', created_at: new Date(Date.now() - HOUR).toISOString(), deleted_at: new Date().toISOString() },
      },
    },
    cursors: {}, outbox: [],
  },
  ['priv.' + UID]: { fights: [], affirmations: [], prefs: {} },
});
const VOICES = [{ name: 'Fred', lang: 'en-US', localService: true }, { name: 'Thomas', lang: 'fr-FR', localService: true }, { name: 'Ava (Premium)', lang: 'en-US', localService: true }, { name: 'Daniel', lang: 'en-GB', localService: true }];

for (const [name, type] of Object.entries(engines)) describe(name, () => {
  let browser;
  before(async () => { browser = await type.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  // opts.native: fake shell (bridge + speech + speechSynthesis); opts.talk: queue of /talk answers ({status, body, delay});
  // opts.voicesLate: getVoices() is empty until the test calls __setVoices (WebKit loads them late).
  async function open({ native = false, talk = [], boxUrl = 'https://box.test', voicesLate = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript(([sd, box, nat, voices, late]) => {
      window.CYCLE_CONFIG = { supabaseUrl: 'https://x.test', supabaseAnonKey: 'k', boxUrl: box };
      if (!localStorage.getItem('cycle:session')) for (const k in sd) localStorage.setItem('cycle:' + k, JSON.stringify(sd[k]));
      if (!nat) return;
      window.__bridge = [];
      window.webkit = { messageHandlers: { cycle: { postMessage: ({ id, cmd, args }) => {
        window.__bridge.push(cmd);
        setTimeout(() => {
          let r = null;
          if (cmd === 'store.get') r = localStorage.getItem('cycle:' + args.key);
          else if (cmd === 'store.set') localStorage.setItem('cycle:' + args.key, args.value);
          else if (cmd === 'store.keys') r = Object.keys(localStorage).filter((k) => k.startsWith('cycle:' + args.prefix)).map((k) => k.slice(6));
          else if (cmd === 'notify.status') r = 'granted';
          else if (cmd === 'lock.get') r = false;
          window.__cycleReply(id, r, null);
        }, 0);
      } } } };
      // speechSynthesis: speak() is logged; the test ends an utterance by hand.
      window.__spoken = [];
      let list = late ? [] : voices;
      const ls = [];
      window.__setVoices = () => { list = voices; ls.forEach((f) => f()); };
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        speak: (u) => window.__spoken.push(u),
        cancel: () => { window.__cancelled = (window.__cancelled || 0) + 1; },
        getVoices: () => list,
        addEventListener: (_e, f) => ls.push(f),
        removeEventListener: (_e, f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
      } });
    }, [seed(), boxUrl, native, VOICES, voicesLate]);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    const posts = [];
    await context.route('https://box.test/talk', async (route) => {
      posts.push(route.request().postDataJSON());
      const a = talk.shift();
      if (!a) return route.abort();
      if (a.delay) await new Promise((r) => setTimeout(r, a.delay)); // a slow box
      if (a.abort) return route.abort();
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', body: JSON.stringify(a.body || {}) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="go:fight"]');
    return { context, page, posts };
  }
  const logFight = async (page) => { await page.click('[data-a="go:fight"]'); await page.waitForSelector('[data-a="fightsave"]'); };
  const openTalk = async (page, field = 'note') => { await page.click(`[data-a="talk:${field}"]`); await page.waitForSelector('.tkbar'); };
  const sendTyped = async (page, text) => { await page.fill('[data-t="tk"]', text); await page.click('[data-a="tksend"]'); };
  const ok = (reply, draft = null) => ({ body: { reply, draft } });
  const bridge = (page) => page.evaluate(() => window.__bridge.filter((c) => c.startsWith('speech')));
  const hear = (page, text, final = false) => page.evaluate(([t, f]) => window.cycleNative.speech(t, f), [text, final]);
  const rows = (page) => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_notes));
  const starts = (page) => page.evaluate(() => window.__bridge.filter((c) => c === 'speech.start').length);
  const replyIs = (page, text) => page.waitForFunction((t) => { const e = document.querySelector('.tkrep'); return e && e.textContent === t; }, text);
  const state = (page) => page.getAttribute('.tkglow', 'data-state');
  const stateIs = (page, s) => page.waitForSelector(`.tkglow[data-state="${s}"]`);
  const pill = (page) => page.textContent('.tkph');
  const saved = (page, k = 'new') => page.evaluate((key) => JSON.parse(localStorage.getItem('cycle:talk:' + key) || 'null'), k);

  test('layout: no header, no bubbles, a single reply; the send arrow shows only with typed text; request carries names without notes', async () => {
    const { context, page, posts } = await open({ talk: [ok('What happened next?'), ok('And then?')] });
    await logFight(page);
    await page.click('[data-a="int:4"]');
    await page.fill('[data-d="note"]', 'We argued at dinner');
    await openTalk(page);
    assert.equal(await page.$('.hd'), null, 'no header title');
    assert.equal(await page.$('[data-a="fightsave"]'), null, 'drawn instead of the form');
    assert.equal(await page.$('.tb'), null, 'no bubbles');
    assert.equal(await page.textContent('.tkrep'), '', 'empty before the first reply');
    assert.equal(await page.isVisible('[data-a="tksend"]'), false, 'no Send without typed text');
    await page.fill('[data-t="tk"]', 'He forgot the plan');
    assert.equal(await page.isVisible('[data-a="tksend"]'), true);
    assert.ok((await page.$eval('[data-a="tksend"]', (e) => e.getBoundingClientRect().width)) >= 36);
    await page.click('[data-a="tksend"]');
    await replyIs(page, 'What happened next?');
    assert.equal(await pill(page), 'He forgot the plan', 'the sent turn stays in the pill');
    assert.equal(await page.isVisible('[data-a="tksend"]'), false);
    assert.deepEqual(posts[0], { messages: [{ role: 'user', text: 'He forgot the plan' }], finish: false, speaker: 'Mia', partner: 'Jo', notes: [] });
    await sendTyped(page, 'He left');
    await replyIs(page, 'And then?');
    assert.equal(await page.$$eval('.tkrep', (e) => e.length), 1, 'only one reply shown');
    const text = await page.$eval('.scr', (e) => e.innerText);
    assert.equal(text.includes('What happened next?'), false, 'earlier replies are not on screen');
    assert.equal(text.includes('He forgot the plan'), false, 'earlier turns are not on screen');
    await context.close();
  });

  test('native: opening listens at once, silence sends the turn, the reply is spoken, then listening restarts', async () => {
    const { context, page, posts } = await open({ native: true, talk: [{ ...ok('Tell me more.'), delay: 300 }] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await stateIs(page, 'listening');
    await hear(page, 'he said');
    await hear(page, 'he said he would call');
    assert.equal(posts.length, 0, 'not sent while the text is still changing');
    assert.equal(await pill(page), 'he said he would call', 'live transcript in the pill');
    await stateIs(page, 'thinking');
    await replyIs(page, 'Tell me more.');
    assert.equal(posts[0].messages[0].text, 'he said he would call');
    await page.waitForFunction(() => window.__spoken.length === 1);
    assert.equal(await page.evaluate(() => window.__spoken[0].text), 'Tell me more.');
    await stateIs(page, 'speaking');
    // Ordering: the audio session is stopped (awaited) before the reply is spoken, and listening restarts only after it ends.
    assert.deepEqual(await bridge(page), ['speech.start', 'speech.stop', 'speech.stop']);
    await page.evaluate(() => window.__spoken[0].onend());
    await page.waitForFunction(() => window.__bridge.filter((c) => c === 'speech.start').length === 2);
    await stateIs(page, 'listening');
    await context.close();
  });

  test('native: the mic or the glow tapped mid-speech cuts it and listens; speech error and a missing end fall back to idle without an error', async () => {
    const { context, page } = await open({ native: true, talk: [ok('One.'), ok('Two.'), ok('Three.')] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'first', true);
    await page.waitForFunction(() => window.__spoken.length === 1);
    await page.click('[data-a="tkmic"]'); // cut the voice and talk
    await page.waitForFunction(() => window.__bridge.filter((c) => c === 'speech.start').length === 2);
    assert.ok(await page.evaluate(() => window.__cancelled >= 1));
    await hear(page, 'second', true);
    await page.waitForFunction(() => window.__spoken.length === 2);
    await page.click('[data-a="tkglow"]'); // the glow does the same
    await page.waitForFunction(() => window.__bridge.filter((c) => c === 'speech.start').length === 3);
    await hear(page, 'third', true);
    await page.waitForFunction(() => window.__spoken.length === 3);
    await page.evaluate(() => window.__spoken[2].onerror());
    await page.waitForTimeout(100);
    assert.equal(await page.$('.errbar'), null, 'no error shown');
    assert.equal(await starts(page), 3, 'idle, not listening');
    assert.equal(await state(page), 'idle');
    assert.ok(await page.$('[data-a="tkmic"]:not(.rec)'));
    await context.close();
  });

  test('native: the mic mutes (sends what was heard, no relisten after the reply) and unmutes', async () => {
    const { context, page, posts } = await open({ native: true, talk: [ok('Heard you.')] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'last words');
    await page.click('[data-a="tkmic"]');
    await replyIs(page, 'Heard you.');
    assert.equal(posts[0].messages[0].text, 'last words');
    await page.waitForFunction(() => window.__spoken.length === 1);
    await page.evaluate(() => window.__spoken[0].onend());
    await stateIs(page, 'muted');
    await page.waitForTimeout(150);
    assert.equal(await starts(page), 1, 'muted: no auto relisten');
    await page.click('[data-a="tkmic"]');
    await page.waitForFunction(() => window.__bridge.filter((c) => c === 'speech.start').length === 2);
    await stateIs(page, 'listening');
    await context.close();
  });

  test('glow animation follows the state and stops under prefers-reduced-motion', async () => {
    const { context, page } = await open({ native: true, talk: [{ ...ok('Hi.'), delay: 400 }] });
    await logFight(page);
    await openTalk(page);
    const anim = () => page.$eval('.tkglow', (e) => getComputedStyle(e).animationName);
    await stateIs(page, 'listening');
    const listening = await anim();
    assert.notEqual(listening, 'none');
    await hear(page, 'hello', true);
    await stateIs(page, 'thinking');
    const thinking = await anim();
    assert.notEqual(thinking, 'none');
    assert.notEqual(thinking, listening);
    await page.waitForFunction(() => window.__spoken.length === 1);
    await stateIs(page, 'speaking');
    const speaking = await anim();
    assert.ok(speaking !== 'none' && speaking !== listening && speaking !== thinking);
    await page.evaluate(() => window.__spoken[0].onerror());
    await stateIs(page, 'idle');
    assert.equal(await anim(), 'none', 'idle is a dim static glow');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('[data-a="tkmic"]');
    await stateIs(page, 'listening');
    assert.equal(await anim(), 'none', 'reduced motion');
    await context.close();
  });

  test('the best installed English voice is used, at a natural rate; late-loading voices are waited for', async () => {
    const a = await open({ native: true, talk: [ok('Voice check.')] });
    await logFight(a.page);
    await openTalk(a.page);
    await a.page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(a.page, 'hi', true);
    await a.page.waitForFunction(() => window.__spoken.length === 1);
    const u = await a.page.evaluate(() => ({ voice: window.__spoken[0].voice.name, lang: window.__spoken[0].lang, rate: window.__spoken[0].rate }));
    assert.deepEqual(u, { voice: 'Ava (Premium)', lang: 'en-US', rate: 1 });
    await a.context.close();

    const b = await open({ native: true, talk: [ok('Late voices.')], voicesLate: true });
    await logFight(b.page);
    await openTalk(b.page);
    await b.page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(b.page, 'hi', true);
    await replyIs(b.page, 'Late voices.');
    await b.page.waitForTimeout(150);
    assert.equal(await b.page.evaluate(() => window.__spoken.length), 0, 'waits for the voice list');
    await b.page.evaluate(() => window.__setVoices());
    await b.page.waitForFunction(() => window.__spoken.length === 1);
    assert.equal(await b.page.evaluate(() => window.__spoken[0].voice.name), 'Ava (Premium)');
    await b.context.close();
  });

  test('X with turns finishes (finish:true): a clarifying question continues the loop, then the review shows the draft beneath the reply', async () => {
    const { context, page, posts } = await open({ talk: [ok('Ok.'), ok('How did it end?'), ok('Thanks.'), ok('Is that right?', 'I was upset about dinner.')] });
    await logFight(page);
    await openTalk(page);
    await sendTyped(page, 'dinner went badly');
    await replyIs(page, 'Ok.');
    await page.click('[data-a="tkx"]');
    await replyIs(page, 'How did it end?');
    assert.equal(posts[1].finish, true);
    assert.equal(await page.$('.tkd'), null, 'a question is not a draft');
    assert.ok(await page.$('.tkpill'), 'the loop continues');
    await sendTyped(page, 'we made up');
    await replyIs(page, 'Thanks.');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('.tkd');
    assert.equal(await page.textContent('.tkrep'), 'Is that right?', 'the reply stays at the top');
    assert.equal(await page.textContent('.tkd p'), 'I was upset about dinner.');
    assert.deepEqual(await page.$$eval('.tkact .save, .tkact .ghost', (e) => e.map((x) => x.textContent)), ['Use this', 'Keep talking']);
    assert.equal(await page.$('.tkpill'), null, 'the buttons replace the pill row');
    assert.equal(await page.$('.tkglow'), null);
    assert.ok(await page.$('.tkact [data-a="tkx"]'), 'a small X stays');
    assert.equal(posts[3].messages.length, 5);
    // Keep talking dismisses the card and the conversation goes on.
    await page.click('[data-a="tkkeep"]');
    assert.equal(await page.$('.tkd'), null);
    assert.ok(await page.$('.tkpill'));
    await context.close();
  });

  test('X with no turns exits without posting; X on the review exits keeping the conversation and the draft', async () => {
    const a = await open({ talk: [] });
    await logFight(a.page);
    await a.page.fill('[data-d="note"]', 'unsent form text');
    await openTalk(a.page);
    await a.page.click('[data-a="tkx"]');
    await a.page.waitForSelector('[data-a="fightsave"]');
    assert.equal(a.posts.length, 0);
    assert.equal(await a.page.inputValue('[data-d="note"]'), 'unsent form text');
    await a.context.close();

    const { context, page } = await open({ talk: [ok('Ok.'), ok('Right?', 'My draft.')] });
    await logFight(page);
    await openTalk(page);
    await sendTyped(page, 'something');
    await replyIs(page, 'Ok.');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('.tkd');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await page.inputValue('[data-d="note"]'), '', 'nothing written to the note');
    assert.equal((await saved(page)).draft, 'My draft.');
    await openTalk(page);
    await page.waitForSelector('.tkd');
    assert.equal(await page.textContent('.tkd p'), 'My draft.');
    await context.close();
  });

  test('Use this appends to the note after a blank line, keeps the form, writes no fight_notes row until Save', async () => {
    const { context, page } = await open({ talk: [ok('Ok.'), ok('Right?', 'I was upset about dinner.')] });
    await logFight(page);
    await page.click('[data-a="int:5"]');
    await page.fill('[data-d="note"]', 'Typed first');
    const before = await rows(page);
    await openTalk(page);
    await sendTyped(page, 'it was dinner');
    await replyIs(page, 'Ok.');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('[data-a="tkuse"]');
    await page.click('[data-a="tkuse"]');
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await page.inputValue('[data-d="note"]'), 'Typed first\n\nI was upset about dinner.');
    assert.equal(await page.$eval('[data-a="int:5"]', (e) => (e.getAttribute('class') || '').trim() !== (document.querySelector('[data-a="int:1"]').getAttribute('class') || '').trim()), true, 'intensity 5 still selected');
    await page.waitForTimeout(300); // the store persists on a 50ms debounce; a stray insert would only show in localStorage after it
    assert.deepEqual(await rows(page), before, 'nothing shared yet');
    assert.equal(await page.evaluate(() => localStorage.getItem('cycle:talk:new')), '', 'saved conversation cleared');
    await page.click('[data-a="fightsave"]');
    await page.waitForFunction((n) => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_notes).length === n + 1, before.length);
    await context.close();
  });

  test('failure keeps the turn with Retry and Use my words in place of the pill; Use my words fills the note; Retry recovers; X leaves', async () => {
    const { context, page } = await open({ talk: [{ status: 500 }, ok('Got it.')] });
    await logFight(page);
    await openTalk(page);
    await sendTyped(page, 'first thing');
    await page.waitForSelector('[data-a="tkretry"]');
    assert.equal(await page.$('.tkpill'), null, 'actions replace the pill');
    assert.equal(await page.textContent('[data-a="tkwords"]'), 'Use my words');
    await page.click('[data-a="tkretry"]');
    await replyIs(page, 'Got it.');
    await sendTyped(page, 'second thing'); // next answer: the stub queue is empty, so the request fails
    await page.waitForSelector('[data-a="tkwords"]');
    await page.click('[data-a="tkx"]'); // X leaves, keeping the words
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await page.inputValue('[data-d="note"]'), '');
    await openTalk(page);
    await page.waitForSelector('[data-a="tkwords"]');
    await page.click('[data-a="tkwords"]');
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await page.inputValue('[data-d="note"]'), 'first thing second thing');
    await context.close();
  });

  test('a reload restores the conversation (newest reply and last turn) on the same new-fight form', async () => {
    const { context, page } = await open({ talk: [ok('Go on.')] });
    await logFight(page);
    await openTalk(page);
    await sendTyped(page, 'my words survive');
    await replyIs(page, 'Go on.');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="go:fight"]');
    await logFight(page);
    await openTalk(page);
    await replyIs(page, 'Go on.');
    assert.equal(await pill(page), 'my words survive');
    await context.close();
  });

  test('X while listening sends the half-heard words as the final turn', async () => {
    const { context, page, posts } = await open({ native: true, talk: [ok('Is that right?', 'A draft.')] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'half a sentence');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('.tkd');
    assert.equal(posts[0].finish, true);
    assert.deepEqual(posts[0].messages, [{ role: 'user', text: 'half a sentence' }]);
    assert.equal(await page.evaluate(() => window.__bridge.filter((c) => c === 'speech.stop').length >= 1), true);
    await context.close();
  });

  test('fight detail: Talk on Note only, not Analysis; shared notes (not deleted) go as context', async () => {
    const { context, page, posts } = await open({ talk: [ok('Ok.')] });
    await page.evaluate(() => window.cycleNative.route('fight/fp'));
    await page.waitForSelector('[data-a="notesave"]');
    assert.ok(await page.$('[data-a="talk:more"]'));
    await page.click('[data-a="fnkind:analysis"]');
    assert.equal(await page.$('[data-a="talk:more"]'), null, 'hidden for Analysis');
    await page.click('[data-a="fnkind:note"]');
    await openTalk(page, 'more');
    await sendTyped(page, 'my side');
    await replyIs(page, 'Ok.');
    assert.deepEqual(posts[0].notes, ['Jo: Started with the dishes']);
    assert.equal(JSON.stringify(posts[0]).includes('DELETED TEXT'), false, 'a deleted note never goes to the model');
    await context.close();
  });

  test('saving a note on fight detail clears that fight\'s stored conversation', async () => {
    const { context, page } = await open({ talk: [{ status: 500 }] });
    await page.evaluate(() => window.cycleNative.route('fight/fp'));
    await page.waitForSelector('[data-a="notesave"]');
    await openTalk(page, 'more');
    await sendTyped(page, 'some words');
    await page.waitForSelector('[data-a="tkretry"]');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('[data-a="notesave"]');
    assert.notEqual(await page.evaluate(() => localStorage.getItem('cycle:talk:fp')), '', 'kept on leaving');
    await page.fill('[data-d="more"]', 'typed myself');
    await page.click('[data-a="notesave"]');
    await page.waitForFunction(() => localStorage.getItem('cycle:talk:fp') === '');
    await context.close();
  });

  test('a reply that arrives after leaving is dropped, not added to the saved conversation', async () => {
    const { context, page, posts } = await open({ talk: [{ ...ok('too late'), delay: 600 }] });
    await logFight(page);
    await openTalk(page);
    await sendTyped(page, 'quick words');
    await stateIs(page, 'thinking');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('[data-a="fightsave"]');
    await page.waitForTimeout(900);
    assert.equal(posts.length, 1);
    await openTalk(page);
    await page.waitForSelector('[data-a="tkretry"]', { timeout: 3000 });
    assert.equal(await page.textContent('.tkrep'), '', 'no late reply');
    assert.deepEqual((await saved(page)).msgs, [{ role: 'user', text: 'quick words' }]);
    await context.close();
  });

  test('a push that moves the app to another route leaves Talk and keeps the words', async () => {
    const { context, page } = await open({ talk: [ok('Go on.')] });
    await logFight(page);
    await openTalk(page);
    await sendTyped(page, 'before the push');
    await replyIs(page, 'Go on.');
    await page.evaluate(() => window.cycleNative.route('fight/fp'));
    await page.waitForSelector('[data-a="notesave"]');
    assert.equal(await page.$('.tkrep'), null, 'Talk is gone');
    assert.ok((await saved(page)).msgs.length >= 2, 'words kept');
    await context.close();
  });

  test('native: typing during the live mic stops the mic and the pending voice turn, and keeps the pill', async () => {
    const { context, page, posts } = await open({ native: true, talk: [ok('should not be asked')] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'still talking');
    await page.type('[data-t="tk"]', 'x');
    await page.waitForFunction(() => window.__bridge.includes('speech.stop'));
    assert.ok(await page.$('[data-a="tkmic"]:not(.rec)'), 'mic no longer recording');
    assert.ok(await page.$('.tkpill.has'), 'still the typing pill, not the failure buttons');
    // Without the halt the silence timer would still send the heard words 1800ms later; wait it out.
    await page.waitForTimeout(2300);
    assert.equal(posts.length, 0, 'typing cancelled the pending voice turn');
    assert.equal(await page.inputValue('[data-t="tk"]'), 'x');
    assert.deepEqual((await saved(page)).msgs, [{ role: 'user', text: 'still talking' }], 'heard words kept');
    await context.close();
  });

  test('native: backgrounding the app cancels speech and does not relisten', async () => {
    const { context, page } = await open({ native: true, talk: [ok('Speaking now.')] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'hello', true);
    await page.waitForFunction(() => window.__spoken.length === 1);
    const cancelled = await page.evaluate(() => window.__cancelled || 0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction((n) => (window.__cancelled || 0) > n, cancelled);
    await page.evaluate(() => window.__spoken[0].onend && window.__spoken[0].onend());
    await page.waitForTimeout(150);
    assert.equal(await starts(page), 1, 'a cancelled voice does not restart listening');
    await context.close();
  });

  test('native: backgrounding while listening stops recognition via Talk and keeps the partial transcript', async () => {
    const { context, page } = await open({ native: true });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'half heard');
    const cancelled = await page.evaluate(() => window.__cancelled || 0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction((n) => (window.__cancelled || 0) > n, cancelled);
    await page.waitForFunction(() => window.__bridge.includes('speech.stop'));
    await page.waitForSelector('[data-a="tkretry"]');
    assert.deepEqual((await saved(page)).msgs, [{ role: 'user', text: 'half heard' }], 'the partial transcript is kept, not dropped');
    await context.close();
  });

  test('a failed X (finish) retries as finish:true', async () => {
    const { context, page, posts } = await open({ talk: [ok('Ok.'), { status: 500 }, ok('Right?', 'My note.')] });
    await logFight(page);
    await openTalk(page);
    await sendTyped(page, 'something');
    await replyIs(page, 'Ok.');
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('[data-a="tkretry"]');
    assert.equal(posts[1].finish, true);
    await page.click('[data-a="tkretry"]');
    await page.waitForSelector('.tkd');
    assert.equal(posts[2].finish, true, 'Retry keeps finish');
    await context.close();
  });

  test('native: a voice whose end never fires goes idle after the timeout, with no error and no relisten', async () => {
    const { context, page } = await open({ native: true, talk: [ok('Ok.')] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'hi', true);
    await page.waitForFunction(() => window.__spoken.length === 1);
    const cancelled = await page.evaluate(() => window.__cancelled || 0);
    // talkSpeakMs('Ok.') is 5000 + 3*120 ms; nothing fires onend, so the fallback timer cancels the voice.
    await page.waitForFunction((n) => (window.__cancelled || 0) > n, cancelled, { timeout: 9000 });
    await page.waitForTimeout(100);
    assert.equal(await page.$('.errbar'), null);
    assert.equal(await starts(page), 1, 'idle, not listening');
    assert.equal(await state(page), 'idle');
    await context.close();
  });

  test('no box url: no Talk control', async () => {
    const { context, page } = await open({ boxUrl: '' });
    await logFight(page);
    assert.equal(await page.$('[data-a="talk:note"]'), null);
    await context.close();
  });

  test('keyboard: the pill sits above the keyboard when the viewport shrinks, and the row clears the bottom edge', async () => {
    const { context, page } = await open({ native: true });
    await logFight(page);
    await openTalk(page);
    const geo = () => page.evaluate(() => {
      const p = document.querySelector('.tkpill').getBoundingClientRect(), r = document.querySelector('.tkrow').getBoundingClientRect();
      return { pillBottom: p.bottom, rowBottom: r.bottom, rowTop: r.top, h: window.innerHeight };
    });
    const closed = await geo();
    assert.ok(closed.rowBottom <= closed.h - 12, 'row clear of the bottom edge');
    assert.ok(closed.pillBottom < closed.rowTop);
    await page.setViewportSize({ width: 390, height: 520 }); // keyboard open
    const open_ = await geo();
    assert.ok(open_.rowBottom <= 520 && open_.pillBottom < open_.rowTop, 'pill and row inside the shrunk viewport');
    await context.close();
  });

  test('every control is at least 44px', async () => {
    const { context, page } = await open({ native: true });
    await logFight(page);
    await openTalk(page);
    for (const sel of ['[data-a="tkmic"]', '[data-a="tkx"]', '[data-a="tkglow"]']) {
      const r = await page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return [b.width, b.height]; });
      assert.ok(r[0] >= 44 && r[1] >= 44, sel + ' ' + r);
    }
    await context.close();
  });

  test('screenshots at 390px: listening with a reply, and the review', { skip: !SHOTS }, async () => {
    const { context, page } = await open({ native: true, talk: [ok('That sounds hard. What set it off?'), ok('Is that right?', 'We argued at dinner on Friday about the plans. I felt dismissed when he checked his phone.\n\nWe made up later that night.')] });
    await logFight(page);
    await openTalk(page);
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'We had a fight at dinner and he just kept looking at his phone the whole time', true);
    await replyIs(page, 'That sounds hard. What set it off?');
    await page.waitForFunction(() => window.__spoken.length === 1);
    await page.evaluate(() => window.__spoken[0].onend());
    await stateIs(page, 'listening');
    await hear(page, 'Test test two.');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, `talk-listening-${name}.png`) });
    await page.click('[data-a="tkx"]');
    await page.waitForSelector('.tkd');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, `talk-review-${name}.png`) });
    await context.close();
  });
});
