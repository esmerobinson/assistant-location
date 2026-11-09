// Tests for Modules/WebPages/session.html against a MOCKED GL bridge (see
// mock-bridge.mjs) and mocked /sessions/* fetches (via page.route()) -- no
// native app, no real server. Loaded via file:// exactly as
// GLWebModuleViewController's -initWithManagedPageNamed: loads it, same
// convention as more.test.mjs/recents.test.mjs/settings.test.mjs.
//
// Moved here from location-server/test-fixtures/session-page-playwright.mjs
// (superseded, deleted in the same change): that version stood up a REAL
// location-server instance across a fragile cross-repo relative path into
// this worktree just to serve session.html as a static file -- everything
// it actually exercised is page behavior against network/bridge responses,
// which this suite's existing page.route()/mock-bridge pattern covers with
// no real server at all, same as every other managed page's tests here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildMockBridgeScript } from './mock-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_URL = 'file://' + path.join(HERE, '../../Modules/WebPages/session.html');
const API_BASE = 'http://192.0.2.77:8302'; // TEST-NET-1 (RFC 5737) -- never a real host

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
  // Every Playwright wait fails after 8s (default 30s), so a regression is a prompt, attributable test failure rather than a hang.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    context.setDefaultTimeout(8000);
    return context;
  };
});
after(async () => { await browser.close(); });

function baseBoot(overrides = {}) {
  return { palette: null, mode: 'dark', themeId: null, platform: 'ios', apiBase: API_BASE, ...overrides };
}

function baseConfig(bridgeOverrides = {}) {
  return {
    boot: baseBoot(),
    responses: {
      getApiToken: { token: 'test-token' },
      goBack: {},
      getPref: { value: null },
      setPref: {},
      voiceStart: {},
      voiceStop: { text: 'a fake voice transcript' },
      voicePending: { ready: [], failed: [], pending: [], waiting: 0 },
      voiceAck: {},
      voiceCancel: {},
      ...bridgeOverrides,
    },
  };
}

/** Generates N fake project names, so tests can exercise the >7 overflow case without hand-listing them. */
function projectNames(n) {
  return Array.from({ length: n }, (_, i) => 'project-' + String(i + 1).padStart(2, '0'));
}

/** Routes GET /sessions/projects to a fixed project list (7 by default -- exactly at the no-More-chip boundary). */
async function routeProjects(context, projects = projectNames(7)) {
  await context.route(`${API_BASE}/sessions/projects*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects }) }));
}

/** Routes GET /sessions/recent to a fixed sessions list. */
async function routeRecent(context, sessions = []) {
  await context.route(`${API_BASE}/sessions/recent*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions }) }));
}

/**
 * Routes POST /sessions/upload to succeed with a DETERMINISTIC fake id
 * derived from the uploaded file's own bytes (unless `opts.fail` or
 * `opts.delayMs` is set), and records every request seen -- both its body
 * buffer AND its Authorization header -- onto `calls` so tests can assert on
 * upload count / exact byte content / auth, all independent of which
 * request the browser happens to dispatch first.
 *
 * A counter-based id (the previous version of this mock: `fake-${n}.png`
 * where n increments per request handled) is NOT deterministic when two
 * uploads fire concurrently (picking 2+ images at once) -- the browser can
 * dispatch/complete those requests in either order, so "the first id
 * returned" doesn't reliably correspond to "the first file picked". Any test
 * asserting pick-order on the Start body was therefore silently order-blind
 * (a prior version literally compared as Sets to paper over exactly this).
 * Deriving the id from the file's own (unique, per fakeImage()) bytes fixes
 * that at the source: whichever request arrives first, THIS file's upload
 * always gets THIS file's id.
 */
async function routeUpload(context, calls, opts = {}) {
  // Per-content occurrence count, scoped to this routeUpload() call (a fresh
  // Map per test, not shared across tests) -- picking the SAME file twice
  // (two sequential, non-concurrent setInputFiles calls) still gets each
  // pick its own distinct id, exactly like two real uploads of identical
  // bytes would, without reintroducing an arrival-order dependency for the
  // concurrent-different-files case idForBuffer exists to fix.
  const seenCounts = new Map();
  await context.route(`${API_BASE}/sessions/upload`, async (route) => {
    const buffer = route.request().postDataBuffer();
    calls.push({ buffer, auth: route.request().headers()['authorization'] });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) {
      return route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'unsupported image type' }) });
    }
    const baseId = idForBuffer(buffer);
    const count = (seenCounts.get(baseId) || 0) + 1;
    seenCounts.set(baseId, count);
    const id = count === 1 ? baseId : `${baseId}-${count}`;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id }) });
  });
}

/** A real (browser-decodable) 1x1 PNG followed by a `name` marker -- browsers ignore trailing bytes after a PNG's IEND chunk, so the <img> preview still renders, while the marker lets routeUpload/idForBuffer identify exactly which pick produced which request. */
const REAL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function fakeImage(name = 'shot.png') {
  return { name, mimeType: 'image/png', buffer: Buffer.concat([REAL_PNG, Buffer.from('|marker:' + name)]) };
}
function idForBuffer(buffer) {
  const marker = buffer.toString('latin1').split('|marker:')[1] || 'unknown';
  return `id-${marker.replace(/[^a-z0-9.]/gi, '-')}`;
}

async function newSessionPage(context) {
  const page = await context.newPage();
  await page.goto(SESSION_URL);
  // pillBtn.dataset.ready is set once loadProjects()'s fetch resolves and the
  // pill + tray-source state are ready (see session.html) -- waiting on it
  // (rather than an arbitrary timeout) means this is robust to the exact
  // project list for any given test, including the zero-projects case.
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  return page;
}

function pillText(page) {
  return page.locator('#session-project-pill-value').textContent();
}

async function openTray(page) {
  await page.click('#session-project-pill');
  await page.waitForSelector('#session-project-tray-backdrop:not([hidden])');
}

function trayRowLocator(page, name) {
  return page.locator(`.tray-row:has-text("${name}")`);
}

// --- project tray ----------------------------------------------------------

/** The tray always shows a "None" row first, and every skill row as "/<name>". */
function slashNames(names) { return names.map((n) => '/' + n); }

test('exactly 7 projects: all 7 appear under Recent, no All-projects section, "None" pinned first', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  const page = await newSessionPage(context);
  await openTray(page);
  const recentLabel = page.locator('.tray-section-label:text("Recent")');
  await assert.doesNotReject(recentLabel.waitFor({ state: 'attached', timeout: 2000 }));
  assert.equal(await page.locator('.tray-section-label:text("All skills")').count(), 0, 'no All-projects header at exactly 7 projects');
  const rowNames = await page.locator('.tray-row span:first-child').allTextContents();
  assert.deepEqual(rowNames, ['None', ...slashNames(projectNames(7))]);
  await context.close();
});

test('8+ projects: first 7 under Recent, the rest under All projects, no duplicates, "None" still pinned first', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(10));
  await routeRecent(context);
  const page = await newSessionPage(context);
  await openTray(page);
  const rowNames = await page.locator('.tray-row span:first-child').allTextContents();
  assert.deepEqual(rowNames, ['None', ...slashNames(projectNames(10))], 'None, then Recent (7), then All projects (3), each name exactly once');
  assert.equal(new Set(rowNames).size, rowNames.length, 'no project appears in both sections');
  await context.close();
});

test('tapping a Recent row selects it, closes the tray, updates the pill, and Start sends that exact project', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  let sentProject = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    sentProject = JSON.parse(route.request().postData()).project;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: sentProject }) });
  });
  const page = await newSessionPage(context);
  await openTray(page);
  await trayRowLocator(page, 'project-03').click();
  await page.waitForSelector('#session-project-tray-backdrop[hidden]', { state: 'attached' });
  assert.equal(await pillText(page), 'project-03');
  await page.fill('#session-prompt', 'do a thing');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  // The confirmation shows optimistically on click, before the POST
  // resolves -- wait for the actual response so `sentProject` (set inside
  // the route handler) is guaranteed populated before we read it.
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.equal(sentProject, 'project-03');
  await context.close();
});

test('tapping an All-projects row selects it (pill shows its name) and Start sends it; opening/selecting never itself hits the network', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(9));
  await routeRecent(context);
  let startCalls = 0;
  let sentProject = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startCalls += 1;
    sentProject = JSON.parse(route.request().postData()).project;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: sentProject }) });
  });
  const page = await newSessionPage(context);
  await openTray(page);
  await trayRowLocator(page, 'project-09').click();
  assert.equal(startCalls, 0, 'selecting a project must not itself call /sessions/start');
  assert.equal(await pillText(page), 'project-09');

  await page.fill('#session-prompt', 'overflow pick');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.equal(sentProject, 'project-09');
  await context.close();
});

test('backdrop tap dismisses the tray WITHOUT changing the selection, and the pill\'s aria-expanded tracks open/closed', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  // Start on a NON-first project: with project-01 selected, a dismiss that
  // wrongly resets to the default/first project is indistinguishable from
  // one that leaves the selection alone (test-skeptic mutation X6 survived
  // the project-01 version of this test for exactly that reason).
  await context.addInitScript((key) => { window.localStorage.setItem(key, 'project-04'); }, 'gl-session-last-project-v1');
  await routeProjects(context, projectNames(9));
  await routeRecent(context);
  const page = await newSessionPage(context);
  assert.equal(await pillText(page), 'project-04', 'sanity: starts on a remembered non-first project');
  assert.equal(await page.locator('#session-project-pill').getAttribute('aria-expanded'), 'false');
  await openTray(page);
  assert.equal(await page.locator('#session-project-pill').getAttribute('aria-expanded'), 'true', 'pill reports the tray as expanded while open');
  // Tap a corner of the backdrop, well outside the sheet, which sits flush
  // to the bottom -- { position: 'top-left' } lands above the sheet.
  await page.locator('#session-project-tray-backdrop').click({ position: { x: 5, y: 5 } });
  await page.waitForSelector('#session-project-tray-backdrop[hidden]', { state: 'attached' });
  assert.equal(await pillText(page), 'project-04', 'selection must be unchanged by a backdrop dismiss');
  assert.equal(await page.locator('#session-project-pill').getAttribute('aria-expanded'), 'false', 'pill reports collapsed again after dismiss');
  await context.close();
});

test('tapping INSIDE the sheet (search box, title) never dismisses the tray -- the sheet stops the click reaching the backdrop\'s dismiss handler', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(9));
  await routeRecent(context);
  const page = await newSessionPage(context);
  await openTray(page);
  // page.fill() only focuses the input, so the search assertions elsewhere
  // never exercise a real tap on it -- a REAL click is what bubbles.
  await page.click('#session-project-tray-search');
  await page.click('.tray-title');
  await page.waitForTimeout(100); // let a (wrong) bubbled dismiss settle
  assert.equal(await page.locator('#session-project-tray-backdrop').isHidden(), false, 'tray must still be open after tapping its own search box / title');
  assert.equal(await page.locator('#session-project-pill').getAttribute('aria-expanded'), 'true');
  await context.close();
});

test('tray search: case-insensitive, whitespace-trimmed, filters both sections, hides an empty section header, and never duplicates a match', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  // Recent (first 7): project-01..06 + UpperRecent. All projects (rest):
  // project-08..11 + MixedCaseRepo. A mixed-case name sits in EACH section
  // on purpose: the filter lowercases Recent and All in two separate
  // expressions, so a case-insensitivity check against only one section
  // leaves the other's .toLowerCase() free to disappear unnoticed (mutation
  // M1 in the test-skeptic audit survived the single-section version).
  await routeProjects(context, [...projectNames(6), 'UpperRecent', 'project-08', 'project-09', 'project-10', 'project-11', 'MixedCaseRepo']);
  await routeRecent(context);
  const page = await newSessionPage(context);
  await openTray(page);

  // "None" is pinned at top and unaffected by the search query -- every
  // query below still has it present, on top of whatever else matches.

  // Case-insensitive + only the All-projects section matches -> Recent header hidden.
  await page.fill('#session-project-tray-search', 'mixed');
  await assert.doesNotReject(trayRowLocator(page, 'MixedCaseRepo').waitFor({ state: 'visible', timeout: 2000 }));
  assert.equal(await page.locator('.tray-section-label:text("Recent")').count(), 0, 'Recent header hidden when it has zero matches');
  assert.equal(await page.locator('.tray-row').count(), 2, 'None + the one match');

  // Case-insensitive in the Recent section too -> All-projects header hidden.
  await page.fill('#session-project-tray-search', 'upperrec');
  await assert.doesNotReject(trayRowLocator(page, 'UpperRecent').waitFor({ state: 'visible', timeout: 2000 }));
  assert.equal(await page.locator('.tray-section-label:text("All skills")').count(), 0, 'All-projects header hidden when only a Recent name matches');
  assert.equal(await page.locator('.tray-row').count(), 2, 'None + the one match');

  // SUBSTRING match, not prefix: "ject-0" starts no name but sits inside
  // project-01..06 (Recent) and project-08/09 (All) -> 8 rows, both
  // headers. A startsWith-style filter would show nothing here.
  await page.fill('#session-project-tray-search', 'ject-0');
  await assert.doesNotReject(trayRowLocator(page, 'project-09').waitFor({ state: 'visible', timeout: 2000 }));
  assert.deepEqual(await page.locator('.tray-row span:first-child').allTextContents(),
    ['None', ...slashNames([...projectNames(6), 'project-08', 'project-09'])], 'a mid-name query matches in BOTH sections, Recent first, None still pinned');
  assert.equal(await page.locator('.tray-section-label').count(), 2);

  // Whitespace padding around a real query is trimmed the same way.
  await page.fill('#session-project-tray-search', '   mixed   ');
  await assert.doesNotReject(trayRowLocator(page, 'MixedCaseRepo').waitFor({ state: 'visible', timeout: 2000 }));

  // A query matching a Recent name only -> All-projects header hidden.
  await page.fill('#session-project-tray-search', 'project-03');
  await assert.doesNotReject(trayRowLocator(page, 'project-03').waitFor({ state: 'visible', timeout: 2000 }));
  assert.equal(await page.locator('.tray-section-label:text("All skills")').count(), 0, 'All-projects header hidden when it has zero matches');

  // All-whitespace query = full, unfiltered list (both sections back, no dupes).
  await page.fill('#session-project-tray-search', '   ');
  await assert.doesNotReject(page.locator('.tray-section-label:text("Recent")').waitFor({ state: 'visible', timeout: 2000 }));
  await assert.doesNotReject(page.locator('.tray-section-label:text("All skills")').waitFor({ state: 'visible', timeout: 2000 }));
  const allNames = await page.locator('.tray-row span:first-child').allTextContents();
  assert.equal(new Set(allNames).size, allNames.length, 'no duplicates in the unfiltered list');
  assert.equal(allNames.length, 13, 'None + 12 skills');

  // No match at all -> empty state, no stray section headers, but "None" survives.
  await page.fill('#session-project-tray-search', 'zzz-nope');
  await assert.doesNotReject(page.locator('.tray-empty').waitFor({ state: 'visible', timeout: 2000 }));
  assert.equal(await page.locator('.tray-section-label').count(), 0);
  assert.equal(await page.locator('.tray-row').count(), 1, 'only the pinned None row remains');
  await context.close();
});

test('reopening the tray clears the previous search query', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  const page = await newSessionPage(context);
  await openTray(page);
  await page.fill('#session-project-tray-search', 'project-02');
  await trayRowLocator(page, 'project-02').click();
  await openTray(page);
  assert.equal(await page.inputValue('#session-project-tray-search'), '', 'query must be cleared on reopen');
  assert.equal(await page.locator('.tray-row').count(), 8, 'None + reopening with a cleared query shows the full list again');
  // The reopened list is re-rendered from the CURRENT selection: the
  // checkmark moved to project-02 and is on no other row (a list rendered
  // once and cached would still show project-01 checked).
  assert.equal(await page.locator('.tray-row .gl-check.selected').count(), 1, 'exactly one row carries the selected checkmark');
  assert.equal(await trayRowLocator(page, 'project-02').locator('.gl-check.selected').count(), 1, 'the checkmark is on the row just picked');
  await context.close();
});

test('after a successful Start, a reload preselects the project that session ran in (LAST_PROJECT_KEY survives the draft being cleared)', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: 'project-03' }) }));
  const page = await newSessionPage(context);
  await openTray(page);
  await trayRowLocator(page, 'project-03').click();
  await page.fill('#session-prompt', 'remember me');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 5000 });
  // A successful Start clears the draft (which also carries the project),
  // so what's left to restore from is ONLY the last-used-project key --
  // selecting a row must have written it, or this reload falls back to
  // project-01. (The draft-restore test can't see this: its draft.project
  // wins before the key is ever consulted.)
  assert.equal(await page.evaluate(() => window.localStorage.getItem('gl-session-draft-v1')), null, 'sanity: draft is gone after a successful Start');
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  assert.equal(await pillText(page), 'project-03', 'the project the last session ran in is preselected on the next visit');
  await context.close();
});

test('last-used project (localStorage) is restored as the pill value and the tray\'s selected row on load', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript((key) => { window.localStorage.setItem(key, 'project-05'); }, 'gl-session-last-project-v1');
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  const page = await newSessionPage(context);
  assert.equal(await pillText(page), 'project-05');
  await openTray(page);
  assert.equal(await trayRowLocator(page, 'project-05').locator('.gl-check').getAttribute('class'), 'gl-check selected');
  // ...and ONLY that row: a checkmark painted on every row would pass the
  // line above (test-skeptic mutation X3).
  assert.equal(await page.locator('.tray-row .gl-check.selected').count(), 1, 'exactly one row is marked selected');
  assert.equal(await trayRowLocator(page, 'project-01').locator('.gl-check').getAttribute('class'), 'gl-check', 'the first (default) project is NOT marked selected');
  await context.close();
});

test('a remembered last-used project that no longer exists in the list falls back to None, never a ghost pill value or some OTHER skill', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  // Also covers the "legacy value from the old repo-based picker" case: a
  // stale name from before this feature is indistinguishable, at this
  // point, from a skill that was simply renamed/removed -- both fall back
  // to None the same way, via the same membership check.
  await context.addInitScript((key) => { window.localStorage.setItem(key, 'renamed-away-project'); }, 'gl-session-last-project-v1');
  await routeProjects(context, projectNames(3));
  await routeRecent(context);
  const page = await newSessionPage(context);
  assert.equal(await pillText(page), 'None', 'falls back to None, never to project-01 or any other skill it never chose');
  await page.fill('#session-prompt', 'go');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled, undefined, { timeout: 2000 })
    .catch(() => { throw new Error('Start must be enabled: None + prompt text is startable'); });
  await context.close();
});

test('with a real skill list but nothing remembered, the default selection is None (not the first/only skill), and Start enables once a prompt is typed', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, ['only-project']);
  await routeRecent(context);
  const page = await newSessionPage(context);
  assert.equal(await pillText(page), 'None', 'None is the default when nothing is remembered, even with real skills available');
  await page.fill('#session-prompt', 'go');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await context.close();
});

test('explicitly picking the "None" row sends project "" to Start and is remembered across a reload, just like a real skill', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(3));
  await routeRecent(context);
  let sentProject;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    sentProject = JSON.parse(route.request().postData()).project;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: sentProject }) });
  });
  const page = await newSessionPage(context);
  // Seed a remembered REAL skill via a plain write (NOT addInitScript, which
  // would re-run and re-clobber this on the reload below) so we can prove
  // picking None overrides it, not merely that None was already the default.
  await page.evaluate((key) => window.localStorage.setItem(key, 'project-02'), 'gl-session-last-project-v1');
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  assert.equal(await pillText(page), 'project-02', 'sanity: starts on the remembered real skill');
  await openTray(page);
  await trayRowLocator(page, 'None').click();
  assert.equal(await pillText(page), 'None');
  await page.fill('#session-prompt', 'plain session please');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  // The optimistic commit shows the confirmation on the tap itself, before
  // the POST resolves -- waiting on the confirmation alone would race the
  // route handler below and read `sentProject` before it's set. Wait for the
  // actual response instead so the assertion is synchronized to the real
  // network call, not to the (now-instant) UI feedback.
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 5000 });
  assert.equal(sentProject, '', 'None must send project: "" to the server, not a name or null');
  // The server echoes project: '' back; the confirmation must render that as
  // "None", never a dangling "in " (mutation: drop the `|| 'None'` fallback).
  assert.match(await page.locator('#session-confirmation-title').textContent(), /no skill$/);

  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  assert.equal(await pillText(page), 'None', 'None survives a reload exactly like a remembered real skill would');
  await context.close();
});

test('the clear button shows only while a real skill is selected, resets the pill to None, and Start then sends project ""', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(3));
  await routeRecent(context);
  let sentProject;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    sentProject = JSON.parse(route.request().postData()).project;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: sentProject }) });
  });
  const page = await newSessionPage(context);
  const clearBtn = page.locator('#session-project-clear');
  assert.equal(await pillText(page), 'None');
  assert.equal(await clearBtn.isVisible(), false, 'hidden while None is selected');
  await openTray(page);
  await trayRowLocator(page, 'project-02').click();
  assert.equal(await clearBtn.isVisible(), true, 'shown once a real skill is picked');
  await clearBtn.click();
  assert.equal(await pillText(page), 'None');
  assert.equal(await clearBtn.isVisible(), false);
  await page.fill('#session-prompt', 'no skill please');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.equal(sentProject, '');
  await context.close();
});

// QA case: a draft explicitly carrying project: '' (the user picked None,
// then typed and left before Start) must not be overridden by a DIFFERENT,
// stale LAST_PROJECT_KEY from an earlier session -- an `||`-based read would
// treat draft.project === '' as "missing" and wrongly fall through to it.
test('a draft that explicitly saved project: "" (None) is honored over a different, stale LAST_PROJECT_KEY', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript((key) => { window.localStorage.setItem(key, 'project-02'); }, 'gl-session-last-project-v1');
  await context.addInitScript(({ key, val }) => { window.localStorage.setItem(key, JSON.stringify(val)); },
    { key: 'gl-session-draft-v1', val: { prompt: 'left mid-thought', project: '', attachments: [] } });
  await routeProjects(context, projectNames(3));
  await routeRecent(context);
  const page = await newSessionPage(context);
  assert.equal(await pillText(page), 'None', 'the draft\'s explicit None must win over the different stale LAST_PROJECT_KEY value');
  await context.close();
});

test('zero skills discovered: pill shows "None" (never "undefined"), tray shows only the None row plus an informational empty state, and Start still enables with a prompt (None is a real, always-available choice)', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, []);
  await routeRecent(context);
  const page = await newSessionPage(context);
  const pillValue = await pillText(page);
  assert.equal(pillValue, 'None', 'zero DISCOVERED skills still defaults the pill to None, not a blank/undefined');
  await openTray(page);
  await assert.doesNotReject(page.locator('.tray-empty').waitFor({ state: 'visible', timeout: 2000 }), 'an informational empty state for the (empty) skill list');
  assert.equal(await page.locator('.tray-row').count(), 1, 'the None row is still there even with zero skills');
  await page.fill('#session-prompt', 'go nowhere');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled, undefined, { timeout: 2000 });
  await context.close();
});

test('projects-load failure with no cache: the error banner shows, the pill falls back to None, and Start is still enabled', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.route(`${API_BASE}/sessions/projects*`, (route) => route.fulfill({ status: 500, body: 'boom' }));
  await routeRecent(context);
  const page = await context.newPage();
  await page.goto(SESSION_URL);
  await page.waitForSelector('#gl-error:not(.gl-hidden)', { timeout: 5000 });
  assert.match(await page.locator('#gl-error-text').textContent(), /Couldn't load projects/);
  assert.equal(await pillText(page), 'None', 'a failed load with no cache must leave None selected, never blank or "undefined"');
  await page.fill('#session-prompt', 'trying anyway');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await context.close();
});

test('Start failure (server 400) stays in Recent as a persistent Failed row with the reason, the typed text, Retry and Discard', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unknown project' }) }));
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'this will fail');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('.gl-row-failed', { timeout: 5000 });
  const row = await page.locator('.gl-row-failed').textContent();
  assert.match(row, /this will fail/);
  assert.match(row, /unknown project/);
  assert.deepEqual(await page.locator('.gl-row-failed button').allTextContents(), ['Retry', 'Edit', 'Discard']);
  assert.equal(await page.locator('#session-confirmation').isHidden(), true);
  await context.close();
});

// Extends the test above to the attachment side, and to idempotencyKey
// behavior -- a genuine rejection is a DEAD attempt (fresh key next try),
// unlike a network failure (same key, see the "retried Start" test), because
// here we KNOW the box saw and refused the request.
//
// REINSTATE-BUG PROOF: reverting startSession()'s failure branch to this
// worktree's pre-change version (which never restores `attachments` from a
// snapshot, since attachments weren't cleared optimistically in the first
// place, and always mints via `starting` gating rather than resetting
// currentIdempotencyKey to null on rejection) makes the second and third
// assertions below fail: the thumbnail assertion because the old code never
// had an `attachmentsSnapshot` to restore (attachments were never touched
// until the success path), and the fresh-key assertion because the old code
// only reset the key inside the shared `starting=false` line, not
// distinctly per branch. Confirmed by temporarily restoring the pre-change
// startSession() (see the git diff captured for this task) and re-running
// this file; restored afterward.
test('a genuine 4xx rejection keeps the request (with its attachment) as a Failed row, and Retry sends it again under a fresh idempotencyKey (unlike a network failure)', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, []);
  const seen = [];
  let shouldFail = true;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    const body = JSON.parse(route.request().postData());
    seen.push(body);
    if (shouldFail) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unknown project' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: 'project-01' }) });
  });
  await context.route(`${API_BASE}/sessions/submissions/*/dismiss`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage('revert.png')]);
  await page.waitForSelector('.gl-thumb.done', { timeout: 5000 });
  await page.fill('#session-prompt', 'revert me please');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('.gl-row-failed', { timeout: 5000 });
  assert.equal(await page.locator('#session-confirmation').isHidden(), true, 'the optimistic confirmation must be hidden after a real rejection');
  assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k))[0].failed, START_QUEUE), 'unknown project', 'the request stays on disk');

  shouldFail = false;
  await page.click('.gl-row-failed button:has-text("Retry")');
  await waitFor(() => seen.length === 2, 'the retried start');
  assert.notEqual(seen[1].idempotencyKey, seen[0].idempotencyKey, 'the box replays its recorded answer per key -- a retry after an answer needs a fresh one');
  assert.deepEqual(seen[1].attachments, seen[0].attachments);
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  await context.close();
});

