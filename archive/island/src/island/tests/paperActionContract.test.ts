import assert from 'node:assert/strict';
import test from 'node:test';

test('paper input action carries the selected PDF without execution fields', () => {
  const file = new File(['%PDF-'], 'paper.pdf', { type: 'application/pdf' });
  const action = { type: 'paper.input', input: { kind: 'pdf', file } } as const;
  assert.equal(action.type, 'paper.input');
  assert.equal(action.input.kind, 'pdf');
  assert.equal(action.input.file.name, 'paper.pdf');
  assert.deepEqual(Object.keys(action), ['type', 'input']);
});
