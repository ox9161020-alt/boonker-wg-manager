'use strict';
jest.mock('child_process');
jest.mock('readline');
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayShaping');

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const xrayConfig = require('../../src/services/xrayConfig');
const xrayShaping = require('../../src/services/xrayShaping');
const xrayAccessLog = require('../../src/services/xrayAccessLog');

let lineHandler;

beforeEach(() => {
  jest.clearAllMocks();
  // readline's own line-splitting isn't what's under test here — capture the
  // 'line' callback and invoke it directly with a full line string instead of
  // needing a real readable stream (fake stdout is a plain EventEmitter).
  readline.createInterface.mockReturnValue({
    on: (event, cb) => { if (event === 'line') lineHandler = cb; },
  });
});

afterEach(() => {
  xrayAccessLog.stop();
});

describe('parseAccessLogLine', () => {
  it('extracts ip, port and email from a real Xray access-record line', () => {
    const line = '2026/07/24 11:28:31.377572 from tcp:46.8.7.197:3467 accepted tcp:cdn.example.com:443 [vless-in >> direct] email: ef8245b3-4231-4bbd-b4d3-7ecc886da50e | Vless2';
    expect(xrayAccessLog.parseAccessLogLine(line)).toEqual({
      ip: '46.8.7.197', port: 3467, email: 'ef8245b3-4231-4bbd-b4d3-7ecc886da50e | Vless2',
    });
  });

  it('also matches udp-protocol accept lines (e.g. DNS)', () => {
    const line = '2026/07/24 11:28:31.112939 from tcp:46.8.7.197:3456 accepted udp:1.1.1.1:53 [vless-in -> dns-out] email: user | Device';
    expect(xrayAccessLog.parseAccessLogLine(line)).toEqual({ ip: '46.8.7.197', port: 3456, email: 'user | Device' });
  });

  it('matches lines with no tcp:/udp: prefix before the client address — confirmed live this omits inconsistently (found via the Этап 1 throughput E2E, direct-routed connections often lack it while dns-out ones carry it)', () => {
    const line = '2026/07/24 12:43:43.854996 from 194.87.83.183:51114 accepted tcp:ipv4.download.thinkbroadband.com:80 [vless-in -> tier-105] email: user | Device';
    expect(xrayAccessLog.parseAccessLogLine(line)).toEqual({ ip: '194.87.83.183', port: 51114, email: 'user | Device' });
  });

  it('returns null for unrelated log lines', () => {
    expect(xrayAccessLog.parseAccessLogLine('2026/07/24 11:28:31 [Warning] core: Xray 26.3.27 started')).toBeNull();
  });
});

describe('start', () => {
  function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    return child;
  }

  it('spawns journalctl tailing the xray unit from now (no backlog)', () => {
    spawn.mockReturnValue(fakeChild());
    xrayAccessLog.start();

    expect(spawn).toHaveBeenCalledWith('journalctl', ['-u', 'xray', '-f', '-n', '0', '-o', 'cat'], { stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('marks the client connection when a tiered user\'s line appears', () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    xrayConfig.getMarkForEmail.mockReturnValue(103);
    xrayAccessLog.start();

    lineHandler('from tcp:46.8.7.197:3467 accepted tcp:x:443 [vless-in >> direct] email: user | Device');

    expect(xrayConfig.getMarkForEmail).toHaveBeenCalledWith('user | Device');
    expect(xrayShaping.markClientConnection).toHaveBeenCalledWith('46.8.7.197', 3467, 103);
  });

  it('does nothing for a user with no assigned tier (full speed by default)', () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    xrayConfig.getMarkForEmail.mockReturnValue(null);
    xrayAccessLog.start();

    lineHandler('from tcp:46.8.7.197:3467 accepted tcp:x:443 [vless-in >> direct] email: user | Device');

    expect(xrayShaping.markClientConnection).not.toHaveBeenCalled();
  });

  it('does not spawn a second process if already running', () => {
    spawn.mockReturnValue(fakeChild());
    xrayAccessLog.start();
    xrayAccessLog.start();

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
