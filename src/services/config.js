'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

const getConfigPath = () => process.env.WG_CONFIG_PATH || '/etc/amnezia/amneziawg/awg0.conf';

function readConfig() {
  return fs.readFileSync(getConfigPath(), 'utf8');
}

function writeConfig(content) {
  fs.writeFileSync(getConfigPath(), content, 'utf8');
}

function parsePeers(configContent) {
  const peers = [];
  const lines = configContent.split('\n');
  let inPeer = false;
  let current = null;

  for (const line of lines) {
    const t = line.trim();

    if (t === '[Peer]') {
      // save previous peer before starting a new one
      if (current?.publicKey) peers.push(current);
      inPeer = true;
      current = { publicKey: null, allowedIp: null, userId: null, deviceName: null };
      continue;
    }

    if (t.startsWith('[') && t !== '[Peer]') {
      if (current?.publicKey) peers.push(current);
      inPeer = false;
      current = null;
      continue;
    }

    if (!inPeer || !current) continue;

    const commentMatch = t.match(/^#\s*(.+?)\s*\|\s*(.+?)\s*$/);
    if (commentMatch) {
      current.userId = commentMatch[1].trim();
      current.deviceName = commentMatch[2].trim();
      continue;
    }

    const pkMatch = t.match(/^PublicKey\s*=\s*(.+)$/);
    if (pkMatch) { current.publicKey = pkMatch[1].trim(); continue; }

    const ipMatch = t.match(/^AllowedIPs\s*=\s*(.+)$/);
    if (ipMatch) { current.allowedIp = ipMatch[1].trim(); }
  }

  if (current?.publicKey) peers.push(current);
  return peers;
}

function allocateIp(peers) {
  const used = new Set(peers.map(p => p.allowedIp?.split('/')[0]).filter(Boolean));
  for (let i = 2; i <= 254; i++) {
    const ip = `10.0.0.${i}`;
    if (!used.has(ip)) return `${ip}/32`;
  }
  throw new Error('No available IP addresses');
}

function getServerPublicKey() {
  const config = readConfig();
  const match = config.match(/^PrivateKey\s*=\s*(.+)$/m);
  if (!match) throw new Error('Server private key not found in config');
  const result = spawnSync('awg', ['pubkey'], { input: match[1].trim() + '\n', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'awg pubkey failed');
  return result.stdout.trim();
}

function addPeer(publicKey, allowedIp, userId, deviceName) {
  const config = readConfig();
  const block = `\n[Peer]\n# ${userId} | ${deviceName}\nPublicKey = ${publicKey}\nAllowedIPs = ${allowedIp}\n`;
  writeConfig(config.trimEnd() + '\n' + block);
}

function removePeer(publicKey) {
  const config = readConfig();
  const lines = config.split('\n');
  const result = [];
  let skipPeer = false;
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    if (t === '[Peer]') {
      let isTarget = false;
      for (let j = i + 1; j < lines.length; j++) {
        const jt = lines[j].trim();
        if (jt === '[Peer]' || jt === '[Interface]') break;
        const pk = jt.match(/^PublicKey\s*=\s*(.+)$/);
        if (pk && pk[1].trim() === publicKey) { isTarget = true; found = true; break; }
      }
      skipPeer = isTarget;
      if (!isTarget) result.push(lines[i]);
    } else if (t.startsWith('[') && t !== '[Peer]') {
      skipPeer = false;
      result.push(lines[i]);
    } else if (!skipPeer) {
      result.push(lines[i]);
    }
  }

  if (!found) throw new Error('Peer not found');
  writeConfig(result.join('\n').trimEnd() + '\n');
}

module.exports = { readConfig, writeConfig, parsePeers, allocateIp, addPeer, removePeer, getServerPublicKey };
