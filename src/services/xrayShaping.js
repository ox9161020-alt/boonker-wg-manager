'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const speedTiers = require('./xraySpeedTiers');
const xrayConfig = require('./xrayConfig');

const NFT_TABLE = 'boonker_vless_shape';
const NFT_RULESET_PATH = '/tmp/boonker-vless-shape.conf';
// How long a (client_ip, client_port) → mark mapping survives in the nftables
// map without being refreshed by a newer access-log line for the same
// connection. Generous on purpose — this only feeds a SPEED LIMIT, not a
// security control, so a stale entry lingering a bit past a closed connection
// is harmless (that port simply won't see matching traffic again).
const DL_MARK_TTL_SECONDS = 120;

const publicIface = () => process.env.PUBLIC_IFACE || '';

function sh(cmd, args, extraOpts) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...extraOpts });
  if (result.error) {
    console.error(`[xrayShaping] failed to run "${cmd}": ${result.error.message}`);
  } else if (result.status !== 0 && result.stderr) {
    console.error(`[xrayShaping] "${cmd} ${args.join(' ')}" exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result;
}

// The fw mark IS the filter's prio too — both just need to be unique per
// user, and re-using one number for both avoids needing a separate
// prio-allocation scheme on top of xrayConfig's mark allocation.
function removePeerFilter(mark) {
  const iface = publicIface();
  const prio = String(mark);
  sh('tc', ['filter', 'del', 'dev', iface, 'parent', '1:0', 'protocol', 'ip', 'prio', prio]);
}

// One filter PER USER (not per tier) handles BOTH directions: Xray's own
// `sockopt.mark` tags the upload leg (outbound to the real site) directly via
// that user's own personal outbound, while the download leg gets the same
// mark via the `dl_mark` nftables map (see ensureNftablesShapingTable below)
// — confirmed live, see ROADMAP_AWG-VLESS.md Этап 1. A single filter/police
// action shared across every user on a tier (the original design) meant N
// concurrent same-tier users split ONE combined rate limit instead of each
// getting the tier's rate individually — found live during the Этап 1 audit,
// not caught by the throughput E2E because it only ever tested one client at
// a time. One filter per user is the fix: nobody's cap depends on how many
// other users share their tier.
function addPeerFilter(mark, tier) {
  const iface = publicIface();
  const prio = String(mark);
  // `handle` takes a plain decimal fwmark value — confirmed live (tc's own
  // `tc filter show` just displays it back in hex, e.g. 100 -> 0x64).
  const rateMbit = speedTiers.rateMbitFor(tier);
  const rate = `${rateMbit}mbit`;
  // A flat 32k burst (fine for AWG's low, fixed default) polices ordinary
  // TCP bursts far too aggressively at higher VLESS tier rates — found live
  // via the Этап 1 throughput E2E: even the top tier collapsed to a fraction
  // of its configured rate once burst-sized packets started getting dropped,
  // triggering TCP retransmit backoff. ~100ms worth of tokens at the tier's
  // own rate scales the allowance with it instead.
  const burstKB = Math.max(32, Math.ceil(rateMbit * 12.5));

  removePeerFilter(mark); // idempotent: clear any stale filter at this prio first

  sh('tc', ['filter', 'add', 'dev', iface, 'parent', '1:0', 'protocol', 'ip', 'prio', prio,
    'handle', String(mark), 'fw',
    'police', 'rate', rate, 'burst', `${burstKB}k`, 'drop', 'flowid', '1:1']);
}

function ensureNftablesShapingTable() {
  // Recreated on every call, same idiom as trafficControl.js's
  // ensureNftablesLimitTable — cheap, and picks up a changed TTL/table shape
  // on restart without needing a diff.
  sh('nft', ['delete', 'table', 'inet', NFT_TABLE]);
  const script = [
    `table inet ${NFT_TABLE} {`,
    '  map dl_mark {',
    '    type ipv4_addr . inet_service : mark',
    `    timeout ${DL_MARK_TTL_SECONDS}s`,
    '  }',
    '  chain postrouting {',
    '    type filter hook postrouting priority mangle; policy accept;',
    // For the node->client (download) leg, the client's IP is the packet's
    // DESTINATION address and the client's ephemeral port is the packet's
    // DESTINATION port (source port is Xray's fixed listen port, 443, on
    // every such packet — not useful as a key). Must match what
    // markClientConnection() inserts: (client_ip, client_port). A `tcp
    // sport` key here would never match anything, since 443 (the only
    // sport value that ever appears) isn't a key in the map — found live,
    // see ROADMAP_AWG-VLESS.md Этап 1 E2E notes.
    '    meta mark set ip daddr . tcp dport map @dl_mark',
    '  }',
    '}',
  ].join('\n');
  fs.writeFileSync(NFT_RULESET_PATH, script, 'utf8');
  sh('nft', ['-f', NFT_RULESET_PATH]);
}

// Idempotent — safe to call on every wg-manager start, same contract as
// trafficControl.js's ensureTrafficControlBase(). Non-fatal by convention:
// the caller (server.js) logs and continues on failure rather than refusing
// to boot, since VPN connectivity must never depend on QoS bootstrap.
function ensureVlessShapingBase() {
  const iface = publicIface();
  if (!iface) {
    console.error('[xrayShaping] PUBLIC_IFACE is not set — skipping VLESS shaping bootstrap');
    return;
  }

  // Standard "replace root with classful prio" idiom — confirmed live on the
  // test node's actual public interface (ens18, started as kernel-default
  // `mq`) with zero SSH/connectivity disruption.
  sh('tc', ['qdisc', 'replace', 'dev', iface, 'root', 'handle', '1:', 'prio']);

  ensureNftablesShapingTable();

  // Re-apply every already-assigned user's filter — covers the interface
  // being torn down and recreated since this last ran (reboot, xray
  // reinstall), which wipes all tc state on it, not just the base qdisc
  // above. Same pattern as trafficControl.js's per-peer reapply loop in
  // ensureTrafficControlBase(). Non-fatal if xrayConfig can't be read (e.g.
  // Xray genuinely not installed on this node) — shaping just stays empty.
  try {
    for (const peer of xrayConfig.listPeerOutbounds()) addPeerFilter(peer.mark, peer.tier);
  } catch (err) {
    console.error('[xrayShaping] failed to re-apply per-user filters:', err.message);
  }
}

// Called by the access-log tailer (xrayAccessLog.js) for every newly-accepted
// connection belonging to a tiered user — marks the client-facing (download)
// leg by (ip, port) so the SAME tc filter that already catches the upload
// leg's Xray-set mark also catches this one.
function markClientConnection(ip, port, mark) {
  sh('nft', ['add', 'element', 'inet', NFT_TABLE, 'dl_mark',
    `{ ${ip} . ${port} timeout ${DL_MARK_TTL_SECONDS}s : ${mark} }`]);
}

module.exports = {
  ensureVlessShapingBase, addPeerFilter, removePeerFilter, markClientConnection,
  DL_MARK_TTL_SECONDS, NFT_TABLE,
};
