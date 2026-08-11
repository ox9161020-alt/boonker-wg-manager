'use strict';
const fs = require('fs');
const speedTiers = require('./xraySpeedTiers');

const VLESS_TAG = 'vless-in';
const RELAY_OUTBOUND_TAG = 'relay-out';
const RELAY_RULE_TAG = 'relay-routing';
// YouTube/Google-video domains detoured through the RF relay (Фаза 3,
// plans/MULTI_REGION_NODES.md) — deliberately narrow, not `geosite:google`
// (would also pull Gmail/Диск/Search through the RF hop with unrelated side
// effects the plan never asked for).
// youtubei.googleapis.com (InnerTube — the API the YouTube app/site actually
// calls for feed/browse/player data, separate eTLD+1 from youtube.com, so
// `domain:youtube.com` doesn't cover it) was missing from the original list —
// found live 2026-08-12 via `journalctl -u xray`: real client traffic to it
// was going `[vless-in >> direct]`, not through the relay. Фаза 0's own audit
// already established the ad-or-not decision is embedded in this API's
// response (ytInitialPlayerResponse's adPlacements/adSlots/playerAds), so
// missing it here is exactly why ads kept showing in the feed even though
// googlevideo.com (video bytes) was correctly detoured.
const RELAY_DOMAINS = ['domain:youtube.com', 'domain:youtu.be', 'domain:googlevideo.com', 'domain:ytimg.com', 'domain:ggpht.com', 'domain:youtubei.googleapis.com'];
// Real-world Reality clients (Happ included) default to Vision when importing a
// Reality profile — an account without this flow gets its connection accepted at
// the TLS/Reality layer (looks "connected") but immediately ended by Xray at the
// VLESS layer ("is not able to use the flow xtls-rprx-vision"), which reads as
// "connected but no internet". Found live 2026-07-18 testing Happ on Android; the
// Этап 1 local xray-cli client never hit this because it didn't request a flow.
const CLIENT_FLOW = 'xtls-rprx-vision';

const getConfigPath = () => process.env.XRAY_CONFIG_PATH || '/usr/local/etc/xray/config.json';

function isAvailable() {
  return fs.existsSync(getConfigPath());
}

