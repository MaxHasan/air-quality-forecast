import { describe, expect, it } from 'vitest';
import { TREND_PRESENTATION, pm25Trend } from '@/lib/display';

/**
 * The trend arrow sits between today's and tomorrow's numbers on every card.
 * Its dead band is the point under test: the models' holdout MAE runs 6–10
 * µg/m³, so an arrow that reacted to a 1–2 µg/m³ wiggle would be reading tea
 * leaves and flipping direction day to day.
 */
describe('pm25Trend', () => {
  it('calls a real improvement improving', () => {
    expect(pm25Trend(68, 56)).toBe('improving');
  });

  it('calls a real deterioration worsening', () => {
    expect(pm25Trend(33, 44)).toBe('worsening');
  });

  it('treats moves inside the dead band as steady, in both directions', () => {
    expect(pm25Trend(33, 31)).toBe('steady');
    expect(pm25Trend(33, 35)).toBe('steady');
    expect(pm25Trend(33, 33)).toBe('steady');
  });

  it('uses an absolute floor of 3 µg/m³ at clean-air levels', () => {
    // At Bali-clean levels a 10% band would be under 1 µg/m³ — pure noise.
    expect(pm25Trend(9, 11)).toBe('steady');
    expect(pm25Trend(9, 12.5)).toBe('worsening');
  });

  it('scales the band to 10% at polluted levels', () => {
    // At 80 µg/m³ the band is 8, so a 5-point move is still "about the same".
    expect(pm25Trend(80, 75)).toBe('steady');
    expect(pm25Trend(80, 71)).toBe('improving');
  });

  it('returns null — no arrow — when either side is missing', () => {
    expect(pm25Trend(null, 30)).toBeNull();
    expect(pm25Trend(30, null)).toBeNull();
    expect(pm25Trend(undefined, undefined)).toBeNull();
    expect(pm25Trend(Number.NaN, 30)).toBeNull();
  });

  it('has presentation (glyph, label, tone) for every trend it can return', () => {
    for (const t of ['improving', 'worsening', 'steady'] as const) {
      expect(TREND_PRESENTATION[t].glyph.length).toBeGreaterThan(0);
      expect(TREND_PRESENTATION[t].label.length).toBeGreaterThan(0);
      expect(TREND_PRESENTATION[t].toneClass.length).toBeGreaterThan(0);
    }
  });
});
