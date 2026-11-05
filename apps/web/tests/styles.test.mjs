import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const src = path.resolve('apps/web/src');
async function files(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}

test('all application styling uses the single Tailwind entry', async () => {
  const entries = await files(src);
  assert.deepEqual(entries.filter(file => file.endsWith('.css')).map(file => path.relative(src, file).replaceAll('\\', '/')), ['styles/tailwind.css']);
  for (const file of entries.filter(file => /\.tsx?$/.test(file))) {
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(source, /import\s+['"][^'"]*(?:global|print|map-canvas|handwriting-font|kinghwa-font)\.css['"]/, file);
    assert.doesNotMatch(source, /uiClasses\(/, 'Do not reintroduce a runtime legacy class translator');
    if (file.endsWith('.tsx') && !file.includes(`${path.sep}ui${path.sep}`)) {
      assert.doesNotMatch(source, /<(?:button|input|select|textarea)\b/, `Use shared controls: ${file}`);
      assert.doesNotMatch(source, /window\.(?:confirm|prompt)\(/, `Use shared dialogs: ${file}`);
    }
  }
  const stylesheet = await fs.readFile(path.join(src, 'styles/tailwind.css'), 'utf8');
  assert.match(stylesheet, /@import 'tailwindcss\/utilities.css'/);
  assert.match(stylesheet, /@layer base/);
  assert.doesNotMatch(stylesheet, /@import [^;]*preflight/);
});