test('an unreachable box (network-level failure, not a server response) shows a distinct error and does NOT revert the optimistic clear -- unlike a genuine 4xx/5xx, we never know whether the box actually saw it', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) => route.abort('connectionrefused'));
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'box is down');
  await page.locator('#session-prompt').blur(); // keyboard down: Start skips the dictation settle wait and clears at the tap
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  // The optimistic clear runs synchronously inside startSession(), before
  // the fetch is even issued -- so it's already visible right after the
  // click, with no need to wait on the (aborted) network call.
  assert.equal(await page.inputValue('#session-prompt'), '', 'a network-level failure must NOT restore the typed prompt -- only a genuine server rejection reverts');
  assert.equal(await page.locator('#session-confirmation').isHidden(), false, 'the optimistic confirmation must keep showing through a network failure');
  await page.waitForSelector('#gl-error:not(.gl-hidden)', { timeout: 5000 });
  const errorText = await page.locator('#gl-error-text').textContent();
  assert.match(errorText, /Box unreachable/);
  await context.close();
});

// Proves the optimistic-commit contract itself, not just its downstream
// effects: the prompt clears and the confirmation shows BEFORE the network
// round-trip resolves, not after. Held via a route promise (same pattern as
// the deep-link/projects-race test below) so the assertions run while
// /sessions/start is provably still in flight -- checking AFTER the route
// unblocks would pass even against the old blocking code, since both old and
// new code show the confirmation once the response arrives.
//
// REINSTATE-BUG PROOF: reverting startSession() to this worktree's
// pre-change version (starting=true, button text "Starting…", clear/confirm
// moved into the .then() success handler) makes this test fail with a
// timeout waiting for '#session-confirmation:not(.gl-hidden)', because the
// old code never shows the confirmation until AFTER the held route resolves.
// Confirmed by temporarily restoring that version and re-running this file;
// restored afterward -- see the task report for the exact command run.
test('optimistic commit: the prompt clears and the confirmation shows BEFORE /sessions/start responds, not after', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  let releaseStart;
  const startHeld = new Promise((resolve) => { releaseStart = resolve; });
  await context.route(`${API_BASE}/sessions/start`, async (route) => {
    await startHeld;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: 'project-01' }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'optimistic please');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  // Assert immediately, WHILE the route above is still held (unresolved) --
  // if any of this required the response, it would time out right here.
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 2000 });
  assert.equal(await page.inputValue('#session-prompt'), '', 'the prompt must already be cleared before the network call resolves');
  assert.equal(await page.locator('.gl-thumb').count(), 0);
  releaseStart();
  await context.close();
});

test('a successful Start clears the draft and shows the confirmation', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'abc12345', name: 'do a thing', project: 'project-01' }) }));
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'this will succeed');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 5000 });
  assert.equal(await page.inputValue('#session-prompt'), '');
  await context.close();
});

test('a Start that hit a network failure is replayed with the SAME idempotencyKey (oldest first); a later Start mints a fresh one', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const seenKeys = [];
  let callCount = 0;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    callCount += 1;
    const body = JSON.parse(route.request().postData());
    seenKeys.push(body.idempotencyKey);
    if (callCount === 1) {
      route.abort('connectionrefused');
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'retry0001', name: 'retried', project: 'project-01' }) });
    }
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'retry me');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#gl-error:not(.gl-hidden)', { timeout: 5000 });
  // The failed request is saved; the 'online' event replays it by itself.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => seenKeys.length >= 2, 'the automatic replay of the failed Start');
  assert.equal(seenKeys[0], seenKeys[1], 'the automatic replay of a failed attempt must reuse its idempotencyKey');

  await page.fill('#session-prompt', 'a genuinely new attempt');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.equal(seenKeys.length, 3);
  assert.notEqual(seenKeys[2], seenKeys[0], 'a new Start attempt must mint a fresh idempotencyKey');
  await context.close();
});

test('the recent-sessions list groups like the agents view: Needs input, Working, Completed, Terminal, with summary and short age', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  const now = Date.now();
  await routeRecent(context, [
    { id: 'aaa11111', name: 'Fix the bug', summary: 'building the fix', project: 'p', state: 'working', kind: 'background', startedAt: now - 7200000, activityAt: now - 120000 },
    { id: 'bbb22222', name: 'Ship it', summary: 'approve Bash: rm -rf', project: 'p', state: 'blocked', kind: 'background', startedAt: now - 60000 },
    { id: 'ccc33333', name: 'Old done', summary: 'It is live', project: 'p', state: 'done', kind: 'background', startedAt: now - 3 * 86400000, activityAt: now - 2 * 86400000 },
    { id: 'ddd44444', name: 'New done', project: 'p', state: 'done', kind: 'background', startedAt: now - 7200000, activityAt: now - 3600000 },
    { id: 'eee55555', name: 'assistant-72', project: 'p', state: 'idle', kind: 'interactive', startedAt: now - 30000 },
  ]);
  // Ages are exact to the second, so the page's clock is pinned to `now`: a slow
  // full-suite run otherwise renders 31s for the 30s row.
  await context.addInitScript((t) => { Date.now = () => t; }, now);
  const page = await newSessionPage(context);
  await page.waitForSelector('.gl-recent-group');
  const groups = await page.$$eval('.gl-recent-group', (els) => els.map((g) => ({
    label: g.querySelector('.gl-recent-group-label').textContent,
    rows: Array.from(g.querySelectorAll('.gl-row')).map((r) => [
      r.querySelector('.gl-recent-glyph').textContent,
      r.querySelector('.gl-row-label').textContent,
      (r.querySelector('.gl-recent-summary') || { textContent: '' }).textContent,
      r.querySelector('.gl-recent-age').textContent,
    ]),
  })));
  assert.deepEqual(groups, [
    { label: 'Needs input', rows: [['✻', 'Ship it', 'approve Bash: rm -rf', '1m']] },
    { label: 'Working', rows: [['●', 'Fix the bug', 'building the fix', '2m']] },
    { label: 'Completed', rows: [['✻', 'New done', '', '1h'], ['✻', 'Old done', 'It is live', '2d']] },
    { label: 'Terminal', rows: [['·', 'assistant-72', '', '30s']] },
  ]);
  await context.close();
});

test("loadProjects()/loadRecent() clear a stale error banner on the NEXT successful load -- regression for the review round's clearError fix", async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  let recentShouldFail = true;
  await context.route(`${API_BASE}/sessions/recent*`, (route) => {
    if (recentShouldFail) return route.fulfill({ status: 401, body: 'unauthorized' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
  });
  await routeProjects(context);
  const page = await newSessionPage(context);
  await page.waitForSelector('#gl-error:not(.gl-hidden)', { timeout: 5000 });
  recentShouldFail = false;
  await page.click('#gl-refresh-btn');
  await page.waitForFunction(() => document.getElementById('gl-error').classList.contains('gl-hidden'), { timeout: 5000 });
  await context.close();
});

test('REGRESSION PROOF: without gl-bridge.js\'s per-call timeout option, a 6s-delayed voiceStop reply is dropped as a false "timeout"', async () => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(buildMockBridgeScript(baseConfig({
    voiceStop: { text: 'delayed transcript' },
  })));
  await context.addInitScript((cfg) => {
    window.__glMock ? window.__glMock.configure(cfg) : (window.__pendingMockConfig = cfg);
  }, { delays: { voiceStop: 6000 } });
  await routeProjects(context);
  await routeRecent(context);
  const page = await newSessionPage(context);
  await page.evaluate(() => window.__glMock.configure({ delays: { voiceStop: 6000 } }));
  await page.click('#session-record-btn'); // start
  await page.waitForSelector('#session-record-btn.recording');
  const t0 = Date.now();
  // A tap-stop now auto-sends, so reach the insert path (which fills the prompt) with the real gesture: hold + Insert.
  await stopViaInsert(page); // -> voiceStop, delayed 6s by the mock
  await page.waitForFunction(
    () => document.getElementById('session-prompt').value.indexOf('delayed transcript') !== -1,
    { timeout: 15000 }
  );
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs >= 5900, `expected the reply to actually wait out the 6s mock delay (took ${elapsedMs}ms)`);
  assert.equal(await page.locator('#gl-error').isHidden(), true, 'no timeout error should have fired');
  await context.close();
});

// --- attachments (screenshots) -------------------------------------------

test('attaching 2 images uploads both, thumbnails show, and Start body carries both returned ids', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const uploadCalls = [];
  await routeUpload(context, uploadCalls);
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage('a.png'), fakeImage('b.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb.done').length === 2, { timeout: 5000 });
  assert.equal(uploadCalls.length, 2, 'each picked image uploads independently');
  // Screenshot-only start: no prompt text typed.
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  // Order-sensitive (deepEqual on the ARRAY, not a Set) -- see idForBuffer's
  // header comment: a prior version of this assertion compared as Sets,
  // which can't tell "correct pick order" apart from "silently reversed".
  // Mutation: swap attachIdsForStart()'s .map/.filter for something that
  // reorders (e.g. sort by id string) -> this fails.
  assert.deepEqual(startBody.attachments, ['id-a.png', 'id-b.png']);
  // The page sends the prompt EXACTLY as typed (empty here) -- the "See the
  // attached screenshot(s)." fallback text is server-side only (see
  // lib/sessions.mjs's startSession), so there's a single source of truth
  // for it rather than the client guessing at the server's wording.
  assert.equal(startBody.prompt, '');
  await context.close();
});

// Mutations P17/P18: swap the Authorization header source (e.g. hardcode a
// wrong token) or send a re-encoded/mangled copy of the file instead of the
// real File object -> this fails on the auth or the byte-equality assertion
// respectively.
test('the upload request carries the Bearer token and the EXACT picked file bytes, unmodified', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const uploadCalls = [];
  await routeUpload(context, uploadCalls);
  const picked = fakeImage('exact-bytes.png');
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [picked]);
  await page.waitForSelector('.gl-thumb.done');
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].auth, 'Bearer test-token', 'the upload POST must carry the same Bearer token authedFetch attaches everywhere else');
  assert.deepEqual(uploadCalls[0].buffer, picked.buffer, 'the server must receive the exact bytes of the picked file, not a re-encoded or truncated copy');
  await context.close();
});

// Mutation P16: drop `attachInput.value = ''` from the change handler ->
// this fails (a second setInputFiles with the SAME path wouldn't even fire
// a 'change' event in a real browser once the input's value already equals
// it, but the assertion here is on the input's OWN state right after a
// pick, which is the thing that has to be true for a repick to work at all).
test('the file input is cleared immediately after a pick (attachInput.value === \'\'), so picking the same file again still fires a change event', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, []);
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage('reset-check.png')]);
  await page.waitForSelector('.gl-thumb.done');
  const inputValue = await page.locator('#session-attach-input').inputValue();
  assert.equal(inputValue, '', 'the <input type=file> must be reset to empty right after handling a pick');
  await context.close();
});

// Mutation P21: comment out the `attachments = []; renderAttachments();`
// lines in startSession's success handler -> this fails (thumbnails and
// their ids would still be showing/sendable after a successful Start, which
// would silently re-attach an already-used screenshot to whatever session
// gets started next).
test('a successful Start clears every thumbnail and attachment (not just the prompt/draft)', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, []);
  await context.route(`${API_BASE}/sessions/start`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: 'project-01' }) }));
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage('a.png'), fakeImage('b.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb.done').length === 2, { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 5000 });
  assert.equal(await page.locator('.gl-thumb').count(), 0, 'every thumbnail must be gone after a successful Start');
  // Start a SECOND time (Add screenshot is re-enabled with 0 attachments) --
  // if the old attachments object were still referenced anywhere, this would
  // either throw or silently resurrect a stale entry.
  await page.fill('#session-prompt', 'a second, unrelated session');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await context.close();
});

test('a failed upload shows a visible failed state and keeps Start disabled/unusable for that attachment; removing it clears the failure', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, [], { fail: true });
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage()]);
  await page.waitForSelector('.gl-thumb.failed', { timeout: 5000 });
  // No prompt text and the only attachment failed -> nothing startable yet.
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#session-start-btn').isDisabled(), true);
  await page.click('.gl-thumb-remove');
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb').length === 0);
  await context.close();
});

test('retrying a failed upload succeeds and its id then appears in the Start body', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  let attempt = 0;
  await context.route(`${API_BASE}/sessions/upload`, (route) => {
    attempt += 1;
    if (attempt === 1) return route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'retried.png' }) });
  });
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage()]);
  await page.waitForSelector('.gl-thumb.failed', { timeout: 5000 });
  await page.click('.gl-thumb-status'); // tap-to-retry overlay
  await page.waitForSelector('.gl-thumb.done', { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  // The confirmation now appears optimistically on click, before the POST
  // resolves -- wait for the actual response so `startBody` (set inside the
  // route handler) is guaranteed populated before we read it.
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 5000 });
  assert.deepEqual(startBody.attachments, ['retried.png']);
  await context.close();
});

test('removing an in-flight (uploading) thumbnail works immediately, and the late-finishing upload does not resurrect it or add its id', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const uploadCalls = [];
  await routeUpload(context, uploadCalls, { delayMs: 1500 });
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'text content so Start can enable once the upload clears');
  await page.setInputFiles('#session-attach-input', [fakeImage()]);
  await page.waitForSelector('.gl-thumb.uploading');
  // Start stays enabled while the upload is in flight.
  assert.equal(await page.locator('#session-start-btn').isDisabled(), false);
  await page.click('.gl-thumb-remove'); // removes it BEFORE the delayed upload resolves
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb').length === 0);
  // No other upload pending -> Start re-enables (there's prompt text).
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled, { timeout: 5000 });
  // Let the delayed mock route actually resolve in the background.
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('.gl-thumb').count(), 0, 'the late-finishing upload must not resurrect a removed thumbnail');
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.deepEqual(startBody.attachments, [], 'the removed-while-uploading attachment\'s id must never reach Start\'s body');
  await context.close();
});

test('the 5-image cap disables Add once reached, and picking more than the remaining room attaches up to the cap with a visible (never silent) message', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, []);
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage('1.png'), fakeImage('2.png'), fakeImage('3.png'), fakeImage('4.png'), fakeImage('5.png'), fakeImage('6.png'), fakeImage('7.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb').length === 5, { timeout: 5000 });
  assert.equal(await page.locator('#session-attach-btn').isDisabled(), true);
  await page.waitForSelector('#gl-error:not(.gl-hidden)', { timeout: 5000 });
  const errorText = await page.locator('#gl-error-text').textContent();
  assert.match(errorText, /2 skipped/);
  await context.close();
});

test('removing a thumbnail drops its id from the Start body', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, []);
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'has attachments then removes one');
  await page.setInputFiles('#session-attach-input', [fakeImage('a.png'), fakeImage('b.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb.done').length === 2, { timeout: 5000 });
  await page.locator('.gl-thumb-remove').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb').length === 1);
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.equal(startBody.attachments.length, 1, 'only the NOT-removed attachment\'s id reaches Start');
  await context.close();
});

test('draft restore: reloading with a saved prompt/project/attachment restores all three, fetches the restored attachment\'s thumbnail (authed), and never re-uploads it', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript(({ key, val }) => { window.localStorage.setItem(key, JSON.stringify(val)); },
    { key: 'gl-session-draft-v1', val: { prompt: 'restored draft text', project: 'project-04', attachments: ['restored-id.png'] } });
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  const uploadCalls = [];
  await routeUpload(context, uploadCalls);
  let thumbnailAuth = null;
  await context.route(`${API_BASE}/sessions/upload/restored-id.png`, (route) => {
    thumbnailAuth = route.request().headers()['authorization'];
    return route.fulfill({ status: 200, contentType: 'image/png', body: REAL_PNG });
  });
  const page = await newSessionPage(context);
  assert.equal(await page.inputValue('#session-prompt'), 'restored draft text');
  assert.equal(await pillText(page), 'project-04', 'remembered project selection survives reload');
  await page.waitForSelector('.gl-thumb.done img', { timeout: 5000 }); // the fetched-thumbnail <img>, not just the placeholder
  assert.equal(thumbnailAuth, 'Bearer test-token', 'the thumbnail GET must carry the Bearer token (an <img src> alone could not)');
  assert.equal(uploadCalls.length, 0, 'a restored attachment must not re-upload -- it already has a server id');
  await context.close();
});

test('window.addAttachments(ids): valid ids are added (thumbnail fetched, id in Start body), invalid ids are dropped, and the 5-cap + skip message apply the same as manual picks', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/upload/*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: REAL_PNG }));
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await newSessionPage(context);
  const validId = '11111111-1111-1111-1111-111111111111.png';
  await page.evaluate((id) => window.addAttachments([
    id,
    '../../../etc/passwd', // traversal text -- not even a well-formed id
    'not-a-uuid.png', // malformed
    '22222222-2222-2222-2222-222222222222.exe', // disallowed extension
  ]), validId);
  await page.waitForSelector('.gl-thumb.done img', { timeout: 5000 });
  assert.equal(await page.locator('.gl-thumb').count(), 1, 'only the ONE valid id should have been added');
  await page.fill('#session-prompt', 'from a deep link');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  // As above: the confirmation shows optimistically before the POST
  // resolves, so synchronize on the actual response before reading
  // `startBody` (set inside the route handler).
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 5000 });
  assert.deepEqual(startBody.attachments, [validId]);
  await context.close();
});

test('window.addAttachments respects the 5-image cap and shows the skip message like a manual pick would', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/upload/*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: REAL_PNG }));
  const page = await newSessionPage(context);
  const ids = Array.from({ length: 7 }, (_, i) => `${String(i).repeat(8)}-1111-1111-1111-111111111111.png`);
  await page.evaluate((ids) => window.addAttachments(ids), ids);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb').length === 5, { timeout: 5000 });
  await page.waitForSelector('#gl-error:not(.gl-hidden)', { timeout: 5000 });
  assert.match(await page.locator('#gl-error-text').textContent(), /2 skipped/);
  await context.close();
});

// Mutation: drop the `existingIds.indexOf(id) === -1` clause from
// window.addAttachments' filter -> this fails on BOTH assertions (2
// thumbnails / 2 ids in the Start body instead of 1) -- native can call
// addAttachments again for the SAME deep link after a page reload mid-flow,
// and a draft restore may already have added an id before native's call
// runs; either way the same server id must never become two thumbnails or
// appear twice in one Start request.
test('window.addAttachments ignores ids already present -- called twice with the same id, and once more after a draft restore already added it -- ends up as ONE thumbnail with the id ONCE in the Start body', async () => {
  const validId = 'dddddddd-dddd-dddd-dddd-dddddddddddd.png';
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript(({ key, val }) => { window.localStorage.setItem(key, JSON.stringify(val)); },
    { key: 'gl-session-draft-v1', val: { prompt: '', project: 'project-01', attachments: [validId] } });
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/upload/*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: REAL_PNG }));
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await newSessionPage(context);
  // The draft restore above already added `validId` as a `done` attachment
  // before this page even finished loading -- confirm that first, so the
  // addAttachments calls below are provably deduping against a
  // PRE-EXISTING entry, not against each other only.
  await page.waitForSelector('.gl-thumb.done');
  assert.equal(await page.locator('.gl-thumb').count(), 1);
  // Native calling addAttachments AGAIN for the same deep link id (page
  // reload mid-flow) -- twice, for good measure.
  await page.evaluate((id) => window.addAttachments([id]), validId);
  await page.evaluate((id) => window.addAttachments([id]), validId);
  await page.waitForTimeout(200); // let any (wrongly) duplicated adds settle
  assert.equal(await page.locator('.gl-thumb').count(), 1, 'still exactly one thumbnail despite three total addAttachments-equivalent calls for the same id');
  await page.fill('#session-prompt', 'dedupe check');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.deepEqual(startBody.attachments, [validId], 'the id must appear exactly ONCE in the Start body');
  await context.close();
});

// The real share-sheet cold launch (seen on device 2026-09-14): native runs
// window.addAttachments at didFinishNavigation, BEFORE /sessions/projects has
// answered. addAttachments saves the draft with the id, then the projects
// response arrives and the draft restore adds that same id again. The test
// above only covers the opposite order (restore first, then addAttachments).
test('a deep-link id added before the projects list loads is not duplicated by the draft restore that follows', async () => {
  const validId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jpg';
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  let releaseProjects;
  const projectsHeld = new Promise((resolve) => { releaseProjects = resolve; });
  await context.route(`${API_BASE}/sessions/projects*`, async (route) => {
    await projectsHeld;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: projectNames(7) }) });
  });
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/upload/*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: REAL_PNG }));
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await context.newPage();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => typeof window.addAttachments === 'function');
  assert.equal(await page.evaluate(() => document.getElementById('session-project-pill').dataset.ready), undefined,
    'sanity: the projects list must still be pending when native adds the attachment');
  await page.evaluate((id) => window.addAttachments([id]), validId);
  releaseProjects();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.gl-thumb').count(), 1, 'the shared image must show as ONE thumbnail');
  await page.fill('#session-prompt', 'share sheet order');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.deepEqual(startBody.attachments, [validId], 'the id must appear exactly ONCE in the Start body');
  await context.close();
});

// Start is never disabled by an upload in flight: the attachment rides along
// in the queued Start, which awaits that SAME upload (one POST, not two).
// Reinstating `|| anyUploadInFlight()` in updateStartEnabled (and the early
// return in startSession) makes this fail at the isDisabled() assertion.
test('Start stays enabled while an upload is in flight; tapping it queues a Start that completes after the upload resolves, with exactly ONE upload', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const uploadCalls = [];
  await routeUpload(context, uploadCalls, { delayMs: 1500 });
  const startBodies = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBodies.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: 'project-01' }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'plenty of prompt text right here');
  await page.setInputFiles('#session-attach-input', [fakeImage('slow.png')]);
  await page.waitForSelector('.gl-thumb.uploading');
  assert.equal(await page.locator('#session-start-btn').isDisabled(), false, 'Start must be enabled while the upload is still in flight');
  await page.click('#session-start-btn');
  await page.waitForFunction((k) => (JSON.parse(localStorage.getItem(k) || '[]')[0] || {}).pending?.length === 1, START_QUEUE);
  assert.equal(startBodies.length, 0, 'the Start must wait for the upload');
  await waitFor(() => startBodies.length === 1, 'the queued start');
  await drained(page, START_QUEUE);
  await page.waitForTimeout(300);
  assert.equal(uploadCalls.length, 1, 'exactly one POST /sessions/upload for that image');
  assert.deepEqual(startBodies[0].attachments, ['id-slow.png']);
  await context.close();
});

test('Start tapped while an upload is failing at the network level: the Start waits, then goes out once the box answers, still with one successful upload', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  let online = false;
  let uploadOk = 0;
  const startBodies = [];
  await context.route(`${API_BASE}/sessions/upload`, async (route) => {
    if (!online) { await new Promise((r) => setTimeout(r, 400)); return route.abort('connectionrefused'); }
    uploadOk++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'later.png' }) });
  });
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBodies.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: 'project-01' }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'flaky signal');
  await page.setInputFiles('#session-attach-input', [fakeImage('flaky.png')]);
  await page.waitForSelector('.gl-thumb.uploading');
  await page.click('#session-start-btn');
  await page.waitForFunction((k) => (JSON.parse(localStorage.getItem(k) || '[]')[0] || {}).pending?.length === 1, START_QUEUE);
  await page.waitForTimeout(800);
  assert.equal(startBodies.length, 0, 'nothing is started while the upload cannot reach the box');
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => startBodies.length === 1, 'the queued start');
  await drained(page, START_QUEUE);
  assert.equal(uploadOk, 1);
  assert.deepEqual(startBodies[0].attachments, ['later.png']);
  await context.close();
});

test('window.addAttachmentFiles (native share handoff) adds a thumbnail and uploads the decoded bytes', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const uploadCalls = [];
  await routeUpload(context, uploadCalls);
  const page = await newSessionPage(context);
  const img = fakeImage('shared.png');
  await page.evaluate((b64) => window.addAttachmentFiles([{ type: 'image/png', data: b64 }]), img.buffer.toString('base64'));
  await page.waitForSelector('.gl-thumb.done', { timeout: 5000 });
  assert.equal(uploadCalls.length, 1);
  assert.deepEqual(uploadCalls[0].buffer, img.buffer, 'the uploaded bytes must equal the decoded base64');
  assert.equal(await page.locator('#session-start-btn').isDisabled(), false, 'an attachment alone is startable');
  await context.close();
});

test('window.addAttachmentFiles respects the 5-image cap with the visible "skipped" message', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, []);
  const page = await newSessionPage(context);
  const b64 = fakeImage('x.png').buffer.toString('base64');
  await page.evaluate((d) => window.addAttachmentFiles(Array.from({ length: 7 }, () => ({ type: 'image/jpeg', data: d }))), b64);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb').length === 5);
  assert.match(await page.locator('#gl-error-text').textContent(), /2 skipped/);
  await context.close();
});

test('an in-flight (not-yet-done) attachment is never persisted to the draft, so a reload mid-upload restores nothing for it', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  // Long enough to still be "in flight" for every assertion this test makes,
  // short enough not to hold up the suite's own process exit waiting on the
  // pending route's setTimeout after context.close().
  await routeUpload(context, [], { delayMs: 3000 });
  const page = await newSessionPage(context);
  await page.setInputFiles('#session-attach-input', [fakeImage()]);
  await page.waitForSelector('.gl-thumb.uploading');
  // MUTATION-PROOF FIX (was VACUOUS): typing the prompt BEFORE picking the
  // file (the previous version of this test) means the localStorage draft
  // examined afterward could just be leftover from THAT fill's own
  // saveDraft() call -- picking a file never itself calls saveDraft(), so
  // the assertion below would pass identically whether or not the
  // in-flight-exclusion logic works at all. Typing AFTER the pick forces a
  // FRESH saveDraft() call while the upload is still 'uploading', which is
  // the only way this test can actually distinguish "excluded on purpose"
  // from "never had the chance to be included".
  await page.fill('#session-prompt', 'draft check, written mid-upload');
  const draft = await page.evaluate(() => JSON.parse(window.localStorage.getItem('gl-session-draft-v1') || 'null'));
  assert.equal(draft.prompt, 'draft check, written mid-upload', 'sanity: this saveDraft() call must be the one from the fill above, not a stale one');
  assert.deepEqual(draft.attachments, [], 'saveDraft only ever persists DONE attachment ids, never one still uploading');
  assert.equal(draft.pendingLocalIds.length, 1, 'the uploading attachment persists by local id so a reload restores it from IndexedDB');
  await context.close();
});

test('picking the same photo twice creates two independent attachments -- each its own upload/id, and removing one never affects the other', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const uploadCalls = [];
  await routeUpload(context, uploadCalls);
  let startBody = null;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBody = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: startBody.project }) });
  });
  const page = await newSessionPage(context);
  // Two picks of the exact same file/name, in two separate change events
  // (mirrors picking, then picking again) -- each must upload and get its
  // own id independently.
  await page.setInputFiles('#session-attach-input', [fakeImage('same.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb.done').length === 1);
  await page.setInputFiles('#session-attach-input', [fakeImage('same.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb.done').length === 2);
  assert.equal(uploadCalls.length, 2);
  // Remove the first thumbnail; the second must survive untouched.
  await page.locator('.gl-thumb-remove').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb').length === 1);
  assert.equal(await page.locator('.gl-thumb.done').count(), 1, 'the remaining attachment must still be intact');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/sessions/start')),
    page.click('#session-start-btn'),
  ]);
  assert.equal(startBody.attachments.length, 1, 'only the surviving attachment\'s id reaches Start');
  await context.close();
});

// --- composer icon buttons (mic + screenshot docked in the textarea) -----

test('the mic and screenshot buttons are icon buttons with the required aria-labels, and trigger the right actions', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const page = await newSessionPage(context);

  assert.equal(await page.locator('#session-attach-btn').getAttribute('aria-label'), 'Add screenshot');
  assert.equal(await page.locator('#session-record-btn').getAttribute('aria-label'), 'Dictate');

  // Tapping the screenshot icon must open the file picker -- the hidden
  // #session-attach-input, unchanged behind the icon.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#session-attach-btn'),
  ]);
  assert.ok(chooser, 'clicking the screenshot icon must trigger the file input');

  // Tapping the mic icon must call the bridge's voiceStart (same as the old
  // full-width mic button) and flip aria-pressed/the recording class.
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  assert.equal(await page.locator('#session-record-btn').getAttribute('aria-pressed'), 'true');
  const calls = await page.evaluate(() => window.__glCallLog.map((c) => c.method));
  assert.ok(calls.includes('voiceStart'), 'clicking the mic icon must call the voiceStart bridge method');
  await context.close();
});

async function pendingVoiceStartPage() {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript({ ...baseConfig(), neverReply: ['voiceStart'] }));
  await routeProjects(context);
  await routeRecent(context);
  const page = await newSessionPage(context);
  return { context, page };
}
const bridgeCalls = (page, method) =>
  page.evaluate((m) => window.__glCallLog.filter((c) => c.method === m).length, method);

test('while voiceStart is pending the mic shows "Starting mic…" and is NOT in the recording state', async () => {
  const { context, page } = await pendingVoiceStartPage();
  await page.click('#session-record-btn');
  await page.waitForFunction(() => document.getElementById('session-record-status').textContent === 'Starting mic…');
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording')), false);
  assert.equal(await page.locator('#session-record-btn').getAttribute('aria-pressed'), 'false');
  await context.close();
});

test('once voiceStart resolves the mic flips to recording with "Speak now"', async () => {
  const { context, page } = await pendingVoiceStartPage();
  await page.click('#session-record-btn');
  await page.waitForFunction(() => document.getElementById('session-record-status').textContent === 'Starting mic…');
  await page.evaluate(() => window.__glMock.replyNow('voiceStart', {}));
  await page.waitForSelector('#session-record-btn.recording');
  assert.equal(await page.locator('#session-record-status').textContent(), 'Speak now');
  assert.equal(await page.locator('#session-record-btn').getAttribute('aria-pressed'), 'true');
  await context.close();
});

test('a tap (or startVoiceMode) while voiceStart is pending issues no second voiceStart and no voiceStop', async () => {
  const { context, page } = await pendingVoiceStartPage();
  await page.click('#session-record-btn');
  await page.waitForFunction(() => document.getElementById('session-record-status').textContent === 'Starting mic…');
  await page.click('#session-record-btn');
  await page.evaluate(() => window.startVoiceMode());
  await page.waitForTimeout(200);
  assert.equal(await bridgeCalls(page, 'voiceStart'), 1);
  assert.equal(await bridgeCalls(page, 'voiceStop'), 0);
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording')), false);
  // The pending start still lands normally afterwards.
  await page.evaluate(() => window.__glMock.replyNow('voiceStart', {}));
  await page.waitForSelector('#session-record-btn.recording');
  await context.close();
});

test('the mic button visibly loses its recording state (class + aria-pressed) once stopped', async () => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const page = await newSessionPage(context);
  await page.click('#session-record-btn'); // start
  await page.waitForSelector('#session-record-btn.recording');
  await stopViaInsert(page); // tap would auto-send; hold-drag inserts
  await page.waitForFunction(() => document.getElementById('session-prompt').value.indexOf('a fake voice transcript') !== -1);
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording')), false);
  assert.equal(await page.locator('#session-record-btn').getAttribute('aria-pressed'), 'false');
  await context.close();
});

// --- voice stop: tap = auto-send, long-press + drag onto Insert = insert ----

async function slidePage(startBodies, { holdProjects = false } = {}) {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  if (holdProjects) {
    // Projects never load, so selectedProject stays null (nothing chosen yet).
    await context.route(`${API_BASE}/sessions/projects*`, () => {});
  } else {
    await routeProjects(context);
  }
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    startBodies.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 's1', name: 'new-session', project: 'project-01' }) });
  });
  let page;
  if (holdProjects) {
    page = await context.newPage();
    await page.goto(SESSION_URL);
    await page.waitForSelector('#session-record-btn');
  } else {
    page = await newSessionPage(context);
  }
  await page.fill('#session-prompt', 'typed words');
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  return { context, page };
}

/** Long-presses a mic ('session' = launcher, 'detail' = reply row) while recording; returns touch helpers and the target centres. */
async function holdMic(page, mic = 'session') {
  const box = await page.locator(`#${mic}-record-btn`).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pt) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pt ? [{ x: pt.x, y: pt.y }] : [] });
  await touch('touchStart', from);
  await page.waitForSelector(`#${mic}-hold-targets:not([hidden])`);
  const t = await page.locator(`#${mic}-insert-target`).boundingBox();
  const c = await page.locator(`#${mic}-cancel-target`).boundingBox();
  return { touch, from, target: { x: t.x + t.width / 2, y: t.y + t.height / 2 }, cancel: { x: c.x + c.width / 2, y: c.y + c.height / 2 } };
}

