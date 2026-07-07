// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Escape one CSV cell. Two ordered stages (mirrors OpenMasjidDonations):
 *  1. **Formula/DDE-injection guard.** Donor name/email are attacker-controllable and would execute
 *     when an admin opens the export in Excel/Sheets/LibreOffice. If the value STARTS with = + - @,
 *     a TAB or a CR, prefix a single quote to neutralise it (OWASP mitigation). LF is intentionally
 *     not a trigger; the guard is position-0 only (so "A-1" is untouched).
 *  2. **Standard CSV quoting** of the (possibly prefixed) string: if it contains a quote, comma, CR
 *     or LF, wrap in double quotes and double any embedded quotes. */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header + rows (every cell escaped). Rows are CRLF-joined per RFC 4180. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
