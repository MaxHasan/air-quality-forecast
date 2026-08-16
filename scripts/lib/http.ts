/**
 * http.ts — the one place a script talks to the outside world.
 *
 * Everything upstream (WAQI, data.gov.sg, Open-Meteo) is fetched through
 * `fetchJson`, which never throws and never returns a half-parsed body. Callers
 * get a discriminated result and decide what a failure means; a per-station
 * failure is routine (see run-log.ts), a total failure is not.
 *
 * Three things this file exists to guarantee:
 *
 * 1. **Secrets never reach a log line.** The WAQI token travels in the query
 *    string, so the naive `throw new Error(\`fetch failed: ${url}\`)` would put
 *    it into `ingestion_runs.error` — a column with a *public* SELECT policy
 *    (0003_rls.sql). Every message that leaves this module goes through
 *    `redactSecrets` first, which scrubs both known query-parameter names and
 *    the literal values of the secrets present in the environment.
 *
 * 2. **A hung request cannot hang a cron job.** GitHub Actions bills wall-clock
 *    minutes and a stalled socket has no natural timeout in undici, so every
 *    request carries an AbortSignal.
 *
 * 3. **A blip is not an outage.** Transient network errors, 429s and 5xx are
 *    retried with exponential backoff; 4xx are not, because retrying a bad
 *    request just makes the same mistake more slowly. Note that WAQI answers a
 *    bad station id with HTTP 200 and an error *body*, so status-based retry
 *    logic never sees it — that case belongs to the parser, not here.
 */

/** Successful fetch + JSON parse. `data` is unvalidated — parse it downstream. */
export interface HttpOk<T> {
  ok: true;
  status: number;
  data: T;
}

/** Any failure: DNS, timeout, non-2xx, or a body that was not JSON. */
export interface HttpErr {
  ok: false;
  /** HTTP status, or `null` when the request never completed. */
  status: number | null;
  /** Already redacted — safe to store and print. */
  message: string;
}

export type HttpResult<T> = HttpOk<T> | HttpErr;

export interface FetchJsonOptions {
  /** Per-attempt timeout, ms. */
  timeoutMs?: number;
  /** Additional attempts after the first. */
  retries?: number;
  /** Base backoff, ms; doubles per attempt. */
  backoffMs?: number;
  /** Sent on every request — upstreams are free and asking for identification is cheap. */
  userAgent?: string;
}

const DEFAULTS: Required<FetchJsonOptions> = {
  timeoutMs: 20_000,
  retries: 2,
  backoffMs: 750,
  userAgent: 'air-quality-predictor/1.0 (personal, non-commercial; github.com/MaxHasan/air-quality-predictor)',
};

/** Query parameters whose values must never be printed. */
const SECRET_PARAMS = ['token', 'api_key', 'apikey', 'key', 'access_token'];

/** Environment variables whose literal values must never be printed. */
const SECRET_ENV_VARS = ['WAQI_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'];

/**
 * Remove secrets from arbitrary text.
 *
 * Belt and braces on purpose: the query-parameter pass catches URLs we built,
 * and the environment-value pass catches anything else that happens to embed a
 * key — an upstream error message echoing the request, say. A short env value
 * (< 8 chars) is ignored, because scrubbing a two-character "token" would
 * mangle unrelated text without protecting anything.
 */
export function redactSecrets(text: string): string {
  let out = text;

  for (const param of SECRET_PARAMS) {
    // Matches `token=abc` up to the next & or whitespace, case-insensitively.
    out = out.replace(new RegExp(`([?&]${param}=)[^&\\s"']+`, 'gi'), '$1[redacted]');
  }

  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 8) {
      out = out.split(value).join('[redacted]');
    }
  }

  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip the query string entirely — enough to identify an endpoint in a log. */
export function safeUrlLabel(url: string): string {
  const q = url.indexOf('?');
  return redactSecrets(q === -1 ? url : url.slice(0, q));
}

/** 408/429 and 5xx are worth another go; everything else is a real answer. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * GET a URL and parse the body as JSON.
 *
 * Returns `HttpErr` rather than throwing for every failure mode, including a
 * non-2xx status: a caller that wants to treat "404 from data.gov.sg" as an
 * empty day rather than an outage can, and one that does not has a `message`
 * ready to log.
 *
 * A non-2xx response still has its body read (truncated) into the message,
 * because upstream error bodies are usually the only thing that says *why*.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<HttpResult<T>> {
  const { timeoutMs, retries, backoffMs, userAgent } = { ...DEFAULTS, ...options };
  const label = safeUrlLabel(url);
  let last: HttpErr = { ok: false, status: null, message: `${label}: no attempt was made` };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));

    // A fresh controller per attempt: an AbortSignal cannot be un-aborted.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': userAgent },
      });

      if (!res.ok) {
        const body = redactSecrets((await res.text().catch(() => '')).slice(0, 300));
        last = { ok: false, status: res.status, message: `${label}: HTTP ${res.status} ${res.statusText} ${body}`.trim() };
        if (!isRetryableStatus(res.status)) return last;
        continue;
      }

      // Parsed inside the try so a truncated/HTML body (a captive portal, a
      // proxy error page) is reported as a failure rather than crashing.
      const data = (await res.json()) as T;
      return { ok: true, status: res.status, data };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const detail = aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      last = { ok: false, status: null, message: redactSecrets(`${label}: ${detail}`) };
    } finally {
      clearTimeout(timer);
    }
  }

  return last;
}
