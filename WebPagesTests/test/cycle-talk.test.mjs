// Talk: the voice-first conversation on the fight note fields. Box /talk is stubbed, the native shell (bridge, speech
// recognition, speechSynthesis) is faked. Runs in WebKit (GL_WEBKIT_PW / GL_WEBKIT_EXEC), and Chromium too.
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

for (const [name, type] of Object.entries(engines)) describe(name, () => {
  let browser;
  before(async () => { browser = await type.launch({ headless: true }); });
  after(async () => { await browser.close(); });

  // opts.native: fake shell (bridge + speech + speechSynthesis); opts.talk: queue of /talk answers ({status, body} or {abort}).
  async function open({ native = false, talk = [], boxUrl = 'https://box.test' } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript(([sd, box, nat]) => {
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
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (u) => window.__spoken.push(u), cancel: () => { window.__cancelled = (window.__cancelled || 0) + 1; } } });
    }, [seed(), boxUrl, native]);
    await context.route('**/cycle.css', (route) => route.fulfill({ contentType: 'text/css', body: CSS }));
    await context.route('https://x.test/**', (route) => route.abort());
    const posts = [];
    await context.route('https://box.test/talk', async (route) => {
      posts.push(route.request().postDataJSON());
      const a = talk.shift();
      if (!a) return route.abort();
      if (a.delay) await new Promise((r) => setTimeout(r, a.delay)); // a slow box, for the late-reply case
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
  const bubbles = (page) => page.$$eval('.tb', (e) => e.map((x) => x.className.replace('tb ', '') + ':' + x.textContent));
  const sendTyped = async (page, text) => { await page.fill('[data-t="tk"]', text); await page.click('[data-a="tksend"]'); };
  const ok = (reply, draft = null) => ({ body: { reply, draft } });
  const bridge = (page) => page.evaluate(() => window.__bridge.filter((c) => c.startsWith('speech')));
  const hear = (page, text, final = false) => page.evaluate(([t, f]) => window.cycleNative.speech(t, f), [text, final]);
  const rows = (page) => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_notes));

  test('opens from Log a fight, a typed turn shows the reply, and the request carries names without notes', async () => {
    const { context, page, posts } = await open({ talk: [ok('What happened next?')] });
    await logFight(page);
    await page.click('[data-a="int:4"]');
    await page.fill('[data-d="note"]', 'We argued at dinner');
    await page.click('[data-a="talk:note"]');
    await page.waitForSelector('[data-a="tkclose"]');
    assert.equal(await page.textContent('.hd h2'), 'Talk');
    assert.equal(await page.$('[data-a="fightsave"]'), null, 'drawn instead of the form');
    assert.equal(await page.$('[data-a="tkdone"]'), null, 'no Done before an exchange');
    await sendTyped(page, 'He forgot the plan');
    await page.waitForSelector('.tb.ai:not(.live)');
    assert.deepEqual(await bubbles(page), ['me:He forgot the plan', 'ai:What happened next?']);
    assert.deepEqual(posts[0], { messages: [{ role: 'user', text: 'He forgot the plan' }], finish: false, speaker: 'Mia', partner: 'Jo', notes: [] });
    assert.ok(await page.$('[data-a="tkdone"]'), 'Done after one exchange');
    await context.close();
  });

  test('native: opening listens at once, silence sends the turn, the reply is spoken, then listening restarts', async () => {
    const { context, page, posts } = await open({ native: true, talk: [ok('Tell me more.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'he said');
    await hear(page, 'he said he would call');
    assert.equal(posts.length, 0, 'not sent while the text is still changing');
    assert.equal(await page.textContent('.tb.me.live'), 'he said he would call');
    await page.waitForFunction(() => document.querySelector('.tb.ai:not(.live)'), null, { timeout: 5000 });
    assert.equal(posts[0].messages[0].text, 'he said he would call');
    await page.waitForFunction(() => window.__spoken.length === 1);
    assert.equal(await page.evaluate(() => window.__spoken[0].text), 'Tell me more.');
    // Ordering: the audio session is stopped (awaited) before the reply is spoken, and listening restarts only after it ends.
    assert.deepEqual(await bridge(page), ['speech.start', 'speech.stop', 'speech.stop']);
    await page.evaluate(() => window.__spoken[0].onend());
    await page.waitForFunction(() => window.__bridge.filter((c) => c === 'speech.start').length === 2);
    await context.close();
  });

  test('native: tapping the mic mid-speech cuts it and listens; speech error and missing end fall back to idle without an error', async () => {
    const { context, page } = await open({ native: true, talk: [ok('One.'), ok('Two.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'first', true);
    await page.waitForFunction(() => window.__spoken.length === 1);
    await page.click('[data-a="tkmic"]'); // cut the voice and talk
    await page.waitForFunction(() => window.__bridge.filter((c) => c === 'speech.start').length === 2);
    assert.ok(await page.evaluate(() => window.__cancelled >= 1));
    await hear(page, 'second', true);
    await page.waitForFunction(() => window.__spoken.length === 2);
    await page.evaluate(() => window.__spoken[1].onerror());
    await page.waitForTimeout(100);
    assert.equal(await page.$('.errbar'), null, 'no error shown');
    assert.equal(await page.evaluate(() => window.__bridge.filter((c) => c === 'speech.start').length), 2, 'idle, not listening');
    assert.ok(await page.$('[data-a="tkmic"]:not(.rec)'));
    await context.close();
  });

  test('Done: a clarifying question continues the loop, then the draft card appears', async () => {
    const { context, page, posts } = await open({ talk: [ok('Ok.'), ok('How did it end?'), ok('Thanks.'), ok('Is that right?', 'I was upset about dinner.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await sendTyped(page, 'dinner went badly');
    await page.waitForSelector('[data-a="tkdone"]');
    await page.click('[data-a="tkdone"]');
    await page.waitForFunction(() => document.querySelectorAll('.tb.ai:not(.live)').length === 2);
    assert.equal(posts[1].finish, true);
    assert.equal(await page.$('.tkd'), null, 'a question is not a draft');
    await sendTyped(page, 'we made up');
    await page.waitForFunction(() => document.querySelectorAll('.tb.ai:not(.live)').length === 3);
    await page.click('[data-a="tkdone"]');
    await page.waitForSelector('.tkd');
    assert.equal(await page.textContent('.tkd p'), 'I was upset about dinner.');
    assert.deepEqual(await page.$$eval('.tkd [data-a]', (e) => e.map((x) => x.textContent)), ['Use this', 'Keep talking']);
    assert.equal(posts[3].messages.length, 5);
    // Keep talking dismisses the card and the conversation goes on.
    await page.click('[data-a="tkkeep"]');
    assert.equal(await page.$('.tkd'), null);
    await context.close();
  });

  test('Use this appends to the note after a blank line, keeps the form, writes no fight_notes row until Save', async () => {
    const { context, page } = await open({ talk: [ok('Ok.'), ok('Right?', 'I was upset about dinner.')] });
    await logFight(page);
    await page.click('[data-a="int:5"]');
    await page.fill('[data-d="note"]', 'Typed first');
    const before = await rows(page);
    await page.click('[data-a="talk:note"]');
    await sendTyped(page, 'it was dinner');
    await page.waitForSelector('[data-a="tkdone"]');
    await page.click('[data-a="tkdone"]');
    await page.waitForSelector('[data-a="tkuse"]');
    await page.click('[data-a="tkuse"]');
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await page.inputValue('[data-d="note"]'), 'Typed first\n\nI was upset about dinner.');
    assert.equal(await page.$eval('[data-a="int:5"]', (e) => e.className.includes('on') || e.classList.length > 0), true);
    assert.equal(await page.$eval('[data-a="int:5"]', (e) => (e.getAttribute('class') || '').trim() !== (document.querySelector('[data-a="int:1"]').getAttribute('class') || '').trim()), true, 'intensity 5 still selected');
    await page.waitForTimeout(300); // the store persists on a 50ms debounce; a stray insert would only show in localStorage after it
    assert.deepEqual(await rows(page), before, 'nothing shared yet');
    assert.equal(await page.evaluate(() => localStorage.getItem('cycle:talk:new')), '', 'saved conversation cleared');
    await page.click('[data-a="fightsave"]');
    await page.waitForFunction((n) => Object.keys(JSON.parse(localStorage.getItem('cycle:shared.u-me')).rows.fight_notes).length === n + 1, before.length);
    await context.close();
  });

  test('failure keeps the turn with Retry and Use my words; Use my words fills the note; Retry recovers', async () => {
    const { context, page } = await open({ talk: [{ status: 500 }, ok('Got it.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await sendTyped(page, 'first thing');
    await page.waitForSelector('[data-a="tkretry"]');
    assert.deepEqual(await bubbles(page), ['me:first thing']);
    assert.equal(await page.textContent('[data-a="tkwords"]'), 'Use my words');
    await page.click('[data-a="tkretry"]');
    await page.waitForSelector('.tb.ai:not(.live)');
    assert.deepEqual(await bubbles(page), ['me:first thing', 'ai:Got it.']);
    await sendTyped(page, 'second thing'); // next answer: the stub queue is empty, so the request fails
    await page.waitForSelector('[data-a="tkwords"]');
    await page.click('[data-a="tkwords"]');
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await page.inputValue('[data-d="note"]'), 'first thing second thing');
    await context.close();
  });

  test('a reload restores the conversation on the same new-fight form; Close keeps it', async () => {
    const { context, page } = await open({ talk: [ok('Go on.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await sendTyped(page, 'my words survive');
    await page.waitForSelector('.tb.ai:not(.live)');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-a="go:fight"]');
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await page.waitForSelector('.tb.me');
    assert.deepEqual(await bubbles(page), ['me:my words survive', 'ai:Go on.']);
    await page.click('[data-a="tkclose"]');
    await page.waitForSelector('[data-a="fightsave"]');
    await page.click('[data-a="talk:note"]');
    await page.waitForSelector('.tb.me');
    assert.equal((await bubbles(page)).length, 2);
    await context.close();
  });

  test('Close with a just-heard partial transcript keeps it as an unsent turn', async () => {
    const { context, page } = await open({ native: true });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'half a sentence');
    await page.click('[data-a="tkclose"]');
    await page.waitForSelector('[data-a="fightsave"]');
    assert.equal(await page.evaluate(() => window.__bridge.filter((c) => c === 'speech.stop').length >= 1), true);
    await page.click('[data-a="talk:note"]');
    await page.waitForSelector('.tb.me');
    assert.deepEqual(await bubbles(page), ['me:half a sentence']);
    assert.ok(await page.$('[data-a="tkretry"]'), 'unsent turn can be retried');
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
    await page.click('[data-a="talk:more"]');
    await sendTyped(page, 'my side');
    await page.waitForSelector('.tb.ai:not(.live)');
    assert.deepEqual(posts[0].notes, ['Jo: Started with the dishes']);
    assert.equal(JSON.stringify(posts[0]).includes('DELETED TEXT'), false, 'a deleted note never goes to the model');
    await context.close();
  });

  test('saving a note on fight detail clears that fight\'s stored conversation', async () => {
    const { context, page } = await open({ talk: [ok('Go on.')] });
    await page.evaluate(() => window.cycleNative.route('fight/fp'));
    await page.waitForSelector('[data-a="notesave"]');
    await page.click('[data-a="talk:more"]');
    await sendTyped(page, 'some words');
    await page.waitForSelector('.tb.ai:not(.live)');
    await page.click('[data-a="tkclose"]');
    await page.waitForSelector('[data-a="notesave"]');
    assert.notEqual(await page.evaluate(() => localStorage.getItem('cycle:talk:fp')), '', 'kept on Close');
    await page.fill('[data-d="more"]', 'typed myself');
    await page.click('[data-a="notesave"]');
    await page.waitForFunction(() => localStorage.getItem('cycle:talk:fp') === '');
    await context.close();
  });

  test('a reply that arrives after Close is dropped, not added to the saved conversation', async () => {
    const { context, page, posts } = await open({ talk: [{ ...ok('too late'), delay: 600 }] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await sendTyped(page, 'quick words');
    await page.waitForSelector('.tb.ai.live'); // pending
    await page.click('[data-a="tkclose"]');
    await page.waitForSelector('[data-a="fightsave"]');
    await page.waitForTimeout(900);
    assert.equal(posts.length, 1);
    await page.click('[data-a="talk:note"]');
    await page.waitForSelector('.tb.me');
    assert.deepEqual(await bubbles(page), ['me:quick words'], 'no late AI bubble');
    assert.ok(await page.$('[data-a="tkretry"]'), 'the unanswered turn is retryable');
    await context.close();
  });

  test('a push that moves the app to another route leaves Talk and keeps the words', async () => {
    const { context, page } = await open({ talk: [ok('Go on.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await sendTyped(page, 'before the push');
    await page.waitForSelector('.tb.ai:not(.live)');
    await page.evaluate(() => window.cycleNative.route('fight/fp'));
    await page.waitForSelector('[data-a="notesave"]');
    assert.equal(await page.$('.tkm'), null, 'Talk is gone');
    assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('cycle:talk:new'))).msgs.length >= 2, 'words kept');
    await context.close();
  });

  test('native: typing during the live mic stops the mic', async () => {
    const { context, page } = await open({ native: true });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'still talking');
    await page.type('[data-t="tk"]', 'x');
    await page.waitForFunction(() => window.__bridge.includes('speech.stop'));
    assert.ok(await page.$('[data-a="tkmic"]:not(.rec)'), 'mic no longer recording');
    await context.close();
  });

  test('native: backgrounding the app stops recognition and cancels speech', async () => {
    const { context, page } = await open({ native: true, talk: [ok('Speaking now.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
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
    assert.equal(await page.evaluate(() => window.__bridge.filter((c) => c === 'speech.start').length), 1, 'a cancelled voice does not restart listening');
    await context.close();
  });

  test('native: backgrounding while listening stops speech recognition via Talk', async () => {
    const { context, page } = await open({ native: true });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'half heard');
    const cancelled = await page.evaluate(() => window.__cancelled || 0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction((n) => (window.__cancelled || 0) > n, cancelled);
    await page.waitForFunction(() => window.__bridge.includes('speech.stop'));
    assert.deepEqual(await bubbles(page), ['me:half heard'], 'the partial transcript is kept, not dropped');
    await context.close();
  });

  test('a failed Done retries as Done (finish:true)', async () => {
    const { context, page, posts } = await open({ talk: [ok('Ok.'), { status: 500 }, ok('Right?', 'My note.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await sendTyped(page, 'something');
    await page.waitForSelector('[data-a="tkdone"]');
    await page.click('[data-a="tkdone"]');
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
    await page.click('[data-a="talk:note"]');
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'hi', true);
    await page.waitForFunction(() => window.__spoken.length === 1);
    const cancelled = await page.evaluate(() => window.__cancelled || 0);
    // talkSpeakMs('Ok.') is 5000 + 3*120 ms; nothing fires onend, so the fallback timer cancels the voice.
    await page.waitForFunction((n) => (window.__cancelled || 0) > n, cancelled, { timeout: 9000 });
    await page.waitForTimeout(100);
    assert.equal(await page.$('.errbar'), null);
    assert.equal(await page.evaluate(() => window.__bridge.filter((c) => c === 'speech.start').length), 1, 'idle, not listening');
    assert.ok(await page.$('[data-a="tkmic"]:not(.rec)'));
    await context.close();
  });

  test('no box url: no Talk control', async () => {
    const { context, page } = await open({ boxUrl: '' });
    await logFight(page);
    assert.equal(await page.$('[data-a="talk:note"]'), null);
    await context.close();
  });

  test('screenshots at 390px: conversation and draft card', { skip: !SHOTS }, async () => {
    const { context, page } = await open({ native: true, talk: [ok('That sounds hard. What set it off?'), ok('Got it. Was that when you left?'), ok('Is that right?', 'We argued at dinner on Friday about the plans. I felt dismissed when he checked his phone.\n\nWe made up later that night.')] });
    await logFight(page);
    await page.click('[data-a="talk:note"]');
    await page.waitForFunction(() => window.__bridge.includes('speech.start'));
    await hear(page, 'We had a fight at dinner and he just kept looking at his phone the whole time', true);
    await page.waitForSelector('.tb.ai:not(.live)');
    await page.evaluate(() => window.__spoken[0].onend());
    await hear(page, 'yes', true);
    await page.waitForFunction(() => document.querySelectorAll('.tb.ai:not(.live)').length === 2);
    await page.waitForSelector('[data-a="tkdone"]');
    await page.screenshot({ path: path.join(SHOTS, `talk-conversation-${name}.png`) });
    await page.click('[data-a="tkdone"]');
    await page.waitForSelector('.tkd');
    await page.screenshot({ path: path.join(SHOTS, `talk-draft-${name}.png`) });
    await context.close();
  });
});
