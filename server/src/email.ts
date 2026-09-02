// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Renders a branded donation-receipt email — a clean, Stripe-style receipt: the masjid logo,
 * a short thank-you paragraph (admin-editable), then a details table (amount paid, date/time,
 * payment method + last 4, fund) kept SEPARATE from the paragraph, and a contact line. PURE +
 * unit-tested. The actual send goes through the OpenMasjidOS Fabric (fabric.ts `fabricEmail`).
 *
 * SECURITY: the template subject/heading/body are treated as PLAIN TEXT and fully HTML-escaped
 * (newlines → <br>), and EVERY value — including the donor's own name (which came from the
 * *unauthenticated* tablet at the kiosk) and the masjid contact fields — is escaped. So nothing
 * can inject markup. Images (the masjid logo) and links (website) are only emitted for http(s)
 * URLs; the accent is gated to a hex color so it can't break out of the inline style.
 *
 * Mirrors OpenMasjidDonations/server/src/email.ts so both apps send an identical-looking receipt.
 */

export interface ReceiptTemplate {
  subject: string;
  heading: string;
  /** The thank-you paragraph. Supports {name} {amount} {campaign} {masjid}. */
  body: string;
  /** Accent color (hex) for the heading + links, or '' for the default emerald. */
  accent: string;
}

/** Everything auto-filled from the donation + masjid settings (NOT admin free text). */
export interface ReceiptContext {
  name: string;
  amountText: string;
  campaignTitle: string;
  masjidName: string;
  /** ALREADY-RESOLVED absolute http(s) logo URL, or '' (caller resolves /uploads → public URL). */
  masjidLogo: string;
  datePaid: string;
  paymentMethod: string;
  reference: string;
  contactEmail: string;
  contactPhone: string;
  contactWebsite: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ACCENT_DEFAULT = '#1FA37A';

/** Shared with the server’s donor-facing pages, so every place we emit donor-supplied text escapes
 *  it the same way. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Substitute {name}/{amount}/{campaign}/{masjid}. Empty {name} → tidy an adjacent comma/space.
 *  Collapses runs of spaces/tabs (NOT newlines — paragraph breaks in the body are preserved). */
export function fillVars(tpl: string, v: { name: string; amount: string; campaign: string; masjid: string }): string {
  let out = tpl;
  if (!v.name.trim()) out = out.replace(/,?[ \t]*\{name\}[ \t]*,?/g, ' ');
  out = out
    .replace(/\{name\}/g, v.name)
    .replace(/\{amount\}/g, v.amount)
    .replace(/\{campaign\}/g, v.campaign)
    .replace(/\{masjid\}/g, v.masjid);
  return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([!?.,])/g, '$1').trim();
}

