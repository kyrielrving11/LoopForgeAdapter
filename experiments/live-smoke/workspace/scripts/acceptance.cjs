const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

(async () => {
  const source = require('node:path').resolve(__dirname, '..', 'src', 'tags.ts');
  const module = await import(pathToFileURL(source).href);
  assert.equal(module.normalizeTag('  CaFe\t AU  LAIT  '), 'cafe au lait');
  assert.equal(module.normalizeTag(' CAFE\u0301 '), 'café');
  assert.equal(module.normalizeTag(' \t '), '');
  if (typeof module.uniqueTags === 'function') {
    const input = [' A ', 'a', '', 'CAFÉ', ' cafe\u0301 ', 'B'];
    assert.deepEqual(module.uniqueTags(input), ['a', 'café', 'b']);
    assert.deepEqual(input, [' A ', 'a', '', 'CAFÉ', ' cafe\u0301 ', 'B']);
  }
  process.stdout.write('ACCEPTANCE_PASSED\n');
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
