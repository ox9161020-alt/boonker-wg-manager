'use strict';
const xrayConfig = require('./xrayConfig');
const xrayProcess = require('./xrayProcess');

// Этап 3 (ROADMAP_AWG-VLESS.md): closes "one VLESS key = unlimited simultaneous
// devices" — critical specifically for VLESS since the subscription is a bare
// shareable link, unlike AWG. D3 (confirmed by the user 2026-07-24): hard
// `xray api rmu` the moment the limit is crossed, auto `adu` after a cooldown
// — no soft/warn-only mode.
//
// No log-tailing infra needed here (unlike the original plan in the roadmap
// file): `xray api statsonlineiplist -email <email>` already gives Xray's own
// {ip: last-seen unix timestamp} record for that email — confirmed live during
// the Этап 1 research spike (see server-nl/xray/README.md, "Учёт онлайн-IP").
// Xray's own retention of stale entries isn't documented/guaranteed, so the
// window filter below is applied here, not trusted to Xray's internal state.
const pollIntervalMs = () => parseInt(process.env.VLESS_DEVICE_LIMIT_POLL_MS || '30000', 10);
// How far back a distinct IP still counts as "currently in use" — this IS the
// tolerance for legitimate Wi-Fi<->mobile roaming of a single device (a short
// blip shows two IPs at once, but both age out of a short window quickly). No
// separate consecutive-poll debounce like xrayConnLimitPoller — the roadmap
// frames the correct signal as "distinct IPs at once within a window", not
// "the IP changed at all", and the window itself is that mechanism.
const windowMs = () => parseInt(process.env.VLESS_DEVICE_LIMIT_WINDOW_MS || '600000', 10);
// After a kick, how long before the user is automatically let back in. If
// still over the limit by then, the very next poll kicks again — repeated
// friction rather than a permanent block, matching D3's "hard, not soft" mode
// without leaving anyone stuck forever (same "always an automatic way back"
// principle as Этап 2's auto-restore).
const cooldownMs = () => parseInt(process.env.VLESS_DEVICE_LIMIT_COOLDOWN_MS || '300000', 10);

// uuid -> { kickedAt }. In-memory only — same accepted trade-off as the other
// pollers (CLAUDE.md Этап 14 п.1): a wg-manager restart mid-cooldown just
// means the user gets let back in on the next poll instead of waiting out the
// rest of the cooldown, not a correctness issue.
const state = new Map();

function emailFor(client) {
  return xrayConfig.buildEmail(client.userId, client.deviceName);
}

function countRecentIps(email, now) {
  const entries = xrayProcess.getOnlineIps(email);
  return entries.filter((e) => now - e.lastSeenMs <= windowMs()).length;
}

function kick(uuid, email, count, limit) {
  try {
    xrayProcess.removeClientFromRunning(email);
  } catch (err) {
    console.error(`[xrayDeviceLimitPoller] failed to kick ${email}:`, err.message);
    return false;
  }
  console.error(`[xrayDeviceLimitPoller] kicked ${email} — ${count} concurrent IPs exceeds limit ${limit}`);
  return true;
}

function restore(uuid, email) {
  try {
    xrayProcess.addClientToRunning(uuid, email);
  } catch (err) {
    console.error(`[xrayDeviceLimitPoller] failed to restore ${email} after cooldown:`, err.message);
    return false;
  }
  console.error(`[xrayDeviceLimitPoller] restored ${email} after cooldown`);
  return true;
}

function poll() {
  let clients;
  try {
    clients = xrayConfig.listClients();
  } catch (err) {
    console.error('[xrayDeviceLimitPoller] failed to list clients:', err.message);
    return;
  }

  const now = Date.now();
  const seen = new Set();

  for (const client of clients) {
    if (client.maxDevices == null) continue; // no limit configured — nothing to enforce
    seen.add(client.uuid);
    const email = emailFor(client);
    const kickedEntry = state.get(client.uuid);

    if (kickedEntry) {
      if (now - kickedEntry.kickedAt >= cooldownMs()) {
        if (restore(client.uuid, email)) state.delete(client.uuid);
      }
      continue; // still cooling down (or just restored) — don't re-count this cycle
    }

    let count;
    try {
      count = countRecentIps(email, now);
    } catch (err) {
      console.error(`[xrayDeviceLimitPoller] failed to read online IPs for ${email}:`, err.message);
      continue;
    }

    if (count > client.maxDevices) {
      if (kick(client.uuid, email, count, client.maxDevices)) {
        state.set(client.uuid, { kickedAt: now });
      }
    }
  }

  // Drop cooldown state for uuids no longer configured (revoked) — avoids an
  // unbounded memory leak over the node's lifetime.
  for (const uuid of state.keys()) {
    if (!seen.has(uuid)) state.delete(uuid);
  }
}

function clearState(uuid) {
  state.delete(uuid);
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

module.exports = { start, stop, poll, clearState };
