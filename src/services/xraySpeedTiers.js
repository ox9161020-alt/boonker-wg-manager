'use strict';

// Speed tiers are tied to the existing device-count plan tiers (D4,
// ROADMAP_AWG-VLESS.md Этап 0) rather than a separate tariff dimension — a
// user's tier is derived from their subscription's max_devices (1/3/5).
// Exact Mbit/s numbers are still a pending product decision (D4) — the
// defaults below are placeholders, tunable via env without a redeploy, same
// as AWG_PEER_RATE_MBIT already is.
//
// IMPORTANT: the RATE is per-tier, but the fw mark/tc filter is per USER, not
// per tier — every VLESS user gets their own personal freedom outbound with a
// unique mark, so their tc police action is never shared with anyone else on
// the same tier. A single shared mark per tier (the original Этап 1 design)
// meant every concurrent user on that tier split ONE combined rate limit —
// found live during audit 2026-07-24, not caught by the throughput E2E
// because it only ever tested one client at a time.
// Tier 0 is not a device-count plan tier — it's the anti-torrent penalty tier
// (Этап 2, ROADMAP_AWG-VLESS.md): applied by xrayConnLimitPoller.js when a
// UUID's simultaneous connection count crosses VLESS_PEER_CONNLIMIT, via the
// exact same setUserSpeedTier()/applySpeedTier() path as a normal plan tier.
const PENALTY_TIER = 0;

const TIER_RATES = {
  [PENALTY_TIER]: { envVar: 'VLESS_TIER_PENALTY_MBIT', defaultMbit: 0.5 },
  1: { envVar: 'VLESS_TIER_1_MBIT', defaultMbit: 10 },
  3: { envVar: 'VLESS_TIER_3_MBIT', defaultMbit: 30 },
  5: { envVar: 'VLESS_TIER_5_MBIT', defaultMbit: 50 },
};

function getTierRate(tier) {
  const t = TIER_RATES[tier];
  if (!t) throw new Error(`Unknown VLESS speed tier: ${tier}`);
  return t;
}

// Product-facing plan tiers only — excludes PENALTY_TIER, which is an
// internal anti-abuse mechanism, not something a subscription ever grants.
function listTiers() {
  return Object.keys(TIER_RATES).map(Number).filter((t) => t !== PENALTY_TIER);
}

function rateMbitFor(tier) {
  const t = getTierRate(tier);
  // parseFloat, not parseInt — the penalty tier's 0.5 default would truncate
  // to 0 (an unlimited/no-op tc rate) with parseInt.
  return parseFloat(process.env[t.envVar] || String(t.defaultMbit));
}

// Every user gets a stable per-UUID ruleTag so `xray api rmrules` can remove
// exactly their routing rule without disturbing anyone else's (confirmed live
// on an isolated throwaway xray instance — see ROADMAP_AWG-VLESS.md Этап 1).
function ruleTagFor(uuid) {
  return `user-${uuid}`;
}

// Personal per-user outbound tag. Encodes the tier number so a node reboot
// can re-derive each user's rate (tc filter state is wiped on reboot, this
// tag persists in config.json's outbounds list) without a separate lookup
// table, and so an env-var rate change (VLESS_TIER_3_MBIT etc.) takes effect
// for every tier-3 user on the next wg-manager restart, same as before.
function peerOutboundTag(tier, uuid) {
  return `peer-t${tier}-${uuid}`;
}

const PEER_TAG_RE = /^peer-t(\d+)-(.+)$/;

function parsePeerOutboundTag(tag) {
  const match = PEER_TAG_RE.exec(String(tag || ''));
  if (!match) return null;
  return { tier: parseInt(match[1], 10), uuid: match[2] };
}

// fw mark / tc prio pool for personal per-user filters — deliberately a
// different range than anything else already in use (old shared tier marks
// 101/103/105, AWG's per-peer prio range 2-254 on a different interface
// entirely) purely to keep `tc filter show`/`nft` output unambiguous during
// debugging; there's no actual collision risk since VLESS shaping runs on
// PUBLIC_IFACE while AWG's runs on awg0/ifb0.
const PEER_MARK_BASE = 2000;
const PEER_MARK_MAX = 59999;

module.exports = {
  listTiers,
  rateMbitFor,
  ruleTagFor,
  peerOutboundTag,
  parsePeerOutboundTag,
  PEER_MARK_BASE,
  PEER_MARK_MAX,
  PENALTY_TIER,
};