/** Stops a recording the "insert only" way: long-press the mic, drag onto Insert, release. */
async function stopViaInsert(page) {
  const { touch, target } = await holdMic(page);
  await touch('touchMove', target);
  await page.waitForSelector('#session-insert-target.armed');
  await touch('touchEnd');
}

test('tap-stop with a project selected stops and auto-sends: composer cleared at once, /sessions/start called once with typed + spoken text', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.click('#session-record-btn'); // stop
  await page.waitForFunction(() => document.getElementById('session-prompt').value === '');
  await waitFor(() => bodies.length === 1, 'the auto-started session');
  assert.equal(bodies[0].prompt, 'typed words a fake voice transcript');
  assert.equal(await page.inputValue('#session-prompt'), '', 'composer must be free for the next session');
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording')), false);
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 1, 'started exactly once');
  await context.close();
});

test('long press shows Insert below the mic; releasing on it stops and INSERTS the transcript, starting nothing', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await stopViaInsert(page);
  await page.waitForFunction(() => document.getElementById('session-prompt').value === 'typed words a fake voice transcript');
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording')), false);
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 0, 'insert must not start a session');
  await context.close();
});

test('long press shows Cancel beside Insert; releasing on it discards the recording: no transcription, composer untouched, nothing started', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  const { touch, cancel } = await holdMic(page);
  await touch('touchMove', cancel);
  await page.waitForSelector('#session-cancel-target.armed');
  assert.equal(await page.locator('#session-insert-target').evaluate((el) => el.classList.contains('armed')), false, 'only Cancel is armed');
  await touch('touchEnd');
  await page.waitForSelector('#session-hold-targets', { state: 'hidden' });
  await page.waitForFunction(() => window.__glCallLog.some((c) => c.method === 'voiceCancel'));
  assert.equal((await callsTo(page, 'voiceStop')).length, 0, 'cancel must not transcribe');
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording')), false);
  assert.equal(await page.inputValue('#session-prompt'), 'typed words', 'composer keeps the typed draft');
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 0);
  await context.close();
});

test('tap-stop with no project selected falls back to inserting the transcript', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies, { holdProjects: true });
  await page.click('#session-record-btn'); // stop
  await page.waitForFunction(() => document.getElementById('session-prompt').value === 'typed words a fake voice transcript');
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 0);
  await context.close();
});

test('releasing the long press elsewhere dismisses Insert and does NOT stop or start anything', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  const { touch } = await holdMic(page);
  await touch('touchEnd');
  await page.waitForSelector('#session-hold-targets', { state: 'hidden' });
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording')), true, 'still recording');
  assert.equal(bodies.length, 0);
  await context.close();
});

test('tap-stop auto-send: a failed transcription leaves a Failed row holding the typed text and starts nothing', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.evaluate(() => window.__glMock.configure({ responses: { voiceStop: { code: 'empty_transcript' } } }));
  await page.click('#session-record-btn'); // stop
  await page.waitForSelector('.gl-row-failed');
  assert.match(await page.locator('.gl-row-failed').textContent(), /typed words/);
  assert.match(await page.locator('.gl-row-failed').textContent(), /Didn't catch anything/);
  assert.equal(await page.inputValue('#session-prompt'), '');
  assert.equal(bodies.length, 0);
  await context.close();
});

// REGRESSION 2026-10-24: a tap-stop whose upload missed its first flush
// (native answers "queued", e.g. right after the app resumes) used to put the
// typed text back and later merely INSERT the late transcript -- the dictated
// prompt sat unsent. A tap-stop means send, however late the transcript is.
test('tap-stop auto-send survives a "queued" stop: the late transcript from voicePending starts the session once, composer untouched', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.evaluate(() => window.__glMock.configure({ responses: { voiceStop: { code: 'queued', id: 'v9' }, voicePending: { ready: [], failed: [], pending: [], waiting: 1 } } }));
  await page.click('#session-record-btn'); // stop
  await page.waitForFunction(() => /transcribes when the box is reachable/.test(document.getElementById('session-record-status').textContent));
  assert.equal(await page.inputValue('#session-prompt'), '', 'typed text stays with the pending send, not back in the composer');
  assert.equal(await page.locator('#gl-error').evaluate((el) => el.classList.contains('gl-hidden')), true, 'a queued recording is not an error');
  assert.equal(bodies.length, 0);
  await page.evaluate(() => window.__glMock.configure({ responses: { voicePending: { ready: [{ id: 'v9', text: 'late transcript' }], failed: [], pending: [], waiting: 0 } } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => bodies.length === 1, 'the late auto-started session');
  assert.equal(bodies[0].prompt, 'typed words late transcript');
  assert.equal(await page.inputValue('#session-prompt'), '');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 1, 'started exactly once');
  await context.close();
});

// --- composer geometry: icons never overlap typed text --------------------

/**
 * REGRESSION for the real 2026-09-13 bug: a scrolled textarea's padding box
 * IS its scrollport, so reserving room for the icons via the TEXTAREA's own
 * padding-bottom only ever worked at scrollTop=0 -- scroll it (a long
 * prompt) and text renders straight through underneath the icons, because
 * padding on a scrolled element scrolls away with the content instead of
 * staying pinned to the element's visual bottom edge. The fix moves the
 * icons out of the textarea entirely into the WRAPPER's own (non-scrolling)
 * padding-bottom band, so this test checks the thing that actually matters:
 * the textarea element's own bounding box (which never moves on scroll --
 * only its CONTENT does) must never intersect either icon's box, at ANY
 * scroll position. Unlike the old padding-arithmetic version, this can't be
 * satisfied by an unscrolled textarea alone; it's checked at 0, a middle
 * position, and (critically) scrolled all the way to the bottom.
 */
function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

test('the textarea box never intersects the docked icons at any scroll position (40-line prompt, scrolled to several positions including the bottom)', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const page = await newSessionPage(context);
  await page.setViewportSize({ width: 390, height: 844 });
  const longText = Array.from({ length: 40 }, (_, i) => `Line ${i} of a task description long enough to force real scrolling.`).join('\n');
  await page.fill('#session-prompt', longText);

  const maxScrollTop = await page.locator('#session-prompt').evaluate((el) => el.scrollHeight - el.clientHeight);
  assert.ok(maxScrollTop > 50, `sanity: 40 lines must actually overflow the textarea's fixed height (got scrollable range ${maxScrollTop}px)`);

  for (const scrollTop of [0, 100, 200, maxScrollTop]) {
    await page.locator('#session-prompt').evaluate((el, top) => { el.scrollTop = top; }, scrollTop);
    const geometry = await page.evaluate(() => {
      var taRect = document.getElementById('session-prompt').getBoundingClientRect().toJSON();
      var icons = Array.from(document.querySelectorAll('.gl-composer-icons .gl-icon-btn')).map(function (el) {
        return el.getBoundingClientRect().toJSON();
      });
      return { taRect: taRect, icons: icons };
    });
    assert.equal(geometry.icons.length, 2, 'expected exactly 2 docked icon buttons');
    geometry.icons.forEach((iconRect) => {
      assert.equal(
        rectsIntersect(geometry.taRect, iconRect), false,
        `at scrollTop=${scrollTop}: textarea box (${JSON.stringify(geometry.taRect)}) must not intersect icon box (${JSON.stringify(iconRect)})`
      );
    });
  }
  await context.close();
});

// --- no horizontal overflow at phone width --------------------------------

test('no horizontal overflow at 390px width with the project tray open', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(10));
  await routeRecent(context);
  const page = await newSessionPage(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await openTray(page);
  const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflowsX, false, 'the page must not scroll horizontally at 390px with the tray open');
  await context.close();
});

test('no horizontal overflow at 390px width with 5 thumbnails attached', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await routeUpload(context, []);
  const page = await newSessionPage(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setInputFiles('#session-attach-input', [fakeImage('1.png'), fakeImage('2.png'), fakeImage('3.png'), fakeImage('4.png'), fakeImage('5.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-thumb.done').length === 5, { timeout: 5000 });
  const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflowsX, false, 'the page must not scroll horizontally at 390px with 5 thumbnails attached');
  await context.close();
});

test('the Model picker defaults to Opus', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(7));
  await routeRecent(context);
  const page = await newSessionPage(context);
  assert.equal(await page.locator('#session-model-select').inputValue(), 'opus');
  await context.close();
});

// --- skill auto-detect (POST /sessions/suggest-skill) ----------------------

/** Routes POST /sessions/suggest-skill; `respond(prompt)` returns a skill name/null (or a promise of one). Returns the recorded prompts. */
async function routeSuggest(context, respond) {
  const prompts = [];
  await context.route(`${API_BASE}/sessions/suggest-skill`, async (route) => {
    const prompt = JSON.parse(route.request().postData()).prompt;
    prompts.push(prompt);
    const skill = await respond(prompt);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skill }) });
  });
  return prompts;
}

async function autoPage(respond) {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const prompts = await routeSuggest(context, respond);
  const page = await newSessionPage(context);
  return { context, page, prompts };
}

const autoTagVisible = (page) => page.locator('#session-project-pill-auto').isVisible();
const waitPill = (page, text) => page.waitForFunction((t) => document.getElementById('session-project-pill-value').textContent === t, text);

test('typing a prompt: after the debounce the pill shows the detected skill with an "auto" tag and an auto-detected aria-label; LAST_PROJECT_KEY is untouched', async () => {
  const { context, page, prompts } = await autoPage(() => 'project-05');
  assert.equal(await autoTagVisible(page), false, 'no tag before any detection');
  await page.fill('#session-prompt', 'make the project five thing bigger');
  assert.equal(prompts.length, 0, 'nothing is sent before the debounce elapses');
  await waitPill(page, 'project-05');
  assert.equal(await autoTagVisible(page), true);
  assert.match(await page.locator('#session-project-pill').getAttribute('aria-label'), /auto-detected/);
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-last-project-v1')), null);
  await context.close();
});

test('a manual tray pick stops later auto changes for the draft, and a manual pick after an auto one drops the tag', async () => {
  const { context, page, prompts } = await autoPage(() => 'project-05');
  await page.fill('#session-prompt', 'make the project five thing bigger');
  await waitPill(page, 'project-05');
  await openTray(page);
  await trayRowLocator(page, 'project-02').click();
  assert.equal(await pillText(page), 'project-02');
  assert.equal(await autoTagVisible(page), false);
  await page.fill('#session-prompt', 'a completely different request now');
  await page.waitForTimeout(1800);
  assert.equal(prompts.length, 1, 'no further suggest request once manual');
  assert.equal(await pillText(page), 'project-02');
  await context.close();
});

test('clearing an auto-detected skill counts as a manual pick: the tag goes and detection does not re-apply', async () => {
  const { context, page, prompts } = await autoPage(() => 'project-05');
  await page.fill('#session-prompt', 'make the project five thing bigger');
  await waitPill(page, 'project-05');
  await page.click('#session-project-clear');
  assert.equal(await pillText(page), 'None');
  assert.equal(await autoTagVisible(page), false);
  await page.fill('#session-prompt', 'make the project five thing even bigger');
  await page.waitForTimeout(1800);
  assert.equal(prompts.length, 1, 'no further suggest request after clearing');
  assert.equal(await pillText(page), 'None');
  await context.close();
});

test('a null suggestion while auto reverts to the previous skill and removes the tag', async () => {
  const { context, page } = await autoPage((p) => (p.includes('five') ? 'project-05' : null));
  await openTray(page);
  await trayRowLocator(page, 'None').click(); // establish a known previous value ... then reload to make it a 'default' source
  await page.evaluate(() => localStorage.removeItem('gl-session-draft-v1'));
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  const before = await pillText(page);
  await page.fill('#session-prompt', 'make the project five thing bigger');
  await waitPill(page, 'project-05');
  await page.fill('#session-prompt', 'what is the weather tomorrow');
  await waitPill(page, before);
  assert.equal(await autoTagVisible(page), false);
  await context.close();
});

test('an out-of-order (stale) suggestion response is ignored', async () => {
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  const { context, page, prompts } = await autoPage((p) => (p.includes('first') ? firstGate.then(() => 'project-03') : 'project-06'));
  await page.fill('#session-prompt', 'first request about something');
  await page.waitForTimeout(1500); // first request is now in flight, gated
  assert.equal(prompts.length, 1);
  await page.fill('#session-prompt', 'second request about something else');
  await waitPill(page, 'project-06');
  releaseFirst();
  await page.waitForTimeout(500);
  assert.equal(await pillText(page), 'project-06', 'the late reply for the older prompt must not win');
  await context.close();
});

test('dictation append triggers detection', async () => {
  const { context, page, prompts } = await autoPage(() => 'project-04');
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  await stopViaInsert(page);
  await waitPill(page, 'project-04');
  assert.deepEqual(prompts, ['a fake voice transcript']);
  assert.equal(await autoTagVisible(page), true);
  await context.close();
});

test('a failed suggest request leaves the selection alone and shows no error banner', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/suggest-skill`, (route) => route.fulfill({ status: 500, body: 'boom' }));
  const page = await newSessionPage(context);
  const before = await pillText(page);
  const warned = page.waitForEvent('console', (m) => m.type() === 'warning' && /skill suggestion failed/.test(m.text()));
  await page.fill('#session-prompt', 'make the project five thing bigger');
  await warned;
  assert.equal(await pillText(page), before);
  assert.equal(await page.locator('#gl-error').isVisible(), false);
  await context.close();
});

test('the auto source survives a reload via the draft, and a successful Start resets it (tag gone, detection allowed again)', async () => {
  const { context, page, prompts } = await autoPage(() => 'project-05');
  await context.route(`${API_BASE}/sessions/start`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: 'project-05' }) }));
  const preAuto = await pillText(page);
  assert.notEqual(preAuto, 'project-05');
  await page.fill('#session-prompt', 'make the project five thing bigger');
  await waitPill(page, 'project-05');
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  assert.equal(await pillText(page), 'project-05');
  assert.equal(await autoTagVisible(page), true, 'draft restores the auto source');
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/sessions/start')), page.click('#session-start-btn')]);
  await page.waitForFunction(() => document.getElementById('session-project-pill-auto').classList.contains('gl-hidden'));
  assert.equal(await pillText(page), preAuto, 'the auto pick belonged to the sent prompt, so Start reverts it');
  await page.fill('#session-prompt', 'another request for later');
  await page.waitForTimeout(1800);
  assert.equal(prompts.length, 2, 'detection runs again for the next draft');
  await context.close();
});

// --- session detail view (tap a recent row -> transcript + reply) -----------

const SESS = (over = {}) => ({
  id: 'abc12345', sessionId: 'sess-uuid-1', name: 'Fix the bug', project: 'project-01',
  state: 'done', startedAt: Date.now(), kind: 'background', bridgeUrl: 'https://claude.ai/code/session_abc', ...over,
});

/** Routes transcript + reply for sessionId; returns a handle with recorded calls and mutable response state. */
async function routeDetail(context, sess, opts = {}) {
  const h = {
    transcriptCalls: 0, replies: [], auths: [],
    messages: opts.messages || [
      { uuid: 'm1', role: 'user', text: 'please fix it', tools: [], at: '2026-10-04T10:00:00Z' },
      { uuid: 'm2', role: 'assistant', text: 'Done. Run `npm test`.\n```js\nconst a = "<b>x</b>";\n```\nAll green.', tools: [{ name: 'Bash', summary: 'git status' }], at: '2026-10-04T10:01:00Z' },
    ],
    truncated: !!opts.truncated, replyStatus: opts.replyStatus || 200, replyBody: opts.replyBody || { ok: true, id: 'r1' },
    sessionState: sess.state,
  };
  await context.route(`${API_BASE}/sessions/${sess.sessionId}/transcript*`, async (route) => {
    h.transcriptCalls++;
    h.auths.push(route.request().headers()['authorization']);
    if (h.transcriptGate) await h.transcriptGate;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: { ...sess, state: h.sessionState }, messages: h.messages, truncated: h.truncated }) });
  });
  await context.route(`${API_BASE}/sessions/${sess.sessionId}/reply`, async (route) => {
    h.replies.push(JSON.parse(route.request().postData()));
    if (h.replyGate) await h.replyGate;
    if (h.replyAbort) return route.abort('connectionrefused');
    return route.fulfill({ status: h.replyStatus, contentType: 'application/json', body: JSON.stringify(h.replyBody) });
  });
  return h;
}

async function openDetailPage(opts = {}) {
  const sess = SESS(opts.sess);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: !!opts.hasTouch });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context, [sess]);
  const h = await routeDetail(context, sess, opts);
  if (opts.beforeNav) await opts.beforeNav(context);
  const page = await newSessionPage(context);
  await page.waitForSelector('#session-recent-list .gl-row');
  await page.click('#session-recent-list .gl-row');
  await page.waitForSelector('#detail-scroll .gl-msg');
  return { context, page, h, sess };
}

test('tapping a recent row opens the detail view and fetches the transcript with the bearer token', async () => {
  const { context, page, h } = await openDetailPage();
  assert.equal(await page.locator('#gl-launcher').isVisible(), false);
  assert.equal(await page.locator('#gl-detail').isVisible(), true);
  assert.equal(await page.locator('#detail-name').textContent(), 'Fix the bug');
  assert.equal(await page.locator('#detail-project').textContent(), 'project-01');
  assert.equal(await page.locator('#detail-state').textContent(), 'done');
  assert.equal(h.transcriptCalls, 2, 'the prefetch after the list loaded, then the tap');
  assert.deepEqual(h.auths, ['Bearer test-token', 'Bearer test-token']);
  assert.equal(await page.locator('.gl-bubble').first().textContent(), 'please fix it');
  await context.close();
});

test('assistant text is escaped, fenced blocks and inline code are formatted, tools render as muted lines, truncation note shows', async () => {
  const { context, page } = await openDetailPage({ truncated: true });
  assert.equal(await page.locator('.gl-tool-line').textContent(), 'Bash · git status');
  assert.equal(await page.locator('.gl-codeblock').textContent(), 'const a = "<b>x</b>";');
  assert.equal(await page.locator('.gl-msg-assistant code:not(.gl-codeblock)').textContent(), 'npm test');
  assert.equal(await page.locator('#detail-scroll b').count(), 0, 'transcript text must never become markup');
  assert.equal(await page.locator('.gl-trunc-note').textContent(), 'Earlier messages hidden');
  await context.close();
});

test('assistant markdown renders as formatting with no raw syntax left over', async () => {
  const text = [
    '**The Add button isn\'t shipped.** Costs **$3/month**, see `logins.json` and **`bold.code`**.',
    '',
    '## Add button',
    'First line with *emphasis* and a [doc](https://example.com/a_b).',
    'Second line https://example.com/x*y*z',
    '',
    '- bullet **one**',
    '  - nested',
    '1. numbered',
    '',
    '---',
    '',
    '| Plan | Cost |',
    '|---|---:|',
    '| **Azure** | $3 |',
    '| Full | $23 |',
    '',
    'After table.',
    '```js',
    '**not bold** # not heading',
    '```',
  ].join('\n');
  const { context, page } = await openDetailPage({ messages: [{ uuid: 'a', role: 'assistant', text, tools: [], at: 'x' }] });
  const msg = page.locator('.gl-msg-assistant .gl-msg-text');
  assert.deepEqual(await msg.locator('strong').allTextContents(), ['The Add button isn\'t shipped.', '$3/month', 'bold.code', 'one', 'Azure']);
  assert.equal(await msg.locator('strong code').textContent(), 'bold.code');
  assert.equal(await msg.locator('.gl-md-h2').textContent(), 'Add button');
  assert.equal(await msg.locator('em').textContent(), 'emphasis');
  assert.equal(await msg.locator('a', { hasText: 'doc' }).getAttribute('href'), 'https://example.com/a_b');
  assert.equal(await msg.locator('a').nth(1).getAttribute('href'), 'https://example.com/x*y*z', 'a URL is never split by italics');
  assert.deepEqual(await msg.locator('.gl-md-li').evaluateAll((els) => els.map((e) => [e.children[0].textContent, e.children[1].textContent, e.style.marginLeft])),
    [['•', 'bullet one', '0px'], ['•', 'nested', '16px'], ['1.', 'numbered', '0px']]);
  assert.equal(await msg.locator('hr').count(), 1);
  assert.deepEqual(await msg.locator('tr').evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.tagName + ':' + c.textContent))),
    [['TH:Plan', 'TH:Cost'], ['TD:Azure', 'TD:$3'], ['TD:Full', 'TD:$23']]);
  assert.equal(await msg.locator('.gl-md-p').last().textContent(), 'After table.', 'the line after a table is not swallowed');
  assert.equal(await msg.locator('.gl-codeblock').textContent(), '**not bold** # not heading', 'fences stay literal');
  const outside = await msg.evaluate((el) => { const c = el.cloneNode(true); c.querySelector('.gl-codeblock').remove(); return c.textContent; });
  assert.doesNotMatch(outside, /\*\*|##|\|---/, 'no raw markdown left: ' + outside);
  await context.close();
});

