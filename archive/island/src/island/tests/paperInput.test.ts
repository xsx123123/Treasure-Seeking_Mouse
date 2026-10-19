import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPaperInput } from '../paperInput.ts';

test('classifies DOI, PMID and HTTPS paper URLs without fetching', () => {
  assert.deepEqual(classifyPaperInput('https://doi.org/10.1000/ABC.'), { kind: 'doi', value: '10.1000/abc' });
  assert.deepEqual(classifyPaperInput('PMID: 12345678'), { kind: 'pmid', value: '12345678' });
  assert.deepEqual(classifyPaperInput('https://example.org/paper.pdf'), { kind: 'url', value: 'https://example.org/paper.pdf' });
});

test('keeps natural questions separate from paper sources', () => {
  assert.deepEqual(classifyPaperInput('Which samples are controls in this study?'), { kind: 'question', value: 'Which samples are controls in this study?' });
  assert.deepEqual(classifyPaperInput(''), { kind: 'invalid', reason: 'empty' });
});

test('classifies PDF selections with size and type limits', () => {
  const pdf = new File(['%PDF-'], 'paper.pdf', { type: 'application/pdf' });
  assert.deepEqual(classifyPaperInput(pdf), { kind: 'pdf', file: pdf });
  assert.deepEqual(classifyPaperInput(new File([], 'empty.pdf')), { kind: 'invalid', reason: 'pdf_size' });
  assert.deepEqual(classifyPaperInput(new File(['text'], 'note.txt')), { kind: 'invalid', reason: 'pdf_type' });
  assert.deepEqual(classifyPaperInput(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.pdf')), { kind: 'invalid', reason: 'pdf_size' });
});

test('rejects non-HTTPS links and malformed identifiers', () => {
  assert.deepEqual(classifyPaperInput('http://example.org/paper.pdf'), { kind: 'invalid', reason: 'url_scheme' });
  assert.deepEqual(classifyPaperInput('PMID:123'), { kind: 'invalid', reason: 'pmid_format' });
  assert.deepEqual(classifyPaperInput('javascript:alert(1)'), { kind: 'invalid', reason: 'url_scheme' });
});
