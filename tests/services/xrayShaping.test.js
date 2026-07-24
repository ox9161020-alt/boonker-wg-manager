'use strict';
jest.mock('child_process');
jest.mock('fs');

const { spawnSync } = require('child_process');
const fs = require('fs');

beforeEach(() => {
  jest.clearAllMocks();
  spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: null });
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

  it('adds a fw-mark police filter per tier at the tier\'s default rate, with a burst scaled to that rate (~100ms worth of tokens)', () => {
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');
    ensureVlessShapingBase();

    // A flat 32k burst let TCP retransmit storms crush real throughput well
    // below the configured rate — found live (Этап 1 E2E). ~12.5k per Mbit.
    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '60',
      'handle', '101', 'fw', 'police', 'rate', '10mbit', 'burst', '125k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '61',
      'handle', '103', 'fw', 'police', 'rate', '30mbit', 'burst', '375k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '62',
      'handle', '105', 'fw', 'police', 'rate', '50mbit', 'burst', '625k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });

  it('floors the burst at 32k for a very low custom rate', () => {
    process.env.VLESS_TIER_1_MBIT = '1';
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');
    ensureVlessShapingBase();

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'add', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '60',
      'handle', '101', 'fw', 'police', 'rate', '1mbit', 'burst', '32k', 'drop', 'flowid', '1:1',
    ], { encoding: 'utf8' });
  });

  it('clears any stale filter at the tier\'s prio first, so re-running is idempotent', () => {
    const { ensureVlessShapingBase } = require('../../src/services/xrayShaping');
    ensureVlessShapingBase();

    expect(spawnSync).toHaveBeenCalledWith('tc', [
      'filter', 'del', 'dev', 'ens18', 'parent', '1:0', 'protocol', 'ip', 'prio', '60',
    ], { encoding: 'utf8' });
  });
});

describe('markClientConnection', () => {
  it('adds a timed (ip, port) -> mark element to the dl_mark map', () => {
    const { markClientConnection } = require('../../src/services/xrayShaping');
    markClientConnection('46.8.7.197', 3467, 103);

    expect(spawnSync).toHaveBeenCalledWith('nft', [
      'add', 'element', 'inet', 'boonker_vless_shape', 'dl_mark',
      '{ 46.8.7.197 . 3467 timeout 120s : 103 }',
    ], { encoding: 'utf8' });
  });
});
