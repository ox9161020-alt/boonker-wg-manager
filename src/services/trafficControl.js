'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const configService = require('./config');

const NFT_RULESET_PATH = '/tmp/boonker-nftables-limits.conf';

const iface = () => process.env.WG_INTERFACE || 'awg0';
const ifbIface = () => process.env.AWG_IFB_INTERFACE || 'ifb0';
const rateMbit = () => parseInt(process.env.AWG_PEER_RATE_MBIT || '20', 10);
const connLimit = () => parseInt(process.env.AWG_PEER_CONNLIMIT || '200', 10);

function sh(cmd, args, extraOpts) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...extraOpts });
  if (result.error) {
    console.error(`[trafficControl] failed to run "${cmd}": ${result.error.message}`);
  } else if (result.status !== 0 && result.stderr) {
    // Non-fatal (calls are idempotent add-then-remove or best-effort setup), but
    // logged so a genuine failure — e.g. rejected nft ruleset syntax — is visible
    // in journalctl instead of silently leaving the node unprotected.
    console.error(`[trafficControl] "${cmd} ${args.join(' ')}" exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result;
}

function peerFilterPrio(allowedIp) {
  const octet = parseInt(allowedIp.split('/')[0].split('.')[3], 10);
  if (!Number.isInteger(octet) || octet < 2 || octet > 254) {
    throw new Error(`peerFilterPrio: unexpected allowedIp "${allowedIp}"`);
  }
  return octet;
}

function removePeerLimit(allowedIp) {
  const dev = iface(), ifb = ifbIface(), prio = String(peerFilterPrio(allowedIp));
  sh('tc', ['filter', 'del', 'dev', dev, 'parent', '1:0', 'protocol', 'ip', 'prio', prio]);
  sh('tc', ['filter', 'del', 'dev', ifb, 'parent', '1:0', 'protocol', 'ip', 'prio', prio]);
}

function addPeerLimit(allowedIp) {
  const dev = iface(), ifb = ifbIface(), ip = allowedIp.split('/')[0];
  const prio = String(peerFilterPrio(allowedIp)), rate = `${rateMbit()}mbit`;

  removePeerLimit(allowedIp); // idempotent: clear any stale filter at this prio first

  sh('tc', ['filter', 'add', 'dev', dev, 'parent', '1:0', 'protocol', 'ip', 'prio', prio,
    'u32', 'match', 'ip', 'dst', `${ip}/32`,
    'police', 'rate', rate, 'burst', '32k', 'drop', 'flowid', '1:1']);

  sh('tc', ['filter', 'add', 'dev', ifb, 'parent', '1:0', 'protocol', 'ip', 'prio', prio,
    'u32', 'match', 'ip', 'src', `${ip}/32`,
    'police', 'rate', rate, 'burst', '32k', 'drop', 'flowid', '1:1']);
}

function ensureNftablesLimitTable() {
  const N = connLimit();
  // Recreated on every call so a changed AWG_PEER_CONNLIMIT takes effect on restart.
  sh('nft', ['delete', 'table', 'inet', 'boonker_limits']);
  // `ct count` requires the `meter` construct, not a plain dynamic-set `add @set {...}` —
  // the latter parses but nftables 1.0.9 rejects it at load time with "Operation not
  // supported". `meter` creates its own per-key dynamic set, so no separate `set` block
  // is needed; it's what gives one independent counter per source IP (10.0.0.x) instead
  // of a single counter shared by the whole subnet.
  const script = [
    'table inet boonker_limits {',
    '  chain forward {',
    '    type filter hook forward priority 0; policy accept;',
    `    ip saddr 10.0.0.0/24 ct state new meter conn_count { ip saddr ct count over ${N} } drop`,
    '  }',
    '}',
  ].join('\n');
  // `nft -f -` (ruleset piped via stdin) fails on this nftables version with
  // "Not a regular file: /dev/stdin" — write to a real file and point -f at it.
  fs.writeFileSync(NFT_RULESET_PATH, script, 'utf8');
  sh('nft', ['-f', NFT_RULESET_PATH]);
}

function ensureTrafficControlBase() {
  const dev = iface(), ifb = ifbIface();

  sh('modprobe', ['ifb', 'numifbs=1']);
  sh('ip', ['link', 'add', ifb, 'type', 'ifb']);
  sh('ip', ['link', 'set', ifb, 'up']);

  sh('tc', ['qdisc', 'add', 'dev', dev, 'root', 'handle', '1:', 'prio']);
  sh('tc', ['qdisc', 'add', 'dev', dev, 'handle', 'ffff:', 'ingress']);
  sh('tc', ['qdisc', 'add', 'dev', ifb, 'root', 'handle', '1:', 'prio']);

  // Mirror all ingress (upload) traffic on `dev` to `ifb` so it can be shaped as
  // ordinary egress there (tc cannot shape ingress directly). Fixed prio 1 (distinct
  // from the per-peer prio range 2-254) lets this use the same del-then-add
  // idempotent pattern as per-peer filters, so restarts don't pile up duplicates.
  sh('tc', ['filter', 'del', 'dev', dev, 'parent', 'ffff:', 'protocol', 'ip', 'prio', '1']);
  sh('tc', ['filter', 'add', 'dev', dev, 'parent', 'ffff:', 'protocol', 'ip', 'prio', '1',
    'u32', 'match', 'u32', '0', '0', 'action', 'mirred', 'egress', 'redirect', 'dev', ifb]);

  ensureNftablesLimitTable();

  // Re-apply every current peer's filters — covers awg0/ifb0 being torn down and
  // recreated since this last ran (reboot, systemctl restart awg-quick@awg0),
  // which wipes all tc state on the interface, not just the base qdiscs above.
  for (const peer of configService.parsePeers(configService.readConfig())) {
    if (peer.allowedIp) addPeerLimit(peer.allowedIp);
  }
}

module.exports = { peerFilterPrio, addPeerLimit, removePeerLimit, ensureTrafficControlBase };
