/**
 * db.ts — Supabase client factories.
 *
 * Two clients, deliberately separated:
 *
 *   getAnonClient()    read-only, safe in the browser and in RSC. Backed by the
 *                      publishable anon key; RLS grants it SELECT and nothing else.
 *   getServiceClient() full read/write, **server/CI only**. Backed by the
 *                      service-role key, which bypasses RLS entirely.
 *
 * The service-role key must never reach a bundle. Two guards enforce that:
 * it is read from a non-`NEXT_PUBLIC_` variable (so Next.js will not inline it
 * into client code), and `getServiceClient` throws if it is called where
 * `window` exists.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export type Db = SupabaseClient<Database>;

/** Read an env var, trimming accidental whitespace from copy-paste. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Project URL. Accepts either variable so the same code runs in Next.js
 * (`NEXT_PUBLIC_SUPABASE_URL`) and in GitHub Actions (`SUPABASE_URL`).
 */
function supabaseUrl(): string {
  const url = env('NEXT_PUBLIC_SUPABASE_URL') ?? env('SUPABASE_URL');
  if (!url) {
    throw new Error(
      'Missing Supabase URL. Set NEXT_PUBLIC_SUPABASE_URL (app) or SUPABASE_URL (scripts). See .env.example.',
    );
  }
  return url.replace(/\/+$/, '');
}

let anonClient: Db | null = null;

/**
 * Read-only client, memoised.
 *
 * Auth persistence is off: the app has no login in v1, and leaving it on makes
 * the client write to storage that does not exist in a Node script.
 */
export function getAnonClient(): Db {
  if (anonClient) return anonClient;

  const key = env('NEXT_PUBLIC_SUPABASE_ANON_KEY') ?? env('SUPABASE_ANON_KEY');
  if (!key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example.');
  }

  anonClient = createClient<Database>(supabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return anonClient;
}

let serviceClient: Db | null = null;

/**
 * Read/write client for ingestion, prediction and calibration.
 *
 * Throws rather than degrading to the anon key: a script that silently lost its
 * write privileges would look like it succeeded while persisting nothing.
 */
export function getServiceClient(): Db {
  if (typeof window !== 'undefined') {
    throw new Error('getServiceClient() called in a browser context — the service-role key must stay server-side.');
  }
  if (serviceClient) return serviceClient;

  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY. Set it locally in .env.local, and in CI as a repo secret.');
  }

  serviceClient = createClient<Database>(supabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'air-quality-predictor/ingest' } },
  });
  return serviceClient;
}

/** True when the service-role key is present — lets scripts fail fast with a clear message. */
export function hasServiceCredentials(): boolean {
  return Boolean(env('SUPABASE_SERVICE_ROLE_KEY')) && Boolean(env('NEXT_PUBLIC_SUPABASE_URL') ?? env('SUPABASE_URL'));
}

/** Reset memoised clients. Tests only. */
export function __resetClients(): void {
  anonClient = null;
  serviceClient = null;
}
