'use strict';
const { spawnSync } = require('child_process');
const xrayConfig = require('./xrayConfig');
const xrayShaping = require('./xrayShaping');
const speedTiers = require('./xraySpeedTiers');
const { applySpeedTier } = require('./xraySpeedTierApply');

// Этап 2 (ROADMAP_AWG-VLESS.md): anti-torrent protection via simultaneous
// connection count per UUID, not traffic volume — a BitTorrent swarm opens
// one connection per peer (tens to hundreds concurrently), which ordinary
// browsing/streaming never does even at high byte volume. Same underlying
// idea as AWG's already-shipped AWG_PEER_CONNLIMIT (trafficControl.js), just
// counted differently since VLESS has no equivalent of AWG's per-peer
// allowedIp to key an nftables `ct count` meter on.
//
// No new counting infrastructure needed: the `dl_mark` nftables map
// (xrayShaping.js, Этап 1) already holds one (client_ip, client_port) entry
// per currently-open connection, keyed by the user's own personal fw mark —
// populated live by xrayAccessLog.js for every connection Xray accepts. The
// number of entries currently mapped to a mark IS the user's live concurrent
// connection count.
const connLimit = () => parseInt(process.env.VLESS_PEER_CONNLIMIT || '200', 10);
const pollIntervalMs = () => parseInt(process.env.VLESS_CONNLIMIT_POLL_MS || '15000', 10);
// Sustained-breach requirement before acting — absorbs a brief legitimate
// burst (e.g. a page loading many assets at once) rather than reacting to
// one noisy poll.
const breachPollsToDowngrade = () => parseInt(process.env.VLESS_CONNLIMIT_BREACH_POLLS || '2', 10);
// Deliberately set well above dl_mark's own TTL (DL_MARK_TTL_SECONDS, 120s):
// right after a downgrade, the user's connections move to a NEW mark (their
// new penalty-tier outbound) — old entries under the OLD mark linger until
// they expire naturally, and only NEW connections get logged under the new
// mark. Requiring the count to stay calm for longer than that TTL means any
// leftover old-mark noise has already aged out by the time restore is even
// considered, and genuinely continued abuse keeps generating new-mark
// entries in the meantime (a real torrent swarm constantly churns peer
// connections, so it won't look "calm" for 2+ minutes by accident).
const calmPollsToRestore = () => parseInt(process.env.VLESS_CONNLIMIT_CALM_POLLS || '9', 10);

// uuid -> { breachPolls, calmPolls, originalTier }. Deliberately in-memory
// only, same accepted trade-off as the OTP token store (CLAUDE.md Этап 14
// п.1): a wg-manager restart mid-penalty loses the record of which tier to
// restore to, and the affected user stays on the penalty tier until the next
// natural tier-set from backend-api (device add/restore/upgrade). Acceptable
// for a test-stage anti-abuse mechanism, not a source of truth.
const state = new Map();

function getState(uuid) {
  let entry = state.get(uuid);
  if (!entry) {
    entry = { breachPolls: 0, calmPolls: 0, originalTier: null };
    state.set(uuid, entry);
  }
  return entry;
}

// Reads the dl_mark map and returns Map<mark, currentConnectionCount>. Treats
// a missing table/map (shaping not bootstrapped yet, or no tiered users at
// all) the same as "no data" — non-fatal, matches the rest of this codebase's
// QoS convention that connectivity must never depend on shaping/monitoring.
function readMarkCounts() {
  const result = spawnSync('nft', ['-j', 'list', 'map', 'inet', xrayShaping.NFT_TABLE, 'dl_mark'], { encoding: 'utf8' });
  if (result.error) {
    console.error('[xrayConnLimitPoller] failed to run nft:', result.error.message);
    return new Map();
  }
  if (result.status !== 0) {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    console.error('[xrayConnLimitPoller] failed to parse nft JSON output:', err.message);
    return new Map();
  }
  const mapEntry = (parsed.nftables || []).find((x) => x.map);
  const elems = mapEntry?.map?.elem || [];
  const counts = new Map();
  for (const [, mark] of elems) {
    counts.set(mark, (counts.get(mark) || 0) + 1);
  }
  return counts;
}

function emailFor(uuid) {
  const client = xrayConfig.findClient(uuid);
  return client ? xrayConfig.buildEmail(client.userId, client.deviceName) : null;
}

function downgrade(uuid, currentTier) {
  const email = emailFor(uuid);
  if (!email) return false; // orphaned outbound (client already removed) — nothing to act on
  try {
    applySpeedTier(uuid, email, speedTiers.PENALTY_TIER);
  } catch (err) {
    console.error(`[xrayConnLimitPoller] failed to downgrade ${email}:`, err.message);
    return false;
  }
  console.error(`[xrayConnLimitPoller] downgraded ${email} (tier ${currentTier} -> penalty) — connection count exceeded ${connLimit()}`);
  return true;
}

function restore(uuid, originalTier) {
  const email = emailFor(uuid);
  if (!email) return true; // client gone — drop tracking, nothing to restore
  try {
    applySpeedTier(uuid, email, originalTier);
  } catch (err) {
    console.error(`[xrayConnLimitPoller] failed to restore ${email} to tier ${originalTier}:`, err.message);
    return false;
  }
  console.error(`[xrayConnLimitPoller] restored ${email} to tier ${originalTier} — connection count back under threshold`);
  return true;
}

function poll() {
  let peers;
  try {
    peers = xrayConfig.listPeerOutbounds();
  } catch (err) {
    console.error('[xrayConnLimitPoller] failed to read peer outbounds:', err.message);
    return;
  }
  const counts = readMarkCounts();
  const threshold = connLimit();
  const seen = new Set();

  for (const peer of peers) {
    seen.add(peer.uuid);
    const count = counts.get(peer.mark) || 0;
    const entry = getState(peer.uuid);

    if (peer.tier === speedTiers.PENALTY_TIER) {
      if (count <= threshold) {
        entry.calmPolls += 1;
      } else {
        entry.calmPolls = 0;
      }
      if (entry.calmPolls >= calmPollsToRestore() && entry.originalTier != null) {
        if (restore(peer.uuid, entry.originalTier)) state.delete(peer.uuid);
      }
    } else {
      if (count > threshold) {
        entry.breachPolls += 1;
      } else {
        entry.breachPolls = 0;
      }
      if (entry.breachPolls >= breachPollsToDowngrade()) {
        if (downgrade(peer.uuid, peer.tier)) {
          entry.originalTier = peer.tier;
          entry.breachPolls = 0;
          entry.calmPolls = 0;
        }
      }
    }
  }

  // Drop debounce state for uuids no longer among current peer outbounds
  // (revoked devices) — avoids an unbounded memory leak over node lifetime.
  for (const uuid of state.keys()) {
    if (!seen.has(uuid)) state.delete(uuid);
  }
}

let timer = null;

function start() {
  if (timer) return; // already running
  timer = setInterval(poll, pollIntervalMs());
  if (timer.unref) timer.unref();
}

function stop() {
  clearInterval(timer);
  timer = null;
  state.clear();
}

module.exports = { start, stop, poll };
