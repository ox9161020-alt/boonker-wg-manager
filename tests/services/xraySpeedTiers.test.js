'use strict';

let speedTiers;

beforeEach(() => {
  jest.resetModules();
  delete process.env.VLESS_TIER_1_MBIT;
  delete process.env.VLESS_TIER_3_MBIT;
  delete process.env.VLESS_TIER_5_MBIT;
  delete process.env.VLESS_TIER_PENALTY_MBIT;
  delete process.env.VLESS_QUOTA_BAND_0_MBIT;
  delete process.env.VLESS_QUOTA_BAND_1_MBIT;
  delete process.env.VLESS_QUOTA_BAND_2_MBIT;
  delete process.env.VLESS_QUOTA_EXHAUSTED_MBIT;
  speedTiers = require('../../src/services/xraySpeedTiers');
});

describe('listTiers', () => {
  it('exposes the 1/3/5 device-count tiers (D4: tied to the existing device-tier model)', () => {
    expect(speedTiers.listTiers()).toEqual([1, 3, 5]);
  });

  it('excludes PENALTY_TIER — it is an anti-abuse mechanism, not a plan a subscription grants', () => {
    expect(speedTiers.listTiers()).not.toContain(speedTiers.PENALTY_TIER);
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

  it('resolves the penalty tier (0) to a 0.5 Mbit default, not truncated to 0 by parseInt (Этап 2)', () => {
    expect(speedTiers.rateMbitFor(speedTiers.PENALTY_TIER)).toBe(0.5);
  });

  it('honours a fractional env override for the penalty tier', () => {
    process.env.VLESS_TIER_PENALTY_MBIT = '0.25';
    expect(speedTiers.rateMbitFor(speedTiers.PENALTY_TIER)).toBe(0.25);
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

  it('round-trips the penalty tier (0) same as any other tier', () => {
    const tag = speedTiers.peerOutboundTag(speedTiers.PENALTY_TIER, 'abc-123');
    expect(tag).toBe('peer-t0-abc-123');
    expect(speedTiers.parsePeerOutboundTag(tag)).toEqual({ tier: 0, uuid: 'abc-123' });
  });
});

describe('PEER_MARK_BASE / PEER_MARK_MAX', () => {
  it('defines a mark pool disjoint from the old shared tier marks (101/103/105)', () => {
    expect(speedTiers.PEER_MARK_BASE).toBeGreaterThan(105);
    expect(speedTiers.PEER_MARK_MAX).toBeGreaterThan(speedTiers.PEER_MARK_BASE);
  });
});

describe('volume-quota tiers (ROADMAP_AWG-VLESS.md — "честная лестница" 2026-07-26)', () => {
  it('excludes quota-band tiers and the exhausted tier from listTiers (not a plan a subscription grants)', () => {
    expect(speedTiers.listTiers()).toEqual([1, 3, 5]);
    for (const t of speedTiers.QUOTA_BAND_TIERS) expect(speedTiers.listTiers()).not.toContain(t);
    expect(speedTiers.listTiers()).not.toContain(speedTiers.QUOTA_EXHAUSTED_TIER);
  });

  it('resolves default Mbit rates matching the 2026-07-26 ladder (30/10/1/0.5)', () => {
    const [band0, band1, band2] = speedTiers.QUOTA_BAND_TIERS;
    expect(speedTiers.rateMbitFor(band0)).toBe(30);
    expect(speedTiers.rateMbitFor(band1)).toBe(10);
    expect(speedTiers.rateMbitFor(band2)).toBe(1);
    expect(speedTiers.rateMbitFor(speedTiers.QUOTA_EXHAUSTED_TIER)).toBe(0.5);
  });

  it('honours per-band env overrides independently of PENALTY_TIER, even though defaults happen to match today', () => {
    process.env.VLESS_QUOTA_EXHAUSTED_MBIT = '0.25';
    expect(speedTiers.rateMbitFor(speedTiers.QUOTA_EXHAUSTED_TIER)).toBe(0.25);
    expect(speedTiers.rateMbitFor(speedTiers.PENALTY_TIER)).toBe(0.5); // untouched
  });

  it('round-trips quota tier tags same as any other tier', () => {
    const tag = speedTiers.peerOutboundTag(speedTiers.QUOTA_BAND_TIERS[0], 'abc-123');
    expect(tag).toBe('peer-t100-abc-123');
    expect(speedTiers.parsePeerOutboundTag(tag)).toEqual({ tier: 100, uuid: 'abc-123' });
  });
});
