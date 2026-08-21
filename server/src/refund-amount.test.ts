// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// DOES THE REFUND BOX SEND BACK THE AMOUNT THE ADMIN TYPED?
//
// It did not. `web/src/donations.tsx` worked out how many minor units a typed figure meant by
// sniffing the FORMATTED output of the money helper:
//
//     const decimals = money(0).replace(/[^0-9.,]/g, '').includes('.') ? 2 : 0;
//
// `formatMoney` drops the decimals on a whole number, so `money(0)` is "$0" and never "$0.00" —
// for every currency there is. The sniff therefore always answered 0, and an admin refunding $50 of
// a $100 donation typed `50` and gave back **50 pence**. The placeholder, computed from the same
// number, told them to type `10000` instead. Three-decimal currencies (KWD, BHD, OMR) were out by a
// factor of 1000 in the same direction.
//
// The server was never at fault: it refunds exactly the minor units it is handed, and every bound
// it checks (`<= remaining`) passed happily, because 50 really is less than 10000.
//
// This lives in the server's test run because it is the only runner CI executes — the same reason
// `theme-contrast.test.ts` does. It reaches across into the web sources on purpose: the arithmetic
// under test is web-side, and asserting it here is worth more than asserting nothing anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decimals, factor, formatMoney, toMinor } from '../../web/src/money';

const donationsTsx = readFileSync(new URL('../../web/src/donations.tsx', import.meta.url), 'utf8');

/** The same file with whole-line comments dropped. The fix left a comment QUOTING the broken line
 *  so the next reader knows why it is written the way it is — which a naive text search then
 *  matched, failing on the explanation rather than on any live code. */
const donationsCode = donationsTsx
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .join('\n');

test('the money formatter really does drop the decimals — which is what broke the sniff', () => {
  // Pinning the property the old code assumed away. This is CORRECT behavior and is not being
  // changed: "$25" reads better than "$25.00" down a list. It is simply not something you can
  // recover a currency's scale from.
  assert.equal(formatMoney(0, 'GBP'), '£0');
  assert.equal(formatMoney(2500, 'USD'), '$25');
  assert.equal(formatMoney(2550, 'USD'), '$25.50');
  assert.ok(!formatMoney(0, 'GBP').includes('.'), 'no decimal point to detect, in any currency');
  assert.ok(!formatMoney(0, 'KWD').includes('.'));
});

test('a typed refund amount converts at the currency’s real scale', () => {
  const cases: [string, string, number][] = [
    ['GBP', '50', 5000],
    ['USD', '50', 5000],
    ['EUR', '12.34', 1234],
    ['GBP', '0.50', 50],
    ['JPY', '500', 500], // zero-decimal: a yen IS the minor unit
    ['KWD', '50', 50000], // three-decimal
    ['BHD', '1.5', 1500],
  ];
  for (const [ccy, typed, expected] of cases) {
    assert.equal(toMinor(typed, ccy), expected, `${typed} ${ccy}`);
  }
});

test('a refund of the whole remaining amount round-trips through the box', () => {
  // The path an admin takes most: read the "up to $X" label, type that number back in.
  for (const ccy of ['GBP', 'USD', 'JPY', 'KWD']) {
    for (const minor of [1, 50, 5000, 123456]) {
      const shown = (minor / factor(ccy)).toFixed(decimals(ccy));
      assert.equal(toMinor(shown, ccy), minor, `${minor} ${ccy} shown as "${shown}"`);
    }
  }
});

test('the refund box does not infer the currency scale from formatted text', () => {
  // The specific regression. A future "tidy" that reintroduces any form of sniffing puts real money
  // back at risk, and no screenshot or type-check would notice.
  assert.ok(
    !/money\(0\)[\s\S]{0,120}includes\(/.test(donationsCode),
    'donations.tsx is deriving decimals from formatted output again — use decimals(currency)',
  );
  assert.match(
    donationsCode,
    /from '\.\/money'/,
    'donations.tsx must take its currency arithmetic from web/src/money.ts',
  );
  assert.match(donationsCode, /toMinor\(/, 'the typed amount must go through toMinor()');
  assert.match(
    donationsCode,
    /currency: string/,
    'the modal needs the ISO code, not only a formatter — that is the whole fix',
  );
});
