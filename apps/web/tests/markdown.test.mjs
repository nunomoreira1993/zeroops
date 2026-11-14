import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMarkdown } from '../src/components/markdown-format.ts';

test('formatting wraps the selection without dropping surrounding text', () => {
  const result = formatMarkdown('Antes erro depois', 6, 10, 'bold');
  assert.equal(result.value, 'Antes **erro** depois');
  assert.equal(result.value.slice(result.start, result.end), 'erro');
});

test('list formatting covers whole selected lines and leaves other lines intact', () => {
  assert.equal(formatMarkdown('primeiro\nsegundo', 0, 9, 'list').value, '- primeiro\nsegundo');
  assert.equal(
    formatMarkdown('primeiro\nsegundo\nterceiro', 2, 12, 'list').value,
    '- primeiro\n- segundo\nterceiro',
  );
  assert.equal(formatMarkdown('\nsegundo', 0, 0, 'heading').value, '## Título\nsegundo');
});

test('code blocks start on a new line and preserve following text', () => {
  assert.equal(
    formatMarkdown('antes x depois', 6, 7, 'code').value,
    'antes \n```\nx\n```\n depois',
  );
});
