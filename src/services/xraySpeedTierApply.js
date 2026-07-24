'use strict';
const xrayConfig = require('./xrayConfig');
const xrayProcess = require('./xrayProcess');
const xrayShaping = require('./xrayShaping');

// Applies (or updates, on an upgrade/downgrade) a user's speed-tier: their
// own personal outbound + tc filter (never shared with another user, even
// on the same tier — see xraySpeedTiers.js's header comment) and a
// `user`-matched routing rule. Used by vless.js (create/restore) and by
// xrayConnLimitPoller.js (Этап 2 anti-torrent downgrade/auto-restore) so a
// tier change never needs a fresh UUID and both callers hot-apply exactly
// the same way (ROADMAP_AWG-VLESS.md Этап 1/2). No-op when speedTier is
// absent.
function applySpeedTier(uuid, email, speedTier) {
  if (speedTier == null) return null;
  const { ruleTag, outboundTag, mark, created, hadPreviousRule, oldMark, oldTag } =
    xrayConfig.setUserSpeedTier(uuid, email, speedTier);

  if (created) xrayProcess.addOutboundToRunning(outboundTag, mark);
  // adrules -append never replaces a same-tagged rule already live in
  // Xray's memory (confirmed live, ROADMAP_AWG-VLESS.md Этап 1) — clear the
  // old one first on a re-assign (tier change, or an idempotent re-confirm
  // via /restore) so Xray never evaluates a stale duplicate. Skipped on a
  // genuinely first-ever assignment since there's nothing live to remove.
  if (hadPreviousRule) xrayProcess.removeRoutingRuleFromRunning(ruleTag);
  xrayProcess.addRoutingRuleToRunning(ruleTag, email, outboundTag);

  xrayShaping.addPeerFilter(mark, speedTier);
  if (oldMark != null) {
    // Tier changed — the old personal outbound/filter belongs to nobody
    // now, clean both up instead of leaking them.
    xrayProcess.removeOutboundFromRunning(oldTag);
    xrayShaping.removePeerFilter(oldMark);
  }
  return { speedTier, mark };
}

module.exports = { applySpeedTier };
