'use strict';
jest.mock('child_process');
jest.mock('fs');
jest.mock('../../src/services/xrayConfig');

const { spawnSync } = require('child_process');
const fs = require('fs');
const xrayConfig = require('../../src/services/xrayConfig');

beforeEach(() => {
  jest.clearAllMocks();
  spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: null });
  xrayConfig.listPeerOutbounds.mockReturnValue([]);
  process.env.PUBLIC_IFACE = 'ens18';
  delete process.env.VLESS_TIER_1_MBIT;
  delete process.env.VLESS_TIER_3_MBIT;
  delete process.env.VLESS_TIER_5_MBIT;
});

describe('ensureVlessShapingBase', () => {
  it('logs and skips when PUBLIC_IFACE is not set, instead of throwing', () => {
    delete process.env.PUBLIC_IFACE;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');

    expect(() => ensureVlessShapingBase()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('PUBLIC_IFACE'));
    expect(spawnSync).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('replaces (not add) the public interface\'s qdisc — it may already carry the kernel-default mq discipline', () => {
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');
    ensureVlessShapingBase();

    expect(spawnSync).toHaveBeenCalledWith('tc', ['qdisc', 'replace', 'dev', 'ens18', 'root', 'handle', '1:', 'prio'], { encoding: 'utf8' });
  });

  it('installs the nftables dl_mark map + postrouting rule via a ruleset file', () => {
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');
    ensureVlessShapingBase();

    expect(spawnSync).toHaveBeenCalledWith('nft', ['delete', 'table', 'inet', 'boonker_vless_shape'], { encoding: 'utf8' });
    const writeCall = fs.writeFileSync.mock.calls[0];
    expect(writeCall[1]).toContain('type ipv4_addr . inet_service : mark');
    // dport, not sport: for the node->client leg the client's port is the
    // packet's DESTINATION port (source port is always 443) — a live E2E
    // throughput test caught this as `sport` first (silently matched
    // nothing, no throttling at all on download).
    expect(writeCall[1]).toContain('meta mark set ip daddr . tcp dport map @dl_mark');
    expect(spawnSync).toHaveBeenCalledWith('nft', ['-f', writeCall[0]], { encoding: 'utf8' });
  });

  it('re-applies a tc filter for every already-assigned user read from config — tc state is wiped on reboot, config.json isn\'t', () => {
    xrayConfig.listPeerOutbounds.mockReturnValue([
      { tier: 1, uuid: 'uuid-aaa', mark: 2000 },
      { tier: 5, uuid: 'uuid-bbb', mark: 2001 },
    ]);
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');
    ensureVlessShapingBase();

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '2000',
      'handle', '2000', 'fw', 'police', 'rate', '10mbit', 'burst', '125k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '2001',
      'handle', '2001', 'fw', 'police', 'rate', '50mbit', 'burst', '625k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });

  it('does not throw and just logs if reading peer outbounds fails (e.g. config missing)', () => {
    xrayConfig.listPeerOutbounds.mockImplementation(() => { throw new Error('ENOENT'); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');

    expect(() => ensureVlessShapingBase()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('re-apply'), 'ENOENT');
    errorSpy.mockRestore();
  });
});

describe('addPeerFilter / removePeerFilter', () => {
  it('adds a fw-mark police filter using the mark as both prio and handle, at the tier\'s rate, with a burst scaled to it (~100ms worth of tokens)', () => {
    const { addPeerFilter } = require('../../src/services/xrayShaping');
    addPeerFilter(2000, 1);

    // A flat 32k burst let TCP retransmit storms crush real throughput well
    // below the configured rate — found live (Этап 1 E2E). ~12.5k per Mbit.
    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '2000',
      'handle', '2000', 'fw', 'police', 'rate', '10mbit', 'burst', '125k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });

  it('two different users on the SAME tier get two INDEPENDENT filters (no shared police action)', () => {
    const { addPeerFilter } = require('../../src/services/xrayShaping');
    addPeerFilter(2000, 1);
    addPeerFilter(2001, 1);

    const filterAddCalls = spawnSync.mock.calls.filter((c) => c[1][0] === 'filter' && c[1][1] === 'add');
    expect(filterAddCalls).toHaveLength(2);
    expect(filterAddCalls[0][1]).toEqual(expect.arrayContaining(['prio', '2000', 'handle', '2000']));
    expect(filterAddCalls[1][1]).toEqual(expect.arrayContaining(['prio', '2001', 'handle', '2001']));
  });

  it('floors the burst at 32k for a very low custom rate', () => {
    process.env.VLESS_TIER_1_MBIT = '1';
    const { addPeerFilter } = require('../../src/services/xrayShaping');
    addPeerFilter(2000, 1);

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '2000',
      'handle', '2000', 'fw', 'police', 'rate', '1mbit', 'burst', '32k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });

  it('clears any stale filter at that mark\'s prio first, so re-running is idempotent', () => {
    const { addPeerFilter } = require('../../src/services/xrayShaping');
    addPeerFilter(2000, 1);

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'del', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '2000',
    ], { encoding: 'utf8' });
  });

  it('removePeerFilter deletes the filter at the mark\'s prio', () => {
    const { removePeerFilter } = require('../../src/services/xrayShaping');
    removePeerFilter(2000);

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'del', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '2000',
    ], { encoding: 'utf8' });
  });
});

describe('markClientConnection', () => {
  it('adds a timed (ip, port) -> mark element to the dl_mark map', () => {
    const { markClientConnection } = require('../../src/services/xrayShaping');
    markClientConnection('46.8.7.197', 3467, 2001);

    expect(spawnSync).toHaveBeenCalledWith('nft', [
      'add', 'element', 'inet', 'boonker_vless_shape', 'dl_mark',
      '{ 46.8.7.197 . 3467 timeout 120s : 2001 }',
    ], { encoding: 'utf8' });
  });
});
