'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { VLESS_TAG, CLIENT_FLOW } = require('./xrayConfig');

const apiAddr = () => process.env.XRAY_API_ADDR || '127.0.0.1:10085';
const xrayBin = () => process.env.XRAY_BIN || '/usr/local/bin/xray';
const listenPort = () => process.env.XRAY_REALITY_PORT || '443';

function restartService() {
  const result = spawnSync('systemctl', ['restart', 'xray'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'systemctl restart xray failed');
}

// `xray api adu` loads a full mini Xray config (not a flat {tag,user} object) and
// extracts the inbound's client list from it — see server-nl/xray/README.md for how
// this was reverse-engineered from the Xray-core source.
function addClientToRunning(uuid, email) {
  const miniConfig = {
    inbounds: [
      {
        tag: VLESS_TAG,
        listen: '0.0.0.0',
        port: Number(listenPort()),
        protocol: 'vless',
        settings: { clients: [{ id: uuid, email, flow: CLIENT_FLOW }], decryption: 'none' },
      },
    ],
  };
  const tmpFile = path.join(os.tmpdir(), `xray-adu-${uuid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(miniConfig), 'utf8');
  try {
    runAdu(tmpFile);
  } catch (err) {
    // Hot-apply failed (e.g. xray process down or api inbound unreachable) — the
    // config file on disk already has the client (config.js-equivalent write
    // happens before this call, same order as peer.js/wireguard.js), so a full
    // restart picks it up without losing the change.
    restartService();
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function runAdu(tmpFile) {
  const result = spawnSync(xrayBin(), ['api', 'adu', `--server=${apiAddr()}`, tmpFile], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const out = result.stdout || '';
  if (!/Added [1-9]\d* user\(s\) in total\./.test(out)) {
    throw new Error(`xray api adu did not confirm the add: ${out || result.stderr}`);
  }
}

function removeClientFromRunning(email) {
  try {
    runRmu(email);
  } catch (err) {
    restartService();
  }
}

function runRmu(email) {
  const result = spawnSync(xrayBin(), ['api', 'rmu', `--server=${apiAddr()}`, `-tag=${VLESS_TAG}`, email], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const out = result.stdout || '';
  if (!/Removed [1-9]\d* user\(s\) in total\./.test(out)) {
    throw new Error(`xray api rmu did not confirm the removal: ${out || result.stderr}`);
  }
}

module.exports = { addClientToRunning, removeClientFromRunning, restartService };
