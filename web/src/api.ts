// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Typed client for the OpenMasjid Kiosk API. Responses use a { data | error } envelope;
 *  this unwraps `data` and turns `error` into a thrown friendly message. Grows with each
 *  slice (auth/SSO, devices, payments, donations). */
import { withBase } from './base';

export interface AppInfo {
  name: string;
  version: string;
  /** True when running embedded under OpenMasjidOS (Fabric available). */
  embedded: boolean;
  /** Whether the Android kiosk app is bundled in this server image (false in dev / before
   *  the first CI build). */
  apkAvailable: boolean;
  /** Where /new links the download button. */
  apkDownloadPath: string;
  /** Suggested download filename (versioned). */
  apkFilename: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBase(path), {
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok || body.error) {
    throw new Error(body.error || 'Something went wrong. Please try again.');
  }
  return body.data as T;
}

export const getAppInfo = () => request<AppInfo>('/api/app');