test('text that only resembles markdown stays literal', async () => {
  const text = 'Compute 2 * 3 * 4 and a*b*c, plus snake_case_name and **unclosed.\nA | pipe line\nnext line';
  const { context, page } = await openDetailPage({ messages: [{ uuid: 'a', role: 'assistant', text, tools: [], at: 'x' }] });
  const msg = page.locator('.gl-msg-assistant .gl-msg-text');
  assert.equal(await msg.textContent(), text);
  assert.equal(await msg.locator('em, strong, table, .gl-md-li').count(), 0);
  await context.close();
});

test('detail view opens scrolled to the bottom', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ uuid: 'u' + i, role: i % 2 ? 'assistant' : 'user', text: 'line ' + i + ' lorem ipsum dolor sit amet', tools: [], at: 'x' }));
  const { context, page } = await openDetailPage({ messages: many });
  const gap = await page.evaluate(() => { const e = document.getElementById('detail-scroll'); return e.scrollHeight - e.scrollTop - e.clientHeight; });
  assert.ok(gap < 5, 'scrolled to bottom, gap=' + gap);
  assert.ok(await page.evaluate(() => document.getElementById('detail-scroll').scrollHeight > document.getElementById('detail-scroll').clientHeight));
  await context.close();
});

test('Back in the detail view returns to the list WITHOUT calling goBack; on the list (a tab root) Back is hidden', async () => {
  const { context, page } = await openDetailPage();
  assert.equal(await page.locator('#gl-back-btn').isVisible(), true);
  await page.click('#gl-back-btn');
  assert.equal(await page.locator('#gl-launcher').isVisible(), true);
  assert.equal(await page.locator('#gl-detail').isVisible(), false);
  assert.equal(await page.locator('#gl-back-btn').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__glCallLog.filter((c) => c.method === 'goBack').length), 0);
  await context.close();
});

test('reply: optimistic pending bubble, POST with text + idempotencyKey, draft cleared on 200, state flips to working', async () => {
  const { context, page, h } = await openDetailPage();
  await page.fill('#detail-reply', 'thanks, now ship it');
  await page.click('#detail-send');
  await page.waitForFunction(() => document.querySelector('#detail-scroll .gl-msg-user:last-child .gl-bubble')?.textContent === 'thanks, now ship it');
  assert.equal(await page.inputValue('#detail-reply'), '');
  await page.waitForFunction(() => document.getElementById('detail-state').textContent === 'working');
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].text, 'thanks, now ship it');
  assert.ok(typeof h.replies[0].idempotencyKey === 'string' && h.replies[0].idempotencyKey.length > 6);
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-reply-draft-v1:sess-uuid-1')), null);
  assert.equal(await page.locator('#detail-send').isDisabled(), false, 'composer stays open while working: a reply is a clarification');
  await context.close();
});

test('reply 409: bubble marked failed, text persisted, error shown; tap retries with the SAME idempotencyKey', async () => {
  const { context, page, h } = await openDetailPage({ replyStatus: 409, replyBody: { error: 'session is busy' } });
  await page.fill('#detail-reply', 'try this');
  await page.click('#detail-send');
  await page.waitForSelector('.gl-bubble.failed');
  assert.match(await page.locator('#gl-error-text').textContent(), /session is busy/);
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-reply-draft-v1:sess-uuid-1')), 'try this');
  h.replyStatus = 200; h.replyBody = { ok: true, id: 'r2' };
  await page.click('.gl-bubble.failed');
  while (h.replies.length < 2) await page.waitForTimeout(50);
  await page.waitForFunction(() => !document.querySelector('.gl-bubble.failed'));
  await page.waitForFunction(() => document.getElementById('detail-state').textContent === 'working');
  assert.equal(h.replies.length, 2);
  assert.equal(h.replies[1].idempotencyKey, h.replies[0].idempotencyKey);
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-reply-draft-v1:sess-uuid-1')), null);
  await context.close();
});

test('a persisted unsent draft is restored when the detail view opens', async () => {
  const sess = SESS();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript(() => { try { localStorage.setItem('gl-session-reply-draft-v1:sess-uuid-1', 'half typed'); } catch (e) {} });
  await routeProjects(context);
  await routeRecent(context, [sess]);
  await routeDetail(context, sess);
  const page = await newSessionPage(context);
  await page.click('#session-recent-list .gl-row');
  await page.waitForSelector('#detail-scroll .gl-msg');
  assert.equal(await page.inputValue('#detail-reply'), 'half typed');
  await context.close();
});

test('composer is disabled with a hint for interactive sessions', async () => {
  const { context, page } = await openDetailPage({ sess: { kind: 'interactive', state: 'idle' } });
  assert.equal(await page.locator('#detail-reply').isDisabled(), true);
  assert.equal(await page.locator('#detail-send').isDisabled(), true);
  assert.equal(await page.locator('#detail-hint').textContent(), 'Open in Claude to reply');
  await context.close();
});

test('composer stays ENABLED while working or busy, with the clarification hint; enabled and hint-free when done', async () => {
  for (const state of ['working', 'busy']) {
    const { context, page } = await openDetailPage({ sess: { state } });
    assert.equal(await page.locator('#detail-send').isDisabled(), false, state);
    assert.equal(await page.locator('#detail-reply').isDisabled(), false, state);
    assert.equal(await page.locator('#detail-hint').textContent(), 'Working… a reply now goes in as a clarification');
    await context.close();
  }
  const { context, page } = await openDetailPage({ sess: { state: 'done' } });
  assert.equal(await page.locator('#detail-send').isDisabled(), false);
  assert.equal(await page.locator('#detail-hint').isVisible(), false);
  await context.close();
});

test('Open in Claude links to bridgeUrl in a new window; hidden when bridgeUrl is null', async () => {
  let r = await openDetailPage();
  assert.equal(await r.page.locator('#detail-open-claude').getAttribute('href'), 'https://claude.ai/code/session_abc');
  assert.equal(await r.page.locator('#detail-open-claude').getAttribute('target'), '_blank');
  await r.context.close();
  r = await openDetailPage({ sess: { bridgeUrl: null } });
  assert.equal(await r.page.locator('#detail-open-claude').isVisible(), false);
  await r.context.close();
});

test('polling: 4s while working, stops after leaving detail and while the page is hidden', async () => {
  const sess = SESS({ state: 'working' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context, [sess]);
  const h = await routeDetail(context, sess);
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.click('#session-recent-list .gl-row');
  await page.waitForSelector('#detail-scroll .gl-msg');
  await waitFor(() => h.transcriptCalls === 2, 'the prefetch, then the tap\'s own fetch');
  await page.clock.runFor(4100);
  await page.waitForTimeout(150);
  assert.equal(h.transcriptCalls, 3, 'refetched after 4s while working');
  for (let i = 0; i < 2; i++) { await page.clock.runFor(4100); await page.waitForTimeout(150); }
  assert.equal(h.transcriptCalls, 5, 'keeps polling at 4s cadence');
  await page.click('#gl-back-btn');
  await waitFor(() => h.transcriptCalls === 6, 'the reloaded list\'s prefetch');
  const after = h.transcriptCalls;
  await page.clock.runFor(30000);
  await page.waitForTimeout(150);
  assert.equal(h.transcriptCalls, after, 'no polling after leaving detail');
  await context.close();
});

test('polling: 15s cadence when not working', async () => {
  const sess = SESS({ state: 'done' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context, [sess]);
  const h = await routeDetail(context, sess);
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.click('#session-recent-list .gl-row');
  await page.waitForSelector('#detail-scroll .gl-msg');
  await waitFor(() => h.transcriptCalls === 2, 'the prefetch, then the tap\'s own fetch');
  await page.clock.runFor(14000);
  await page.waitForTimeout(150);
  assert.equal(h.transcriptCalls, 2, 'no refetch before 15s');
  await page.clock.runFor(1500);
  await page.waitForTimeout(150);
  assert.equal(h.transcriptCalls, 3);
  await context.close();
});

test('detail view has no horizontal overflow at 390px', async () => {
  const { context, page } = await openDetailPage();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await context.close();
});

// Bounded wait, so a regression fails with a message instead of hanging the file.
async function waitFor(predicate, what, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- transcript prefetch: a tap paints the conversation without waiting on the box ---

const TRANSCRIPT_CACHE = 'gl-session-transcripts-v1';

test('a transcript prefetched when the list loads paints at once on tap, then the live fetch replaces it', async () => {
  const sess = SESS();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context, [sess]);
  const h = await routeDetail(context, sess);
  const page = await newSessionPage(context);
  await waitFor(() => h.transcriptCalls === 1, 'the prefetch');
  await page.waitForFunction((k) => !!JSON.parse(localStorage.getItem(k) || '{}')['sess-uuid-1'], TRANSCRIPT_CACHE);
  let release;
  h.transcriptGate = new Promise((r) => { release = r; }); // the box is slow from here on
  h.messages = [...h.messages, { uuid: 'm3', role: 'user', text: 'newer message', tools: [], at: 'x' }];
  await page.click('#session-recent-list .gl-row');
  await page.waitForSelector('#detail-scroll .gl-msg', { timeout: 1000 });
  assert.equal(await page.locator('.gl-bubble').first().textContent(), 'please fix it');
  assert.equal(await page.locator('.gl-bubble').count(), 1, 'the cached copy, not yet the newer message');
  await waitFor(() => h.transcriptCalls === 2, 'the tap\'s live fetch');
  release();
  await page.waitForFunction(() => document.querySelectorAll('.gl-bubble').length === 2);
  await context.close();
});

test('a cold launch paints a saved transcript on tap before /recent or the transcript answer', async () => {
  const sess = SESS();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript(([rk, tk, sess]) => {
    localStorage.setItem(rk, JSON.stringify({ sessions: [sess] }));
    localStorage.setItem(tk, JSON.stringify({ [sess.sessionId]: { session: sess, messages: [{ uuid: 's1', role: 'user', text: 'saved copy', tools: [], at: 'x' }], truncated: false } }));
  }, ['gl-session-recent-cache-v1', TRANSCRIPT_CACHE, sess]);
  await routeProjects(context);
  await context.route(`${API_BASE}/sessions/recent*`, () => {}); // never answers
  await context.route(`${API_BASE}/sessions/${sess.sessionId}/transcript*`, () => {}); // never answers
  const page = await newSessionPage(context);
  await page.click('#session-recent-list .gl-row');
  await page.waitForSelector('#detail-scroll .gl-msg', { timeout: 1000 });
  assert.equal(await page.locator('.gl-bubble').textContent(), 'saved copy');
  await context.close();
});

test('prefetch covers the top 8 rows in on-screen order and drops transcripts no longer near the top', async () => {
  // Older first in the array, so on-screen order (newest first) differs from it.
  const sessions = Array.from({ length: 10 }, (_, i) => SESS({ id: 'id' + i, sessionId: 'sess-' + i, name: 'S' + i, activityAt: 1000 + i }));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript((k) => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(k, JSON.stringify({ 'gone-sess': { session: {}, messages: [], truncated: false } }));
    }
  }, TRANSCRIPT_CACHE);
  await routeProjects(context);
  await routeRecent(context, sessions);
  const fetched = [];
  await context.route(`${API_BASE}/sessions/*/transcript*`, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[2]);
    fetched.push(id);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: {}, messages: [], truncated: false }) });
  });
  const page = await newSessionPage(context);
  await waitFor(() => fetched.length === 8, '8 prefetches');
  await page.waitForTimeout(300);
  assert.deepEqual(fetched.slice().sort(), ['sess-2', 'sess-3', 'sess-4', 'sess-5', 'sess-6', 'sess-7', 'sess-8', 'sess-9']);
  await page.waitForFunction((k) => Object.keys(JSON.parse(localStorage.getItem(k))).length === 8, TRANSCRIPT_CACHE);
  const kept = await page.evaluate((k) => Object.keys(JSON.parse(localStorage.getItem(k))).sort(), TRANSCRIPT_CACHE);
  assert.deepEqual(kept, ['sess-2', 'sess-3', 'sess-4', 'sess-5', 'sess-6', 'sess-7', 'sess-8', 'sess-9']);
  await context.close();
});

// --- offline data-loss: Start / Reply / voice are saved first, replayed until the box answers ---

const START_QUEUE = 'gl-session-pending-starts-v1';
const REPLY_QUEUE = 'gl-session-pending-replies-v1';

async function startPageWithStartRoute(handler, opts = {}) {
  const context = await browser.newContext({ hasTouch: !!opts.hasTouch });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  if (opts.beforeNav) await opts.beforeNav(context);
  await routeProjects(context);
  await routeRecent(context);
  const calls = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    const body = JSON.parse(route.request().postData());
    calls.push(body);
    return handler(route, calls.length, body);
  });
  const page = await newSessionPage(context);
  return { context, page, calls };
}
const OK_START = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'ok000001', name: 'made it', project: 'project-01' }) });

test('OFFLINE Start: the request is on disk (with its key) before it is cleared; a reload replays it automatically with the SAME key and drains the queue', async () => {
  let offline = true;
  const { context, page, calls } = await startPageWithStartRoute((route) => (offline ? route.abort('connectionrefused') : OK_START(route)));
  await page.fill('#session-prompt', 'do the offline thing');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  assert.match(await page.locator('#gl-error-text').textContent(), /Box unreachable/);
  assert.equal(await page.inputValue('#session-prompt'), '');
  const queued = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), START_QUEUE));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].body.prompt, 'do the offline thing');
  assert.equal(queued[0].body.idempotencyKey, queued[0].key);

  // "Relaunch": same origin storage, new page load, box now reachable.
  offline = false;
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await waitFor(() => calls.length >= 2, 'calls to reach 2 requests');
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey, 'replay must reuse the key so the server dedupes');
  assert.equal(calls[1].prompt, 'do the offline thing');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  await page.waitForFunction(() => /made it/.test(document.getElementById('session-confirmation-body') ? document.getElementById('session-confirmation-body').textContent : document.body.textContent));
  await context.close();
});

test('OFFLINE Start: the saved request also replays on the "online" event without a reload', async () => {
  let offline = true;
  const { context, page, calls } = await startPageWithStartRoute((route) => (offline ? route.abort('connectionrefused') : OK_START(route)));
  await page.fill('#session-prompt', 'online later');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  assert.equal(calls.length, 2);
  await context.close();
});

test('Start rejected by the server (HTTP 400) is NOT retried by itself: the request stays queued as Failed, Discard removes it', async () => {
  const { context, page, calls } = await startPageWithStartRoute((route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad project' }) }));
  await page.fill('#session-prompt', 'will be refused');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('.gl-row-failed');
  assert.match(await page.locator('.gl-row-failed').textContent(), /bad project/);
  assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).length, START_QUEUE), 1, 'kept, not dropped');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(400);
  assert.equal(calls.length, 1, 'a 4xx must never be replayed');
  await page.click('.gl-row-failed button:has-text("Discard")');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  assert.equal(await page.locator('.gl-row-failed').count(), 0);
  await context.close();
});

test('OFFLINE Reply: saved before send, bubble stays pending (not failed), replays on "online" with the SAME key, queue and draft cleared on success', async () => {
  const { context, page, h } = await openDetailPage();
  h.replyAbort = true;
  await page.fill('#detail-reply', 'reply while offline');
  await page.click('#detail-send');
  await waitFor(() => h.replies.length >= 1, 'h.replies to reach 1 requests');
  const queued = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), REPLY_QUEUE));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, 'reply while offline');
  assert.equal(queued[0].sessionId, 'sess-uuid-1');
  assert.equal(await page.locator('.gl-bubble.failed').count(), 0, 'a network failure is not a failure state, it is waiting');

  h.replyAbort = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => h.replies.length >= 2, 'h.replies to reach 2 requests');
  assert.equal(h.replies[1].idempotencyKey, h.replies[0].idempotencyKey);
  await page.waitForFunction((k) => localStorage.getItem(k) === null, REPLY_QUEUE);
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-reply-draft-v1:sess-uuid-1')), null);
  await context.close();
});

test('OFFLINE Reply: a saved reply survives a reload and is sent from the list view without the detail open', async () => {
  const sess = SESS();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('seeded')) {
        localStorage.setItem('seeded', '1');
        localStorage.setItem('gl-session-pending-replies-v1', JSON.stringify([{ sessionId: 'sess-uuid-1', text: 'left over', key: 'key-left-over' }]));
      }
    } catch (e) {}
  });
  await routeProjects(context);
  await routeRecent(context, [sess]);
  const h = await routeDetail(context, sess);
  const page = await newSessionPage(context);
  await waitFor(() => h.replies.length >= 1, 'h.replies to reach 1 requests');
  assert.deepEqual(h.replies[0], { text: 'left over', idempotencyKey: 'key-left-over' });
  await page.waitForFunction((k) => localStorage.getItem(k) === null, REPLY_QUEUE);
  await context.close();
});

test('Reply rejected by the server (HTTP 409) is NOT auto-retried: queue drained, bubble failed', async () => {
  const { context, page, h } = await openDetailPage({ replyStatus: 409, replyBody: { error: 'session is busy' } });
  await page.fill('#detail-reply', 'refused');
  await page.click('#detail-send');
  await page.waitForSelector('.gl-bubble.failed');
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), REPLY_QUEUE), null);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(400);
  assert.equal(h.replies.length, 1, 'a 4xx must never be replayed automatically');
  await context.close();
});

test('OFFLINE voice: a "queued" stop reply leaves the prompt alone, shows no error, polls native itself, then the transcript from voicePending is appended once and acked', async () => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(buildMockBridgeScript(baseConfig({
    voiceStop: { code: 'queued', id: 'v1' },
    voicePending: { ready: [], failed: [], pending: [], waiting: 0 },   // the load-time poll sees nothing waiting
    voiceAck: {},
  })));
  await context.addInitScript(HOLD_TIMERS);                // the 5s poll timer must not mask the queued branch
  await routeProjects(context);
  await routeRecent(context);
  const page = await newSessionPage(context);
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  await page.evaluate(() => window.__glMock.configure({ responses: { voicePending: { ready: [], failed: [], pending: [], waiting: 1 } } }));
  await stopViaInsert(page);
  // Only the queued branch's own pollVoice() can produce this status now.
  await page.waitForFunction(() => /transcribes when the box is reachable/.test(document.getElementById('session-record-status').textContent), undefined, { timeout: 5000 });
  assert.equal(await page.locator('#gl-error').evaluate((el) => el.classList.contains('gl-hidden')), true, 'a queued recording is not an error');
  assert.equal(await page.inputValue('#session-prompt'), '');
  const order = await page.evaluate(() => window.__glCallLog.map((c) => c.method));
  assert.ok(order.indexOf('voicePending', order.indexOf('voiceStop')) > order.indexOf('voiceStop'), 'voicePending must be called right after the queued voiceStop');
  await page.evaluate(() => window.__glMock.configure({ responses: { voicePending: { ready: [{ id: 'v1', text: 'late transcript' }], failed: [], pending: [], waiting: 0 } } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.getElementById('session-prompt').value.indexOf('late transcript') !== -1);
  // A second poll must not append it again.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  assert.equal((await page.inputValue('#session-prompt')).split('late transcript').length - 1, 1);
  const acks = await page.evaluate(() => window.__glCallLog.filter((c) => c.method === 'voiceAck').map((c) => c.params));
  assert.ok(acks.some((p) => p.id === 'v1'), 'transcript must be acked so native deletes the recording');
  await context.close();
});

// --- a send is never lost: Recent row from the press, clip kept until the box confirms --------------

const LAUNCHES = 'gl-session-voice-launches-v1';
const callsTo = (page, method) => page.evaluate((m) => window.__glCallLog.filter((c) => c.method === m).map((c) => c.params), method);

test('LAUNCH: pressing voice send puts a Transcribing row in Recent before any network answer, with the typed text and a local id, persisted on disk', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await page.click('#session-record-btn'); // stop = send
  await page.waitForSelector('#session-recent-list .gl-row');
  const row = await page.locator('#session-recent-list .gl-row').first().textContent();
  assert.match(row, /typed words/);
  assert.match(row, /Transcribing/);
  const launches = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), LAUNCHES);
  const [launch] = Object.values(launches);
  assert.equal(Object.keys(launches).length, 1);
  assert.match(row, new RegExp(launch.localId.slice(0, 8)), 'the local id is shown');
  assert.equal(launch.snap.prefix, 'typed words');
  assert.deepEqual((await callsTo(page, 'voiceStop'))[0], { launchId: launch.localId }, 'native is told which row owns the recording');
  assert.equal(bodies.length, 0);
  await context.close();
});

// A box that is down or rebooting used to keep the launcher mic spinning (and
// untappable) and the Starting card up for the whole 90s voiceStop wait.
test('LAUNCH: a voice send with no answer frees the mic within seconds, waits in Recent, and the late transcript still starts it without disturbing a newer recording', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await page.click('#session-record-btn'); // stop = send; the box never answers
  await page.waitForSelector('#session-record-btn.busy');
  await page.waitForSelector('#session-record-btn:not(.busy)', { timeout: 5000 });
  assert.equal(await page.locator('#session-confirmation').evaluate((el) => el.classList.contains('gl-hidden')), true, 'the Starting card hands off to the Recent row');
  const [launch] = Object.values(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), LAUNCHES));
  assert.equal(launch.status, 'waiting');
  await page.click('#session-record-btn'); // the mic works again: a second recording
  await page.waitForSelector('#session-record-btn.recording');
  await page.evaluate(() => window.__glMock.replyNow('voiceStop', { text: 'late transcript' }));
  await waitFor(() => bodies.length === 1, 'the late voiceStop answer starts the first send');
  assert.equal(bodies[0].prompt, 'typed words late transcript');
  assert.equal(await page.locator('#session-record-btn').evaluate((el) => el.classList.contains('recording') && !el.classList.contains('busy')), true, 'the newer recording is untouched');
  await context.close();
});

test('LAUNCH: a launch whose recording native never heard of (app died mid-send) becomes a loud Failed row after reload, not a silent loss', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-recent-list .gl-row');
  await page.reload();
  await page.waitForSelector('.gl-row-failed');
  assert.match(await page.locator('.gl-row-failed').textContent(), /typed words/);
  assert.match(await page.locator('.gl-row-failed').textContent(), /not saved/);
  assert.equal(await page.locator('.gl-recent-group-label.failed').textContent(), 'Failed to send');
  await context.close();
});

test('LAUNCH: a queued recording stays playable in its row, becomes a Start, and is deleted (voiceAck) only AFTER /sessions/start succeeds', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(buildMockBridgeScript(baseConfig({ voiceStop: { code: 'queued', id: 'v1' }, voiceAudio: { base64: 'AAAA', mime: 'audio/mp4' } })));
  await routeProjects(context);
  await routeRecent(context);
  const starts = [];
  await context.route(`${API_BASE}/sessions/start`, async (route) => {
    starts.push(JSON.parse(route.request().postData()));
    await gate;
    return OK_START(route);
  });
  const page = await newSessionPage(context);
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  await page.fill('#session-prompt', 'say it');
  await page.evaluate(() => { window.__audioSrc = null; window.Audio = function (src) { window.__audioSrc = src; this.addEventListener = () => {}; this.play = () => Promise.resolve(); }; });
  await page.click('#session-record-btn'); // stop = send
  await page.waitForFunction(() => /Waiting for box/.test(document.getElementById('session-recent-list').textContent));
  await page.click('#session-recent-list button:has-text("Play")');
  await page.waitForFunction(() => /^blob:/.test(window.__audioSrc || ''));
  assert.deepEqual(await callsTo(page, 'voiceAudio'), [{ id: 'v1' }]);

  await page.evaluate(() => window.__glMock.configure({ responses: { voicePending: { ready: [{ id: 'v1', text: 'spoken', launchId: '' }], failed: [], pending: [], waiting: 0 } } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => starts.length === 1, 'the start request');
  assert.equal(starts[0].prompt, 'say it spoken');
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), LAUNCHES), null, 'the Start row replaced the launch row');
  assert.match(await page.locator('#session-recent-list').textContent(), /say it spoken/);
  assert.deepEqual(await callsTo(page, 'voiceAck'), [], 'the box has not confirmed yet: the recording must still exist');
  // A reload while the Start is unconfirmed must not re-insert the already-owned transcript into the composer.
  release();
  await waitFor(() => starts.length >= 1, 'start');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  assert.deepEqual(await callsTo(page, 'voiceAck'), [{ id: 'v1' }], 'acked once the start was confirmed');
  await context.close();
});

test('LAUNCH: a definitive transcription failure keeps the clip in a red Failed row; Retry re-queues it natively, Discard acks it away', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.evaluate(() => window.__glMock.configure({ responses: { voiceStop: { code: 'failed', id: 'v2', error: 'transcription failed (HTTP 400)' } } }));
  await page.click('#session-record-btn');
  await page.waitForSelector('.gl-row-failed');
  const row = await page.locator('.gl-row-failed').textContent();
  assert.match(row, /typed words/);
  assert.match(row, /transcription failed \(HTTP 400\)/);
  assert.deepEqual(await page.locator('.gl-row-failed button').allTextContents(), ['▶ Play', 'Retry', 'Discard']);
  assert.deepEqual(await callsTo(page, 'voiceAck'), [], 'a failed clip is never deleted by itself');
  assert.equal(await page.inputValue('#session-prompt'), '');

  await page.click('.gl-row-failed button:has-text("Retry")');
  assert.deepEqual(await callsTo(page, 'voiceRetry'), [{ id: 'v2' }]);
  await page.waitForFunction(() => document.querySelectorAll('.gl-row-failed').length === 0);
  assert.match(await page.locator('#session-recent-list').textContent(), /Waiting for box/);

  // It fails again: the row goes red again, then the user gives up.
  await page.evaluate(() => window.__glMock.configure({ responses: { voicePending: { ready: [], failed: [{ id: 'v2', error: 'HTTP 400', launchId: '' }], pending: [], waiting: 0 } } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('.gl-row-failed');
  await page.click('.gl-row-failed button:has-text("Discard")');
  await page.waitForFunction(() => document.querySelectorAll('#session-recent-list .gl-row').length === 0);
  assert.deepEqual(await callsTo(page, 'voiceAck'), [{ id: 'v2' }]);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), LAUNCHES), null);
  assert.equal(bodies.length, 0);
  await context.close();
});

test('LAUNCH: a transient /sessions/start answer (503) keeps the request queued and retries it automatically; no Failed row, no lost text', async () => {
  let n = 0;
  const { context, page, calls } = await startPageWithStartRoute((route) =>
    (++n === 1 ? OK_JSON(route, 503, { error: 'box busy' }) : OK_START(route)));
  await context.route(`${API_BASE}/sessions/submissions/*/dismiss`, (route) => OK_JSON(route, 200, {}));
  await page.fill('#session-prompt', 'try again later');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForFunction(() => /HTTP 503/.test(document.getElementById('gl-error-text').textContent));
  assert.equal(await page.locator('.gl-row-failed').count(), 0, 'a 503 is not a definitive failure');
  assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).length, START_QUEUE), 1);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => calls.length === 2, 'the automatic retry');
  assert.equal(calls[1].prompt, 'try again later');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  await context.close();
});

