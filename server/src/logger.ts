// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Tiny tagged logger. Keep it boring — and never log secrets (the Stripe secret key,
 *  the per-app Fabric secret, device tokens, session cookies). */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function emit(level: Level, tag: string, args: unknown[]): void {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${tag}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line, ...args);
}

export function makeLog(tag: string) {
  return {
    debug: (...a: unknown[]) => emit('debug', tag, a),
    info: (...a: unknown[]) => emit('info', tag, a),
    warn: (...a: unknown[]) => emit('warn', tag, a),
    error: (...a: unknown[]) => emit('error', tag, a),
  };
}
