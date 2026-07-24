'use strict';
const fs = require('fs');
const speedTiers = require('./xraySpeedTiers');

const VLESS_TAG = 'vless-in';
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

function listClients() {
  const inbound = findVlessInbound(readConfig());
  return inbound.settings.clients.map((c) => ({ uuid: c.id, ...parseEmail(c.email) }));
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

// Idempotently makes sure every speed tier has its marked freedom outbound in
// the on-disk config — safe to call on every request, and doubles as the
// backfill path for nodes provisioned before this feature existed (see
// ROADMAP_AWG-VLESS.md Этап 1).
function ensureTierOutbounds() {
  const config = readConfig();
  config.outbounds = config.outbounds || [];
  let changed = false;
  for (const tier of speedTiers.listTiers()) {
    const tag = speedTiers.outboundTag(tier);
    if (!config.outbounds.find((o) => o.tag === tag)) {
      config.outbounds.push({
        protocol: 'freedom',
        tag,
        streamSettings: { sockopt: { mark: speedTiers.markFor(tier) } },
      });
      changed = true;
    }
  }
  if (changed) writeConfig(config);
  return changed;
}

// Assigns (or re-assigns, on an upgrade/downgrade) a user's speed tier by
// writing a `user`-matched routing rule tagged with their own ruleTag, so it
// can later be removed in isolation via `xray api rmrules` without touching
// anyone else's rule or the base api/dns-out rules. Only patches the on-disk
// file — the caller (xrayProcess) is responsible for hot-applying via
// `adrules`, exactly like addClientToRunning() does for client adds.
function setUserSpeedTier(uuid, email, tier) {
  ensureTierOutbounds();
  const config = readConfig();
  const ruleTag = speedTiers.ruleTagFor(uuid);
  const outboundTag = speedTiers.outboundTag(tier);
  config.routing.rules = (config.routing.rules || []).filter((r) => r.ruleTag !== ruleTag);
  config.routing.rules.push({ type: 'field', user: [email], outboundTag, ruleTag });
  writeConfig(config);
  return { ruleTag, outboundTag, mark: speedTiers.markFor(tier) };
}

// Returns the ruleTag only if a rule actually existed (null otherwise) so
// callers don't hot-remove a rule that was never applied — most users won't
// have a speed tier assigned at all yet, and rmrules on an unknown tag would
// needlessly trigger the restart fallback in removeRoutingRuleFromRunning().
function removeUserSpeedTier(uuid) {
  const config = readConfig();
  const ruleTag = speedTiers.ruleTagFor(uuid);
  const before = (config.routing.rules || []).length;
  config.routing.rules = (config.routing.rules || []).filter((r) => r.ruleTag !== ruleTag);
  if (config.routing.rules.length === before) return null;
  writeConfig(config);
  return ruleTag;
}

// Used by the access-log tailer (xrayAccessLog.js) to resolve a connection's
// `email` (from Xray's own "accepted ... email: X" log line) to the fw mark
// its tier's outbound carries, so the download-direction leg can be marked
// too — see the D1 research-spike finding in ROADMAP_AWG-VLESS.md Этап 1.
function getMarkForEmail(email) {
  const config = readConfig();
  const rule = (config.routing.rules || []).find((r) => Array.isArray(r.user) && r.user.includes(email));
  if (!rule) return null;
  const outbound = (config.outbounds || []).find((o) => o.tag === rule.outboundTag);
  return outbound?.streamSettings?.sockopt?.mark ?? null;
}

module.exports = {
  VLESS_TAG,
  CLIENT_FLOW,
  isAvailable,
  readConfig,
  writeConfig,
  listClients,
  addClient,
  removeClient,
  findClient,
  buildVlessUri,
  buildEmail,
  parseEmail,
  getRealityPublicParams,
  ensureTierOutbounds,
  setUserSpeedTier,
  removeUserSpeedTier,
  getMarkForEmail,
};