// --- isolating each replay trigger (a 15s retry timer used to mask the others: tests waited up to 30s) ---

// Init script: the page's own 15s queue-retry and 5s voice-poll timers are
// recorded in window.__held instead of scheduled, so a test fires them by hand
// (or never) and no timer can silently stand in for the trigger under test.
function HOLD_TIMERS() {
  const real = window.setTimeout;
  window.__held = [];
  window.setTimeout = function (fn, ms, ...rest) {
    const src = typeof fn === 'function' ? String(fn) : '';
    if ((ms === 15000 && /flushQueues/.test(src)) || (ms === 5000 && /pollVoice/.test(src))) {
      window.__held.push({ ms, fn });
      return 1000000 + window.__held.length;
    }
    return real.call(window, fn, ms, ...rest);
  };
}

// Init script: localStorage refuses to save the offline queues (quota / private mode).
function FAIL_QUEUE_WRITES() {
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (String(k).startsWith('gl-session-pending-')) throw new DOMException('quota exceeded', 'QuotaExceededError');
    return set.call(this, k, v);
  };
}

const TRIGGERS = {
  load: (page) => page.reload(),
  online: (page) => page.evaluate(() => window.dispatchEvent(new Event('online'))),
  visibilitychange: (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  timer: (page) => page.evaluate(() => {
    const t = window.__held.filter((h) => h.ms === 15000);
    if (t.length !== 1) throw new Error('expected exactly one held 15s retry timer, got ' + t.length);
    t[0].fn();
  }),
};
const drained = (page, key) => page.waitForFunction((k) => localStorage.getItem(k) === null, key, { timeout: 8000 });

for (const [name, fire] of Object.entries(TRIGGERS)) {
  test(`OFFLINE Start: with only the ${name} trigger, a saved request is replayed`, async () => {
    let offline = true;
    const { context, page, calls } = await startPageWithStartRoute((route) => (offline ? route.abort('connectionrefused') : OK_START(route)), { beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
    await page.fill('#session-prompt', 'only ' + name);
    await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
    await page.click('#session-start-btn');
    await page.waitForSelector('#gl-error:not(.gl-hidden)');
    await waitFor(() => calls.length === 1, 'the first (failing) attempt');
    offline = false;
    await fire(page);
    await waitFor(() => calls.length >= 2, `a replay triggered only by ${name}`);
    assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey);
    await drained(page, START_QUEUE);
    await context.close();
  });

  test(`OFFLINE Reply: with only the ${name} trigger, a saved reply is replayed`, async () => {
    const { context, page, h } = await openDetailPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
    h.replyAbort = true;
    await page.fill('#detail-reply', 'only ' + name);
    await page.click('#detail-send');
    await waitFor(() => h.replies.length === 1, 'the first (failing) reply attempt');
    await page.waitForFunction((k) => localStorage.getItem(k) !== null, REPLY_QUEUE);
    h.replyAbort = false;
    await fire(page);
    await waitFor(() => h.replies.length >= 2, `a reply replay triggered only by ${name}`);
    assert.equal(h.replies[1].idempotencyKey, h.replies[0].idempotencyKey);
    await drained(page, REPLY_QUEUE);
    await context.close();
  });
}

test('OFFLINE Start: a failed attempt schedules exactly one 15s retry, and firing it does replay', async () => {
  let offline = true;
  const { context, page, calls } = await startPageWithStartRoute((route) => (offline ? route.abort('connectionrefused') : OK_START(route)), { beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.fill('#session-prompt', 'timer');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => calls.length === 1, 'the first attempt');
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  assert.equal(await page.evaluate(() => window.__held.filter((h) => h.ms === 15000).length), 1, 'a failed send must schedule a retry');
  await context.close();
});

// --- durable BEFORE the request leaves ---

test('OFFLINE Start: the request is already on disk while its fetch is still in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { context, page, calls } = await startPageWithStartRoute(async (route) => { await gate; return OK_START(route); });
  await page.fill('#session-prompt', 'held in flight');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => calls.length === 1, 'the request to reach the box');
  const queued = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), START_QUEUE));
  assert.equal(queued.length, 1, 'the request must be saved before/while it is sent');
  assert.equal(queued[0].key, calls[0].idempotencyKey);
  assert.equal(queued[0].body.prompt, 'held in flight');
  release();
  await drained(page, START_QUEUE);
  await context.close();
});

test('OFFLINE Reply: the reply is already on disk while its fetch is still in flight', async () => {
  let release;
  const { context, page, h } = await openDetailPage();
  h.replyGate = new Promise((r) => { release = r; });
  await page.fill('#detail-reply', 'reply in flight');
  await page.click('#detail-send');
  await waitFor(() => h.replies.length === 1, 'the reply to reach the box');
  const queued = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), REPLY_QUEUE));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].key, h.replies[0].idempotencyKey);
  assert.equal(queued[0].text, 'reply in flight');
  release();
  await drained(page, REPLY_QUEUE);
  await context.close();
});

// --- the queue write itself failing: nothing may be cleared or reported as sent ---

test('OFFLINE Start: when the queue cannot be saved, the prompt stays, an error shows, and nothing is sent', async () => {
  const { context, page, calls } = await startPageWithStartRoute(OK_START, { beforeNav: (c) => c.addInitScript(FAIL_QUEUE_WRITES) });
  await page.fill('#session-prompt', 'must not vanish');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  assert.match(await page.locator('#gl-error-text').textContent(), /Couldn't save the request on this device/);
  assert.equal(await page.inputValue('#session-prompt'), 'must not vanish');
  assert.equal(await page.locator('#session-confirmation').evaluate((el) => el.classList.contains('gl-hidden')), true, 'must not claim it is starting');
  await page.waitForTimeout(300);
  assert.equal(calls.length, 0);
  await context.close();
});

test('OFFLINE Reply: when the queue cannot be saved, the reply is shown as failed with its text, an error shows, and nothing is sent', async () => {
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => c.addInitScript(FAIL_QUEUE_WRITES) });
  await page.fill('#detail-reply', 'must not vanish');
  await page.click('#detail-send');
  await page.waitForSelector('.gl-bubble.failed', { timeout: 5000 });
  assert.match(await page.locator('.gl-bubble.failed').textContent(), /must not vanish/);
  assert.match(await page.locator('#gl-error-text').textContent(), /Couldn't save the reply on this device/);
  await page.waitForTimeout(300);
  assert.equal(h.replies.length, 0);
  await context.close();
});

// --- single flight, ordering, the load banner ---

test('OFFLINE Start: repeated online/visibilitychange while a request is in flight send it exactly once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { context, page, calls } = await startPageWithStartRoute(async (route) => { await gate; return OK_START(route); });
  await page.fill('#session-prompt', 'once only');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => calls.length === 1, 'the request to reach the box');
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }
  });
  await page.waitForTimeout(300);
  assert.equal(calls.length, 1, 'overlapping triggers re-sent the in-flight request');
  release();
  await drained(page, START_QUEUE);
  assert.equal(calls.length, 1);
  await context.close();
});

test('OFFLINE Reply: repeated online/visibilitychange while a reply is in flight send it exactly once', async () => {
  let release;
  const { context, page, h } = await openDetailPage();
  h.replyGate = new Promise((r) => { release = r; });
  await page.fill('#detail-reply', 'once only');
  await page.click('#detail-send');
  await waitFor(() => h.replies.length === 1, 'the reply to reach the box');
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }
  });
  await page.waitForTimeout(300);
  assert.equal(h.replies.length, 1, 'overlapping triggers re-sent the in-flight reply');
  release();
  await drained(page, REPLY_QUEUE);
  assert.equal(h.replies.length, 1);
  await context.close();
});

function seedQueues(context, seed) {
  return context.addInitScript((s) => {
    try {
      if (!localStorage.getItem('seeded')) {
        localStorage.setItem('seeded', '1');
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
      }
    } catch (e) {}
  }, seed);
}

test('OFFLINE Start: several saved requests replay oldest first, one at a time', async () => {
  const entries = ['first', 'second', 'third'].map((p, i) => ({ key: 'k' + i, body: { project: '', prompt: p, attachments: [], idempotencyKey: 'k' + i, model: 'sonnet' } }));
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await seedQueues(context, { [START_QUEUE]: entries });
  await routeProjects(context);
  await routeRecent(context);
  const seen = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    seen.push(JSON.parse(route.request().postData()).prompt);
    return OK_START(route);
  });
  const page = await newSessionPage(context);
  await waitFor(() => seen.length >= 3, 'all three saved requests');
  assert.deepEqual(seen, ['first', 'second', 'third']);
  await drained(page, START_QUEUE);
  await context.close();
});

test('OFFLINE Reply: several saved replies replay oldest first', async () => {
  const sess = SESS();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await seedQueues(context, { [REPLY_QUEUE]: ['one', 'two', 'three'].map((t) => ({ sessionId: 'sess-uuid-1', text: t, key: 'r-' + t })) });
  await routeProjects(context);
  await routeRecent(context, [sess]);
  const h = await routeDetail(context, sess);
  const page = await newSessionPage(context);
  await waitFor(() => h.replies.length >= 3, 'all three saved replies');
  assert.deepEqual(h.replies.map((r) => r.text), ['one', 'two', 'three']);
  await drained(page, REPLY_QUEUE);
  await context.close();
});

test('OFFLINE Start: on load, a saved request that is still being sent shows "Waiting for the box"', async () => {
  const entry = { key: 'kw', body: { project: '', prompt: 'saved', attachments: [], idempotencyKey: 'kw', model: 'sonnet' } };
  let release;
  const gate = new Promise((r) => { release = r; });
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await seedQueues(context, { [START_QUEUE]: [entry] });
  await routeProjects(context);
  await routeRecent(context);
  let reached = false;
  await context.route(`${API_BASE}/sessions/start`, async (route) => { reached = true; await gate; return OK_START(route); });
  const page = await newSessionPage(context);
  await waitFor(() => reached, 'the saved request to be sent');
  await page.waitForSelector('#session-confirmation:not(.gl-hidden)', { timeout: 3000 });
  assert.match(await page.locator('#session-confirmation-body').textContent(), /Waiting for the box/);
  release();
  await drained(page, START_QUEUE);
  await context.close();
});

// --- fully offline: skill list cache, local skill matcher, offline attachments ---

const PROJECTS_CACHE = 'gl-session-projects-cache-v1';
const OFFLINE_SKILLS = ['outfits', 'todo', 'beach', 'sunny', 'g'];

/** Seeds the projects cache once (a reload keeps whatever the page itself wrote after). */
function seedProjectsCache(context, projects) {
  return context.addInitScript(([key, list]) => {
    try {
      if (!localStorage.getItem('seeded-cache')) {
        localStorage.setItem('seeded-cache', '1');
        localStorage.setItem(key, JSON.stringify({ projects: list, skills: list.map((name) => ({ name, description: '' })) }));
      }
    } catch (e) {}
  }, [PROJECTS_CACHE, projects]);
}

/** A context whose box is unreachable: every /sessions/* request is aborted like a dead network. */
async function offlineContext(opts = {}) {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  if (opts.cache) await seedProjectsCache(context, opts.cache);
  await context.route(`${API_BASE}/sessions/**`, (route) => route.abort('internetdisconnected'));
  return context;
}

test('OFFLINE cold launch with a cached skill list: the tray lists the skills, Start enables, no error banner', async () => {
  const context = await offlineContext({ cache: OFFLINE_SKILLS });
  const page = await newSessionPage(context);
  await openTray(page);
  const rows = await page.locator('.tray-row span:first-child').allTextContents();
  assert.deepEqual(rows, ['None', ...slashNames(OFFLINE_SKILLS)]);
  await page.click('.tray-row:has-text("/todo")');
  await page.fill('#session-prompt', 'something to do');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  assert.equal(await page.locator('#gl-error:not(.gl-hidden)').count(), 0, 'offline with a cache is not an error');
  await context.close();
});

test('OFFLINE cold launch with no cache: None is selectable, Start enables, and the draft still restores', async () => {
  const context = await offlineContext();
  await context.addInitScript(() => {
    try { if (!localStorage.getItem('seeded-draft')) { localStorage.setItem('seeded-draft', '1'); localStorage.setItem('gl-session-draft-v1', JSON.stringify({ prompt: 'unsent words', project: '', projectSource: 'default', model: 'sonnet', effort: '', attachments: [] })); } } catch (e) {}
  });
  const page = await newSessionPage(context);
  assert.equal(await pillText(page), 'None');
  assert.equal(await page.inputValue('#session-prompt'), 'unsent words', 'draft restore must not depend on the projects fetch');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await openTray(page);
  assert.equal(await page.locator('.tray-row').count(), 1);
  await context.close();
});

test('the projects response is cached and a later offline launch shows the same skills', async () => {
  let online = true;
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.route(`${API_BASE}/sessions/**`, (route) => {
    if (!online) return route.abort('internetdisconnected');
    if (route.request().url().includes('/sessions/projects')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: ['alpha', 'beta'], skills: [{ name: 'alpha', description: 'a' }, { name: 'beta', description: 'b' }] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
  });
  const page = await newSessionPage(context);
  online = false;
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await openTray(page);
  assert.deepEqual(await page.locator('.tray-row span:first-child').allTextContents(), ['None', '/alpha', '/beta']);
  await context.close();
});

test('OFFLINE skill auto-detect: "add this to out fits" selects outfits via the local matcher with the auto tag', async () => {
  const context = await offlineContext({ cache: OFFLINE_SKILLS });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'add this to out fits');
  await waitPill(page, 'outfits');
  assert.equal(await autoTagVisible(page), true);
  await context.close();
});

test('OFFLINE skill auto-detect: a prompt naming no skill, or two equally good skills, changes nothing', async () => {
  const context = await offlineContext({ cache: OFFLINE_SKILLS });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'what is the weather tomorrow');
  await page.waitForTimeout(1800);
  assert.equal(await pillText(page), 'None');
  await page.fill('#session-prompt', 'going to the beach on a sunny day');
  await page.waitForTimeout(1800);
  assert.equal(await pillText(page), 'None', 'beach and sunny tie, so no pick');
  assert.equal(await autoTagVisible(page), false);
  await context.close();
});

test('navigator.onLine === false: the local matcher answers without any suggest-skill request', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await seedProjectsCache(context, OFFLINE_SKILLS);
  const suggestCalls = [];
  await context.route(`${API_BASE}/sessions/suggest-skill`, (route) => { suggestCalls.push(1); return route.abort('internetdisconnected'); });
  await context.route(`${API_BASE}/sessions/**`, (route) => route.abort('internetdisconnected'));
  const page = await newSessionPage(context);
  await context.setOffline(true);
  await page.fill('#session-prompt', 'put this in outfits please');
  await waitPill(page, 'outfits');
  assert.equal(suggestCalls.length, 0, 'no network attempt while navigator.onLine is false');
  await context.close();
});

test('localSuggestSkill: whole words, joined/plural forms, spaces-removed, explicit slash, short names, ties', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, []);
  await routeRecent(context);
  const page = await newSessionPage(context);
  const cases = [
    [['outfits'], 'add this to out fits', 'outfits'],
    [['outfits'], 'new outfit idea', 'outfits'],
    [['worktree-visualizer'], 'open the worktree visualizer', 'worktree-visualizer'],
    [['worktree-visualizer'], 'worktreevisualizer please', 'worktree-visualizer'],
    [['todo'], 'something else entirely', null],
    [['todo'], 'xtodox', null],
    [['todo'], 'out fits todo', 'todo'],
    [['and', 'g'], 'this and that', null],
    [['and', 'g'], 'run /g now', 'g'],
    [['and'], 'slash and then', 'and'],
    [['beach', 'sunny'], 'beach on a sunny day', null],
    [['outfits', 'todo'], 'todo list for outfits', 'outfits'],
    [['todo'], 'to do list', null],
  ];
  for (const [names, prompt, expected] of cases) {
    const got = await page.evaluate(([n, p]) => window.localSuggestSkill(p, n), [names, prompt]);
    assert.equal(got, expected, JSON.stringify({ names, prompt }));
  }
  await context.close();
});

test('OFFLINE Start with an attachment: queued, survives a reload, then upload and start each fire exactly once', async () => {
  let online = false;
  const counts = { uploadOk: 0, startOk: 0, uploadAttempts: 0 };
  let startBody = null;
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.route(`${API_BASE}/sessions/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/sessions/upload')) counts.uploadAttempts++;
    if (!online) return route.abort('internetdisconnected');
    if (url.includes('/sessions/projects')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: ['alpha'], skills: [] }) });
    if (url.includes('/sessions/upload')) { counts.uploadOk++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001.png' }) }); }
    if (url.includes('/sessions/start')) { counts.startOk++; startBody = JSON.parse(route.request().postData()); return OK_START(route); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
  });
  const page = await context.newPage();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.setInputFiles('#session-attach-input', [fakeImage('offline.png')]);
  await page.waitForSelector('.gl-thumb.pending');
  await page.fill('#session-prompt', 'start with a screenshot');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForFunction((k) => (JSON.parse(localStorage.getItem(k) || '[]')[0] || {}).pending?.length === 1, START_QUEUE);
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  assert.equal(counts.uploadOk + counts.startOk, 0, 'nothing reaches the box while offline');
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => counts.startOk >= 1, 'the queued start');
  await drained(page, START_QUEUE);
  await page.waitForTimeout(500);
  assert.equal(counts.uploadOk, 1, 'upload fired exactly once');
  assert.equal(counts.startOk, 1, 'start fired exactly once');
  assert.deepEqual(startBody.attachments, ['00000000-0000-4000-8000-000000000001.png']);
  const left = await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('gl-session-attachments', 1);
    r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); };
    r.onerror = () => rej(r.error);
  }));
  assert.equal(left, 0, 'blob deleted from IndexedDB after the start succeeded');
  await context.close();
});

test('OFFLINE attachment picked and the app closed before Start: the blob is restored from IndexedDB and uploads once back online', async () => {
  let online = false;
  let uploadOk = 0;
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.route(`${API_BASE}/sessions/**`, async (route) => {
    const url = route.request().url();
    if (!online) return route.abort('internetdisconnected');
    if (url.includes('/sessions/projects')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: ['alpha'], skills: [] }) });
    if (url.includes('/sessions/upload')) { uploadOk++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000002.png' }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
  });
  const page = await context.newPage();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.setInputFiles('#session-attach-input', [fakeImage('kept.png')]);
  await page.waitForSelector('.gl-thumb.pending');
  await page.reload();
  await page.waitForSelector('.gl-thumb.pending');
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('.gl-thumb.done');
  assert.equal(uploadOk, 1);
  await context.close();
});

test('OFFLINE queued Start whose upload is rejected (415): kept as a Failed row naming the reason, nothing is started', async () => {
  let online = false;
  let startCalls = 0;
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.route(`${API_BASE}/sessions/**`, async (route) => {
    const url = route.request().url();
    if (!online) return route.abort('internetdisconnected');
    if (url.includes('/sessions/projects')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: ['alpha'], skills: [] }) });
    if (url.includes('/sessions/upload')) return route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'unsupported image type' }) });
    if (url.includes('/sessions/start')) { startCalls++; return OK_START(route); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
  });
  const page = await context.newPage();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.setInputFiles('#session-attach-input', [fakeImage('bad.png')]);
  await page.waitForSelector('.gl-thumb.pending');
  await page.fill('#session-prompt', 'keep my words');
  await page.locator('#session-prompt').blur(); // keyboard down: Start queues at the tap, while still offline
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => /unsupported image type/.test((document.querySelector('.gl-row-failed') || { textContent: '' }).textContent));
  assert.match(await page.locator('.gl-row-failed').textContent(), /keep my words/);
  assert.equal(startCalls, 0);
  await context.close();
});

test('OFFLINE Start pressed before the attachment\'s IndexedDB write finishes waits for it: the screenshot is never reported missing', async () => {
  let online = false;
  const counts = { uploadOk: 0, startOk: 0 };
  let startBody = null;
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  // Delay ONLY the first IndexedDB open (the attachment's put) by 1.5s; later opens are immediate, so a Start that does not wait reads the blob too early.
  await context.addInitScript(() => {
    const orig = IDBFactory.prototype.open;
    let n = 0;
    IDBFactory.prototype.open = function (...args) {
      if (n++ > 0) return orig.apply(this, args);
      const fake = { get result() { return real.result; }, get error() { return real.error; } };
      let real;
      setTimeout(() => {
        real = orig.apply(this, args);
        real.onupgradeneeded = (e) => fake.onupgradeneeded && fake.onupgradeneeded(e);
        real.onsuccess = (e) => fake.onsuccess && fake.onsuccess(e);
        real.onerror = (e) => fake.onerror && fake.onerror(e);
      }, 1500);
      return fake;
    };
  });
  await context.route(`${API_BASE}/sessions/**`, async (route) => {
    const url = route.request().url();
    if (!online) return route.abort('internetdisconnected');
    if (url.includes('/sessions/projects')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: ['alpha'], skills: [] }) });
    if (url.includes('/sessions/upload')) { counts.uploadOk++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000003.png' }) }); }
    if (url.includes('/sessions/start')) { counts.startOk++; startBody = JSON.parse(route.request().postData()); return OK_START(route); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
  });
  const page = await context.newPage();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.fill('#session-prompt', 'fast start');
  await page.setInputFiles('#session-attach-input', [fakeImage('race.png')]);
  await page.waitForSelector('.gl-thumb.pending');
  online = true;
  await page.click('#session-start-btn'); // immediately, long before the delayed IndexedDB write completes
  await page.waitForTimeout(3500);
  const errorText = await page.locator('#gl-error:not(.gl-hidden) #gl-error-text').allTextContents();
  assert.deepEqual(errorText, [], 'no error may be shown (e.g. "a screenshot is missing from device storage")');
  assert.equal(counts.startOk, 1, 'the start must reach the box exactly once, with its attachment');
  assert.equal(counts.uploadOk, 1);
  assert.deepEqual(startBody.attachments, ['00000000-0000-4000-8000-000000000003.png']);
  await context.close();
});


// --- voice/typed launch: autoSkill + prominent skill on the Started card -----

test('voice auto-send carries autoSkill true when the skill was not hand-picked, and the card shows the found skill and how', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await context.unroute(`${API_BASE}/sessions/start`);
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    bodies.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 's1', name: 'outfits - tiles', project: 'outfits', skillSource: 'screenshot' }) });
  });
  await page.click('#session-record-btn'); // stop -> auto-send
  await waitFor(() => bodies.length === 1, 'the auto-started session');
  assert.equal(bodies[0].autoSkill, true);
  await page.waitForFunction(() => /outfits/.test(document.getElementById('session-confirmation-title').textContent));
  assert.equal(await page.locator('#session-confirmation-title').textContent(), 'Started · /outfits');
  assert.equal(await page.locator('#session-confirmation-title').evaluate((el) => getComputedStyle(el).fontSize), '18px');
  const body = await page.locator('#session-confirmation-body').textContent();
  assert.match(body, /Skill picked from the screenshot/);
  assert.match(body, /outfits - tiles \(s1\)/);
  await context.close();
});

test('while the box auto-detects, the card says it is checking which skill fits', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await context.unroute(`${API_BASE}/sessions/start`);
  await context.route(`${API_BASE}/sessions/start`, () => {}); // never answers
  await page.click('#session-record-btn');
  await page.waitForFunction(() => /checking which skill fits/.test(document.getElementById('session-confirmation-body').textContent));
  assert.equal(await page.locator('#session-confirmation-title').textContent(), 'Starting');
  await context.close();
});

test('voice auto-send omits autoSkill when the skill was picked by hand in the tray', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await openTray(page);
  await trayRowLocator(page, 'project-02').click();
  await page.click('#session-record-btn'); // stop -> auto-send
  await waitFor(() => bodies.length === 1, 'the auto-started session');
  assert.equal(bodies[0].project, 'project-02');
  assert.ok(!bodies[0].autoSkill, 'a hand-picked skill must not ask the box to override it');
  await context.close();
});

test('typed Start carries autoSkill true for a default skill, omits it after a manual pick; no-skill result renders "no skill"', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(3));
  await routeRecent(context);
  const bodies = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    bodies.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: '', skillSource: null }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'first one');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => bodies.length === 1, 'first start');
  assert.equal(bodies[0].autoSkill, true);
  await page.waitForFunction(() => document.getElementById('session-confirmation-title').textContent === 'Started · no skill');
  await openTray(page);
  await trayRowLocator(page, 'project-02').click();
  await page.fill('#session-prompt', 'second one');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => bodies.length === 2, 'second start');
  assert.ok(!bodies[1].autoSkill);
  await context.close();
});

// A skill showing in the pill that detection did not put there is Oliver's
// earlier tray pick; the box must start in it, never re-detect and ask.
test('typed Start omits autoSkill for a skill restored from the last tray pick, and for one kept after a previous Start', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.addInitScript((key) => { if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, 'project-02'); }, 'gl-session-last-project-v1');
  await routeProjects(context, projectNames(3));
  await routeRecent(context);
  const bodies = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    bodies.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x' + bodies.length, name: 'n', project: 'project-02', skillSource: null }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'restored pick');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => bodies.length === 1, 'first start');
  assert.deepEqual([bodies[0].project, !!bodies[0].autoSkill], ['project-02', false]);
  await page.fill('#session-prompt', 'kept after start');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => bodies.length === 2, 'second start');
  assert.deepEqual([bodies[1].project, !!bodies[1].autoSkill], ['project-02', false]);
  await context.close();
});

/** A page whose first /sessions/start answers askSkill, later ones start; records bodies and dismissed keys. */
async function askSkillPage() {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(3));
  await routeRecent(context);
  const bodies = [], dismissed = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    const b = JSON.parse(route.request().postData());
    bodies.push(b);
    const json = bodies.length === 1 ? { askSkill: ['project-01', 'project-02'], skillSource: 'screenshot' }
      : { id: 's2', name: 'n', project: b.project, skillSource: null };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });
  await context.route(`${API_BASE}/sessions/submissions/*/dismiss`, (route) => {
    dismissed.push(decodeURIComponent(route.request().url().split('/').slice(-2)[0]));
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'make it remember');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#session-ask-skill:not(.gl-hidden)');
  return { context, page, bodies, dismissed };
}

test('an unsure auto-detect asks which skill; a chip starts the same request under it with autoSkill off', async () => {
  const { context, page, bodies, dismissed } = await askSkillPage();
  assert.equal(await page.locator('#session-confirmation-title').textContent(), 'Which skill?');
  assert.deepEqual(await page.locator('#session-ask-skill button').allTextContents(), ['/project-01', '/project-02', 'No skill', 'Put back']);
  await page.locator('#session-ask-skill button', { hasText: '/project-02' }).click();
  await waitFor(() => bodies.length === 2, 'the re-start');
  assert.deepEqual([bodies[1].project, bodies[1].prompt, !!bodies[1].autoSkill], ['project-02', 'make it remember', false]);
  assert.notEqual(bodies[1].idempotencyKey, bodies[0].idempotencyKey);
  await page.waitForFunction(() => document.getElementById('session-confirmation-title').textContent === 'Started · /project-02');
  assert.ok(await page.locator('#session-ask-skill').evaluate((el) => el.classList.contains('gl-hidden')));
  assert.equal(bodies[1].answers, bodies[0].idempotencyKey, 'the start names the question it answers');
  assert.deepEqual(dismissed, [], 'the chip path sends no separate dismiss');
  await context.close();
});

test('"Other skill…" on the skill question lists only the skills not offered as chips, and picking one starts the request under it', async () => {
  const { context, page, bodies, dismissed } = await askSkillPage();
  const options = await page.locator('#session-ask-skill select option').allTextContents();
  assert.deepEqual(options, ['Other skill…', '/project-03']);
  await page.locator('#session-ask-skill select').selectOption('project-03');
  await waitFor(() => bodies.length === 2, 'the re-start');
  assert.deepEqual([bodies[1].project, bodies[1].prompt, !!bodies[1].autoSkill], ['project-03', 'make it remember', false]);
  assert.equal(bodies[1].answers, bodies[0].idempotencyKey);
  await context.close();
});

test('"Other skill…" on an asked Recent row starts it under the picked skill', async () => {
  const { context, page, bodies, dismissed } = await askedRowPage();
  await page.locator('#session-recent-list .gl-ask-chips select').selectOption('project-03');
  await waitFor(() => bodies.length === 1, 'the start');
  assert.deepEqual([bodies[0].project, bodies[0].prompt], ['project-03', 'make it remember']);
  assert.equal(bodies[0].answers, 'askk1');
  await context.close();
});

test('"Put back" on the skill question returns the request to the composer and starts nothing', async () => {
  const { context, page, bodies, dismissed } = await askSkillPage();
  await page.locator('#session-ask-skill button', { hasText: 'Put back' }).click();
  assert.equal(await page.inputValue('#session-prompt'), 'make it remember');
  assert.ok(await page.locator('#session-confirmation').evaluate((el) => el.classList.contains('gl-hidden')));
  await waitFor(() => dismissed.includes(bodies[0].idempotencyKey), 'the asked row retired');
  assert.equal(bodies.length, 1);
  await context.close();
});

/** A page whose Recent holds one unanswered skill question from the box; records start bodies and dismissed keys. */
async function askedRowPage({ holdStart = false } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context, projectNames(3));
  let sessions = [{ id: null, key: 'askk1', name: 'make it remember', prompt: 'make it remember', summary: 'Which skill?', state: 'blocked', kind: 'submission', askSkill: ['project-01', 'project-02'], attachments: [], sessionId: null, startedAt: Date.now(), activityAt: Date.now() }];
  await context.route(`${API_BASE}/sessions/recent*`, (route) => OK_JSON(route, 200, { sessions }));
  const bodies = [], dismissed = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    const b = JSON.parse(route.request().postData());
    bodies.push(b);
    if (holdStart) return route.abort('internetdisconnected');
    if (b.answers) sessions = sessions.filter((x) => x.key !== b.answers);
    OK_JSON(route, 200, { id: 's2', name: 'n', project: b.project, skillSource: null });
  });
  await context.route(`${API_BASE}/sessions/submissions/*/dismiss`, (route) => {
    dismissed.push(decodeURIComponent(route.request().url().split('/').slice(-2)[0]));
    sessions = [];
    OK_JSON(route, 200, { ok: true });
  });
  const page = await newSessionPage(context);
  await page.waitForSelector('#session-recent-list .gl-ask-chips');
  return { context, page, bodies, dismissed };
}

