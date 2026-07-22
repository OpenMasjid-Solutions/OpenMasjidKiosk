// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the Stripe-style receipt renderer: the details block (amount/date/method/fund) renders
// separately from the paragraph, contact info appears, and the security property holds — NO value
// (admin template, donor {name}, or masjid contact fields) can inject HTML, and only http(s)
// images/links are emitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReceipt, fillVars, type ReceiptTemplate, type ReceiptContext } from './email';

const TPL: ReceiptTemplate = {
  subject: 'Your donation receipt — {masjid}',
  heading: 'JazākAllāhu khayran, {name}!',
  body: 'Thank you for your gift to {masjid}.\n\nPlease keep this for your records.',
  accent: '',
};
const CTX: ReceiptContext = {
  name: 'Yusuf',
  amountText: '£50.00',
  campaignTitle: 'General Fund',
  masjidName: 'An-Noor',
  masjidLogo: '',
  datePaid: 'Jul 15, 2026, 6:03 PM UTC',
  paymentMethod: 'Visa •••• 4242',
  reference: '0065A17F',
  contactEmail: 'info@annoor.org',
  contactPhone: '718-555-5839',
  contactWebsite: 'https://annoor.org',
};

test('fills variables in subject/heading/body', () => {
  const r = renderReceipt(TPL, CTX);
  assert.equal(r.subject, 'Your donation receipt — An-Noor');
  assert.ok(r.html.includes('JazākAllāhu khayran, Yusuf!'));
  assert.ok(r.html.includes('Thank you for your gift to An-Noor.'));
});

test('the receipt DETAILS block renders amount/date/method/fund (separate from the paragraph)', () => {
  const r = renderReceipt(TPL, CTX);
  for (const s of ['Amount paid', '£50.00', 'Date paid', 'Jul 15, 2026, 6:03 PM UTC', 'Payment method', 'Visa •••• 4242', 'Fund', 'General Fund', '0065A17F']) {
    assert.ok(r.html.includes(s), `html should contain "${s}"`);
    assert.ok(r.text.includes(s), `text should contain "${s}"`);
  }
});

test('contact info appears (mailto + phone + website)', () => {
  const r = renderReceipt(TPL, CTX);
  assert.ok(r.html.includes('mailto:info@annoor.org'));
  assert.ok(r.html.includes('info@annoor.org'));
  assert.ok(r.html.includes('718-555-5839'));
  assert.ok(r.html.includes('https://annoor.org'));
});

test('empty {name} is tidied (no dangling comma)', () => {
  const r = renderReceipt(TPL, { ...CTX, name: '' });
  assert.ok(r.html.includes('JazākAllāhu khayran!'));
  assert.ok(!r.html.includes('{name}'));
});

test('SECURITY: a donor name with HTML is escaped, never injected', () => {
  const r = renderReceipt(TPL, { ...CTX, name: '<img src=x onerror=alert(1)>' });
  assert.ok(!r.html.includes('<img src=x onerror'), 'raw tag must not appear');
  assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('SECURITY: an admin body with a <script> is escaped', () => {
  const r = renderReceipt({ ...TPL, body: 'Hi <script>steal()</script>' }, CTX);
  assert.ok(!r.html.includes('<script>steal'));
  assert.ok(r.html.includes('&lt;script&gt;'));
});

test('SECURITY: a malicious contact field cannot break out of the mailto/markup', () => {
  const r = renderReceipt(TPL, { ...CTX, contactEmail: 'x"><script>evil()</script>@e.org' });
  assert.ok(!r.html.includes('<script>evil'));
});

test('body newlines become <br>', () => {
  assert.ok(renderReceipt(TPL, CTX).html.includes('gift to An-Noor.<br><br>Please keep this'));
});

test('masjid logo: http(s) is embedded; javascript:/data: is rejected', () => {
  assert.ok(renderReceipt(TPL, { ...CTX, masjidLogo: 'https://ex.org/logo.png' }).html.includes('<img src="https://ex.org/logo.png"'));
  assert.ok(!renderReceipt(TPL, { ...CTX, masjidLogo: 'javascript:alert(1)' }).html.includes('<img'));
  assert.ok(!renderReceipt(TPL, { ...CTX, masjidLogo: 'data:image/png;base64,AAAA' }).html.includes('<img'));
  // No logo → the masjid name is shown as the header instead.
  assert.ok(renderReceipt(TPL, { ...CTX, masjidLogo: '' }).html.includes('An-Noor'));
});

test('accent: valid hex used; invalid falls back to default (no CSS injection)', () => {
  assert.ok(renderReceipt({ ...TPL, accent: '#D4AF37' }, CTX).html.includes('#D4AF37'));
  const bad = renderReceipt({ ...TPL, accent: 'red;}body{display:none' }, CTX).html;
  assert.ok(bad.includes('#1FA37A'));
  assert.ok(!bad.includes('display:none'));
});

test('fillVars preserves newlines but collapses runs of spaces', () => {
  assert.equal(fillVars('a\n\nb    c', { name: 'x', amount: 'y', campaign: 'z', masjid: 'm' }), 'a\n\nb c');
});
