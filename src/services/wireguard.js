'use strict';
const { spawnSync } = require('child_process');

const iface = () => process.env.WG_INTERFACE || 'awg0';

function getStatus() {
  const result = spawnSync('awg', ['show', iface()], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Failed to get AmneziaWG status');
  return result.stdout;
}

function addPeerToRunning(publicKey, allowedIp) {
  const result = spawnSync(
    'awg', ['set', iface(), 'peer', publicKey, 'allowed-ips', allowedIp],
    { encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Failed to add peer');
}

function removePeerFromRunning(publicKey) {
  const result = spawnSync(
    'awg', ['set', iface(), 'peer', publicKey, 'remove'],
    { encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Failed to remove peer');
}

// Units: B=1, KiB=1024, MiB=1048576, GiB=1073741824, TiB=1099511627776
const UNIT_MAP = { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 };

function parseTrafficBytes(raw) {
  const re = /transfer:\s+([\d.]+)\s+(\w+)\s+received,\s+([\d.]+)\s+(\w+)\s+sent/g;
  let rxTotal = 0;
  let txTotal = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    rxTotal += parseFloat(match[1]) * (UNIT_MAP[match[2]] || 1);
    txTotal += parseFloat(match[3]) * (UNIT_MAP[match[4]] || 1);
  }
  return { rx_bytes: Math.round(rxTotal), tx_bytes: Math.round(txTotal) };
}

module.exports = { getStatus, addPeerToRunning, removePeerFromRunning, parseTrafficBytes };
