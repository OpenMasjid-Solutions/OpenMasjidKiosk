// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

// The admin panel's phone picker (web/src/phone.ts) and the server's normaliser must agree about the
// trunk 0, or a number typed the way people write it at home is stored as one that does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, toE164Digits } from '../../web/src/phone';
import { normalisePhone, TRUNK_ZERO_DIALS } from './alerts';
import { Store } from './store';

const byCode = (code: string) => COUNTRIES.find((c) => c.code === code)!;

test('a number typed with its national trunk 0 is stored without it', () => {
  assert.equal(toE164Digits(byCode('GB'), '07700 900123'), '447700900123');
  assert.equal(toE164Digits(byCode('PK'), '0300 1234567'), '923001234567');
  assert.equal(toE164Digits(byCode('GB'), '7700 900123'), '447700900123', 'without it, unchanged');
  assert.equal(toE164Digits(byCode('GB'), '+44 (0)7700 900123'), '447700900123');
  assert.equal(toE164Digits(byCode('GB'), '0044 7700 900123'), '447700900123');
  assert.equal(toE164Digits(byCode('US'), '(555) 010-1234'), '15550101234');
  assert.equal(toE164Digits(byCode('US'), '+1 555 010 1234'), '15550101234');
});

test('the server knows exactly the trunk-0 countries the picker offers', () => {
  const picker = COUNTRIES.filter((c) => c.dial && !c.nanp).map((c) => c.dial).sort();
  assert.deepEqual([...TRUNK_ZERO_DIALS].sort(), picker);
  for (const c of COUNTRIES.filter((x) => x.dial)) {
    // Whatever the picker stores — here from a number typed the national way — the server accepts unchanged.
    const typed = c.nanp ? '555 010 1234' : `0${'7'.repeat(c.nationalDigits ?? 9)}`;
    const stored = toE164Digits(c, typed);
    assert.equal(normalisePhone(stored), stored, c.code);
  }
});

test('a number saved wrongly before 0.14.0 is repaired on read, and never listed twice', () => {
  const s = new Store(':memory:');
  s.addAlertRecipient({ kind: 'phone', address: '447700900123', label: 'Right', alerts: ['test'], includeNames: true });
  // What the old picker wrote, straight into the saved list (bypassing the add route's normaliser).
  const raw = JSON.parse(s['getRaw']('alert_recipients') ?? '{"list":[]}');
  raw.list.push({ id: 'rcp_old', kind: 'phone', address: '4407700900123', label: 'Old', alerts: ['test'], includeNames: true });
  raw.list.push({ id: 'rcp_pk', kind: 'phone', address: '9203001234567', label: 'PK', alerts: ['test'], includeNames: true });
  s['setRaw']('alert_recipients', JSON.stringify(raw));
  const phones = s.getAlertRecipients().filter((r) => r.kind === 'phone').map((r) => r.address);
  assert.deepEqual(phones, ['447700900123', '923001234567']);
});
