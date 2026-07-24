'use strict';
jest.mock('child_process');

const { spawnSync } = require('child_process');
const fs = require('fs');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.XRAY_API_ADDR = '127.0.0.1:10085';
  process.env.XRAY_BIN = '/usr/local/bin/xray';
});

describe('getClientTraffic', () => {
  it('runs xray api statsquery filtered to user>>> and maps uplink/downlink to rx/tx', () => {
    const raw = JSON.stringify({
      stat: [
        { name: 'user>>>user-123 | My Laptop>>>traffic>>>uplink', value: '1000' },
        { name: 'user>>>user-123 | My Laptop>>>traffic>>>downlink', value: '2000' },
      ],
    });
    spawnSync.mockReturnValue({ stdout: raw, stderr: '', status: 0, error: null });
    const xrayProcess = require('../../src/services/xrayProcess');

    const result = xrayProcess.getClientTraffic();

    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/local/bin/xray',
      ['api', 'statsquery', '--server=127.0.0.1:10085', '-pattern=user>>>'],
      { encoding: 'utf8' }
    );
    // uplink = client → server (server receives) = rx_bytes, same convention as
    // `awg show dump` — downlink = server → client = tx_bytes.
    expect(result).toEqual([{ email: 'user-123 | My Laptop', rx_bytes: 1000, tx_bytes: 2000 }]);
  });

  it('never passes -reset — these are cumulative counters the traffic poller diffs against a baseline', () => {
    spawnSync.mockReturnValue({ stdout: '{"stat":[]}', stderr: '', status: 0, error: null });
    const xrayProcess = require('../../src/services/xrayProcess');

    xrayProcess.getClientTraffic();

    const args = spawnSync.mock.calls[0][1];
    expect(args).not.toContain(expect.stringContaining('-reset'));
  });

  it('throws with stderr message on non-zero exit', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: 'connecting to API server: connection refused', status: 1, error: null });
    const { getClientTraffic } = require('../../src/services/xrayProcess');

    expect(() => getClientTraffic()).toThrow('connection refused');
  });

  it('throws when spawnSync returns error', () => {
    spawnSync.mockReturnValue({ stdout: '', stderr: '', status: null, error: new Error('xray not installed') });
    const { getClientTraffic } = require('../../src/services/xrayProcess');

    expect(() => getClientTraffic()).toThrow('xray not installed');
  });
});

describe('addRoutingRuleToRunning', () => {
  it('calls xray api adrules with -append and the mini routing config, matching by ruleTag', () => {
    spawnSync.mockReturnValue({ stdout: '{}', stderr: '', status: 0, error: null });
    // The temp file is written then unlinked within the same call, same as
    // addClientToRunning's adu payload — spy on the write to inspect content
    // before it's cleaned up, instead of reading it back afterward.
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    const xrayProcess = require('../../src/services/xrayProcess');

    xrayProcess.addRoutingRuleToRunning('user-uuid-aaa', 'user-1 | Laptop', 'tier-103');

    const call = spawnSync.mock.calls.find((c) => c[1][1] === 'adrules');
    expect(call[0]).toBe('/usr/local/bin/xray');
    expect(call[1]).toEqual(expect.arrayContaining(['api', 'adrules', '--server=127.0.0.1:10085', '-append']));

    const written = JSON.parse(writeSpy.mock.calls[0][1]);
    expect(written).toEqual({
      routing: { rules: [{ type: 'field', user: ['user-1 | Laptop'], outboundTag: 'tier-103', ruleTag: 'user-uuid-aaa' }] },
    });
    writeSpy.mockRestore();
  });

  it('falls back to a full restart when the hot-apply fails', () => {
    spawnSync
      .mockReturnValueOnce({ stdout: '', stderr: 'connection refused', status: 1, error: null }) // adrules
      .mockReturnValueOnce({ stdout: '', stderr: '', status: 0, error: null }); // systemctl restart
    const xrayProcess = require('../../src/services/xrayProcess');

    xrayProcess.addRoutingRuleToRunning('user-uuid-aaa', 'user-1 | Laptop', 'tier-103');

    expect(spawnSync).toHaveBeenCalledWith('systemctl', ['restart', 'xray'], { encoding: 'utf8' });
  });
});

describe('removeRoutingRuleFromRunning', () => {
  it('calls xray api rmrules with the ruleTag', () => {
    spawnSync.mockReturnValue({ stdout: '{}', stderr: '', status: 0, error: null });
    const xrayProcess = require('../../src/services/xrayProcess');

    xrayProcess.removeRoutingRuleFromRunning('user-uuid-aaa');

    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/local/bin/xray',
      ['api', 'rmrules', '--server=127.0.0.1:10085', 'user-uuid-aaa'],
      { encoding: 'utf8' }
    );
  });

  it('falls back to a full restart when the hot-remove fails', () => {
    spawnSync
      .mockReturnValueOnce({ stdout: '', stderr: 'rule not found', status: 1, error: null }) // rmrules
      .mockReturnValueOnce({ stdout: '', stderr: '', status: 0, error: null }); // systemctl restart
    const xrayProcess = require('../../src/services/xrayProcess');

    xrayProcess.removeRoutingRuleFromRunning('user-uuid-aaa');

    expect(spawnSync).toHaveBeenCalledWith('systemctl', ['restart', 'xray'], { encoding: 'utf8' });
  });
});

describe('parseStats', () => {
  it('groups uplink/downlink pairs by email and ignores non-user stats (inbound/system totals)', () => {
    const { parseStats } = require('../../src/services/xrayProcess');
    const raw = JSON.stringify({
      stat: [
        { name: 'inbound>>>vless-in>>>traffic>>>downlink', value: '999999' },
        { name: 'user>>>alice | Phone>>>traffic>>>uplink', value: '10' },
        { name: 'user>>>alice | Phone>>>traffic>>>downlink', value: '20' },
        { name: 'user>>>bob | Laptop>>>traffic>>>uplink', value: '30' },
      ],
    });

    expect(parseStats(raw)).toEqual([
      { email: 'alice | Phone', rx_bytes: 10, tx_bytes: 20 },
      { email: 'bob | Laptop', rx_bytes: 30, tx_bytes: 0 },
    ]);
  });

  it('returns an empty array for malformed JSON instead of throwing', () => {
    const { parseStats } = require('../../src/services/xrayProcess');
    expect(parseStats('not json')).toEqual([]);
  });

  it('returns an empty array when stat is missing or empty', () => {
    const { parseStats } = require('../../src/services/xrayProcess');
    expect(parseStats('{}')).toEqual([]);
    expect(parseStats('{"stat":[]}')).toEqual([]);
    expect(parseStats('')).toEqual([]);
  });
});
