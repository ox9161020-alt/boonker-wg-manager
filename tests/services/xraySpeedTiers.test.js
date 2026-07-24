'use strict';

let speedTiers;

beforeEach(() => {
  jest.resetModules();
  delete process.env.VLESS_TIER_1_MBIT;
  delete process.env.VLESS_TIER_3_MBIT;
  delete process.env.VLESS_TIER_5_MBIT;
  speedTiers = require('../../src/services/xraySpeedTiers');
});

describe('listTiers', () => {
  it('exposes the 1/3/5 device-count tiers (D4: tied to the existing device-tier model)', () => {
    expect(speedTiers.listTiers()).toEqual([1, 3, 5]);
  });
});

describe('markFor / outboundTag / tierForMark', () => {
  it('gives each tier a distinct mark and a mark-derived outbound tag', () => {
    expect(speedTiers.markFor(1)).toBe(101);
    expect(speedTiers.markFor(3)).toBe(103);
    expect(speedTiers.markFor(5)).toBe(105);
    expect(speedTiers.outboundTag(3)).toBe('tier-103');
  });

  it('resolves a mark back to its tier', () => {
    expect(speedTiers.tierForMark(103)).toBe(3);
    expect(speedTiers.tierForMark(999)).toBeNull();
  });

  it('throws for an unknown tier', () => {
    expect(() => speedTiers.markFor(2)).toThrow('Unknown VLESS speed tier');
  });
});

describe('rateMbitFor', () => {
  it('uses the placeholder default when no env override is set', () => {
    expect(speedTiers.rateMbitFor(1)).toBe(10);
    expect(speedTiers.rateMbitFor(3)).toBe(30);
    expect(speedTiers.rateMbitFor(5)).toBe(50);
  });

  it('honours a per-tier env override (D4 exact numbers are still pending — must be tunable without a redeploy)', () => {
    process.env.VLESS_TIER_3_MBIT = '45';
    expect(speedTiers.rateMbitFor(3)).toBe(45);
    expect(speedTiers.rateMbitFor(1)).toBe(10);
  });
});

describe('ruleTagFor', () => {
  it('derives a stable per-uuid ruleTag', () => {
    expect(speedTiers.ruleTagFor('abc-123')).toBe('user-abc-123');
  });
});
