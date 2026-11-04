// The page keeps itself fresh while open: /questions reloads every 30s while visible,
// on becoming visible, never two at once, and not at all while hidden.
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

async function open(handler) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript({
    boot: { mode: 'light', platform: 'ios', apiBase: 'http://x.test' },
    responses: { getApiToken: { token: 't' }, getPref: { value: true }, goBack: {} },
  }));
  const page = await context.newPage();
  await page.clock.install();
  const state = { count: 0, done: 0, urls: [] };
  await page.route('http://x.test/questions*', async (r) => { state.count++; state.urls.push(r.request().url()); await handler(r, state); state.done++; });
  await page.goto(PAGE_URL);
  while (state.count < 1) await page.waitForTimeout(20);
  await page.waitForTimeout(100);
  return { page, state };
}
const ok = (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ questions: [], visits: [], pending: [], takeovers: [] }) });
// A reload is over once its response is fulfilled and the page has processed it; the page ignores
// a reload request while one is in flight, so every step waits for the previous load to finish.
const settled = async (page, state, n = state.count) => {
  while (state.count < n || state.done < state.count) await page.waitForTimeout(20);
  await page.waitForTimeout(300);
};
const setVisibility = (page, v) => page.evaluate((state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}, v);

test('reloads every 30s while visible, stops while hidden, reloads when visible again', async () => {
  const { page, state } = await open(ok);
  assert.equal(state.count, 1);
  await page.clock.runFor(30000);
  await settled(page, state, 2);
  assert.equal(state.count, 2);
  await setVisibility(page, 'hidden');
  await page.clock.runFor(90000);
  await page.waitForTimeout(100);
  assert.equal(state.count, 2);
  await setVisibility(page, 'visible');
  await settled(page, state, 3);
  assert.equal(state.count, 3);
});

test('a tick is skipped while a load is still in flight', async () => {
  const { page, state } = await open(() => new Promise(() => {}));
  assert.equal(state.count, 1);
  await page.clock.runFor(120000);
  await page.waitForTimeout(100);
  assert.equal(state.count, 1);
});

test('only the initial load, a foreground and a visibility return ask for ?fresh=1; the 30s poll never does', async () => {
  const { page, state } = await open(ok);
  const last = () => state.urls[state.urls.length - 1];
  const reached = (n) => settled(page, state, n);
  assert.equal(state.count, 1);
  assert.equal(last(), 'http://x.test/questions?fresh=1');
  await page.clock.runFor(30000);
  await reached(2);
  assert.equal(state.count, 2);
  assert.equal(last(), 'http://x.test/questions');
  await setVisibility(page, 'visible');
  await reached(3);
  assert.equal(state.count, 3);
  assert.equal(last(), 'http://x.test/questions?fresh=1');
  await page.clock.runFor(30000);
  await reached(4);
  assert.equal(state.count, 4);
  assert.equal(last(), 'http://x.test/questions');
  await page.evaluate(() => window.refreshQuestions());
  await reached(5);
  assert.equal(state.count, 5);
  assert.equal(last(), 'http://x.test/questions?fresh=1');
});
