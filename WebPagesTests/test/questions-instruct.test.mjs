// The Reply screen shows why the bot escalated and tappable instructions to it;
// a chip or typed instruction POSTs /questions/instruct and the question leaves the list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildMockBridgeScript } from './mock-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = 'file://' + path.join(HERE, '../../Modules/WebPages/questions.html');

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

const Q = {
  id: 'fb:diego', source: 'facebook', title: 'Diego · SIIPRO Smartwatch, Black', body: 'Hola, puedo recogerlo mañana lunes?', createdAt: new Date().toISOString(),
  context: { listing: 'SIIPRO Smartwatch, Black', buyer: 'Diego', messages: ['Hola, puedo recogerlo mañana lunes?'] },
  reason: 'Monday is already booked for this item (Daniel 11:00)',
  actions: ['Offer Wednesday', 'Book Monday 2pm anyway', 'Tell him it is spoken for'],
  messages: null, approximate: false,
  answer: { endpoint: '/push/reply', payload: { category: 'FB_REPLY', data: { listing: 'SIIPRO Smartwatch, Black', buyer: 'Diego' } } },
};

async function open(q, posts) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript({
    boot: { mode: 'light', platform: 'ios', apiBase: 'http://x.test' },
    responses: { getApiToken: { token: 't' }, getPref: { value: true }, goBack: {} },
  }));
  const page = await context.newPage();
  await page.route('http://x.test/questions/instruct', (r) => { posts.push(JSON.parse(r.request().postData())); r.fulfill({ contentType: 'application/json', body: '{"result":"ok"}' }); });
  await page.route('http://x.test/questions?*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ questions: [q], visits: [], pending: [], takeovers: [] }) }));
  await page.route('http://x.test/questions', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ questions: [q], visits: [], pending: [], takeovers: [] }) }));
  await page.goto(PAGE_URL);
  await page.waitForSelector('.q-item');
  await page.click('.q-item');
  await page.waitForSelector('#q-answer:not(.gl-hidden)');
  return page;
}

test('reply screen shows the reason and the action chips', async () => {
  const page = await open(Q, []);
  assert.equal(await page.textContent('#q-a-why'), Q.reason);
  assert.deepEqual(await page.$$eval('#q-chips button', (b) => b.map((x) => x.textContent)), Q.actions);
});

test('no reason and no actions: no reason line, no chips, instruction input still there', async () => {
  const page = await open({ ...Q, reason: null, actions: [] }, []);
  assert.equal(await page.isHidden('#q-a-why'), true);
  assert.equal(await page.$$eval('#q-chips button', (b) => b.length), 0);
  assert.equal(await page.isVisible('#q-ai-in'), true);
});

test('tapping a chip POSTs the instruction, returns to the list without the question, toasts', async () => {
  const posts = [];
  const page = await open(Q, posts);
  await page.click('#q-chips button:nth-child(2)');
  await page.waitForFunction(() => document.getElementById('q-toast') && !document.getElementById('q-toast').classList.contains('gl-hidden'));
  await page.waitForTimeout(100);
  assert.deepEqual(posts, [{ listing: 'SIIPRO Smartwatch, Black', buyer: 'Diego', instruction: 'Book Monday 2pm anyway' }]);
  assert.match(await page.textContent('#q-toast-msg'), /Told the AI: Book Monday 2pm anyway/);
  assert.equal(await page.isHidden('#q-answer'), true);
  assert.equal(await page.$$eval('.q-item', (e) => e.length), 0);
});

test('typed instruction: button disabled when empty, sends trimmed text', async () => {
  const posts = [];
  const page = await open(Q, posts);
  assert.equal(await page.isDisabled('#q-ai-go'), true);
  await page.fill('#q-ai-in', '  Offer Friday after 3  ');
  assert.equal(await page.isDisabled('#q-ai-go'), false);
  await page.click('#q-ai-go');
  await page.waitForTimeout(200);
  assert.equal(posts[0].instruction, 'Offer Friday after 3');
});
