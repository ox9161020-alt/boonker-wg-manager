'use strict';
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayProcess');

const xrayConfig = require('../../src/services/xrayConfig');
const xrayProcess = require('../../src/services/xrayProcess');
const poller = require('../../src/services/xrayDeviceLimitPoller');

const NOW = 1_800_000_000_000; // arbitrary fixed instant

function ip(addr, ageMs) {
  return { ip: addr, lastSeenMs: NOW - ageMs };
}

beforeEach(() => {
  jest.clearAllMocks();
  poller.stop(); // clears in-memory cooldown state between tests
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  delete process.env.VLESS_DEVICE_LIMIT_POLL_MS;
  delete process.env.VLESS_DEVICE_LIMIT_WINDOW_MS;
  delete process.env.VLESS_DEVICE_LIMIT_COOLDOWN_MS;
  xrayConfig.buildEmail.mockImplementation((userId, deviceName) => `${userId} | ${deviceName}`);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('poll — skipping', () => {
  it('ignores clients with no maxDevices configured', () => {
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop' }]);

    poller.poll();

    expect(xrayProcess.getOnlineIps).not.toHaveBeenCalled();
    expect(xrayProcess.removeClientFromRunning).not.toHaveBeenCalled();
  });
});

describe('poll — kicking', () => {
  it('kicks when the number of distinct recent IPs exceeds maxDevices', () => {
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 2 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 1000), ip('2.2.2.2', 1000), ip('3.3.3.3', 1000)]);

    poller.poll();

    expect(xrayProcess.getOnlineIps).toHaveBeenCalledWith('user-1 | Laptop');
    expect(xrayProcess.removeClientFromRunning).toHaveBeenCalledWith('user-1 | Laptop');
  });

  it('does not kick when the count is within maxDevices', () => {
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 3 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 1000), ip('2.2.2.2', 1000), ip('3.3.3.3', 1000)]);

    poller.poll();

    expect(xrayProcess.removeClientFromRunning).not.toHaveBeenCalled();
  });

  it('ignores IPs outside the sliding window when counting', () => {
    process.env.VLESS_DEVICE_LIMIT_WINDOW_MS = '600000'; // 10 min
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 2 }]);
    // Two fresh IPs (within window) + one stale one (roamed away 20 min ago) —
    // a brief Wi-Fi<->mobile roam shouldn't count as a 3rd device forever.
    xrayProcess.getOnlineIps.mockReturnValue([
      ip('1.1.1.1', 60_000),
      ip('2.2.2.2', 60_000),
      ip('9.9.9.9', 20 * 60_000),
    ]);

    poller.poll();

    expect(xrayProcess.removeClientFromRunning).not.toHaveBeenCalled();
  });

  it('does not re-kick a client already in cooldown', () => {
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 1 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 0), ip('2.2.2.2', 0)]);

    poller.poll(); // kicks, enters cooldown
    xrayProcess.removeClientFromRunning.mockClear();
    poller.poll(); // still within cooldown

    expect(xrayProcess.removeClientFromRunning).not.toHaveBeenCalled();
    expect(xrayProcess.getOnlineIps).toHaveBeenCalledTimes(1); // not re-counted while cooling down
  });
});

describe('poll — auto-restore after cooldown', () => {
  it('restores once the cooldown has elapsed', () => {
    process.env.VLESS_DEVICE_LIMIT_COOLDOWN_MS = '300000'; // 5 min
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 1 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 0), ip('2.2.2.2', 0)]);

    poller.poll(); // kicked at NOW
    expect(xrayProcess.removeClientFromRunning).toHaveBeenCalledWith('user-1 | Laptop');

    Date.now.mockReturnValue(NOW + 300_000); // cooldown just elapsed
    poller.poll();

    expect(xrayProcess.addClientToRunning).toHaveBeenCalledWith('u1', 'user-1 | Laptop');
  });

  it('does not restore before the cooldown elapses', () => {
    process.env.VLESS_DEVICE_LIMIT_COOLDOWN_MS = '300000';
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 1 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 0), ip('2.2.2.2', 0)]);

    poller.poll(); // kicked at NOW
    Date.now.mockReturnValue(NOW + 60_000); // only 1 min in
    poller.poll();

    expect(xrayProcess.addClientToRunning).not.toHaveBeenCalled();
  });
});

describe('poll — state cleanup', () => {
  it('drops cooldown state for a uuid no longer among configured clients (e.g. revoked)', () => {
    process.env.VLESS_DEVICE_LIMIT_COOLDOWN_MS = '300000';
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 1 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 0), ip('2.2.2.2', 0)]);
    poller.poll(); // kicked, state recorded

    xrayConfig.listClients.mockReturnValue([]); // revoked before cooldown elapsed
    poller.poll();

    Date.now.mockReturnValue(NOW + 300_000);
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 1 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 0)]); // now under limit
    poller.poll();

    // If cleanup hadn't happened, this would have tried to "restore" a client
    // that was never actually re-kicked under the new state.
    expect(xrayProcess.addClientToRunning).not.toHaveBeenCalled();
    expect(xrayProcess.removeClientFromRunning).toHaveBeenCalledTimes(1); // only the original kick
  });

  it('clearState() immediately drops cooldown tracking for a uuid (revoke path)', () => {
    process.env.VLESS_DEVICE_LIMIT_COOLDOWN_MS = '300000';
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1', userId: 'user-1', deviceName: 'Laptop', maxDevices: 1 }]);
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 0), ip('2.2.2.2', 0)]);
    poller.poll(); // kicked

    poller.clearState('u1');

    // Re-counts immediately instead of treating u1 as still cooling down.
    xrayProcess.getOnlineIps.mockReturnValue([ip('1.1.1.1', 0)]);
    poller.poll();

    expect(xrayProcess.removeClientFromRunning).toHaveBeenCalledTimes(1); // no 2nd kick, count is now fine
  });
});

describe('start / stop', () => {
  afterEach(() => {
    poller.stop();
    jest.useRealTimers();
  });

  it('starts and clears an interval without throwing', () => {
    jest.useFakeTimers();
    xrayConfig.listClients.mockReturnValue([]);

    expect(() => poller.start()).not.toThrow();
    expect(() => poller.stop()).not.toThrow();
  });

  it('does not start when VLESS_DEVICE_LIMIT_ENABLED=0', () => {
    jest.useFakeTimers();
    process.env.VLESS_DEVICE_LIMIT_ENABLED = '0';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    poller.start();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    delete process.env.VLESS_DEVICE_LIMIT_ENABLED;
  });

  it('does not start a second interval if already running', () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    poller.start();
    poller.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
