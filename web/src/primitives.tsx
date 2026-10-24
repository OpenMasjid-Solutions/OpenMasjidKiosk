// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The few primitives every section of the panel uses — the live masjid clock, the loading skeleton,
 * the outcome line, the switch, and tabular figures inside a line of text.
 *
 * A module of their own, with nothing heavier than React and the icon set, because both ui.tsx (the
 * shell) and whatsnew.tsx need them and ui.tsx also opens the What's-new window: kept in ui.tsx they
 * made the two import each other. That cycle is harmless in a production bundle and not in Vite's
 * hot reload, and the next module to join it would not have been harmless at all. ui.tsx re-exports
 * everything here, so existing imports keep working.
 */
import { useId, useSyncExternalStore, type ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { getClock, subscribeClock, type ClockSettings } from './locale';

/** The masjid's clock settings, live. Any component that formats a date through dates.ts should
 *  read this so it re-renders when the settings load or change. */
export function useClock(): ClockSettings {
  return useSyncExternalStore(subscribeClock, getClock, getClock);
}

/**
 * A loading placeholder shaped like what is coming — never a bare spinner (spec §5). It says
 * "Loading…" to a screen reader once, as a status; the bars themselves are hidden from it. Shimmers
 * only while mounted, and the global reduced-motion rule freezes it.
 */
export function Skeleton({
  rows = 3,
  height = '1rem',
  label = 'Loading…',
  widths,
}: {
  rows?: number;
  height?: string;
  label?: string;
  /** Optional per-row widths (e.g. ['100%', '70%']) so a block of text looks like text. */
  widths?: string[];
}) {
  return (
    <div className="skel-stack" role="status">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton" aria-hidden="true" style={{ height, width: widths?.[i % widths.length] }} />
      ))}
    </div>
  );
}

/**
 * Tabular digits on the FIGURES in a line of text, and on nothing else (spec §4).
 *
 * Inter's `tnum` also widens the hyphen and the brackets, so it cannot go on a whole line that may
 * hold a donor's name, a campaign called "Al-Noor" or the word "One-time". This wraps each run of
 * digits — with the separators inside it, so "1,234.50" stays one figure — in `.num`. Anything that
 * is not a string or a number (a <time>, an element) comes back untouched.
 *
 * `.num` does not isolate itself under dir=rtl (app.css), so wrapping a figure never changes how the
 * line around it is ordered: "$25" reads the same split as whole.
 */
export function figures(node: ReactNode): ReactNode {
  if (typeof node !== 'string' && typeof node !== 'number') return node;
  const parts = String(node).split(/(\d+(?:[.,:\u00a0\u202f]\d+)*)/);
  if (parts.length === 1) return node;
  return parts.map((p, i) => (i % 2 ? <span key={i} className="num">{p}</span> : p));
}

/**
 * The outcome of something the admin just did: a tick or a warning sign, then one sentence.
 *
 * `ok` decides the icon, the colour AND the role — a success is a polite `status`, a failure an
 * `alert` — so a failure can never be drawn as success or read out as help text (spec §9: never
 * report success you cannot verify). `tone="info"` is for an outcome that is neither, like "queued".
 *
 * `live={false}` keeps the look and drops the role, for a line that states how things STAND rather
 * than what just happened — "Connected in live mode" on a panel that mounts on every visit to
 * Settings would otherwise be announced on every visit, and as an interrupting alert when it is bad.
 */
export function ResultLine({
  ok,
  tone,
  live = true,
  children,
}: {
  ok: boolean;
  tone?: 'info';
  live?: boolean;
  children: ReactNode;
}) {
  const kind = tone === 'info' ? 'info' : ok ? 'ok' : 'bad';
  const Icon = kind === 'ok' ? CheckCircle2 : kind === 'bad' ? TriangleAlert : Info;
  return (
    <p className={`result result--${kind}`} role={live ? (kind === 'bad' ? 'alert' : 'status') : undefined}>
      <Icon size={15} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * An on/off switch with its label and hint. A real button with role="switch", described by its hint,
 * so a screen reader hears what the setting does, not just its name.
 *
 * `disabled` is for a setting that genuinely cannot change (the main campaign is always live).
 * `busy` is for "saving that just now": the switch stays focusable (aria-disabled) and ignores presses,
 * because a truly disabled button drops keyboard focus to the page — exactly on the switch just
 * pressed (spec §7).
 */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
  busy,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const hintId = useId();
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && (
          <span className="hint" id={hintId}>
            {hint}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        aria-disabled={busy || undefined}
        className={`switch${checked ? ' switch--on' : ''}`}
        onClick={() => !disabled && !busy && onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </label>
  );
}
