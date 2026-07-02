// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Small shared UI pieces for the admin panel. Grows into a proper component set in later
 *  slices; slice 1 needs the masjid mark and a theme toggle. */
import { Moon, Sun, Monitor } from 'lucide-react';
import { prefsStore, usePrefs, type Prefs } from './prefs';

/** A simple crescent + star mark (geometric motif — never sacred text in chrome). */
export function Crescent({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M17 4a8 8 0 1 0 0 16 6.4 6.4 0 1 1 0-16z" fill="currentColor" />
      <path d="M19.5 5.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

const NEXT: Record<Prefs['theme'], Prefs['theme']> = { system: 'dark', dark: 'light', light: 'system' };
const THEME_LABEL: Record<Prefs['theme'], string> = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };

/** Cycles system → dark → light. Dark is the default look. */
export function ThemeToggle() {
  const { theme } = usePrefs();
  const Icon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  return (
    <button
      className="icon-btn"
      title={THEME_LABEL[theme]}
      aria-label={`${THEME_LABEL[theme]} — click to change`}
      onClick={() => prefsStore.patch({ theme: NEXT[theme] })}
    >
      <Icon size={19} />
    </button>
  );
}
