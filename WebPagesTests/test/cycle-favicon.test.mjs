import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../CycleApp/web/', import.meta.url));

test('web build links the app icon as favicon and home-screen icon', () => {
  const html = readFileSync(web + 'index.html', 'utf8');
  for (const rel of ['icon', 'apple-touch-icon']) {
    const m = html.match(new RegExp(`<link rel="${rel}"[^>]*href="([^"]+)"`));
    assert.ok(m, `missing <link rel="${rel}">`);
    assert.ok(existsSync(web + m[1]), `${m[1]} not in CycleApp/web`);
  }
});