function readConfig() {
  return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function findVlessInbound(config) {
  const inbound = (config.inbounds || []).find((i) => i.tag === VLESS_TAG);
  if (!inbound) throw new Error(`Xray config has no "${VLESS_TAG}" inbound`);
  return inbound;
}

// Same "userId | deviceName" convention as the AWG peer comment in config.js,
// so both protocols stay debuggable the same way from raw config on disk.
const buildEmail = (userId, deviceName) => `${userId} | ${deviceName}`;

function parseEmail(email) {
  const match = String(email || '').match(/^(.+?)\s*\|\s*(.+)$/);
  return match ? { userId: match[1].trim(), deviceName: match[2].trim() } : { userId: null, deviceName: null };
}

// maxDevices only appears when set (see setMaxDevices) — keeps the return
// shape identical to before for clients that never got one, rather than
// forcing every caller to deal with an explicit null.
function listClients() {
  const inbound = findVlessInbound(readConfig());
  return inbound.settings.clients.map((c) => ({
    uuid: c.id,
    ...parseEmail(c.email),
    ...(c.maxDevices != null ? { maxDevices: c.maxDevices } : {}),
  }));
}

function addClient(uuid, userId, deviceName) {
  const config = readConfig();
  const inbound = findVlessInbound(config);
  inbound.settings.clients.push({ id: uuid, email: buildEmail(userId || '', deviceName || ''), flow: CLIENT_FLOW });
  writeConfig(config);
}

function removeClient(uuid) {
  const config = readConfig();
  const inbound = findVlessInbound(config);
  const before = inbound.settings.clients.length;
  inbound.settings.clients = inbound.settings.clients.filter((c) => c.id !== uuid);
  if (inbound.settings.clients.length === before) throw new Error('VLESS client not found');
  writeConfig(config);
}

function findClient(uuid) {
  return listClients().find((c) => c.uuid === uuid) || null;
}

// Persists the device/connection-count limit (ROADMAP_AWG-VLESS.md Этап 3,
// D3 — limit = subscription's max_devices) directly on the client object, the
// same way `flow`/`email` already live there — an extra field Xray itself
// simply ignores. No-op on null/undefined (same guard style as
// xraySpeedTierApply.js's speedTier == null check) so callers can pass
// whatever backend-api sent without a separate branch.
function setMaxDevices(uuid, maxDevices) {
  if (maxDevices == null) return;
  const config = readConfig();
  const inbound = findVlessInbound(config);
  const client = inbound.settings.clients.find((c) => c.id === uuid);
  if (!client) throw new Error('VLESS client not found');
  client.maxDevices = maxDevices;
  writeConfig(config);
}

function buildVlessUri(uuid, label) {
  const host = process.env.SERVER_PUBLIC_IP;
  const port = process.env.XRAY_REALITY_PORT || '443';
  const pbk = process.env.XRAY_REALITY_PUBLIC_KEY;
  const sni = process.env.XRAY_REALITY_SNI;
  const sid = process.env.XRAY_REALITY_SHORT_ID;
  const params = new URLSearchParams({
    security: 'reality',
    pbk,
    sni,
    sid,
    // fp=chrome gets the Reality handshake actively dropped in the wild (confirmed
    // live 2026-07-20: identical link, only fp swapped, went from 0 to instant
    // connectivity in Happ over a real RU network) — firefox is not similarly
    // targeted. See VLESS_Reality.md for the full multi-session investigation.
    fp: 'firefox',
    type: 'tcp',
    flow: CLIENT_FLOW,
    encryption: 'none',
  });
  return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(label || '')}`;
}

function getRealityPublicParams() {
  return {
    publicKey: process.env.XRAY_REALITY_PUBLIC_KEY || null,
    sni: process.env.XRAY_REALITY_SNI || null,
    shortId: process.env.XRAY_REALITY_SHORT_ID || null,
    port: process.env.XRAY_REALITY_PORT || '443',
  };
}

function usedMarks(config) {
  return new Set(
    (config.outbounds || [])
      .map((o) => o.streamSettings?.sockopt?.mark)
      .filter((m) => typeof m === 'number')
  );
}

// Scans existing outbounds for the first free mark in the personal-peer pool
// — same "scan used values, take the first free one" idiom as config.js's
// allocateIp() for AWG peer IPs.
function allocateMark(config) {
  const used = usedMarks(config);
  for (let m = speedTiers.PEER_MARK_BASE; m <= speedTiers.PEER_MARK_MAX; m++) {
    if (!used.has(m)) return m;
  }
  throw new Error('No free VLESS speed mark available (range exhausted)');
}

// Ensures uuid has its own personal freedom outbound for `tier`, allocating a
// fresh mark only if one doesn't already exist for this exact (tier, uuid)
// pair. One outbound per USER (not per tier) is the whole point — see
// xraySpeedTiers.js's header comment for why a shared per-tier mark was
// wrong. Mutates `config` in place; caller writes it.
function ensurePeerOutbound(config, uuid, tier) {
  config.outbounds = config.outbounds || [];
  const tag = speedTiers.peerOutboundTag(tier, uuid);
  const existing = config.outbounds.find((o) => o.tag === tag);
  if (existing) return { tag, mark: existing.streamSettings.sockopt.mark, created: false };
  const mark = allocateMark(config);
  config.outbounds.push({ protocol: 'freedom', tag, streamSettings: { sockopt: { mark } } });
  return { tag, mark, created: true };
}

// Removes a personal outbound by tag if present, freeing its mark for reuse.
// Returns the freed mark, or null if the tag wasn't found. Mutates `config`.
function removePeerOutboundByTag(config, tag) {
  const outbounds = config.outbounds || [];
  const idx = outbounds.findIndex((o) => o.tag === tag);
  if (idx === -1) return null;
  const mark = outbounds[idx].streamSettings?.sockopt?.mark ?? null;
  outbounds.splice(idx, 1);
  return mark;
}

// Assigns (or re-assigns, on an upgrade/downgrade) a user's speed tier: gives
// them their own personal freedom outbound (unique mark — never shared with
// another user, even on the same tier) and a `user`-matched routing rule
// tagged with their own ruleTag, so it can later be removed in isolation via
// `xray api rmrules` without touching anyone else's rule or the base
// api/dns-out rules. Only patches the on-disk file — the caller (vless.js) is
// responsible for hot-applying via xrayProcess/xrayShaping, exactly like
// addClientToRunning() does for client adds.
//
// `hadPreviousRule` tells the caller whether this uuid already had a LIVE
// routing rule before this call — `adrules -append` never replaces a
// same-tagged rule already in the running process's memory (confirmed live,
// ROADMAP_AWG-VLESS.md Этап 1), so re-asserting or changing a tier must
// explicitly remove the old live rule first or Xray ends up with a stale
// duplicate that wins by evaluation order.
function setUserSpeedTier(uuid, email, tier) {
  const config = readConfig();
  const ruleTag = speedTiers.ruleTagFor(uuid);
  const newTag = speedTiers.peerOutboundTag(tier, uuid);

  const existingRule = (config.routing.rules || []).find((r) => r.ruleTag === ruleTag);
  const hadPreviousRule = !!existingRule;

  // Tier changed (upgrade/downgrade) — free the old personal outbound/mark
  // instead of leaking it forever under a tag nothing points to anymore.
  let oldMark = null, oldTag = null;
  if (existingRule && existingRule.outboundTag !== newTag) {
    oldTag = existingRule.outboundTag;
    oldMark = removePeerOutboundByTag(config, oldTag);
  }

  const { tag: outboundTag, mark, created } = ensurePeerOutbound(config, uuid, tier);
  config.routing.rules = (config.routing.rules || []).filter((r) => r.ruleTag !== ruleTag);
  config.routing.rules.push({ type: 'field', user: [email], outboundTag, ruleTag });
  writeConfig(config);
  return { ruleTag, outboundTag, mark, created, hadPreviousRule, oldMark, oldTag };
}

// Returns null (no-op signal) when the user never had a tier rule — most
// users won't have one, and callers shouldn't hot-remove/restart over
// nothing. Otherwise frees the user's personal outbound/mark and returns
// enough info for the caller to also hot-remove the live routing rule and
// tc filter.
function removeUserSpeedTier(uuid) {
  const config = readConfig();
  const ruleTag = speedTiers.ruleTagFor(uuid);
  const rule = (config.routing.rules || []).find((r) => r.ruleTag === ruleTag);
  if (!rule) return null;
  const mark = removePeerOutboundByTag(config, rule.outboundTag);
  config.routing.rules = config.routing.rules.filter((r) => r.ruleTag !== ruleTag);
  writeConfig(config);
  return { ruleTag, outboundTag: rule.outboundTag, mark };
}

// Used by wg-manager's boot sequence (xrayShaping.ensureVlessShapingBase) to
// re-apply a tc filter for every already-assigned user — tc/nft state is
// wiped on reboot or interface recreation, config.json (the source of truth)
// isn't. Tier is recovered from the outbound's own tag, not a separate table.
function listPeerOutbounds() {
  const config = readConfig();
  return (config.outbounds || [])
    .map((o) => {
      const parsed = speedTiers.parsePeerOutboundTag(o.tag);
      if (!parsed) return null;
      const mark = o.streamSettings?.sockopt?.mark;
      if (typeof mark !== 'number') return null;
      return { ...parsed, mark };
    })
    .filter(Boolean);
}

// Used by the access-log tailer (xrayAccessLog.js) to resolve a connection's
// `email` (from Xray's own "accepted ... email: X" log line) to the user's
// OWN personal outbound's fw mark, so the download-direction leg can be
// marked too — see the D1 research-spike finding in ROADMAP_AWG-VLESS.md
// Этап 1, and the per-user-mark fix in the same file's Этап 1 audit follow-up.
function getMarkForEmail(email) {
  const config = readConfig();
  const rule = (config.routing.rules || []).find((r) => Array.isArray(r.user) && r.user.includes(email));
  if (!rule) return null;
  const outbound = (config.outbounds || []).find((o) => o.tag === rule.outboundTag);
  return outbound?.streamSettings?.sockopt?.mark ?? null;
}

// Persists the RF relay detour outbound (a VLESS client dialing the relay's
// inbound — see provisioner.js's stepXrayRelay()) + the domain routing rule
// on disk. Idempotent by tag/ruleTag, same convention as setUserSpeedTier():
// re-running with a changed host/port/uuid (relay re-provisioned) updates
// the existing outbound in place instead of erroring on a duplicate tag or
// leaking a second one. Caller (xrayRelayApply.js) hot-applies afterwards.
function ensureRelayRouting(host, port, uuid) {
  const config = readConfig();
  config.outbounds = config.outbounds || [];
  config.routing = config.routing || { rules: [] };
  config.routing.rules = config.routing.rules || [];

  const vnext = [{ address: host, port, users: [{ id: uuid, encryption: 'none' }] }];
  const existingOutbound = config.outbounds.find((o) => o.tag === RELAY_OUTBOUND_TAG);
  const wasNew = !existingOutbound;
  if (existingOutbound) {
    existingOutbound.settings.vnext = vnext;
  } else {
    config.outbounds.push({
      protocol: 'vless', tag: RELAY_OUTBOUND_TAG,
      settings: { vnext },
      streamSettings: { network: 'tcp' },
    });
  }

  const hadRule = config.routing.rules.some((r) => r.ruleTag === RELAY_RULE_TAG);
  if (!hadRule) {
    config.routing.rules.push({
      type: 'field', domain: RELAY_DOMAINS, outboundTag: RELAY_OUTBOUND_TAG, ruleTag: RELAY_RULE_TAG,
    });
  }

  writeConfig(config);
  return { outboundTag: RELAY_OUTBOUND_TAG, ruleTag: RELAY_RULE_TAG, domains: RELAY_DOMAINS, wasNew, hadRule };
}

// Returns null (no-op signal, same convention as removeUserSpeedTier()) when
// there was nothing to remove.
function removeRelayRouting() {
  const config = readConfig();
  const hadOutbound = (config.outbounds || []).some((o) => o.tag === RELAY_OUTBOUND_TAG);
  if (!hadOutbound) return null;

  config.outbounds = config.outbounds.filter((o) => o.tag !== RELAY_OUTBOUND_TAG);
  config.routing = config.routing || { rules: [] };
  config.routing.rules = (config.routing.rules || []).filter((r) => r.ruleTag !== RELAY_RULE_TAG);
  writeConfig(config);
  return { outboundTag: RELAY_OUTBOUND_TAG, ruleTag: RELAY_RULE_TAG };
}

module.exports = {
  VLESS_TAG,
  CLIENT_FLOW,
  RELAY_OUTBOUND_TAG,
  RELAY_RULE_TAG,
  RELAY_DOMAINS,
  ensureRelayRouting,
  removeRelayRouting,
  isAvailable,
  readConfig,
  writeConfig,
  listClients,
  addClient,
  removeClient,
  findClient,
  setMaxDevices,
  buildVlessUri,
  buildEmail,
  parseEmail,
  getRealityPublicParams,
  setUserSpeedTier,
  removeUserSpeedTier,
  listPeerOutbounds,
  getMarkForEmail,
};