test('an unanswered skill question in Recent sits under Needs input with its chips, and a chip starts it under that skill and retires the row', async () => {
  const { context, page, bodies, dismissed } = await askedRowPage();
  assert.match(await page.locator('#session-recent-list .gl-recent-group-label').first().textContent(), /Needs input/);
  assert.equal(await page.locator('#session-recent-list .gl-recent-glyph').first().textContent(), '✻');
  assert.deepEqual(await page.locator('#session-recent-list .gl-ask-chips button').allTextContents(), ['/project-01', '/project-02', 'No skill', 'Put back']);
  await page.locator('#session-recent-list .gl-ask-chips button', { hasText: '/project-02' }).click();
  await waitFor(() => bodies.length === 1, 'the start');
  assert.deepEqual([bodies[0].project, bodies[0].prompt, !!bodies[0].autoSkill], ['project-02', 'make it remember', false]);
  assert.equal(bodies[0].answers, 'askk1');
  assert.deepEqual(dismissed, []);
  await context.close();
});

test('an asked Recent row whose answer is queued stays hidden across a reload while offline, and the queued Start carries answers', async () => {
  const { context, page } = await askedRowPage({ holdStart: true });
  await page.locator('#session-recent-list .gl-ask-chips button', { hasText: '/project-02' }).click();
  await page.waitForSelector('#session-recent-list .gl-row');
  const queue = await page.evaluate(() => JSON.parse(localStorage.getItem('gl-session-pending-starts-v1')));
  assert.equal(queue[0].body.answers, 'askk1');
  await page.reload();
  await page.waitForSelector('#session-recent-list .gl-recent-group');
  assert.deepEqual(await page.locator('#session-recent-list .gl-ask-chips button').allTextContents(), ['Clarify', 'Cancel'], 'the answered question is not repainted; only the queued Start\'s own chips remain');
  await context.close();
});

test('"Put back" on an asked Recent row returns its text to the composer, starts nothing, and retires the row', async () => {
  const { context, page, bodies, dismissed } = await askedRowPage();
  await page.locator('#session-recent-list .gl-ask-chips button', { hasText: 'Put back' }).click();
  assert.equal(await page.inputValue('#session-prompt'), 'make it remember');
  await waitFor(() => dismissed.includes('askk1'), 'the asked row retired');
  assert.equal(bodies.length, 0);
  await context.close();
});

// --- clarifications: a follow-up typed on the Starting/Started card, addressed by the Start's idempotency key ---

const CLARIFY_QUEUE = 'gl-session-pending-clarify-v1';
const OK_JSON = (route, status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

/** Types a prompt and presses Start; resolves once the confirmation card shows the clarify box. */
async function pressStart(page, text) {
  await page.fill('#session-prompt', text);
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForSelector('#session-clarify:not(.gl-hidden)');
}

/** Routes /sessions/clarify to handler(route, body), recording every body in the returned array. */
async function routeClarify(context, handler) {
  const bodies = [];
  await context.route(`${API_BASE}/sessions/clarify`, (route) => {
    const body = JSON.parse(route.request().postData());
    bodies.push(body);
    return handler(route, body);
  });
  return bodies;
}

test("clarify: typed while /sessions/start is still pending, it is sent only AFTER the start resolves, with THAT start's key", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { context, page, calls } = await startPageWithStartRoute(async (route) => { await gate; return OK_START(route); });
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 200, { delivered: 'live' }));
  await pressStart(page, 'build the thing');
  await waitFor(() => calls.length === 1, 'the start request to be sent');
  await page.fill('#session-clarify-text', 'also use tabs');
  await page.click('#session-clarify-send');
  await page.waitForFunction(() => /Sending clarification/.test(document.getElementById('session-clarify-status').textContent));
  await page.waitForTimeout(500);
  assert.equal(bodies.length, 0, 'no clarify while the Start is unanswered');
  assert.equal(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), CLARIFY_QUEUE)).length, 1, 'held on disk meanwhile');
  release();
  await waitFor(() => bodies.length === 1, 'the clarification to be sent after the start resolved');
  assert.equal(bodies[0].startKey, calls[0].idempotencyKey);
  assert.equal(bodies[0].text, 'also use tabs');
  assert.ok(typeof bodies[0].idempotencyKey === 'string' && bodies[0].idempotencyKey.length > 6);
  await page.waitForFunction(() => /Clarification sent into the running session/.test(document.getElementById('session-clarify-status').textContent));
  await drained(page, CLARIFY_QUEUE);
  await context.close();
});

test("clarify: typed while a voice send is still transcribing, it waits (no clarify request), then goes out with the key the voice Start carried", async () => {
  const starts = [];
  const { context, page } = await slidePage(starts);
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 200, { delivered: 'live' }));
  await page.evaluate(() => window.__glMock.configure({ delays: { voiceStop: 1500 } }));
  await page.click('#session-record-btn'); // stop = send; voiceStop is slow
  await page.waitForFunction(() => /Transcribing, then starting/.test(document.getElementById('session-confirmation-body').textContent));
  await page.waitForSelector('#session-clarify:not(.gl-hidden)');
  await page.fill('#session-clarify-text', 'and use tabs');
  await page.click('#session-clarify-send');
  await page.waitForTimeout(400);
  assert.equal(starts.length, 0, 'still transcribing');
  assert.equal(bodies.length, 0, 'no clarify while the voice launch is unanswered');
  assert.equal(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), CLARIFY_QUEUE)).length, 1, 'held on disk meanwhile');
  await waitFor(() => starts.length === 1, 'the start after the transcript');
  await waitFor(() => bodies.length === 1, 'the clarification after the start resolved');
  assert.equal(bodies[0].startKey, starts[0].idempotencyKey);
  assert.equal(bodies[0].text, 'and use tabs');
  await drained(page, CLARIFY_QUEUE);
  await context.close();
});

test("clarify: discarding a failed voice launch drops the clarifications queued for it", async () => {
  const { context, page } = await slidePage([]);
  await page.evaluate(() => window.__glMock.configure({ delays: { voiceStop: 1500 }, responses: { voiceStop: { code: 'failed', id: 'v2', error: 'transcription failed (HTTP 400)' } } }));
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-clarify:not(.gl-hidden)');
  await page.fill('#session-clarify-text', 'orphan note');
  await page.click('#session-clarify-send');
  assert.equal(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), CLARIFY_QUEUE)).length, 1);
  await page.waitForSelector('.gl-row-failed');
  await page.click('.gl-row-failed button:has-text("Discard")');
  await page.waitForFunction(() => document.querySelectorAll('#session-recent-list .gl-row').length === 0);
  await drained(page, CLARIFY_QUEUE);
  await context.close();
});

test('clarify: an offline clarification stays in localStorage and is replayed (same key) on the "online" event', async () => {
  const { context, page } = await startPageWithStartRoute((route) => OK_START(route));
  let offline = true;
  const bodies = await routeClarify(context, (route) => (offline ? route.abort('connectionrefused') : OK_JSON(route, 200, {})));
  await pressStart(page, 'offline clarify');
  await page.waitForFunction(() => /made it/.test(document.getElementById('session-confirmation-body').textContent));
  await page.fill('#session-clarify-text', 'second thought');
  await page.click('#session-clarify-send');
  await page.waitForFunction(() => /Saved\. Sends when the box is reachable/.test(document.getElementById('session-clarify-status').textContent));
  const queued = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), CLARIFY_QUEUE));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, 'second thought');
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => bodies.length >= 2, 'the replay');
  assert.equal(bodies[bodies.length - 1].idempotencyKey, bodies[0].idempotencyKey, 'replay reuses the key so the server dedupes');
  assert.equal(bodies[bodies.length - 1].startKey, queued[0].startKey);
  await drained(page, CLARIFY_QUEUE);
  await page.waitForFunction(() => /Clarification sent/.test(document.getElementById('session-clarify-status').textContent));
  await context.close();
});

test('clarify: a picked photo is uploaded and its id rides in /sessions/clarify attachments; a photo-only send (no text) works', async () => {
  const { context, page } = await startPageWithStartRoute((route) => OK_START(route));
  const uploads = [];
  await routeUpload(context, uploads);
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 200, { delivered: 'live' }));
  await pressStart(page, 'photo clarify');
  await page.waitForFunction(() => /made it/.test(document.getElementById('session-confirmation-body').textContent));
  await page.setInputFiles('#session-clarify-attach-input', [fakeImage('clar1.png')]);
  assert.equal(await page.locator('#session-clarify-thumbs .gl-thumb').count(), 1);
  await page.fill('#session-clarify-text', 'see this');
  await page.click('#session-clarify-send');
  await waitFor(() => bodies.length === 1, 'the clarification with a photo');
  assert.equal(bodies[0].text, 'see this');
  assert.deepEqual(bodies[0].attachments, [idForBuffer(fakeImage('clar1.png').buffer)]);
  assert.equal(uploads.length, 1);
  assert.equal(await page.locator('#session-clarify-thumbs .gl-thumb').count(), 0, 'box cleared after send');
  await drained(page, CLARIFY_QUEUE);
  // photo only
  await page.setInputFiles('#session-clarify-attach-input', [fakeImage('clar2.png')]);
  await page.click('#session-clarify-send');
  await waitFor(() => bodies.length === 2, 'the photo-only clarification');
  assert.equal(bodies[1].text, '');
  assert.deepEqual(bodies[1].attachments, [idForBuffer(fakeImage('clar2.png').buffer)]);
  await context.close();
});

test('clarify: a 4xx puts the text back in the box, shows the error, and is not retried', async () => {
  const { context, page } = await startPageWithStartRoute((route) => OK_START(route));
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 400, { error: 'session already finished' }));
  await pressStart(page, 'will be clarified');
  await page.waitForFunction(() => /made it/.test(document.getElementById('session-confirmation-body').textContent));
  await page.fill('#session-clarify-text', 'too late');
  await page.click('#session-clarify-send');
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  assert.match(await page.locator('#gl-error-text').textContent(), /Couldn't send the clarification: session already finished/);
  assert.equal(await page.inputValue('#session-clarify-text'), 'too late');
  assert.equal(await page.locator('#session-clarify-status').isVisible(), false, 'no stale "Sending" status left behind');
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), CLARIFY_QUEUE), null);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(400);
  assert.equal(bodies.length, 1, 'a 4xx must never be replayed');
  await context.close();
});

test('clarify: a REJECTED Start keeps its clarifications queued; Edit gives them back in the prompt, after the original prompt', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { context, page, calls } = await startPageWithStartRoute(async (route) => {
    await gate;
    return OK_JSON(route, 400, { error: 'bad project' });
  });
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 200, {}));
  await pressStart(page, 'original prompt');
  await waitFor(() => calls.length === 1, 'the start request');
  await page.fill('#session-clarify-text', 'extra detail');
  await page.click('#session-clarify-send');
  release();
  await page.waitForSelector('.gl-row-failed');
  assert.match(await page.locator('.gl-row-failed').textContent(), /bad project/);
  assert.equal(await page.inputValue('#session-prompt'), '', 'the failed request is a row, not composer text');
  await page.click('.gl-row-failed button:has-text("Edit")');
  assert.equal(await page.inputValue('#session-prompt'), 'original prompt\n\nextra detail');
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), CLARIFY_QUEUE), null, 'queue drained, not left to fire at a Start that never happened');
  assert.equal(await page.locator('#session-clarify').isVisible(), false);
  await page.waitForTimeout(400);
  assert.equal(bodies.length, 0, 'nothing was sent to the box');
  await context.close();
});

test('clarify: an OLDER Start finishing late does not take over the card from the newer Start', async () => {
  const gates = [];
  const { context, page, calls } = await startPageWithStartRoute((route, n) => new Promise((resolve) => {
    gates[n] = () => resolve(route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'id' + n, name: 'start number ' + n, project: 'project-01' }) }));
  }));
  await routeClarify(context, (route) => OK_JSON(route, 200, {}));
  await pressStart(page, 'first');
  await waitFor(() => calls.length === 1, 'first start');
  // The first Start is unanswered, so the second stays queued behind it and owns the card.
  await pressStart(page, 'second');
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k) || '[]').length === 2, START_QUEUE);
  gates[1]();
  await waitFor(() => calls.length === 2, 'second start to be sent once the first resolved');
  assert.notEqual(calls[1].idempotencyKey, calls[0].idempotencyKey);
  // The older Start has answered; its result must not be on the card, and the card must still be the second's.
  assert.doesNotMatch(await page.locator('#session-confirmation-body').textContent(), /start number 1/);
  assert.equal(await page.locator('#session-clarify').isVisible(), true);
  gates[2]();
  await page.waitForFunction(() => /start number 2/.test(document.getElementById('session-confirmation-body').textContent));
  assert.doesNotMatch(await page.locator('#session-confirmation-body').textContent(), /start number 1/);
  await context.close();
});

test('clarify: no horizontal overflow at 390px with the clarify box shown and a long unbroken clarification typed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, async (route) => { await gate; return OK_START(route); });
  const page = await newSessionPage(context);
  await pressStart(page, 'layout check');
  await page.fill('#session-clarify-text', 'x'.repeat(300));
  assert.equal(await page.locator('#session-clarify-send').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  release();
  await context.close();
});

// --- reply with screenshots (session detail) ---

const replyThumbs = (page) => page.locator('#detail-thumbs .gl-thumb');
const queuedReplies = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), REPLY_QUEUE);

test('Reply + screenshot: the reply is queued (with the screenshot pending) before anything is cleared, then uploads, then posts the attachment ids', async () => {
  const uploads = [];
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => routeUpload(c, uploads) });
  h.replyAbort = true; // hold the reply in the queue so the saved item can be inspected
  await page.setInputFiles('#detail-attach-input', fakeImage('one.png'));
  await replyThumbs(page).first().waitFor();
  assert.equal(uploads.length, 0, 'upload happens on send, not on pick');
  await page.fill('#detail-reply', 'here is context');
  await page.click('#detail-send');
  await waitFor(() => h.replies.length >= 1, 'the reply POST');
  const [item] = await queuedReplies(page);
  assert.equal(item.text, 'here is context');
  assert.equal(item.pending.length, 1);
  assert.equal(item.pending[0].id, 'id-one.png', 'the upload id is saved into the queued item');
  assert.deepEqual(h.replies[0].attachments, ['id-one.png']);
  assert.equal(await replyThumbs(page).count(), 0, 'composer thumbs cleared once queued');
  assert.equal(await page.inputValue('#detail-reply'), '');
  assert.match(await page.locator('.gl-bubble-images').textContent(), /1 screenshot/);
  await context.close();
});

test('Reply + screenshot survives a network failure: stays queued, retried on online with the SAME key, uploaded exactly once, blob deleted when it resolves', async () => {
  const uploads = [];
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => routeUpload(c, uploads) });
  h.replyAbort = true;
  await page.setInputFiles('#detail-attach-input', fakeImage('keep.png'));
  await page.fill('#detail-reply', 'retry me');
  await page.click('#detail-send');
  await waitFor(() => h.replies.length >= 1, 'first reply attempt');
  assert.equal((await queuedReplies(page)).length, 1, 'network failure keeps it queued');
  assert.equal(await page.locator('.gl-bubble.failed').count(), 0);
  h.replyAbort = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => h.replies.length >= 2, 'the retry');
  assert.equal(h.replies[1].idempotencyKey, h.replies[0].idempotencyKey);
  assert.deepEqual(h.replies[1].attachments, ['id-keep.png']);
  assert.equal(uploads.length, 1, 'the already-uploaded screenshot is not uploaded again');
  await drained(page, REPLY_QUEUE);
  await page.waitForFunction(() => new Promise((res) => {
    const r = indexedDB.open('gl-session-attachments', 1);
    r.onsuccess = () => { const c = r.result.transaction('blobs').objectStore('blobs').count(); c.onsuccess = () => res(c.result === 0); };
  }));
  await context.close();
});

test('Reply screenshot-only is allowed: the bubble reads the placeholder text and the POST carries it with the attachment', async () => {
  const uploads = [];
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => routeUpload(c, uploads) });
  await page.setInputFiles('#detail-attach-input', fakeImage('only.png'));
  await page.click('#detail-send');
  await waitFor(() => h.replies.length === 1, 'the reply POST');
  assert.equal(h.replies[0].text, 'See the attached screenshot(s).');
  assert.deepEqual(h.replies[0].attachments, ['id-only.png']);
  assert.equal(await page.locator('.gl-bubble').last().textContent(), 'See the attached screenshot(s).');
  await context.close();
});

test('Reply with no text and no screenshot still sends nothing; removing the thumb makes it empty again', async () => {
  const uploads = [];
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => routeUpload(c, uploads) });
  await page.setInputFiles('#detail-attach-input', fakeImage('gone.png'));
  await replyThumbs(page).first().waitFor();
  await page.click('#detail-thumbs .gl-thumb-remove');
  assert.equal(await replyThumbs(page).count(), 0);
  await page.click('#detail-send');
  await page.waitForTimeout(300);
  assert.equal(h.replies.length, 0);
  assert.equal(uploads.length, 0);
  await context.close();
});

test('Reply screenshot rejected by the box (HTTP 400): not retried, bubble failed, queue drained', async () => {
  const uploads = [];
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => routeUpload(c, uploads), replyStatus: 400, replyBody: { error: 'unknown attachment: x' } });
  await page.setInputFiles('#detail-attach-input', fakeImage('bad.png'));
  await page.click('#detail-send');
  await page.waitForSelector('.gl-bubble.failed');
  assert.equal((await queuedReplies(page)).length, 0);
  assert.match(await page.locator('#gl-error-text').textContent(), /unknown attachment/);
  await context.close();
});

test('interactive session: reply attach and dictate buttons are disabled with the composer', async () => {
  const { context, page } = await openDetailPage({ sess: { kind: 'interactive', state: 'idle' } });
  assert.equal(await page.locator('#detail-attach-btn').isDisabled(), true);
  assert.equal(await page.locator('#detail-record-btn').isDisabled(), true);
  await context.close();
});

// --- reply mic: same gesture as the launcher mic (tap-tap sends, hold = Insert / Cancel) ---

const REPLY_LAUNCHES = 'gl-session-voice-reply-launches-v1';
const replyLaunches = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), REPLY_LAUNCHES);
const mockVoice = (page, responses) => page.evaluate((r) => window.__glMock.configure({ responses: r }), responses);
const pollNow = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

async function recordingReplyPage(opts = {}) {
  const r = await openDetailPage(opts);
  await r.page.click('#detail-record-btn');
  await r.page.waitForSelector('#detail-record-btn.recording');
  return r;
}

test('reply dictation: tap-tap stops, transcribes and SENDS typed + transcript as a reply; box clears at once, launcher prompt untouched', async () => {
  const { context, page, h } = await openDetailPage();
  await page.fill('#detail-reply', 'before');
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] })); // hold the transcript back to see the pending state
  await page.click('#detail-record-btn');
  await page.waitForSelector('#detail-record-btn.recording');
  await page.click('#detail-record-btn');
  // Committed before any answer: box empty, a pending bubble with the typed text, a durable record naming the session.
  assert.equal(await page.inputValue('#detail-reply'), '');
  await page.waitForSelector('.gl-bubble.pending');
  assert.equal(await page.locator('.gl-bubble.pending').textContent(), 'before …');
  const rec = Object.values(await replyLaunches(page));
  assert.equal(rec.length, 1);
  assert.equal(rec[0].sessionId, 'sess-uuid-1');
  assert.equal(rec[0].prefix, 'before');
  assert.equal(h.replies.length, 0);
  await page.evaluate(() => window.__glMock.replyNow('voiceStop', { text: 'a fake voice transcript' }));
  await waitFor(() => h.replies.length === 1, 'the voice reply');
  assert.equal(h.replies[0].text, 'before a fake voice transcript');
  assert.equal(await page.inputValue('#session-prompt'), '');
  await page.waitForFunction(() => document.querySelector('.gl-bubble.pending') === null || document.querySelector('.gl-bubble:not(.pending)'));
  assert.ok((await callsTo(page, 'voiceAck')).length >= 1, 'recording acked once the reply is durable');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, REPLY_LAUNCHES);
  await context.close();
});

test('reply dictation: typed text and attached screenshots both go with the voice reply', async () => {
  const uploads = [];
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => routeUpload(c, uploads) });
  await page.fill('#detail-reply', 'see this');
  await page.setInputFiles('#detail-attach-input', fakeImage('one.png'));
  await page.waitForSelector('#detail-thumbs .gl-thumb');
  await page.click('#detail-record-btn');
  await page.waitForSelector('#detail-record-btn.recording');
  await page.click('#detail-record-btn');
  assert.equal(await page.locator('#detail-thumbs .gl-thumb').count(), 0, 'screenshots leave the composer with the send');
  await waitFor(() => h.replies.length === 1, 'the voice reply');
  assert.equal(h.replies[0].text, 'see this a fake voice transcript');
  assert.deepEqual(h.replies[0].attachments, ['id-one.png']);
  await context.close();
});

test('reply dictation: hold + Insert puts the transcript in the reply box and sends nothing', async () => {
  const { context, page, h } = await recordingReplyPage({ hasTouch: true });
  await page.fill('#detail-reply', 'before');
  const { touch, target } = await holdMic(page, 'detail');
  await touch('touchMove', target);
  await page.waitForSelector('#detail-insert-target.armed');
  await touch('touchEnd');
  await page.waitForFunction(() => document.getElementById('detail-reply').value === 'before a fake voice transcript');
  await page.waitForTimeout(300);
  assert.equal(h.replies.length, 0, 'insert must not send');
  assert.equal(await page.locator('#detail-record-btn').evaluate((el) => el.classList.contains('recording')), false);
  assert.deepEqual(await replyLaunches(page), {});
  await context.close();
});

test('reply dictation: hold + Cancel discards the audio (voiceCancel), no transcription, nothing sent, typed text kept', async () => {
  const { context, page, h } = await recordingReplyPage({ hasTouch: true });
  await page.fill('#detail-reply', 'keep me');
  const { touch, cancel } = await holdMic(page, 'detail');
  await touch('touchMove', cancel);
  await page.waitForSelector('#detail-cancel-target.armed');
  await touch('touchEnd');
  await page.waitForFunction(() => window.__glCallLog.some((c) => c.method === 'voiceCancel'));
  await page.waitForSelector('#detail-hold-targets', { state: 'hidden' });
  assert.equal((await callsTo(page, 'voiceStop')).length, 0);
  assert.equal(await page.inputValue('#detail-reply'), 'keep me');
  await page.waitForTimeout(300);
  assert.equal(h.replies.length, 0);
  await context.close();
});

test('reply dictation: releasing the hold elsewhere dismisses the targets and keeps recording', async () => {
  const { context, page, h } = await recordingReplyPage({ hasTouch: true });
  const { touch } = await holdMic(page, 'detail');
  await touch('touchMove', { x: 380, y: 100 });
  await touch('touchEnd');
  await page.waitForSelector('#detail-hold-targets', { state: 'hidden' });
  assert.equal(await page.locator('#detail-record-btn').evaluate((el) => el.classList.contains('recording')), true);
  assert.equal((await callsTo(page, 'voiceStop')).length, 0);
  assert.equal((await callsTo(page, 'voiceCancel')).length, 0);
  assert.equal(h.replies.length, 0);
  await context.close();
});

