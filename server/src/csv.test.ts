// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from './csv';

/** Strip outer quotes + unescape "" so we can assert the EFFECTIVE cell value (what a spreadsheet
 *  sees), including the leading-quote injection guard. */
function decode(cell: string): string {
  if (cell.startsWith('"') && cell.endsWith('"')) return cell.slice(1, -1).replace(/""/g, '"');
  return cell;
}

test('formula/DDE triggers are neutralised with a leading quote', () => {
  for (const v of ['=1+1', '=HYPERLINK("http://evil","x")', "=cmd|'/C calc'!A1", '+1', '-1', '@SUM(A1)', '\ttab', '\rcr']) {
    assert.ok(decode(csvCell(v)).startsWith("'"), `expected guard for: ${JSON.stringify(v)}`);
  }
});

test('a dangerous value that also needs quoting is both prefixed and quoted', () => {
  assert.equal(csvCell('=1,2'), '"\'=1,2"');
});

test('ordinary values pass through unchanged', () => {
  for (const v of ['Aisha Khan', 'aisha@example.com', '£50.00', '', 'A-1', 'one_time']) {
    assert.equal(csvCell(v), v);
  }
});

test('standard CSV quoting for commas, quotes and newlines', () => {
  assert.equal(csvCell('Khan, Aisha'), '"Khan, Aisha"');
  assert.equal(csvCell('she said "hi"'), '"she said ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('phone-like leading + is guarded, not executed', () => {
  assert.equal(csvCell('+1 555 0100'), "'+1 555 0100");
});

test('toCsv joins cells with commas and rows with CRLF, escaping every cell', () => {
  assert.equal(toCsv([['a', 'b'], ['=x', 'y,z']]), "a,b\r\n'=x,\"y,z\"");
});
