import { afterEach, describe, expect, it } from 'vitest';
import { redactSecrets, safeUrlLabel } from '../scripts/lib/http';

/**
 * These tests guard a real exposure, not a hypothetical one.
 *
 * The WAQI token travels in the query string, and every fetch failure message
 * ends up in `ingestion_runs.error` — a column with a *public* SELECT policy
 * (0003_rls.sql), read by the PWA footer, in a **public** GitHub repository.
 * The obvious `throw new Error(\`fetch failed: ${url}\`)` would publish the
 * token to anyone who opened the site.
 */

const ORIGINAL = process.env.WAQI_TOKEN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WAQI_TOKEN;
  else process.env.WAQI_TOKEN = ORIGINAL;
});

describe('redactSecrets — query parameters', () => {
  it('scrubs the WAQI token out of a feed URL', () => {
    const out = redactSecrets('https://api.waqi.info/feed/@8294/?token=abc123def456: HTTP 500');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('token=[redacted]');
    // The useful part survives, or the redaction has just traded one problem
    // for an unreadable log.
    expect(out).toContain('api.waqi.info/feed/@8294');
    expect(out).toContain('HTTP 500');
  });

  it('scrubs the common key parameter names, case-insensitively', () => {
    for (const param of ['token', 'api_key', 'apikey', 'key', 'access_token', 'TOKEN']) {
      expect(redactSecrets(`https://x.test/?${param}=s3cret-value`)).not.toContain('s3cret-value');
    }
  });

  it('stops at the parameter boundary and keeps what follows', () => {
    const out = redactSecrets('https://x.test/?token=s3cretvalue&networks=all');
    expect(out).toBe('https://x.test/?token=[redacted]&networks=all');
  });

  it('handles a token that is not the first parameter', () => {
    const out = redactSecrets('https://x.test/?latlng=1,2,3,4&token=s3cretvalue');
    expect(out).not.toContain('s3cretvalue');
    expect(out).toContain('latlng=1,2,3,4');
  });
});

describe('redactSecrets — literal environment values', () => {
  it('scrubs the token wherever it appears, not just in a URL', () => {
    // The second line of defence: an upstream error body echoing the request,
    // or a message we did not build ourselves.
    process.env.WAQI_TOKEN = 'a1b2c3d4e5f6g7h8';
    const out = redactSecrets('upstream said: your key a1b2c3d4e5f6g7h8 is rate limited');
    expect(out).not.toContain('a1b2c3d4e5f6g7h8');
    expect(out).toContain('[redacted]');
  });

  it('ignores a suspiciously short value rather than mangling unrelated text', () => {
    // Scrubbing a two-character "secret" would corrupt every log line that
    // happened to contain those characters, while protecting nothing.
    process.env.WAQI_TOKEN = 'ab';
    expect(redactSecrets('a stable feed above the abyss')).toBe('a stable feed above the abyss');
  });

  it('leaves ordinary text untouched', () => {
    delete process.env.WAQI_TOKEN;
    const msg = 'reading stations: Could not find the table public.stations [PGRST205]';
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe('safeUrlLabel', () => {
  it('drops the query string entirely, keeping the endpoint identifiable', () => {
    expect(safeUrlLabel('https://api.waqi.info/feed/@8294/?token=s3cretvalue')).toBe(
      'https://api.waqi.info/feed/@8294/',
    );
  });

  it('is a no-op on a URL with no query string', () => {
    expect(safeUrlLabel('https://api-open.data.gov.sg/v2/real-time/api/pm25')).toBe(
      'https://api-open.data.gov.sg/v2/real-time/api/pm25',
    );
  });
});
