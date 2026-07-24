'use strict';

// Speed tiers are tied to the existing device-count plan tiers (D4,
// ROADMAP_AWG-VLESS.md Этап 0) rather than a separate tariff dimension —
// one mark/outbound per device-tier (1/3/5 devices). Exact Mbit/s numbers are
// still a pending product decision (D4) — the defaults below are placeholders,
// tunable via env without a redeploy, same as AWG_PEER_RATE_MBIT already is.
const TIERS = {
  1: { mark: 101, prio: 60, envVar: 'VLESS_TIER_1_MBIT', defaultMbit: 10 },
  3: { mark: 103, prio: 61, envVar: 'VLESS_TIER_3_MBIT', defaultMbit: 30 },
  5: { mark: 105, prio: 62, envVar: 'VLESS_TIER_5_MBIT', defaultMbit: 50 },
};

function getTier(tier) {
  const t = TIERS[tier];
  if (!t) throw new Error(`Unknown VLESS speed tier: ${tier}`);
  return t;
}

function listTiers() {
  return Object.keys(TIERS).map(Number);
}

function markFor(tier) {
  return getTier(tier).mark;
}

function prioFor(tier) {
  return getTier(tier).prio;
}

function rateMbitFor(tier) {
  const t = getTier(tier);
  return parseInt(process.env[t.envVar] || String(t.defaultMbit), 10);
}

// Outbound/rule tags are derived from the mark so config, tc and nft all agree
// on the same identifier without needing a separate lookup table.
function outboundTag(tier) {
  return `tier-${markFor(tier)}`;
}

function tierForMark(mark) {
  return listTiers().find((t) => markFor(t) === mark) ?? null;
}

// Every user gets a stable per-UUID ruleTag so `xray api rmrules` can remove
// exactly their routing rule without disturbing anyone else's (confirmed live
// on an isolated throwaway xray instance — see ROADMAP_AWG-VLESS.md Этап 1).
function ruleTagFor(uuid) {
  return `user-${uuid}`;
}

module.exports = { TIERS, listTiers, markFor, prioFor, rateMbitFor, outboundTag, tierForMark, ruleTagFor };
