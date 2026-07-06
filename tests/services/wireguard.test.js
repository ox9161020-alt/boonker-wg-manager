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

describe('getDump', () => {
  it('runs awg show <interface> dump and returns stdout', () => {
    spawnSync.mockReturnValue({ stdout: 'interface-line\npeer-line\n', stderr: '', status: 0, error: null });
    const wireguard = require('../../src/services/wireguard');

    const result = wireguard.getDump();

    expect(spawnSync).toHaveBeenCalledWith('awg', ['show', 'awg0', 'dump'], { encoding: 'utf8' });
    expect(result).toBe('interface-line\npeer-line\n');
  });

  it('throws with stderr message on non-zero exit', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: 'awg0: No such device', status: 1, error: null });
    const { getDump } = require('../../src/services/wireguard');

    expect(() => getDump()).toThrow('awg0: No such device');
  });

  it('throws when spawnSync returns error', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: '', status: null, error: new Error('awg not installed') });
    const { getDump } = require('../../src/services/wireguard');

    expect(() => getDump()).toThrow('awg not installed');
  });
});

describe('parsePeerDump', () => {
  it('extracts publicKey, allowedIp, rx_bytes and tx_bytes for each peer, skipping the interface line', () => {
    const { parsePeerDump } = require('../../src/services/wireguard');

    const raw = [
      'server-priv\tserver-pub\t51820\toff',
      'peer-pub-1\t(none)\t1.2.3.4:55333\t10.0.0.2/32\t1783177000\t123456\t654321\toff',
      'peer-pub-2\t(none)\t(none)\t10.0.0.3/32\t0\t0\t0\toff',
    ].join('\n');

    expect(parsePeerDump(raw)).toEqual([
      { publicKey: 'peer-pub-1', allowedIp: '10.0.0.2/32', rx_bytes: 123456, tx_bytes: 654321 },
      { publicKey: 'peer-pub-2', allowedIp: '10.0.0.3/32', rx_bytes: 0, tx_bytes: 0 },
    ]);
  });

  it('returns an empty array when only the interface line is present (no peers)', () => {
    const { parsePeerDump } = require('../../src/services/wireguard');

    expect(parsePeerDump('server-priv\tserver-pub\t51820\toff\n')).toEqual([]);
  });
});
