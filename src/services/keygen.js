'use strict';
const { spawnSync } = require('child_process');

function generateKeyPair() {
  const genkey = spawnSync('awg', ['genkey'], { encoding: 'utf8' });
  if (genkey.error) throw genkey.error;
  if (genkey.status !== 0) throw new Error(genkey.stderr || 'awg genkey failed');
  const privateKey = genkey.stdout.trim();
  if (!privateKey) throw new Error('awg genkey returned empty output');

  const pubkey = spawnSync('awg', ['pubkey'], { input: privateKey + '\n', encoding: 'utf8' });
  if (pubkey.error) throw pubkey.error;
  if (pubkey.status !== 0) throw new Error(pubkey.stderr || 'awg pubkey failed');
  const publicKey = pubkey.stdout.trim();
  if (!publicKey) throw new Error('awg pubkey returned empty output');

  return { privateKey, publicKey };
}

module.exports = { generateKeyPair };
