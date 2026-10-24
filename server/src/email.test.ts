// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the Stripe-style receipt renderer: the details block (amount/date/method/fund) renders
// separately from the paragraph, contact info appears, and the security property holds — NO value
// (admin template, donor {name}, or masjid contact fields) can inject HTML, and only http(s)
// images/links are emitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMonthlyStarted, renderReceipt, renderRefund, fillVars, textInkFor, type ReceiptTemplate, type ReceiptContext } from './email';
import { contrastRatio, readableOn } from '../../web/src/contrast';

const TPL: ReceiptTemplate = {
  subject: 'Your donation receipt — {masjid}',
  heading: 'JazākAllāhu khayran, {name}!',
  body: 'Thank you for your gift to {masjid}.\n\nPlease keep this for your records.',
  accent: '',
};
const CTX: ReceiptContext = {
  name: 'Yusuf',
  amountText: '$50.00',
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
  for (const s of ['Amount paid', '$50.00', 'Date paid', 'Jul 15, 2026, 6:03 PM UTC', 'Payment method', 'Visa •••• 4242', 'Fund', 'General Fund', '0065A17F']) {
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

// ── Contrast, direction and figures (app UI spec §3, §6, §7, §4) ──────────────────────────────
// A receipt is read by every donor who gave an email address, on whatever phone they have, and the
// colours in it were chosen by eye: the emerald default was 3.19:1 as link text, the gold in the
// fixture above 2.10:1, the small print 2.46:1.

const MONTHLY = { ...CTX, nextChargeDate: 'Aug 15, 2026', cancelUrl: 'https://omos.example.org/kiosk/m/' + 'a'.repeat(64) };
const REFUND = { ...CTX, refundAmountText: '$20.00', full: false, dateRefunded: 'Jul 16, 2026, 9:00 AM' };
const all = (accent = '') => [
  renderReceipt({ ...TPL, accent }, CTX).html,
  renderMonthlyStarted({ accent }, MONTHLY).html,
  renderRefund({ accent }, REFUND).html,
];

test('textInkFor inks an accent to AA on white, and only as far as it must', () => {
  for (const fg of ['#1FA37A', '#D4AF37', '#22d3ee', '#fbbf24', '#e11d63', '#7c3aed', '#ffffff', '#fff', '#abc']) {
    const ink = textInkFor(fg);
    assert.ok(contrastRatio(ink.length === 4 ? `#${ink.slice(1).replace(/./g, (c) => c + c)}` : ink, '#ffffff') >= 4.5, `${fg} → ${ink}`);
  }
  // Already readable → untouched, including its spelling.
  assert.equal(textInkFor('#15795C'), '#15795C');
  assert.equal(textInkFor('#000'), '#000');
  // Not a colour we can measure → handed back for the caller's own gate, as readableOn does.
  assert.equal(textInkFor('red'), 'red');
  assert.equal(textInkFor('#12345'), '#12345');
});

test('textInkFor is the SAME function as the panel’s readableOn, so the preview matches the email', () => {
  // The receipt designer draws its preview with web/src/contrast.ts. If the two ever disagreed, the
  // heading the admin approved would not be the heading the donor got.
  const steps = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff, 0x1f, 0xa3, 0x7a, 0xd4];
  for (const r of steps) for (const g of steps) for (const b of steps) {
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    assert.equal(textInkFor(hex), readableOn(hex), hex);
  }
});

test('the heading and every link are inked to read; the raw accent survives as the card’s top rule', () => {
  const html = renderReceipt({ ...TPL, accent: '#D4AF37' }, CTX).html;
  const ink = textInkFor('#D4AF37');
  assert.notEqual(ink, '#D4AF37');
  assert.match(html, new RegExp(`<h1[^>]*color:${ink}`), 'heading');
  assert.match(html, new RegExp(`href="mailto:info@annoor.org" style="color:${ink}`), 'contact link');
  assert.match(html, new RegExp(`href="https://annoor.org" style="color:${ink}`), 'website link');
  assert.match(html, /border-top:4px solid #D4AF37/, 'the brand colour is still on the card, as itself');
  // Nowhere is the raw accent used as the colour of TEXT.
  assert.ok(!/(?:^|[;"])color:#D4AF37/.test(html), 'raw accent as text colour');
  for (const h of all('#D4AF37')) {
    assert.match(h, /border-top:4px solid #D4AF37/);
    assert.ok(!/(?:^|[;"])color:#D4AF37/.test(h));
  }
});

test('no small print is below AA — the greys are the panel preview’s own', () => {
  for (const h of all()) {
    assert.ok(!/#7a8892|#9aa7af/i.test(h), 'an old grey survived');
    // Every text colour in the email, measured against the white card it sits on…
    const colours = [...h.matchAll(/(?:^|[;"\s])color:(#[0-9a-fA-F]{6})/g)].map((m) => m[1]);
    assert.ok(colours.length > 5);
    for (const c of colours) assert.ok(contrastRatio(c, '#ffffff') >= 4.5, `${c} is ${contrastRatio(c, '#ffffff').toFixed(2)}:1`);
    // …and the footer, which sits on the #f4f6f9 page outside the card.
    const foot = /<p style="text-align:center;font-size:11px;color:(#[0-9a-fA-F]{6})[^"]*">Sent by/.exec(h)?.[1];
    assert.ok(foot && contrastRatio(foot, '#f4f6f9') >= 4.5, `footer ${foot}`);
  }
  // …and they are EXACTLY the receipt designer's tokens, so the preview is the email.
  const tokens = readFileSync(new URL('../../web/src/styles/tokens.css', import.meta.url), 'utf8');
  const label = /--er-label:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1];
  const faint = /--er-faint:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1];
  assert.ok(label && faint, 'the panel defines --er-label and --er-faint');
  const html = renderReceipt(TPL, CTX).html;
  assert.ok(html.includes(`color:${label}`), `labels use --er-label ${label}`);
  assert.ok(html.includes(`color:${faint}`), `the small print uses --er-faint ${faint}`);
});

test('every email declares English, left-to-right — and what people typed takes its own direction', () => {
  for (const h of all()) {
    assert.match(h, /^<!doctype html><html lang="en" dir="ltr">/);
    // Physical right is kept deliberately (Outlook reads no `end`), and is correct under explicit ltr.
    assert.match(h, /text-align:right/);
    assert.match(h, /<td dir="auto" style="[^"]*">General Fund<\/td>/, 'the fund’s name');
  }
  // The admin wrote the receipt's heading and paragraph, in whatever language they chose.
  const r = renderReceipt(TPL, CTX).html;
  assert.match(r, /<h1 dir="auto"/);
  assert.match(r, /<p dir="auto"/);
  // With no logo the masjid's name is the header — theirs, so it too keeps its own direction.
  assert.match(r, /<div dir="auto" [^>]*>An-Noor<\/div>/);
});

test('a name inside fixed English copy is isolated, and the plain text is unchanged by it', () => {
  const who = 'يوسف';
  const m = renderMonthlyStarted({ accent: '' }, { ...MONTHLY, name: who, masjidName: 'مسجد النور' });
  assert.ok(m.html.includes(`<span dir="auto">${who}</span>,`), 'the donor');
  assert.ok(m.html.includes('repeat every month to <span dir="auto">مسجد النور</span>.'), 'the masjid, mid-sentence');
  // The English sentence around them keeps the email's direction: nothing flips the paragraph.
  assert.ok(!/<p dir="auto"[^>]*>[^<]*<span dir="auto">/.test(m.html));
  assert.ok(m.text.startsWith(`Your monthly donation is set up\n\n${who},\n\nThank you — your $50.00 donation will now repeat every month to مسجد النور.`));
  assert.ok(!m.text.includes('<span'), 'the plain-text part carries no markup');

  const f = renderRefund({ accent: '' }, { ...REFUND, name: who });
  assert.ok(f.html.includes(`<span dir="auto">${who}</span>,`));
  assert.ok(f.html.includes('the card you used at <span dir="auto">An-Noor</span>.'));
  assert.match(f.text, /\$20\.00 of your \$50\.00 donation has been refunded to the card you used at An-Noor\./);
  // Isolation must not become a way in: the name is still escaped inside its span.
  const evil = renderRefund({ accent: '' }, { ...REFUND, name: '<b>x</b>' });
  assert.ok(evil.html.includes('<span dir="auto">&lt;b&gt;x&lt;/b&gt;</span>'));
});

test('amounts and dates in the details table use tabular figures', () => {
  for (const h of all()) {
    const cells = [...h.matchAll(/<td(?: dir="auto")? style="padding:11px 0;text-align:right;[^"]*"/g)];
    assert.ok(cells.length >= 3);
    for (const c of cells) assert.match(c[0], /font-variant-numeric:tabular-nums/);
  }
});
