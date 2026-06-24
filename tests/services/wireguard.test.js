'use strict';
jest.mock('child_process');

const { spawnSync } = require('child_process');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WG_INTERFACE = 'awg0';
});

describe('getStatus', () => {
  it('runs awg show <interface> and returns stdout', () => {
    spawnSync.mockReturnValue({ stdout: 'interface: awg0\n', stderr: '', status: 0, error: null });
    const wireguard = require('../../src/services/wireguard');

    const result = wireguard.getStatus();

    expect(spawnSync).toHaveBeenCalledWith('awg', ['show', 'awg0'], { encoding: 'utf8' });
    expect(result).toBe('interface: awg0\n');
  });

  it('throws when spawnSync returns error', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: '', status: null, error: new Error('not found') });
    const wireguard = require('../../src/services/wireguard');

    expect(() => wireguard.getStatus()).toThrow('not found');
  });

  it('throws on non-zero exit status', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: 'awg0: No such device', status: 1, error: null });
    const { getStatus } = require('../../src/services/wireguard');

    expect(() => getStatus()).toThrow('awg0: No such device');
  });
});

describe('addPeerToRunning', () => {
  it('runs awg set <iface> peer <pubkey> allowed-ips <ip>', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: '', status: 0, error: null });
    const wireguard = require('../../src/services/wireguard');

    wireguard.addPeerToRunning('test-pubkey', '10.0.0.2/32');

    expect(spawnSync).toHaveBeenCalledWith(
      'awg', ['set', 'awg0', 'peer', 'test-pubkey', 'allowed-ips', '10.0.0.2/32'],
      { encoding: 'utf8' }
    );
  });

  it('throws with stderr message on non-zero exit', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: 'No such device', status: 1, error: null });
    const wireguard = require('../../src/services/wireguard');

    expect(() => wireguard.addPeerToRunning('key', '10.0.0.2/32')).toThrow('No such device');
  });
});

describe('removePeerFromRunning', () => {
  it('runs awg set <iface> peer <pubkey> remove', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: '', status: 0, error: null });
    const wireguard = require('../../src/services/wireguard');

    wireguard.removePeerFromRunning('test-pubkey');

    expect(spawnSync).toHaveBeenCalledWith(
      'awg', ['set', 'awg0', 'peer', 'test-pubkey', 'remove'],
      { encoding: 'utf8' }
    );
  });

  it('throws with stderr message on non-zero exit', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: 'peer not found', status: 1, error: null });
    const { removePeerFromRunning } = require('../../src/services/wireguard');

    expect(() => removePeerFromRunning('test-pubkey')).toThrow('peer not found');
  });

  it('throws when spawnSync returns error', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: '', status: null, error: new Error('awg not installed') });
    const { removePeerFromRunning } = require('../../src/services/wireguard');

    expect(() => removePeerFromRunning('test-pubkey')).toThrow('awg not installed');
  });
});
