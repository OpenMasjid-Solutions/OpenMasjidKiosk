// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

// "Verify before we record" includes WHICH payment is being finished: a device token plus a guessed
// PaymentIntent id must not capture someone else's authorisation. Stripe's SDK is stubbed at its own
// resource prototype, so nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, completeCardPresentPaymentIntent, NotOurPaymentIntent } from './stripe';

const proto = Object.getPrototypeOf(client('sk_test_x').paymentIntents) as Record<string, (...a: unknown[]) => unknown>;
const authorised = (metadata: Record<string, string>) => ({
  id: 'pi_1',
  status: 'requires_capture',
  amount: 2500,
  currency: 'usd',
  created: 1_790_000_000,
  metadata,
  latest_charge: null,
});

test('a PaymentIntent another device started is never captured or reported', async (t) => {
  t.mock.method(proto, 'retrieve', async () => authorised({ app: 'kiosk', deviceId: 'dev_other' }));
  const capture = t.mock.method(proto, 'capture', async () => ({ ...authorised({}), status: 'succeeded' }));
  await assert.rejects(
    completeCardPresentPaymentIntent('sk_test_x', 'pi_1', (m) => m.app === 'kiosk' && m.deviceId === 'dev_mine'),
    NotOurPaymentIntent,
  );
  assert.equal(capture.mock.callCount(), 0, 'nothing captured');
});

test('our own authorisation is captured once and reported as it ends up', async (t) => {
  const meta = { app: 'kiosk', deviceId: 'dev_mine' };
  t.mock.method(proto, 'retrieve', async () => authorised(meta));
  const capture = t.mock.method(proto, 'capture', async () => ({ ...authorised(meta), status: 'succeeded' }));
  const r = await completeCardPresentPaymentIntent('sk_test_x', 'pi_1', (m) => m.app === 'kiosk' && m.deviceId === 'dev_mine');
  assert.equal(capture.mock.callCount(), 1);
  assert.equal(r.succeeded, true);
  assert.equal(r.amountMinor, 2500);
});
