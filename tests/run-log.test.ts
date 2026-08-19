import { describe, expect, it } from 'vitest';
import { hasFlag, intFlag, stringFlag } from '../scripts/lib/run-log';

/**
 * Flag parsing is where a typo turns into a silently different job.
 *
 * The rule both helpers follow: a MISSING flag takes the fallback, but a flag
 * that is present and unusable THROWS. The alternative — treating a valueless
 * flag as "not specified" — means `--only` followed by another option quietly
 * runs every source, which is the opposite of what the operator asked for and,
 * in CI, spends the WAQI calls the restricted workflow exists to avoid.
 */

describe('stringFlag', () => {
  it('reads both --flag=value and --flag value', () => {
    expect(stringFlag(['--only=airgradient'], 'only', null)).toBe('airgradient');
    expect(stringFlag(['--only', 'airgradient'], 'only', null)).toBe('airgradient');
  });

  it('returns the fallback when the flag is absent entirely', () => {
    expect(stringFlag([], 'only', null)).toBeNull();
    expect(stringFlag(['--dry-run'], 'only', null)).toBeNull();
    expect(stringFlag(['--other=x'], 'only', 'fallback')).toBe('fallback');
  });

  it('throws when the flag is present but has no value', () => {
    // The regression this guards: each of these used to return null, which
    // aq.ts reads as "all sources" — so `--only --dry-run` ran a full ingest.
    expect(() => stringFlag(['--only'], 'only', null)).toThrow(/no value/);
    expect(() => stringFlag(['--only', '--dry-run'], 'only', null)).toThrow(/no value/);
    expect(() => stringFlag(['--only='], 'only', null)).toThrow(/no value/);
    expect(() => stringFlag(['--only', '   '], 'only', null)).toThrow(/no value/);
  });

  it('does not swallow the following option as its value', () => {
    expect(() => stringFlag(['--only', '--write'], 'only', null)).toThrow(/no value/);
  });

  it('leaves other flags alone', () => {
    expect(stringFlag(['--only=waqi', '--dry-run'], 'only', null)).toBe('waqi');
    expect(hasFlag(['--only=waqi', '--dry-run'], 'dry-run')).toBe(true);
  });
});

describe('intFlag keeps its own contract', () => {
  it('takes the fallback when absent and throws when unparseable', () => {
    expect(intFlag([], 'days', 3)).toBe(3);
    expect(intFlag(['--days=30'], 'days', 3)).toBe(30);
    expect(intFlag(['--days', '30'], 'days', 3)).toBe(30);
    expect(() => intFlag(['--days', 'banana'], 'days', 3)).toThrow();
    expect(() => intFlag(['--days', '0'], 'days', 3)).toThrow();
  });
});
