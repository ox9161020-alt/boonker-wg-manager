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

// `xray api adrules`/`rmrules` hot-patch the routing table with NO restart at
// all (confirmed live — see ROADMAP_AWG-VLESS.md Этап 1), unlike adu/rmu they
// print a bare "{}" on success instead of a human-readable confirmation
// string, so success is read off the exit code instead of stdout matching.
// `-append` is required: without it `adrules` REPLACES the entire routing
// table instead of adding to it (confirmed via an isolated throwaway xray
// instance, not assumed from docs alone).
function addRoutingRuleToRunning(ruleTag, email, outboundTag) {
  const miniConfig = { routing: { rules: [{ type: 'field', user: [email], outboundTag, ruleTag }] } };
  const tmpFile = path.join(os.tmpdir(), `xray-adrules-${ruleTag}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(miniConfig), 'utf8');
  try {
    runAdrules(tmpFile);
  } catch (err) {
    // Same fallback rationale as addClientToRunning(): the file already has
    // the rule (xrayConfig.setUserSpeedTier runs before this), so a restart
    // picks it up without losing the change.
    restartService();
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function runAdrules(tmpFile) {
  const result = spawnSync(xrayBin(), ['api', 'adrules', `--server=${apiAddr()}`, '-append', tmpFile], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'xray api adrules failed');
}

function removeRoutingRuleFromRunning(ruleTag) {
  try {
    runRmrules(ruleTag);
  } catch (err) {
    restartService();
  }
}

function runRmrules(ruleTag) {
  const result = spawnSync(xrayBin(), ['api', 'rmrules', `--server=${apiAddr()}`, ruleTag], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'xray api rmrules failed');
}

// `xray api ado`/`rmo` hot-patch outbounds the same way adrules/rmrules
// hot-patch routing — same {} bare-success convention, same exit-code check.
// Needed now that every VLESS user gets their OWN personal outbound (unique
// mark) instead of sharing one of 3 pre-provisioned tier outbounds: a brand
// new user's outbound has to exist in the running process, not just on disk.
// Unlike adrules/rmrules, `ado`/`rmo` were NOT live-verified during the Этап 1
// research spike (only found by reading `xray help api`) — the restart
// fallback below covers that uncertainty exactly like it does for adu/rmu.
function addOutboundToRunning(tag, mark) {
  const miniConfig = { outbounds: [{ protocol: 'freedom', tag, streamSettings: { sockopt: { mark } } }] };
  const tmpFile = path.join(os.tmpdir(), `xray-ado-${tag}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(miniConfig), 'utf8');
  try {
    runAdo(tmpFile);
  } catch (err) {
    // Same fallback rationale as addClientToRunning(): the file already has
    // the outbound (xrayConfig.setUserSpeedTier runs before this), so a
    // restart picks it up without losing the change.
    restartService();
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function runAdo(tmpFile) {
  const result = spawnSync(xrayBin(), ['api', 'ado', `--server=${apiAddr()}`, tmpFile], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'xray api ado failed');
}

function removeOutboundFromRunning(tag) {
  try {
    runRmo(tag);
  } catch (err) {
    restartService();
  }
}

function runRmo(tag) {
  const result = spawnSync(xrayBin(), ['api', 'rmo', `--server=${apiAddr()}`, tag], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'xray api rmo failed');
}

// `policy.levels["0"].statsUserUplink/Downlink` (set on every node's Xray
// config since the VLESS backfill step) makes Xray track per-client byte
// counters internally — this just reads them out via the same `xray api`
// CLI already used above for adu/rmu. Never pass `-reset`: the traffic poller
// diffs these against a stored baseline exactly like it diffs `awg show
// dump`'s cumulative counters (see wireguard.js) — resetting here would break
// that math.
function queryStats() {
  const result = spawnSync(xrayBin(), ['api', 'statsquery', `--server=${apiAddr()}`, '-pattern=user>>>'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'xray api statsquery failed');
  return result.stdout;
}

// Stat names look like "user>>>EMAIL>>>traffic>>>uplink". EMAIL is
// "userId | deviceName" (xrayConfig.buildEmail) and can contain almost
// anything, so match the fixed ">>>traffic>>>{uplink,downlink}" suffix
// instead of naively splitting the whole name on ">>>".
function parseStats(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    return [];
  }
  const byEmail = new Map();
  for (const { name, value } of parsed.stat || []) {
    const match = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(name || '');
    if (!match) continue;
    const [, email, direction] = match;
    const entry = byEmail.get(email) || { email, rx_bytes: 0, tx_bytes: 0 };
    // Xray's "uplink" = client → server (server receives), matching the
    // `rx_bytes` convention already used for AWG peers via `awg show dump`
    // (see wireguard.js) — "downlink" = server → client = tx_bytes.
    if (direction === 'uplink') entry.rx_bytes = parseInt(value, 10) || 0;
    else entry.tx_bytes = parseInt(value, 10) || 0;
    byEmail.set(email, entry);
  }
  return [...byEmail.values()];
}

function getClientTraffic() {
  return parseStats(queryStats());
}

module.exports = {
  addClientToRunning,
  removeClientFromRunning,
  restartService,
  getClientTraffic,
  parseStats,
  addRoutingRuleToRunning,
  removeRoutingRuleFromRunning,
  addOutboundToRunning,
  removeOutboundFromRunning,
};
