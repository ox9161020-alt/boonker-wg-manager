'use strict';
const xrayConfig = require('./xrayConfig');
const xrayProcess = require('./xrayProcess');

// Wires this edge node into the RF relay's YouTube/Google-video detour
// (Фаза 3, plans/MULTI_REGION_NODES.md): a personal detour outbound (VLESS
// client dialing the relay) + a domain-matched routing rule, both persisted
// to config.json and hot-applied to the running process — same
// file-then-hot-apply split as xraySpeedTierApply.js. Idempotent: safe to
// call again after the relay is re-provisioned with a new host/port/uuid.
function applyRelayRouting(host, port, uuid) {
  const { outboundTag, ruleTag, domains, wasNew, hadRule } = xrayConfig.ensureRelayRouting(host, port, uuid);

  // `xray api ado` rejects adding an outbound whose tag is already live —
  // calling it unconditionally on a re-apply (e.g. clicking "Применить
  // relay-роутинг" a second time in admin-panel) fell through to
  // xrayProcess's restart-fallback, which does a full `systemctl restart
  // xray` and drops every live session on the node (found live 2026-08-07).
  // Remove-then-add on a re-apply mirrors how the routing rule below already
  // handles "re-assert with a possibly-changed value" (relay re-provisioned
  // with a new host/uuid) — skipped only on a genuinely first-ever apply,
  // where there's nothing live to remove yet.
  if (!wasNew) xrayProcess.removeOutboundFromRunning(outboundTag);
  xrayProcess.addRelayOutboundToRunning(outboundTag, host, port, uuid);

  // adrules -append never replaces a same-tagged rule already live in Xray's
  // memory (confirmed live, ROADMAP_AWG-VLESS.md Этап 1) — clear the old one
  // first on a re-apply so Xray never evaluates a stale duplicate pointing at
  // the outbound's old vnext. Skipped on a genuinely first-ever apply since
  // there's nothing live to remove.
  if (hadRule) xrayProcess.removeRoutingRuleFromRunning(ruleTag);
  xrayProcess.addDomainRoutingRuleToRunning(ruleTag, domains, outboundTag);

  return { outboundTag, ruleTag, domains };
}

// Fully removes the relay detour (outbound + routing rule). Returns null
// (no-op signal) when this node never had one applied.
function clearRelayRouting() {
  const removed = xrayConfig.removeRelayRouting();
  if (!removed) return null;
  xrayProcess.removeRoutingRuleFromRunning(removed.ruleTag);
  xrayProcess.removeOutboundFromRunning(removed.outboundTag);
  return removed;
}

module.exports = { applyRelayRouting, clearRelayRouting };