test('reply hold targets pop ABOVE the mic, left-aligned and fully on screen at 390x844', async () => {
  const { context, page } = await recordingReplyPage({ hasTouch: true });
  const { touch } = await holdMic(page, 'detail');
  const mic = await page.locator('#detail-record-btn').boundingBox();
  for (const id of ['detail-insert-target', 'detail-cancel-target']) {
    const b = await page.locator('#' + id).boundingBox();
    assert.ok(b.y + b.height <= mic.y, `${id} sits above the mic`);
    assert.ok(b.x >= 0 && b.x + b.width <= 390 && b.y >= 0, `${id} is fully on screen`);
  }
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await touch('touchEnd');
  await context.close();
});

test('reply dictation, queued stop: the late transcript from voicePending is sent to the session that dictated it, even after the detail was closed', async () => {
  const { context, page, h } = await recordingReplyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.fill('#detail-reply', 'typed');
  await mockVoice(page, { voiceStop: { code: 'queued', id: 'v9' }, voicePending: { ready: [], failed: [], pending: [], waiting: 1 } });
  await page.click('#detail-record-btn');
  await page.waitForFunction((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')).some((r) => r.status === 'waiting' && r.voiceId === 'v9'), REPLY_LAUNCHES);
  assert.equal(await page.inputValue('#detail-reply'), '');
  await page.waitForSelector('.gl-bubble.pending');
  await page.click('#gl-back-btn'); // leave the session before the transcript exists
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  await mockVoice(page, { voicePending: { ready: [{ id: 'v9', text: 'late words', launchId }], failed: [], pending: [], waiting: 0 } });
  await pollNow(page);
  await waitFor(() => h.replies.length === 1, 'the late reply');
  assert.equal(h.replies[0].text, 'typed late words');
  assert.equal(await page.inputValue('#session-prompt'), '', 'never the launcher prompt');
  await pollNow(page);
  await page.waitForTimeout(300);
  assert.equal(h.replies.length, 1, 'sent once');
  assert.ok((await callsTo(page, 'voiceAck')).some((p) => p.id === 'v9'));
  await context.close();
});

test('reply dictation, queued stop then page reload: the transcript still reaches the right session', async () => {
  const { context, page, h } = await recordingReplyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.fill('#detail-reply', 'typed');
  await mockVoice(page, { voiceStop: { code: 'queued', id: 'v9' } });
  await page.click('#detail-record-btn');
  await page.waitForFunction((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')).some((r) => r.status === 'waiting'), REPLY_LAUNCHES);
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await mockVoice(page, { voicePending: { ready: [{ id: 'v9', text: 'after reload', launchId }], failed: [], pending: [], waiting: 0 } });
  await pollNow(page);
  await waitFor(() => h.replies.length === 1, 'the reply after reload');
  assert.equal(h.replies[0].text, 'typed after reload');
  assert.equal(await page.inputValue('#session-prompt'), '');
  await context.close();
});

test('reply dictation, empty transcript: typed text and screenshots come back to the reply box with an error, nothing sent', async () => {
  const uploads = [];
  const { context, page, h } = await openDetailPage({ beforeNav: (c) => routeUpload(c, uploads) });
  await page.fill('#detail-reply', 'do not lose me');
  await page.setInputFiles('#detail-attach-input', fakeImage('keep.png'));
  await page.waitForSelector('#detail-thumbs .gl-thumb');
  await mockVoice(page, { voiceStop: { code: 'empty_transcript' } });
  await page.click('#detail-record-btn');
  await page.waitForSelector('#detail-record-btn.recording');
  await page.click('#detail-record-btn');
  await page.waitForFunction(() => document.getElementById('detail-reply').value === 'do not lose me');
  assert.equal(await page.locator('#detail-thumbs .gl-thumb').count(), 1, 'screenshot restored');
  assert.match(await page.locator('#gl-error-text').textContent(), /Didn't catch anything/);
  assert.equal(await page.locator('.gl-bubble.pending').count(), 0);
  assert.deepEqual(await replyLaunches(page), {});
  // The restored screenshot is still sendable: its blob was kept.
  await page.click('#detail-send');
  await waitFor(() => h.replies.length === 1, 'the manual reply');
  assert.equal(h.replies[0].text, 'do not lose me');
  assert.deepEqual(h.replies[0].attachments, ['id-keep.png']);
  await context.close();
});

test('reply recording left running when the detail is closed: stopping it from the launcher mic inserts the transcript in the prompt, sends nothing', async () => {
  const { context, page, h } = await recordingReplyPage();
  await page.click('#gl-back-btn');
  await page.waitForSelector('#gl-launcher', { state: 'visible' }); // the launcher mic does not show the reply's recording state, but its tap stops it
  await page.click('#session-record-btn');
  await page.waitForFunction(() => document.getElementById('session-prompt').value === 'a fake voice transcript');
  await page.waitForTimeout(300);
  assert.equal(h.replies.length, 0, 'no reply auto-sent');
  assert.deepEqual(await replyLaunches(page), {});
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-voice-launches-v1')), null, 'no launcher launch either');
  assert.ok((await callsTo(page, 'voiceAck')).length >= 1, 'recording acked after the insert');
  await context.close();
});

test('reply dictation, failed transcription while the detail is closed: the text waits and is restored when the session is reopened', async () => {
  const { context, page } = await recordingReplyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.fill('#detail-reply', 'still mine');
  await mockVoice(page, { voiceStop: { code: 'queued', id: 'v7' } });
  await page.click('#detail-record-btn');
  await page.waitForFunction((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')).some((r) => r.status === 'waiting'), REPLY_LAUNCHES);
  await page.click('#gl-back-btn');
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  await mockVoice(page, { voicePending: { ready: [], failed: [{ id: 'v7', error: 'asr down', launchId }], pending: [], waiting: 0 } });
  await pollNow(page);
  await page.waitForFunction(() => /asr down/.test(document.getElementById('gl-error-text').textContent));
  await page.click('#session-recent-list .gl-row');
  await page.waitForFunction(() => document.getElementById('detail-reply').value === 'still mine');
  assert.deepEqual(await replyLaunches(page), {});
  await context.close();
});

// --- Start on a hanging connection ------------------------------------------
// A dead-slow link never rejects, it just never answers. Neither the projects
// load nor /sessions/start has a deadline of its own, so Start stayed disabled
// forever (no cache) or the saved request was never retried (flushingStarts
// stuck true). A hung request must be treated like an unreachable box.

/** Routes a path so the request is accepted but never answered (until the context closes). */
async function routeHang(context, pattern, onRequest) {
  await context.route(`${API_BASE}${pattern}`, (route) => {
    if (onRequest) onRequest(route);
    return new Promise(() => {});
  });
}

test('hanging network, no projects cache: Start is usable and queues the request within the load deadline', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeHang(context, '/sessions/projects*');
  await routeHang(context, '/sessions/recent*');
  const starts = [];
  await routeHang(context, '/sessions/start', (route) => starts.push(JSON.parse(route.request().postData())));
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(SESSION_URL);
  await page.fill('#session-prompt', 'typed on a dead link');
  await page.locator('#session-prompt').blur(); // keyboard down: no dictation settle timer under the frozen clock
  await page.clock.fastForward(30000);
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  assert.equal(await page.inputValue('#session-prompt'), '', 'the composer clears at the tap');
  assert.equal(await page.locator('#session-confirmation').isHidden(), false, 'the queued state shows');
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('gl-session-pending-starts-v1')));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].body.prompt, 'typed on a dead link');
  await context.close();
});

test('hanging /sessions/start: the request stays saved, the hang is abandoned, and the box is retried with the same key', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const seenKeys = [];
  let calls = 0;
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    calls += 1;
    seenKeys.push(JSON.parse(route.request().postData()).idempotencyKey);
    if (calls === 1) return new Promise(() => {}); // never answers
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'late0001', name: 'late', project: 'project-01' }) });
  });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.fill('#session-prompt', 'slow link');
  await page.locator('#session-prompt').blur(); // keyboard down: no dictation settle timer under the frozen clock
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  assert.equal(await page.inputValue('#session-prompt'), '');
  await waitFor(() => calls >= 1, 'the first (hung) Start request');
  // Past the request deadline the hung request is abandoned and reported; past the retry timer it is replayed.
  await page.clock.fastForward(61000);
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  await page.clock.fastForward(16000);
  await waitFor(() => calls >= 2, 'the automatic replay after the hang');
  assert.equal(seenKeys[0], seenKeys[1], 'the replay reuses the idempotencyKey');
  await page.waitForFunction(() => !localStorage.getItem('gl-session-pending-starts-v1'));
  await context.close();
});

// --- pending starts and failed submissions in Recent ----------------------------

const recentRows = (page) => page.locator('#session-recent-list .gl-row');

test('Recent shows a Start the box has not answered, from the tap, and swaps it for the real session once answered', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { context, page } = await startPageWithStartRoute(async (route) => { await gate; return OK_START(route); });
  let sessions = [];
  await context.route(`${API_BASE}/sessions/recent*`, (route) => OK_JSON(route, 200, { sessions }));
  await page.fill('#session-prompt', 'refactor the launcher');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForFunction(() => /refactor the launcher/.test(document.getElementById('session-recent-list').textContent));
  const row = recentRows(page).first();
  assert.match(await row.textContent(), /Saved on this phone — sending…/);
  assert.match(await page.locator('#session-recent-list .gl-recent-group-label').first().textContent(), /Sending/);
  await row.click(); // harmless: no detail opens
  assert.equal(await page.locator('#gl-detail').isHidden(), true);
  sessions = [{ id: 'ok000001', name: 'made it', state: 'working', kind: 'background', sessionId: '11111111-2222-4333-8444-555555555555', startedAt: Date.now(), activityAt: Date.now() }];
  release();
  await page.waitForFunction(() => /made it/.test(document.getElementById('session-recent-list').textContent));
  assert.doesNotMatch(await page.locator('#session-recent-list').textContent(), /sending/);
  assert.equal(await recentRows(page).count(), 1);
  await context.close();
});

test('Recent shows an unanswered Start as waiting for connection after a network failure', async () => {
  const { context, page } = await startPageWithStartRoute((route) => route.abort('connectionrefused'));
  await page.fill('#session-prompt', 'offline thought');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForFunction(() => /Waiting for connection — will send automatically/.test(document.getElementById('session-recent-list').textContent));
  assert.match(await recentRows(page).first().textContent(), /offline thought/);
  await context.close();
});

test('a failed submission row from the box restores its prompt into the composer on tap, dismisses it, and never opens a detail', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  let sessions = [{ id: null, key: 'subk1', name: 'lost words', prompt: 'lost words that must not vanish', summary: 'Not started: boom', state: 'failed', kind: 'submission', sessionId: null, startedAt: Date.now(), activityAt: Date.now() }];
  await context.route(`${API_BASE}/sessions/recent*`, (route) => OK_JSON(route, 200, { sessions }));
  const dismissed = [];
  await context.route(`${API_BASE}/sessions/submissions/*/dismiss`, (route) => {
    dismissed.push(route.request().url());
    sessions = [];
    return OK_JSON(route, 200, { ok: true });
  });
  const page = await newSessionPage(context);
  await page.waitForFunction(() => /Not started: boom/.test(document.getElementById('session-recent-list').textContent));
  await page.fill('#session-prompt', 'typed since');
  await recentRows(page).first().click();
  assert.equal(await page.inputValue('#session-prompt'), 'lost words that must not vanish\n\ntyped since');
  await waitFor(() => dismissed.length === 1, 'the dismiss call');
  assert.equal(dismissed[0], `${API_BASE}/sessions/submissions/subk1/dismiss`);
  assert.equal(await page.locator('#gl-detail').isHidden(), true);
  await page.waitForFunction(() => !document.getElementById('session-recent-list').textContent.includes('Not started: boom'));
  await context.close();
});

// The box takes 20-30s to answer /sessions/start (Haiku skill suggestion +
// title + `claude --bg`). Under the 15s read deadline every start was
// reported "Box unreachable" and only the replay succeeded.
test('slow /sessions/start (25s): no unreachable error, the one request succeeds', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  let calls = 0;
  let release;
  const answered = new Promise((r) => { release = r; });
  await context.route(`${API_BASE}/sessions/start`, async (route) => {
    calls += 1;
    await answered;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'slow0001', name: 'slow', project: 'project-01' }) });
  });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(SESSION_URL);
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await page.fill('#session-prompt', 'busy box');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await waitFor(() => calls >= 1, 'the Start request');
  await page.clock.fastForward(25000);
  assert.equal(await page.locator('#gl-error').evaluate((el) => el.classList.contains('gl-hidden')), true, 'no error while the box is still working');
  release();
  await page.waitForFunction(() => !localStorage.getItem('gl-session-pending-starts-v1'));
  assert.equal(calls, 1, 'no replay was needed');
  assert.equal(await page.locator('#gl-error').evaluate((el) => el.classList.contains('gl-hidden')), true);
  await context.close();
});

// --- inbox quick-select strip ----------------------------------------------

/**
 * A session page whose /sessions/inbox-recents answers from `state.names`
 * (mutable, so a test can change what the server returns between fetches),
 * counting every recents request in `state.recentsCalls`. Thumbnails are a real
 * PNG and /sessions/inbox-claim/<name> answers {id: 'claim-<name>'}.
 */
async function inboxPage(names, { fakeClock = false } = {}) {
  const state = { names, recentsCalls: 0 };
  const context = await browser.newContext();
  // A native build without the camera-roll methods: the page falls back to the inbox.
  await context.addInitScript(buildMockBridgeScript({ ...baseConfig(), errors: { recentPhotos: 'unknown method recentPhotos' } }));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/inbox-recents*`, (route) => {
    state.recentsCalls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recents: state.names.map((name) => ({ name })) }) });
  });
  await context.route(`${API_BASE}/sessions/inbox-image/*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: REAL_PNG }));
  await context.route(`${API_BASE}/sessions/inbox-claim/*`, (route) => {
    const name = decodeURIComponent(route.request().url().split('/inbox-claim/')[1]);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'claim-' + name }) });
  });
  let page;
  if (fakeClock) {
    // The clock has to be installed before the page's scripts arm their timers.
    page = await context.newPage();
    await page.clock.install();
    await page.goto(SESSION_URL);
    await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  } else {
    page = await newSessionPage(context);
  }
  return { context, page, state };
}

/**
 * Waits for the strip to show exactly `names`, in that order. Polls inside the
 * page: the file's waitFor() helper takes a sync predicate, and an async one
 * returns a Promise, which is truthy, so it would pass at once.
 */
async function waitForInboxNames(page, names) {
  await page.waitForFunction((want) => JSON.stringify(Array.from(
    document.querySelectorAll('#session-inbox-strip .gl-inbox-cell'), (c) => c.getAttribute('aria-label'))) === want, JSON.stringify(names));
}

test('inbox strip: becoming visible refetches and shows the new list in the new order, dropping removed names', async () => {
  const { context, page, state } = await inboxPage(['a.png', 'b.png', 'c.png']);
  await waitForInboxNames(page, ['a.png', 'b.png', 'c.png']);
  state.names = ['d.png', 'c.png', 'a.png']; // d is new and newest, b is gone, a and c swap order
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitForInboxNames(page, ['d.png', 'c.png', 'a.png']);
  assert.equal(state.recentsCalls, 2);
  await context.close();
});

test('inbox strip: a selected cell still in the new response keeps .selected and is the same DOM node', async () => {
  const { context, page, state } = await inboxPage(['a.png', 'b.png']);
  await waitForInboxNames(page, ['a.png', 'b.png']);
  await page.click('.gl-inbox-cell[aria-label="b.png"]');
  await page.waitForSelector('.gl-inbox-cell[aria-label="b.png"].selected');
  await page.$eval('.gl-inbox-cell[aria-label="b.png"]', (cell) => { cell.__marker = 'original-b'; });
  state.names = ['b.png', 'z.png', 'a.png'];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitForInboxNames(page, ['b.png', 'z.png', 'a.png']);
  const kept = await page.$eval('.gl-inbox-cell[aria-label="b.png"]', (cell) => ({ marker: cell.__marker, selected: cell.classList.contains('selected') }));
  assert.deepEqual(kept, { marker: 'original-b', selected: true });
  await context.close();
});

test('inbox strip: keeps refetching every 4s while the launcher is visible, and stops while hidden', async () => {
  const { context, page, state } = await inboxPage(['a.png'], { fakeClock: true });
  await waitForInboxNames(page, ['a.png']);
  const before = state.recentsCalls;
  state.names = ['new.png', 'a.png']; // a screenshot whose upload finished after the page was shown
  await page.clock.runFor(4100);
  await waitForInboxNames(page, ['new.png', 'a.png']);
  assert.equal(state.recentsCalls, before + 1);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  await page.clock.runFor(20000);
  await page.waitForTimeout(150);
  assert.equal(state.recentsCalls, before + 1, 'no polling while hidden');
  await context.close();
});

test('inbox strip: visibilitychange while the page is hidden does not refetch', async () => {
  const { context, page, state } = await inboxPage(['a.png']);
  await waitForInboxNames(page, ['a.png']);
  assert.equal(state.recentsCalls, 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  assert.equal(state.recentsCalls, 1);
  await context.close();
});


// --- camera-roll quick-select strip (native bridge recentPhotos / photoData) ---

const PNG_B64 = REAL_PNG.toString('base64');
async function cameraRollPage(ids) {
  const uploads = [];
  const context = await browser.newContext();
  const photos = ids.map((id, i) => ({ id, thumb: PNG_B64, created: 2000 - i }));
  await context.addInitScript(buildMockBridgeScript({ ...baseConfig(), responses: { recentPhotos: { photos }, photoData: { data: PNG_B64 } } }));
  await routeProjects(context);
  await routeRecent(context);
  let inboxCalls = 0;
  await context.route(`${API_BASE}/sessions/inbox-recents*`, (route) => { inboxCalls += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"recents":[]}' }); });
  await context.route(`${API_BASE}/sessions/upload`, (route) => {
    uploads.push(route.request().headers()['content-type']);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-00000000000' + uploads.length + '.jpg' }) });
  });
  const page = await newSessionPage(context);
  return { context, page, uploads, inboxCalls: () => inboxCalls };
}

test('camera roll strip: shows the bridge photos newest-first, tap uploads via /sessions/upload, second tap removes', async () => {
  const { context, page, uploads, inboxCalls } = await cameraRollPage(['p-new', 'p-mid', 'p-old']);
  await waitForInboxNames(page, ['p-new', 'p-mid', 'p-old']);
  assert.equal(await page.$eval('.gl-inbox-cell img', (i) => i.src.startsWith('data:image/jpeg;base64,')), true);
  assert.equal(await page.evaluate(() => window.__glCallLog.find((c) => c.method === 'recentPhotos').params.limit), 8);
  await page.click('.gl-inbox-cell[aria-label="p-mid"]');
  await page.waitForSelector('.gl-inbox-cell[aria-label="p-mid"].selected');
  await waitFor(() => uploads.length === 1, 'one upload');
  assert.equal(uploads[0], 'image/jpeg');
  assert.equal(await page.evaluate(() => window.__glCallLog.find((c) => c.method === 'photoData').params.id), 'p-mid');
  await page.waitForSelector('.gl-thumb.done');
  await page.click('.gl-inbox-cell[aria-label="p-mid"]');
  await page.waitForSelector('.gl-thumb', { state: 'detached' });
  assert.equal(await page.$('.gl-inbox-cell.selected'), null);
  assert.equal(inboxCalls(), 0, 'the server inbox is not used when the bridge has photos');
  await context.close();
});

test('camera roll strip: a denied Photos permission is logged, not hidden behind the inbox', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript({ ...baseConfig(), errors: { recentPhotos: 'photos access denied' } }));
  await routeProjects(context);
  await routeRecent(context);
  let inboxCalls = 0;
  await context.route(`${API_BASE}/sessions/inbox-recents*`, (route) => { inboxCalls += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"recents":[]}' }); });
  const logs = [];
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  await page.goto(SESSION_URL);
  await waitFor(() => logs.some((l) => l.includes('photos access denied') || l.includes('camera roll strip')), 'console error');
  assert.equal(inboxCalls, 0);
  await context.close();
});


// --- version skew: this page runs OTA inside an OLDER native build ----------------------------------
// Old native: no launchId meta, voicePending has no `pending` list, voiceAudio / voiceRetry do not exist
// (the bridge answers an error for an unknown method). The page must read that from the reply itself.

const OLD_NATIVE_ERRORS = { voiceAudio: 'unknown method', voiceRetry: 'unknown method' };
async function oldNativePage(starts, voiceStop) {
  const context = await browser.newContext({ hasTouch: true });
  const cfg = baseConfig({ voiceStop, voicePending: { ready: [], failed: [], waiting: 1 } });
  cfg.errors = OLD_NATIVE_ERRORS;
  await context.addInitScript(buildMockBridgeScript(cfg));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    starts.push(JSON.parse(route.request().postData()));
    return OK_START(route);
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'say it');
  return { context, page };
}

test('OLD NATIVE: queued voice send -> transcript (no launchId, no pending list) -> session started; no false Failed row, no Play/Retry, no bridge error shown', async () => {
  const starts = [];
  const { context, page } = await oldNativePage(starts, { code: 'queued', id: 'v1' });
  await page.click('#session-record-btn'); // start recording
  await page.waitForSelector('#session-record-btn.recording');
  await page.click('#session-record-btn'); // stop = send
  await page.waitForFunction(() => /Waiting for box/.test(document.getElementById('session-recent-list').textContent));
  // A reload while waiting must not turn the (voiceId-matched) launch into "native never saw it".
  await page.reload();
  await page.waitForFunction(() => /Waiting for box/.test(document.getElementById('session-recent-list').textContent));
  assert.equal(await page.locator('.gl-row-failed').count(), 0, 'no false Failed row on old native');
  assert.equal(await page.locator('#session-recent-list button:has-text("Play")').count(), 0, 'Play would call the missing voiceAudio');
  await page.evaluate(() => window.__glMock.configure({ responses: { voicePending: { ready: [{ id: 'v1', text: 'spoken' }], failed: [], waiting: 0 } } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => starts.length === 1, 'the start request');
  assert.equal(starts[0].prompt, 'say it spoken');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  assert.deepEqual(await callsTo(page, 'voiceAck'), [{ id: 'v1' }], 'recording acked after the start succeeded, so old native does not pile items up');
  assert.equal(await page.locator('.gl-row-failed').count(), 0);
  assert.equal(await page.locator('#session-error').isVisible().catch(() => false), false, 'no bridge error surfaced');
  assert.deepEqual(await callsTo(page, 'voiceAudio'), []);
  assert.deepEqual(await callsTo(page, 'voiceRetry'), []);
  await context.close();
});

test('OLD NATIVE: a launch with no voice id after reload is not declared "native never saw it" (old native cannot echo launchId)', async () => {
  const starts = [];
  const { context, page } = await oldNativePage(starts, { text: 'x' });
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-recent-list .gl-row');
  await page.reload();
  await page.waitForSelector('#session-recent-list .gl-row');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.gl-row-failed').count(), 0);
  await context.close();
});

test('MIGRATE: an in-flight gl-session-voice-autosend-v1 entry from before the upgrade becomes a launch and its transcript still starts the session', async () => {
  const starts = [];
  const context = await browser.newContext({ hasTouch: true });
  const cfg = baseConfig({ voicePending: { ready: [{ id: 'v7', text: 'late words' }], failed: [], pending: [], waiting: 0 } });
  await context.addInitScript(buildMockBridgeScript(cfg));
  // Seed the OLD store once, before the page's scripts run (only on the first load, not after migration removed it).
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('gl-session-voice-autosend-v1', JSON.stringify({ v7: { project: 'project-01', prefix: 'old typed', attachmentIds: [], pendingIds: [], autoSkill: null } }));
    }
  });
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    starts.push(JSON.parse(route.request().postData()));
    return OK_START(route);
  });
  const page = await newSessionPage(context);
  await waitFor(() => starts.length === 1, 'the start request');
  assert.equal(starts[0].prompt, 'old typed late words');
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-voice-autosend-v1')), null, 'legacy key removed once migrated');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, START_QUEUE);
  assert.deepEqual(await callsTo(page, 'voiceAck'), [{ id: 'v7' }]);
  await context.close();
});

// --- clarifying a Start from its Sending row, whichever Start the card is showing ---

const sendingRow = (page, text) => page.locator('#session-recent-list .gl-row', { hasText: text });

test('clarify from a Sending row: goes to THAT Start, not the one on the card, waits offline, shows on the row, and is sent after its Start is answered', async () => {
  let offline = true;
  const { context, page, calls } = await startPageWithStartRoute((route) => (offline ? route.abort('connectionrefused') : OK_START(route)));
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 200, { delivered: 'live' }));
  await pressStart(page, 'older prompt');
  await pressStart(page, 'newer prompt');
  await sendingRow(page, 'newer prompt').waitFor();
  const queue = JSON.parse(await page.evaluate(() => localStorage.getItem('gl-session-pending-starts-v1')));
  const older = queue.find((e) => e.body.prompt === 'older prompt');
  const newer = queue.find((e) => e.body.prompt === 'newer prompt');

  await sendingRow(page, 'older prompt').locator('button', { hasText: 'Clarify' }).click();
  assert.equal(await page.locator('#session-confirmation-body').textContent(), 'older prompt');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'session-clarify-text');
  await page.fill('#session-clarify-text', 'for the older one');
  await page.click('#session-clarify-send');

  await sendingRow(page, 'older prompt').locator('.gl-recent-summary', { hasText: '1 clarification waiting' }).waitFor();
  assert.equal(await sendingRow(page, 'newer prompt').locator('.gl-recent-summary', { hasText: 'clarification' }).count(), 0);
  const held = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), CLARIFY_QUEUE));
  assert.deepEqual(held.map((c) => [c.startKey, c.text]), [[older.key, 'for the older one']]);
  assert.equal(bodies.length, 0, 'no clarify while its Start is unanswered');

  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => bodies.length === 1, 'the clarification after its Start was answered');
  assert.equal(bodies[0].startKey, older.key);
  assert.notEqual(bodies[0].startKey, newer.key);
  assert.ok(calls.some((c) => c.idempotencyKey === older.key), 'its Start went out under the same key');
  await drained(page, CLARIFY_QUEUE);
  await context.close();
});