/** Only an http(s) absolute URL with no quotes/whitespace is allowed (img src / link href). */
function safeUrl(url: string): string {
  const u = (url ?? '').trim();
  return /^https?:\/\/[^"'\\\s]+$/i.test(u) ? u : '';
}

/** One "label / value" row of the receipt details table. */
function row(label: string, value: string, opts: { bold?: boolean; first?: boolean } = {}): string {
  const border = opts.first ? '' : 'border-top:1px solid #eef1f3;';
  const val = `padding:11px 0;text-align:right;color:#16242b;${border}${opts.bold ? 'font-weight:700;font-size:16px;' : ''}`;
  return `<tr><td style="padding:11px 0;color:#7a8892;${border}">${escapeHtml(label)}</td><td style="${val}">${escapeHtml(value)}</td></tr>`;
}

/** Build the subject/text/html of a receipt email. `html` is a light, Stripe-style receipt. */
export function renderReceipt(tpl: ReceiptTemplate, ctx: ReceiptContext): RenderedEmail {
  const accent = /^#[0-9a-fA-F]{3,8}$/.test((tpl.accent || '').trim()) ? tpl.accent.trim() : ACCENT_DEFAULT;
  const vars = { name: ctx.name, amount: ctx.amountText, campaign: ctx.campaignTitle, masjid: ctx.masjidName };
  const subject = (fillVars(tpl.subject || 'Your donation receipt', vars) || 'Your donation receipt').slice(0, 200);
  const heading = fillVars(tpl.heading || 'JazākAllāhu khayran!', vars) || 'JazākAllāhu khayran!';
  const paragraph = fillVars(tpl.body || 'Your donation was received. May Allah accept it from you and reward you abundantly.', vars);
  const logo = safeUrl(ctx.masjidLogo);
  const masjid = ctx.masjidName.trim();
  const website = safeUrl(ctx.contactWebsite);

  // ── Plain-text part ──
  const lines = [
    heading,
    '',
    paragraph,
    '',
    `Amount paid:    ${ctx.amountText}`,
    `Date paid:      ${ctx.datePaid}`,
    `Payment method: ${ctx.paymentMethod}`,
    ctx.campaignTitle ? `Fund:           ${ctx.campaignTitle}` : '',
    ctx.reference ? `Receipt:        ${ctx.reference}` : '',
    '',
  ];
  const contactBits = [ctx.contactEmail, ctx.contactPhone].filter((s) => s && s.trim());
  if (contactBits.length) lines.push(`Questions? Contact ${masjid || 'us'} — ${contactBits.join(' · ')}`);
  if (ctx.contactWebsite.trim()) lines.push(ctx.contactWebsite.trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // ── HTML part (everything escaped) ──
  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(masjid)}" style="max-height:60px;max-width:220px;height:auto">`
    : masjid
      ? `<div style="font-size:20px;font-weight:700;color:#16242b">${escapeHtml(masjid)}</div>`
      : '';
  const refLine = ctx.reference ? `<div style="margin-top:12px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9aa7af">Receipt · ${escapeHtml(ctx.reference)}</div>` : '';
  const bodyHtml = escapeHtml(paragraph).replace(/\n/g, '<br>');
  const details = [
    row('Amount paid', ctx.amountText, { bold: true, first: true }),
    row('Date paid', ctx.datePaid),
    row('Payment method', ctx.paymentMethod),
    ctx.campaignTitle ? row('Fund', ctx.campaignTitle) : '',
  ].join('');

  // Contact line — a mailto link (accent) when an email is set, plus phone, plus a website link.
  const contactInner: string[] = [];
  if (ctx.contactEmail.trim()) contactInner.push(`<a href="mailto:${escapeHtml(ctx.contactEmail.trim())}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(ctx.contactEmail.trim())}</a>`);
  if (ctx.contactPhone.trim()) contactInner.push(escapeHtml(ctx.contactPhone.trim()));
  const contactLine = contactInner.length
    ? `<p style="margin:0;font-size:13px;line-height:1.6;color:#7a8892">Questions about this donation? Contact ${escapeHtml(masjid || 'us')} — ${contactInner.join(' · ')}.</p>`
    : `<p style="margin:0;font-size:13px;color:#7a8892">Questions about this donation? Please contact ${escapeHtml(masjid || 'the masjid')}.</p>`;
  const websiteLine = website ? `<p style="margin:6px 0 0;font-size:13px"><a href="${escapeHtml(website)}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a></p>` : '';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9">
  <div style="max-width:540px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242b">
    <div style="background:#ffffff;border:1px solid #e6eaed;border-radius:14px">
      <div style="padding:30px 30px 6px;text-align:center">
        ${header}
        ${refLine}
      </div>
      <div style="padding:14px 30px 4px;text-align:center">
        <h1 style="margin:0 0 12px;font-size:21px;line-height:1.25;color:${escapeHtml(accent)}">${escapeHtml(heading)}</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#42535c">${bodyHtml}</p>
      </div>
      <div style="padding:14px 30px 4px">
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">${details}</table>
      </div>
      <div style="padding:16px 30px 28px;margin-top:8px;border-top:1px solid #eef1f3;text-align:center">
        ${contactLine}
        ${websiteLine}
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#9aa7af;margin-top:14px">Sent by OpenMasjid Kiosk · Secured by Stripe</p>
  </div>
</body></html>`;

  return { subject, text, html };
}

/** What a donor is told when their monthly giving is set up. */
export interface MonthlyStartedContext extends ReceiptContext {
  /** When the FIRST repeat charge falls (the kiosk tap covered this month). */
  nextChargeDate: string;
  /**
   * Absolute https link that stops the plan, or '' when the masjid has no public address.
   *
   * A monthly donation is the one thing a kiosk sets up that keeps taking money after the donor has
   * walked away, so being able to stop it must not depend on finding the right person at the masjid.
   * When there is no link we say plainly to contact the masjid rather than printing a dead URL.
   */
  cancelUrl: string;
}

/**
 * "Your monthly donation is set up" — sent once, when the plan is created.
 *
 * Its real job is the cancel link, so the email is written around keeping it: the donor is told to
 * hold on to the message, and the link is the most prominent thing on the page after the amount.
 * Same shell and same escaping as the receipt.
 */
export function renderMonthlyStarted(tpl: Pick<ReceiptTemplate, 'accent'>, ctx: MonthlyStartedContext): RenderedEmail {
  const accent = /^#[0-9a-fA-F]{3,8}$/.test((tpl.accent || '').trim()) ? tpl.accent.trim() : ACCENT_DEFAULT;
  const masjid = ctx.masjidName.trim();
  const logo = safeUrl(ctx.masjidLogo);
  const website = safeUrl(ctx.contactWebsite);
  const cancel = safeUrl(ctx.cancelUrl);
  const who = ctx.name.trim();

  const subject = (masjid ? `Your monthly donation to ${masjid} is set up` : 'Your monthly donation is set up').slice(0, 200);
  const heading = 'Your monthly donation is set up';
  const paragraph = [
    who ? `${who},` : '',
    `Thank you — your ${ctx.amountText} donation will now repeat every month${masjid ? ` to ${masjid}` : ''}. ` +
      `You have already given this month at the kiosk, so the next payment is on ${ctx.nextChargeDate}.`,
    cancel
      ? 'You can stop it at any time, yourself, using the link below. PLEASE KEEP THIS EMAIL — the link is the quickest way to stop your monthly donation, and this message is the only place it appears.'
      : `You can stop it at any time — just contact ${masjid || 'the masjid'} using the details below and they will end it for you.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const lines = [
    heading,
    '',
    paragraph,
    '',
    `Amount:         ${ctx.amountText} each month`,
    `Next payment:   ${ctx.nextChargeDate}`,
    `Started:        ${ctx.datePaid}`,
    `Payment method: ${ctx.paymentMethod}`,
    ctx.campaignTitle ? `Fund:           ${ctx.campaignTitle}` : '',
    '',
    cancel ? `Stop my monthly donation: ${cancel}` : '',
    '',
  ];
  const contactBits = [ctx.contactEmail, ctx.contactPhone].filter((s) => s && s.trim());
  if (contactBits.length) lines.push(`Questions? Contact ${masjid || 'us'} — ${contactBits.join(' · ')}`);
  if (ctx.contactWebsite.trim()) lines.push(ctx.contactWebsite.trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(masjid)}" style="max-height:60px;max-width:220px;height:auto">`
    : masjid
      ? `<div style="font-size:20px;font-weight:700;color:#16242b">${escapeHtml(masjid)}</div>`
      : '';
  const details = [
    row('Amount', `${ctx.amountText} each month`, { bold: true, first: true }),
    row('Next payment', ctx.nextChargeDate),
    row('Started', ctx.datePaid),
    row('Payment method', ctx.paymentMethod),
    ctx.campaignTitle ? row('Fund', ctx.campaignTitle) : '',
  ].join('');

  // The cancel control is a button, not a bare URL: a donor who wants to stop should not have to hunt
  // for it. The plain-text part carries the raw link for clients that strip HTML.
  const cancelBlock = cancel
    ? `<div style="padding:6px 30px 4px;text-align:center">
         <a href="${escapeHtml(cancel)}" style="display:inline-block;padding:11px 18px;border:1px solid #d6dde2;border-radius:10px;color:#42535c;text-decoration:none;font-size:14px">Stop my monthly donation</a>
         <p style="margin:10px 0 0;font-size:12px;line-height:1.6;color:#9aa7af">Keep this email — this is the only place that link appears.</p>
       </div>`
    : `<div style="padding:6px 30px 4px;text-align:center">
         <p style="margin:0;font-size:13px;line-height:1.6;color:#7a8892">To stop your monthly donation, contact ${escapeHtml(masjid || 'the masjid')} using the details below.</p>
       </div>`;

  const contactInner: string[] = [];
  if (ctx.contactEmail.trim())
    contactInner.push(
      `<a href="mailto:${escapeHtml(ctx.contactEmail.trim())}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(ctx.contactEmail.trim())}</a>`,
    );
  if (ctx.contactPhone.trim()) contactInner.push(escapeHtml(ctx.contactPhone.trim()));
  const contactLine = contactInner.length
    ? `<p style="margin:0;font-size:13px;line-height:1.6;color:#7a8892">Questions about this donation? Contact ${escapeHtml(masjid || 'us')} — ${contactInner.join(' · ')}.</p>`
    : `<p style="margin:0;font-size:13px;color:#7a8892">Questions about this donation? Please contact ${escapeHtml(masjid || 'the masjid')}.</p>`;
  const websiteLine = website
    ? `<p style="margin:6px 0 0;font-size:13px"><a href="${escapeHtml(website)}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a></p>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9">
  <div style="max-width:540px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242b">
    <div style="background:#ffffff;border:1px solid #e6eaed;border-radius:14px">
      <div style="padding:30px 30px 6px;text-align:center">${header}</div>
      <div style="padding:14px 30px 4px;text-align:center">
        <h1 style="margin:0 0 12px;font-size:21px;line-height:1.25;color:${escapeHtml(accent)}">${escapeHtml(heading)}</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#42535c">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>
      </div>
      <div style="padding:14px 30px 4px">
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">${details}</table>
      </div>
      ${cancelBlock}
      <div style="padding:16px 30px 28px;margin-top:8px;border-top:1px solid #eef1f3;text-align:center">
        ${contactLine}
        ${websiteLine}
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#9aa7af;margin-top:14px">Sent by OpenMasjid Kiosk · Secured by Stripe</p>
  </div>
</body></html>`;

  return { subject, text, html };
}

/** What a donor needs to be told about money going back. Every field is auto-filled from the
 *  donation and the masjid's own settings — there is deliberately no admin free-text here (see
 *  [renderRefund]). */
export interface RefundContext extends ReceiptContext {
  /** The amount REFUNDED, already formatted — not necessarily the whole donation. */
  refundAmountText: string;
  /** True when this gives back the entire donation, false for a partial. Changes the wording. */
  full: boolean;
  /** When the refund was issued, formatted like `datePaid`. */
  dateRefunded: string;
}

/**
 * Render the email a donor gets when their donation is refunded.
 *
 * Shares the receipt's shell (logo, accent, details table, contact line) so the two messages look
 * like they come from the same masjid, and inherits its escaping: subject/heading/body are plain
 * text, EVERY value is HTML-escaped, images and links only for http(s) URLs, accent gated to hex.
 * The donor's name still comes from the unauthenticated tablet, so that matters as much here.
 *
 * Unlike the receipt, the wording is NOT admin-editable. A refund note is a factual statement about
 * money being returned and a bank timescale — a template with the wrong tone or a stale {amount}
 * would be actively misleading, and no admin has asked to reword it. The masjid's branding and
 * contact details still come through, which is the part that matters for the donor recognizing it.
 */
export function renderRefund(tpl: Pick<ReceiptTemplate, 'accent'>, ctx: RefundContext): RenderedEmail {
  const accent = /^#[0-9a-fA-F]{3,8}$/.test((tpl.accent || '').trim()) ? tpl.accent.trim() : ACCENT_DEFAULT;
  const masjid = ctx.masjidName.trim();
  const logo = safeUrl(ctx.masjidLogo);
  const website = safeUrl(ctx.contactWebsite);
  const who = ctx.name.trim();

  const subject = (masjid ? `Your donation to ${masjid} has been refunded` : 'Your donation has been refunded').slice(0, 200);
  const heading = ctx.full ? 'Your donation has been refunded' : 'Part of your donation has been refunded';
  // Say the money is on its way back, then the one thing every donor actually asks next: when.
  // 5–10 working days is the card-network norm Stripe documents; promising faster would be a
  // promise neither we nor the masjid control.
  const paragraph = [
    who ? `${who},` : '',
    ctx.full
      ? `${ctx.refundAmountText} has been refunded to the card you used${masjid ? ` at ${masjid}` : ''}.`
      : `${ctx.refundAmountText} of your ${ctx.amountText} donation has been refunded to the card you used${masjid ? ` at ${masjid}` : ''}.`,
    'It goes back to the same card automatically — most banks show it within 5 to 10 working days. There is nothing for you to do.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const lines = [
    heading,
    '',
    paragraph,
    '',
    `Refunded:       ${ctx.refundAmountText}`,
    ctx.full ? '' : `Original gift:  ${ctx.amountText}`,
    `Date refunded:  ${ctx.dateRefunded}`,
    `Date paid:      ${ctx.datePaid}`,
    `Payment method: ${ctx.paymentMethod}`,
    ctx.campaignTitle ? `Fund:           ${ctx.campaignTitle}` : '',
    ctx.reference ? `Reference:      ${ctx.reference}` : '',
    '',
  ];
  const contactBits = [ctx.contactEmail, ctx.contactPhone].filter((s) => s && s.trim());
  if (contactBits.length) lines.push(`Questions? Contact ${masjid || 'us'} — ${contactBits.join(' · ')}`);
  if (ctx.contactWebsite.trim()) lines.push(ctx.contactWebsite.trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(masjid)}" style="max-height:60px;max-width:220px;height:auto">`
    : masjid
      ? `<div style="font-size:20px;font-weight:700;color:#16242b">${escapeHtml(masjid)}</div>`
      : '';
  const refLine = ctx.reference
    ? `<div style="margin-top:12px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9aa7af">Refund · ${escapeHtml(ctx.reference)}</div>`
    : '';
  const details = [
    row('Refunded', ctx.refundAmountText, { bold: true, first: true }),
    ctx.full ? '' : row('Original donation', ctx.amountText),
    row('Date refunded', ctx.dateRefunded),
    row('Date paid', ctx.datePaid),
    row('Payment method', ctx.paymentMethod),
    ctx.campaignTitle ? row('Fund', ctx.campaignTitle) : '',
  ].join('');

  const contactInner: string[] = [];
  if (ctx.contactEmail.trim())
    contactInner.push(
      `<a href="mailto:${escapeHtml(ctx.contactEmail.trim())}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(ctx.contactEmail.trim())}</a>`,
    );
  if (ctx.contactPhone.trim()) contactInner.push(escapeHtml(ctx.contactPhone.trim()));
  const contactLine = contactInner.length
    ? `<p style="margin:0;font-size:13px;line-height:1.6;color:#7a8892">Questions about this refund? Contact ${escapeHtml(masjid || 'us')} — ${contactInner.join(' · ')}.</p>`
    : `<p style="margin:0;font-size:13px;color:#7a8892">Questions about this refund? Please contact ${escapeHtml(masjid || 'the masjid')}.</p>`;
  const websiteLine = website
    ? `<p style="margin:6px 0 0;font-size:13px"><a href="${escapeHtml(website)}" style="color:${escapeHtml(accent)};text-decoration:none">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a></p>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9">
  <div style="max-width:540px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16242b">
    <div style="background:#ffffff;border:1px solid #e6eaed;border-radius:14px">
      <div style="padding:30px 30px 6px;text-align:center">
        ${header}
        ${refLine}
      </div>
      <div style="padding:14px 30px 4px;text-align:center">
        <h1 style="margin:0 0 12px;font-size:21px;line-height:1.25;color:${escapeHtml(accent)}">${escapeHtml(heading)}</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#42535c">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>
      </div>
      <div style="padding:14px 30px 4px">
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">${details}</table>
      </div>
      <div style="padding:16px 30px 28px;margin-top:8px;border-top:1px solid #eef1f3;text-align:center">
        ${contactLine}
        ${websiteLine}
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#9aa7af;margin-top:14px">Sent by OpenMasjid Kiosk · Secured by Stripe</p>
  </div>
</body></html>`;

  return { subject, text, html };
}
