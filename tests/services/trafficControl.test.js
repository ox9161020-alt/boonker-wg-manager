'use strict';
jest.mock('child_process');
jest.mock('fs');
jest.mock('../../src/services/config');

const { spawnSync } = require('child_process');
const fs = require('fs');
const configService = require('../../src/services/config');

beforeEach(() => {
  jest.clearAllMocks();
  spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: null });
  configService.parsePeers.mockReturnValue([]);
  configService.readConfig.mockReturnValue('');
  process.env.WG_INTERFACE = 'awg0';
  delete process.env.AWG_IFB_INTERFACE;
  delete process.env.AWG_PEER_RATE_MBIT;
  delete process.env.AWG_PEER_CONNLIMIT;
});

describe('peerFilterPrio', () => {
  it('derives the tc filter prio from the last octet of an allowed-ip', () => {
    const { peerFilterPrio } = require('../../src/services/trafficControl');
    expect(peerFilterPrio('10.0.0.53/32')).toBe(53);
  });

  it('throws for an octet below the allocatable range (2-254)', () => {
    const { peerFilterPrio } = require('../../src/services/trafficControl');
    expect(() => peerFilterPrio('10.0.0.1/32')).toThrow();
  });

  it('throws for an octet above the allocatable range (2-254)', () => {
    const { peerFilterPrio } = require('../../src/services/trafficControl');
    expect(() => peerFilterPrio('10.0.0.255/32')).toThrow();
  });
});