test('clarify from a Sending row: a transcribing voice send has the chip, and discarding it closes the box aimed at it', async () => {
  const { context, page } = await slidePage([]);
  await page.evaluate(() => window.__glMock.configure({ delays: { voiceStop: 3000 } }));
  await page.click('#session-record-btn');
  const row = sendingRow(page, 'typed words');
  await row.waitFor();
  await page.evaluate(() => document.getElementById('session-confirmation').classList.add('gl-hidden'));
  await row.locator('button', { hasText: 'Clarify' }).click();
  await page.waitForSelector('#session-clarify:not(.gl-hidden)');
  await row.locator('button', { hasText: 'Discard' }).click();
  await page.waitForSelector('#session-confirmation.gl-hidden', { state: 'attached' });
  await context.close();
});

test('clarify from a Sending row: a Failed row has no Clarify chip', async () => {
  const { context, page } = await startPageWithStartRoute((route) => OK_JSON(route, 400, { error: 'refused' }));
  await page.fill('#session-prompt', 'refused prompt');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  const row = page.locator('.gl-row-failed', { hasText: 'refused prompt' });
  await row.waitFor();
  assert.deepEqual(await row.locator('button').allTextContents(), ['Retry', 'Edit', 'Discard']);
  await context.close();
});

// --- clarify mic: same gesture as the launcher and reply mics (tap-tap sends, hold = Insert / Cancel) ---

const CLARIFY_LAUNCHES = 'gl-session-voice-clarify-launches-v1';
const clarifyLaunchRecords = (page) => page.evaluate((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')), CLARIFY_LAUNCHES);

/** A page whose Start succeeded, with the card's clarify box showing; records clarify bodies. */
async function startedClarifyPage(opts = {}) {
  const r = await startPageWithStartRoute(OK_START, { hasTouch: !!opts.hasTouch, beforeNav: opts.beforeNav });
  const bodies = await routeClarify(r.context, (route) => OK_JSON(route, 200, { delivered: 'live' }));
  await pressStart(r.page, 'build the thing');
  await waitFor(() => r.calls.length === 1, 'the start');
  // Answered, not just sent: a reload that interrupts the answer leaves the Start queued, and clarifications wait for it.
  await drained(r.page, 'gl-session-pending-starts-v1');
  return { ...r, bodies };
}

async function recordClarify(page) {
  await page.click('#session-clarify-record-btn');
  await page.waitForSelector('#session-clarify-record-btn.recording');
}

test('clarify mic: tap-tap SENDS typed + transcript to that Start; box clears at once, launcher prompt untouched, recording acked', async () => {
  const { context, page, calls, bodies } = await startedClarifyPage();
  await page.fill('#session-clarify-text', 'before');
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await recordClarify(page);
  assert.equal(await page.locator('#session-record-btn.recording').count(), 0, 'only the clarify mic goes red');
  await page.click('#session-clarify-record-btn');
  // Committed before any answer: box empty, a durable record naming the Start, nothing sent yet.
  assert.equal(await page.inputValue('#session-clarify-text'), '');
  const recs = await clarifyLaunchRecords(page);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].startKey, calls[0].idempotencyKey);
  assert.equal(recs[0].prefix, 'before');
  assert.equal(bodies.length, 0);
  await page.evaluate(() => window.__glMock.replyNow('voiceStop', { text: 'a fake voice transcript' }));
  await waitFor(() => bodies.length === 1, 'the voice clarification');
  assert.equal(bodies[0].text, 'before a fake voice transcript');
  assert.equal(bodies[0].startKey, calls[0].idempotencyKey);
  assert.equal(await page.inputValue('#session-prompt'), '');
  await page.waitForFunction(() => /Clarification sent into the running session/.test(document.getElementById('session-clarify-status').textContent));
  await page.waitForFunction((k) => localStorage.getItem(k) === null, CLARIFY_LAUNCHES);
  await context.close();
});

test('clarify mic: tap-tap also carries the photos in the clarify box (uploaded id in attachments)', async () => {
  const { context, page, bodies } = await startedClarifyPage();
  await routeUpload(context, []);
  await page.setInputFiles('#session-clarify-attach-input', [fakeImage('voicepic.png')]);
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  assert.equal(await page.locator('#session-clarify-thumbs .gl-thumb').count(), 0, 'photos leave the box with the voice send');
  await waitFor(() => bodies.length === 1, 'the voice clarification');
  assert.equal(bodies[0].text, 'a fake voice transcript');
  assert.deepEqual(bodies[0].attachments, [idForBuffer(fakeImage('voicepic.png').buffer)]);
  await context.close();
});

test('clarify mic: hold + Insert puts the transcript in the clarify box and sends nothing', async () => {
  const { context, page, bodies } = await startedClarifyPage({ hasTouch: true });
  await page.fill('#session-clarify-text', 'before');
  await recordClarify(page);
  const { touch, target } = await holdMic(page, 'session-clarify');
  await touch('touchMove', target);
  await page.waitForSelector('#session-clarify-insert-target.armed');
  await touch('touchEnd');
  await page.waitForFunction(() => document.getElementById('session-clarify-text').value === 'before a fake voice transcript');
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 0, 'insert must not send');
  assert.equal(await page.inputValue('#session-prompt'), '');
  assert.deepEqual(await clarifyLaunchRecords(page), []);
  await context.close();
});

test('clarify mic: hold + Cancel discards the audio, nothing transcribed or sent, typed text kept', async () => {
  const { context, page, bodies } = await startedClarifyPage({ hasTouch: true });
  await page.fill('#session-clarify-text', 'keep me');
  await recordClarify(page);
  const { touch, cancel } = await holdMic(page, 'session-clarify');
  await touch('touchMove', cancel);
  await page.waitForSelector('#session-clarify-cancel-target.armed');
  await touch('touchEnd');
  await page.waitForFunction(() => window.__glCallLog.some((c) => c.method === 'voiceCancel'));
  assert.equal((await callsTo(page, 'voiceStop')).length, 0);
  assert.equal(await page.inputValue('#session-clarify-text'), 'keep me');
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 0);
  await context.close();
});

test('clarify mic: a recording native never heard of after a reload fails loudly and keeps the typed text visible', async () => {
  const { context, page, bodies } = await startedClarifyPage();
  await page.fill('#session-clarify-text', 'typed');
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  await page.reload();
  await page.waitForFunction(() => /not saved before the app closed.*typed/.test(document.getElementById('gl-error-text').textContent));
  assert.equal(bodies.length, 0);
  assert.deepEqual(await clarifyLaunchRecords(page), []);
  await context.close();
});

test('clarify mic: a transcript that arrives by poll before voiceStop answers is matched by launchId and reaches that Start, never the prompt', async () => {
  const { context, page, calls, bodies } = await startedClarifyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.fill('#session-clarify-text', 'typed');
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  assert.ok(launchId, 'native is told which record owns the recording');
  await mockVoice(page, { voicePending: { ready: [{ id: 'v9', text: 'polled words', launchId }], failed: [], pending: [], waiting: 0 } });
  await pollNow(page);
  await waitFor(() => bodies.length === 1, 'the clarification');
  assert.equal(bodies[0].text, 'typed polled words');
  assert.equal(bodies[0].startKey, calls[0].idempotencyKey);
  assert.equal(await page.inputValue('#session-prompt'), '');
  await context.close();
});

test('clarify mic, queued stop then page reload: the transcript still reaches the right Start, never the prompt', async () => {
  const { context, page, calls, bodies } = await startedClarifyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.fill('#session-clarify-text', 'typed');
  await mockVoice(page, { voiceStop: { code: 'queued', id: 'v9' } });
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  await page.waitForFunction((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')).some((r) => r.status === 'waiting' && r.voiceId === 'v9'), CLARIFY_LAUNCHES);
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await mockVoice(page, { voicePending: { ready: [{ id: 'v9', text: 'after reload', launchId }], failed: [], pending: [], waiting: 0 } });
  await pollNow(page);
  await waitFor(() => bodies.length === 1, 'the clarification after reload');
  assert.equal(bodies[0].text, 'typed after reload');
  assert.equal(bodies[0].startKey, calls[0].idempotencyKey);
  assert.equal(await page.inputValue('#session-prompt'), '');
  await context.close();
});

test('clarify mic: the card moving to a newer Start mid-recording still sends to the Start that dictated it', async () => {
  const { context, page, calls, bodies } = await startedClarifyPage();
  await recordClarify(page);
  await pressStart(page, 'a second session');
  await waitFor(() => calls.length === 2, 'the second start');
  await page.fill('#session-clarify-text', 'for the newer one');
  await page.click('#session-clarify-record-btn');
  await waitFor(() => bodies.length === 1, 'the clarification');
  assert.equal(bodies[0].startKey, calls[0].idempotencyKey, 'addressed to the first Start');
  assert.equal(bodies[0].text, 'a fake voice transcript', "the newer card's typed text is not swept in");
  assert.equal(await page.inputValue('#session-clarify-text'), 'for the newer one');
  await context.close();
});

test('clarify mic, empty transcript: typed text comes back to the box with an error, nothing sent', async () => {
  const { context, page, bodies } = await startedClarifyPage();
  await page.fill('#session-clarify-text', 'typed');
  await page.evaluate(() => window.__glMock.configure({ responses: { voiceStop: { code: 'empty_transcript' } } }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  await page.waitForFunction(() => document.getElementById('session-clarify-text').value === 'typed');
  assert.match(await page.locator('#gl-error-text').textContent(), /Didn't catch anything/);
  assert.equal(bodies.length, 0);
  assert.deepEqual(await clarifyLaunchRecords(page), []);
  await context.close();
});

test('clarify mic: a Start retried while its clarification is transcribing: the clarification follows the retried key', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { context, page, calls } = await startPageWithStartRoute(async (route, n) => {
    if (n === 1) { await gate; return OK_JSON(route, 400, { error: 'refused' }); }
    return OK_START(route);
  });
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 200, { delivered: 'live' }));
  await pressStart(page, 'build the thing');
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  release();
  const row = page.locator('.gl-row-failed', { hasText: 'build the thing' });
  await row.waitFor();
  await row.locator('button', { hasText: 'Retry' }).click();
  await waitFor(() => calls.length === 2, 'the retried start');
  assert.notEqual(calls[1].idempotencyKey, calls[0].idempotencyKey, 'premise: a retry rekeys');
  await page.evaluate(() => window.__glMock.replyNow('voiceStop', { text: 'late words' }));
  await waitFor(() => bodies.length === 1, 'the clarification');
  assert.equal(bodies[0].startKey, calls[1].idempotencyKey);
  await context.close();
});

test('clarify mic: a transcription that fails on a later poll puts the typed text back in the box', async () => {
  const { context, page, bodies } = await startedClarifyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.fill('#session-clarify-text', 'typed');
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  await mockVoice(page, { voicePending: { ready: [], failed: [{ id: 'v9', error: 'bad audio', launchId }], pending: [], waiting: 0 } });
  await pollNow(page);
  await page.waitForFunction(() => document.getElementById('session-clarify-text').value === 'typed');
  assert.match(await page.locator('#gl-error-text').textContent(), /Transcription failed: bad audio/);
  assert.equal(bodies.length, 0);
  assert.deepEqual(await clarifyLaunchRecords(page), []);
  await context.close();
});

test('clarify mic: a transcript redelivered after a reload (ack failed the first time) is one clarification, and the record clears', async () => {
  const { context, page, bodies } = await startedClarifyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.evaluate(() => window.__glMock.configure({ errors: { voiceAck: 'nope' } }));
  await mockVoice(page, { voiceStop: { code: 'queued', id: 'v9' } });
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  await page.waitForFunction((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')).some((r) => r.status === 'waiting'), CLARIFY_LAUNCHES);
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  const ready = { voicePending: { ready: [{ id: 'v9', text: 'words', launchId }], failed: [], pending: [], waiting: 0 } };
  await mockVoice(page, ready);
  await pollNow(page);
  await waitFor(() => bodies.length === 1, 'the first delivery');
  await page.waitForFunction((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')).some((r) => r.status === 'delivered'), CLARIFY_LAUNCHES);
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('session-project-pill').dataset.ready);
  await mockVoice(page, ready);
  await pollNow(page);
  await page.waitForFunction((k) => localStorage.getItem(k) === null, CLARIFY_LAUNCHES);
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 1, 'sent once');
  assert.equal(await page.inputValue('#session-prompt'), '');
  await context.close();
});

test('clarify mic: a poll reporting the recording pending records its voice id, so the lost-recording sweep cannot kill it', async () => {
  const { context, page } = await startedClarifyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  await mockVoice(page, { voicePending: { ready: [], failed: [], pending: [{ id: 'v9', launchId }], waiting: 1 } });
  await pollNow(page);
  await page.waitForFunction((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')).some((r) => r.status === 'waiting' && r.voiceId === 'v9'), CLARIFY_LAUNCHES);
  await context.close();
});

test('clarify mic: hold + Insert while the box is unreachable: the late transcript fills the clarify box, not the prompt', async () => {
  const { context, page, bodies } = await startedClarifyPage({ hasTouch: true, beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await mockVoice(page, { voiceStop: { code: 'queued', id: 'v9' } });
  await recordClarify(page);
  const { touch, target } = await holdMic(page, 'session-clarify');
  await touch('touchMove', target);
  await page.waitForSelector('#session-clarify-insert-target.armed');
  await touch('touchEnd');
  await page.waitForFunction(() => window.__glCallLog.some((c) => c.method === 'voiceStop'));
  await mockVoice(page, { voicePending: { ready: [{ id: 'v9', text: 'late words' }], failed: [], pending: [], waiting: 0 } });
  await pollNow(page);
  await page.waitForFunction(() => document.getElementById('session-clarify-text').value === 'late words');
  assert.equal(await page.inputValue('#session-prompt'), '');
  assert.equal(bodies.length, 0);
  await context.close();
});

test('clarify mic: a Start retried WHILE the mic is recording: the clarification goes to the retried key', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { context, page, calls } = await startPageWithStartRoute(async (route, n) => {
    if (n === 1) { await gate; return OK_JSON(route, 400, { error: 'refused' }); }
    return OK_START(route);
  });
  const bodies = await routeClarify(context, (route) => OK_JSON(route, 200, { delivered: 'live' }));
  await pressStart(page, 'build the thing');
  await recordClarify(page);
  release();
  const row = page.locator('.gl-row-failed', { hasText: 'build the thing' });
  await row.waitFor();
  await row.locator('button', { hasText: 'Retry' }).click();
  await waitFor(() => calls.length === 2, 'the retried start');
  await page.click('#session-clarify-record-btn');
  await waitFor(() => bodies.length === 1, 'the clarification');
  assert.equal(bodies[0].startKey, calls[1].idempotencyKey);
  await context.close();
});

test('clarify mic: voiceStop erroring puts the typed text back with the error, nothing sent', async () => {
  const { context, page, bodies } = await startedClarifyPage();
  await page.fill('#session-clarify-text', 'typed');
  await page.evaluate(() => window.__glMock.configure({ errors: { voiceStop: 'boom' } }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  await page.waitForFunction(() => document.getElementById('session-clarify-text').value === 'typed');
  assert.match(await page.locator('#gl-error-text').textContent(), /Transcription failed: boom/);
  assert.equal(bodies.length, 0);
  assert.deepEqual(await clarifyLaunchRecords(page), []);
  await context.close();
});

test('clarify mic: storage refusing the record clears nothing, stops nothing, and says so', async () => {
  const { context, page } = await startedClarifyPage();
  await page.fill('#session-clarify-text', 'typed');
  await recordClarify(page);
  await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (/clarify-launches/.test(k)) throw new Error('quota'); return set.call(this, k, v); }; });
  await page.click('#session-clarify-record-btn');
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  assert.match(await page.locator('#gl-error-text').textContent(), /Couldn't save the clarification/);
  assert.equal(await page.inputValue('#session-clarify-text'), 'typed');
  assert.equal((await callsTo(page, 'voiceStop')).length, 0);
  await context.close();
});

test('clarify mic: disabled while the launcher mic records', async () => {
  const { context, page } = await startedClarifyPage();
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  assert.equal(await page.locator('#session-clarify-record-btn').isDisabled(), true);
  await context.close();
});

test('launcher mic stops a clarify recording without starting a session', async () => {
  const { context, page, calls } = await startedClarifyPage();
  await recordClarify(page);
  await page.click('#session-record-btn');
  await page.waitForFunction(() => window.__glCallLog.some((c) => c.method === 'voiceStop'));
  await page.waitForFunction(() => document.getElementById('session-clarify-text').value === 'a fake voice transcript');
  assert.equal(calls.length, 1, 'never auto-started a session');
  await context.close();
});

test('reply mic: voiceStop names the launch, so a transcript polled before it answers still reaches that reply', async () => {
  const { context, page, h } = await recordingReplyPage({ beforeNav: (c) => c.addInitScript(HOLD_TIMERS) });
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await page.click('#detail-record-btn');
  const launchId = (await callsTo(page, 'voiceStop'))[0].launchId;
  assert.ok(launchId, 'voiceStop carries the reply launch id');
  await mockVoice(page, { voicePending: { ready: [{ id: 'v9', text: 'polled words', launchId }], failed: [], pending: [], waiting: 0 } });
  await pollNow(page);
  await waitFor(() => h.replies.length === 1, 'the reply');
  assert.equal(h.replies[0].text, 'polled words');
  await context.close();
});

// iOS keyboard dictation keeps running through a button tap (a <button> tap
// never blurs a focused textarea on iOS), so promptEl.value can hold only part
// of what was said when Start reads it, and dictation's final commit then
// refills the emptied box. Seen 2026-11-05: 281 chars sent, 735 left behind.
// These tests stand in for WebKit's commit by writing the value and firing
// `input`, which is what that commit does.
async function startCapture(context) {
  const bodies = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    bodies.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', name: 'n', project: '' }) });
  });
  return bodies;
}
function dictate(page, text) {
  return page.evaluate((t) => {
    const el = document.getElementById('session-prompt');
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

test('Start tapped mid-dictation waits for the commit, so the session gets the whole dictation', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const bodies = await startCapture(context);
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'There should be a cancel button.');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  // Dictation's commit, arriving after the tap but inside the settle window.
  await dictate(page, 'There should be a cancel button. Also the summary should be readable.');
  await page.waitForFunction(() => document.getElementById('session-prompt').value === '');
  await page.waitForTimeout(200);
  assert.equal(bodies.length, 1, 'one Start, not one per tap or per commit');
  assert.equal(bodies[0].prompt, 'There should be a cancel button. Also the summary should be readable.');
  await context.close();
});

test('a dictation echo after Start is stripped to its unsent tail, flagged, and never saved as the full draft', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const bodies = await startCapture(context);
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'First part.');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForFunction(() => document.getElementById('session-prompt').value === '');
  // The echo arrives in steps: a partial refill first, then the full commit.
  await dictate(page, 'First');
  await dictate(page, 'First part. Second part.');
  assert.equal(await page.inputValue('#session-prompt'), 'Second part.');
  assert.match(await page.locator('#gl-error-text').textContent(), /wasn't sent/);
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('gl-session-draft-v1')).prompt);
  assert.equal(draft, 'Second part.', 'the saved draft holds only the unsent tail');
  assert.equal(bodies[0].prompt, 'First part.');
  await context.close();
});

test('an identical dictation echo after Start leaves the composer empty with no notice', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await startCapture(context);
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'Same words.');
  await page.waitForFunction(() => !document.getElementById('session-start-btn').disabled);
  await page.click('#session-start-btn');
  await page.waitForFunction(() => document.getElementById('session-prompt').value === '');
  await dictate(page, 'Same words.');
  assert.equal(await page.inputValue('#session-prompt'), '');
  assert.equal(await page.locator('#gl-error').isHidden(), true);
  await context.close();
});

// --- busy mic: the tapped mic shows a spinning ring while its stopped clip is transcribed ---

/** Asserts `sel` is busy (ring shown, icon hidden, animating, aria-busy), then that it clears once voiceStop answers. */
async function assertBusyUntilReply(page, sel) {
  await page.waitForSelector(`${sel}.busy`);
  const s = await page.$eval(sel, (el) => ({
    anim: getComputedStyle(el, '::after').animationName,
    svg: getComputedStyle(el.querySelector('svg')).display,
    aria: el.getAttribute('aria-busy'),
    pe: getComputedStyle(el).pointerEvents,
  }));
  assert.deepEqual(s, { anim: 'glmicspin', svg: 'none', aria: 'true', pe: 'none' });
  await page.evaluate(() => window.__glMock.replyNow('voiceStop', { text: 'a fake voice transcript' }));
  await page.waitForFunction((q) => !document.querySelector(q).classList.contains('busy') && !document.querySelector(q).hasAttribute('aria-busy'), sel);
}

test('busy mic: launcher mic spins from stop until voiceStop answers', async () => {
  const bodies = [];
  const { context, page } = await slidePage(bodies);
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  assert.equal(await page.locator('#session-record-btn.busy').count(), 0, 'not busy while recording');
  await page.click('#session-record-btn');
  await assertBusyUntilReply(page, '#session-record-btn');
  assert.equal(await page.locator('#session-record-status').textContent(), '', 'status text clears with the spinner');
  await context.close();
});

test('busy mic: reply mic spins while its clip is transcribed, keeping the status text', async () => {
  const { context, page } = await openDetailPage();
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await page.click('#detail-record-btn');
  await page.waitForSelector('#detail-record-btn.recording');
  await page.click('#detail-record-btn');
  assert.equal(await page.locator('#detail-record-status').textContent(), 'Transcribing, then sending…');
  await assertBusyUntilReply(page, '#detail-record-btn');
  await context.close();
});

test('busy mic: clarify mic spins while its clip is transcribed', async () => {
  const { context, page } = await startedClarifyPage();
  await page.evaluate(() => window.__glMock.configure({ neverReply: ['voiceStop'] }));
  await recordClarify(page);
  await page.click('#session-clarify-record-btn');
  await assertBusyUntilReply(page, '#session-clarify-record-btn');
  await context.close();
});

// The share-sheet "Voice chat" path is only slow on the phone, often offline,
// where a live /debug-log line can't reach the box -- so the timing line must
// wait in localStorage and go out once the box answers.
test('a native startVoiceMode logs its timing to /debug-log, queued while the box is unreachable', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  const sent = [];
  let reachable = false;
  await context.route(`${API_BASE}/debug-log*`, (route) => {
    if (!reachable) return route.abort();
    sent.push(new URL(route.request().url()).searchParams.get('msg'));
    return route.fulfill({ status: 204 });
  });
  const page = await newSessionPage(context);
  await page.evaluate(() => window.startVoiceMode());
  await page.waitForSelector('#session-record-btn.recording');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gl-session-voice-timing-v1') || '[]').length === 1);
  assert.equal(sent.length, 0);
  reachable = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => (localStorage.getItem('gl-session-voice-timing-v1') || '[]') === '[]');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^session-voice: \S+ page age at startVoiceMode \d+ms, page \d+ms, native voiceStart \d+ms, online=\w+, attachments=\d+$/);
  await context.close();
});

test('box unreachable at the network level shows "Not on Tailscale"; the next answer from the box hides it', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  let down = true;
  await context.route(`${API_BASE}/sessions/**`, (route) => down
    ? route.abort('addressunreachable')
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: [], sessions: [] }) }));
  const page = await newSessionPage(context);
  await page.waitForSelector('#gl-tailnet-banner:not(.gl-hidden)');
  assert.equal(await page.locator('#gl-tailnet-banner').textContent(), 'Not on Tailscale');
  down = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('#gl-tailnet-banner.gl-hidden', { state: 'attached' });
  await context.close();
});

test('an HTTP error response (box reachable) never shows the Tailscale banner', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await context.route(`${API_BASE}/sessions/**`, (route) => route.fulfill({ status: 500, body: 'boom' }));
  const page = await newSessionPage(context);
  await page.waitForSelector('#gl-error:not(.gl-hidden)');
  assert.equal(await page.locator('#gl-tailnet-banner').isHidden(), true);
  await context.close();
});

// --- Cancel: withdraw a Start the box has not taken yet ---------------------

test('Cancel on the Starting card drops a queued Start: card and Sending row gone, queue empty, box row dismissed, never sent once the box is back', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  let startCalls = 0;
  const dismissed = [];
  await context.route(`${API_BASE}/sessions/start`, (route) => { startCalls++; route.abort('connectionrefused'); });
  await context.route(`${API_BASE}/sessions/submissions/*/dismiss`, (route) => {
    dismissed.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'never mind this one');
  await page.locator('#session-prompt').blur();
  await page.click('#session-start-btn');
  await page.waitForSelector('#gl-error:not(.gl-hidden)'); // the box is unreachable, so the Start waits in the queue
  await page.waitForSelector('.gl-row:has-text("never mind this one") button:has-text("Cancel")');
  await page.click('#session-confirmation-cancel');
  assert.equal(await page.locator('#session-confirmation').isHidden(), true);
  assert.equal(await page.locator('.gl-row:has-text("never mind this one")').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-pending-starts-v1')), null);
  await waitFor(() => dismissed.length === 1, 'the box row dismiss');
  const before = startCalls;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(300);
  assert.equal(startCalls, before, 'a cancelled Start is never retried');
  await context.close();
});

test('the Sending row Cancel chip drops that queued Start too', async () => {
  const context = await browser.newContext();
  await context.addInitScript(buildMockBridgeScript(baseConfig()));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) => route.abort('connectionrefused'));
  await context.route(`${API_BASE}/sessions/submissions/*/dismiss`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'row cancel');
  await page.locator('#session-prompt').blur();
  await page.click('#session-start-btn');
  await page.click('.gl-row:has-text("row cancel") button:has-text("Cancel")');
  assert.equal(await page.locator('.gl-row:has-text("row cancel")').count(), 0);
  assert.equal(await page.locator('#session-confirmation').isHidden(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('gl-session-pending-starts-v1')), null);
  await context.close();
});

test('Cancel while a voice send is still transcribing: the transcript arrives later but nothing starts, and the recording is deleted', async () => {
  const bodies = [];
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(buildMockBridgeScript({ ...baseConfig({ voiceStop: { id: 'v1', text: 'spoken words' } }), delays: { voiceStop: 1000 } }));
  await routeProjects(context);
  await routeRecent(context);
  await context.route(`${API_BASE}/sessions/start`, (route) => {
    bodies.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 's1', name: 'x', project: '' }) });
  });
  const page = await newSessionPage(context);
  await page.fill('#session-prompt', 'typed words');
  await page.click('#session-record-btn');
  await page.waitForSelector('#session-record-btn.recording');
  await page.click('#session-record-btn'); // tap-stop = send
  await page.waitForSelector('#session-confirmation-cancel:not(.gl-hidden)');
  await page.click('#session-confirmation-cancel');
  await page.waitForFunction(() => window.__glCallLog.some((c) => c.method === 'voiceAck'), null, { timeout: 4000 });
  await page.waitForTimeout(300);
  assert.equal(bodies.length, 0, 'a cancelled voice send must not start a session');
  assert.equal(await page.locator('#session-confirmation').isHidden(), true);
  await context.close();
});
