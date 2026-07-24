'use strict';
const { spawn } = require('child_process');
const readline = require('readline');
const xrayConfig = require('./xrayConfig');
const xrayShaping = require('./xrayShaping');

// Xray writes an access-record line for every accepted connection to
// stdout/journald BY DEFAULT — confirmed live even with `log.access` unset
// and `log.loglevel: warning` (see ROADMAP_AWG-VLESS.md Этап 1), so tailing
// journald directly avoids needing a dedicated access-log file + logrotate.
// Example line (via `journalctl -u xray -o cat`):
//   2026/07/24 11:28:31.377572 from tcp:46.8.7.197:3467 accepted tcp:host:443 [vless-in >> direct] email: uuid | Device
const LINE_RE = /from (?:tcp|udp):([\d.]+):(\d+) accepted .*? email: (.+)$/;

function parseAccessLogLine(line) {
  const match = LINE_RE.exec(line);
  if (!match) return null;
  const [, ip, port, email] = match;
  return { ip, port: parseInt(port, 10), email: email.trim() };
}

let child = null;
let restartTimer = null;

function handleLine(line) {
  const parsed = parseAccessLogLine(line);
  if (!parsed) return;
  let mark;
  try {
    mark = xrayConfig.getMarkForEmail(parsed.email);
  } catch (err) {
    console.error('[xrayAccessLog] failed to look up mark for email:', err.message);
    return;
  }
  // No tier assigned to this user — nothing to mark, full speed by default.
  if (mark == null) return;
  xrayShaping.markClientConnection(parsed.ip, parsed.port, mark);
}

// Spawns `journalctl -u xray -f` and marks each new tiered connection's
// client-facing leg as it appears. Non-fatal by convention (see server.js):
// if journalctl/xray isn't available, VLESS still works at full speed, it
// just isn't shaped — logged, not fatal. Auto-restarts the tail if the child
// process dies unexpectedly (journalctl restarting, xray reinstalled, etc.).
function start() {
  if (child) return; // already running

  child = spawn('journalctl', ['-u', 'xray', '-f', '-n', '0', '-o', 'cat'], { stdio: ['ignore', 'pipe', 'pipe'] });

  readline.createInterface({ input: child.stdout }).on('line', handleLine);
  child.stderr.on('data', (d) => console.error('[xrayAccessLog] journalctl stderr:', d.toString().trim()));

  child.on('error', (err) => {
    console.error('[xrayAccessLog] failed to spawn journalctl:', err.message);
    child = null;
  });

  child.on('exit', (code) => {
    console.error(`[xrayAccessLog] journalctl tail exited (code ${code}) — restarting in 5s`);
    child = null;
    restartTimer = setTimeout(start, 5000);
  });
}

function stop() {
  clearTimeout(restartTimer);
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
    child = null;
  }
}

module.exports = { start, stop, parseAccessLogLine };