describe('sh (internal spawnSync wrapper)', () => {
  it('logs an error instead of throwing when a command fails to spawn (e.g. binary missing)', () => {
    spawnSync.mockReturnValue({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { addPeerLimit } = require('../../src/services/trafficControl');

    expect(() => addPeerLimit('10.0.0.53/32')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[trafficControl]'));

    errorSpy.mockRestore();
  });

  it('logs the stderr text (not just spawn-level failures) when a command exits non-zero, so a bad tc/nft ruleset is visible in journalctl instead of failing silently', () => {
    spawnSync.mockReturnValue({ error: null, status: 1, stdout: '', stderr: 'Error: Could not process rule: Operation not supported' });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { addPeerLimit } = require('../../src/services/trafficControl');

    expect(() => addPeerLimit('10.0.0.53/32')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Operation not supported'));

    errorSpy.mockRestore();
  });
});

describe('removePeerLimit', () => {
  it('deletes the tc filter for this peer on both awg0 (download) and ifb0 (upload)', () => {
    const { removePeerLimit } = require('../../src/services/trafficControl');
    removePeerLimit('10.0.0.53/32');

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'del', 'dev', 'awg0', 'parent', '1:0', 'protocol', 'ip', 'prio', '53',
    ], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'del', 'dev', 'ifb0', 'parent', '1:0', 'protocol', 'ip', 'prio', '53',
    ], { encoding: 'utf8' });
  });
});

describe('addPeerLimit', () => {
  it('adds a police filter capping download (dst match) on awg0 at the configured rate', () => {
    const { addPeerLimit } = require('../../src/services/trafficControl');
    addPeerLimit('10.0.0.53/32');

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'awg0', 'parent', '1:0', 'protocol', 'ip', 'prio', '53',
      'u32', 'match', 'ip', 'dst', '10.0.0.53/32',
      'police', 'rate', '20mbit', 'burst', '32k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });

  it('adds a police filter capping upload (src match) on ifb0 at the configured rate', () => {
    const { addPeerLimit } = require('../../src/services/trafficControl');
    addPeerLimit('10.0.0.53/32');

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ifb0', 'parent', '1:0', 'protocol', 'ip', 'prio', '53',
      'u32', 'match', 'ip', 'src', '10.0.0.53/32',
      'police', 'rate', '20mbit', 'burst', '32k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });

  it('clears any stale filter at this prio before adding, so re-adding the same peer is idempotent', () => {
    const { addPeerLimit } = require('../../src/services/trafficControl');
    addPeerLimit('10.0.0.53/32');

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'del', 'dev', 'awg0', 'parent', '1:0', 'protocol', 'ip', 'prio', '53',
    ], { encoding: 'utf8' });
  });

  it('honours AWG_PEER_RATE_MBIT for the police rate', () => {
    process.env.AWG_PEER_RATE_MBIT = '5';
    const { addPeerLimit } = require('../../src/services/trafficControl');
    addPeerLimit('10.0.0.53/32');

    expect(spawnSync).toHaveBeenCalledWith('tc', expect.arrayContaining(['rate', '5mbit']), { encoding: 'utf8' });
  });
});

describe('ensureTrafficControlBase', () => {
  it('loads the ifb kernel module and brings up ifb0', () => {
    const { ensureTrafficControlBase } = require('../../src/services/trafficControl');
    ensureTrafficControlBase();

    expect(spawnSync).toHaveBeenCalledWith('modprobe', ['ifb', 'numifbs=1'], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('ip', ['link', 'add', 'ifb0', 'type', 'ifb'], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('ip', ['link', 'set', 'ifb0', 'up'], { encoding: 'utf8' });
  });

  it('adds the root qdiscs on awg0 (egress + ingress) and ifb0 (egress)', () => {
    const { ensureTrafficControlBase } = require('../../src/services/trafficControl');
    ensureTrafficControlBase();

    expect(spawnSync).toHaveBeenCalledWith('tc', ['qdisc', 'add', 'dev', 'awg0', 'root', 'handle', '1:', 'prio'], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('tc', ['qdisc', 'add', 'dev', 'awg0', 'handle', 'ffff:', 'ingress'], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('tc', ['qdisc', 'add', 'dev', 'ifb0', 'root', 'handle', '1:', 'prio'], { encoding: 'utf8' });
  });

  it('mirrors awg0 ingress to ifb0, clearing any stale mirror filter first so restarts do not duplicate it', () => {
    const { ensureTrafficControlBase } = require('../../src/services/trafficControl');
    ensureTrafficControlBase();

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'del', 'dev', 'awg0', 'parent', 'ffff:', 'protocol', 'ip', 'prio', '1',
    ], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'awg0', 'parent', 'ffff:', 'protocol', 'ip', 'prio', '1',
      'u32', 'match', 'u32', '0', '0', 'action', 'mirred', 'egress', 'redirect', 'dev', 'ifb0',
    ], { encoding: 'utf8' });
  });

  it('installs the nftables connlimit table via a ruleset file, using the meter idiom (ct count needs a meter — a plain dynamic set add rejects with "Operation not supported" on nftables 1.0.9)', () => {
    const { ensureTrafficControlBase } = require('../../src/services/trafficControl');
    ensureTrafficControlBase();

    expect(spawnSync).toHaveBeenCalledWith('nft', ['delete', 'table', 'inet', 'boonker_limits'], { encoding: 'utf8' });

    // `nft -f -` (reading the ruleset from a piped stdin) fails on this nftables
    // version with "Not a regular file: /dev/stdin" — write to a real file instead.
    const writeCall = fs.writeFileSync.mock.calls[0];
    expect(writeCall[1]).toContain('meter conn_count { ip saddr ct count over 200 } drop');
    const rulesetPath = writeCall[0];
    expect(spawnSync).toHaveBeenCalledWith('nft', ['-f', rulesetPath], { encoding: 'utf8' });
  });

  it('re-applies the per-peer speed limit for every peer currently in the config', () => {
    configService.parsePeers.mockReturnValue([
      { publicKey: 'pk1', allowedIp: '10.0.0.7/32' },
    ]);
    const { ensureTrafficControlBase } = require('../../src/services/trafficControl');
    ensureTrafficControlBase();

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'awg0', 'parent', '1:0', 'protocol', 'ip', 'prio', '7',
      'u32', 'match', 'ip', 'dst', '10.0.0.7/32',
      'police', 'rate', '20mbit', 'burst', '32k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });
});
