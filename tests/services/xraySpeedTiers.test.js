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

  it('throws for an unknown tier', () => {
    expect(() => speedTiers.rateMbitFor(2)).toThrow('Unknown VLESS speed tier');
  });
});

describe('ruleTagFor', () => {
  it('derives a stable per-uuid ruleTag', () => {
    expect(speedTiers.ruleTagFor('abc-123')).toBe('user-abc-123');
  });
});

describe('peerOutboundTag / parsePeerOutboundTag', () => {
  it('encodes the tier and uuid into a personal outbound tag', () => {
    expect(speedTiers.peerOutboundTag(3, 'abc-123')).toBe('peer-t3-abc-123');
  });

  it('round-trips tag -> {tier, uuid}, even when the uuid itself contains hyphens', () => {
    const tag = speedTiers.peerOutboundTag(5, 'ef8245b3-4231-4bbd-b4d3-7ecc886da50e');
    expect(speedTiers.parsePeerOutboundTag(tag)).toEqual({
      tier: 5, uuid: 'ef8245b3-4231-4bbd-b4d3-7ecc886da50e',
    });
  });

  it('returns null for a tag that is not a personal peer outbound (e.g. direct/dns-out)', () => {
    expect(speedTiers.parsePeerOutboundTag('direct')).toBeNull();
    expect(speedTiers.parsePeerOutboundTag('dns-out')).toBeNull();
  });
});

describe('PEER_MARK_BASE / PEER_MARK_MAX', () => {
  it('defines a mark pool disjoint from the old shared tier marks (101/103/105)', () => {
    expect(speedTiers.PEER_MARK_BASE).toBeGreaterThan(105);
    expect(speedTiers.PEER_MARK_MAX).toBeGreaterThan(speedTiers.PEER_MARK_BASE);
  });
});
