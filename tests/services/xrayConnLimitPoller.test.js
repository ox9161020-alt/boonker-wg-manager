'use strict';
jest.mock('child_process');
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayShaping', () => ({ NFT_TABLE: 'boonker_vless_shape' }));
jest.mock('../../src/services/xraySpeedTiers', () => ({ PENALTY_TIER: 0 }));
jest.mock('../../src/services/xraySpeedTierApply');

const { spawnSync } = require('child_process');
const xrayConfig = require('../../src/services/xrayConfig');
const { applySpeedTier } = require('../../src/services/xraySpeedTierApply');
const poller = require('../../src/services/xrayConnLimitPoller');

// Builds the `nft -j list map ... dl_mark` JSON shape (confirmed live on the
// test node, ROADMAP_AWG-VLESS.md Этап 2 spike) from a flat list of marks —
// one dl_mark entry per array item, so passing the same mark N times yields
// a count of N for it.
function nftMapResult(marks) {
  const elem = marks.map((mark, i) => ([
    { elem: { val: { concat: [`10.9.9.${i}`, 1000 + i] }, timeout: 60, expires: 59 } },
    mark,
  ]));
  const mapObj = { family: 'inet', name: 'dl_mark', table: 'boonker_vless_shape', map: 'mark' };
  if (elem.length) mapObj.elem = elem;
  return {
    status: 0, error: null,
    stdout: JSON.stringify({ nftables: [{ metainfo: {} }, { map: mapObj }] }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // stop() clears the poller's in-memory debounce state as a side effect —
  // reused here purely to isolate tests from each other, not to test stop().
  poller.stop();
  delete process.env.VLESS_PEER_CONNLIMIT;
  delete process.env.VLESS_CONNLIMIT_POLL_MS;
  delete process.env.VLESS_CONNLIMIT_BREACH_POLLS;
  delete process.env.VLESS_CONNLIMIT_CALM_POLLS;
  xrayConfig.findClient.mockImplementation((uuid) => ({ uuid, userId: 'user-1', deviceName: 'Laptop' }));
  xrayConfig.buildEmail.mockImplementation((userId, deviceName) => `${userId} | ${deviceName}`);
});

describe('poll — counting', () => {
  it('reads the dl_mark map via nft -j list map on the shared shaping table', () => {
    xrayConfig.listPeerOutbounds.mockReturnValue([]);
    spawnSync.mockReturnValue(nftMapResult([]));

    poller.poll();

    expect(spawnSync).toHaveBeenCalledWith('nft', ['-j', 'list', 'map', 'inet', 'boonker_vless_shape', 'dl_mark'], { encoding: 'utf8' });
  });

  it('treats a non-zero nft exit (map/table not created yet) as no data, without throwing', () => {
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 1, uuid: 'u1', mark: 2000 }]);
    spawnSync.mockReturnValue({ status: 1, error: null, stdout: '', stderr: 'no such object' });

    expect(() => poller.poll()).not.toThrow();
    expect(applySpeedTier).not.toHaveBeenCalled();
  });

  it('does nothing when every user is under the connection threshold', () => {
    process.env.VLESS_PEER_CONNLIMIT = '5';
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 1, uuid: 'u1', mark: 2000 }]);
    spawnSync.mockReturnValue(nftMapResult([2000]));

    poller.poll();

    expect(applySpeedTier).not.toHaveBeenCalled();
  });
});

describe('poll — downgrade', () => {
  it('downgrades to the penalty tier only after a sustained breach (debounced across polls)', () => {
    process.env.VLESS_PEER_CONNLIMIT = '2';
    process.env.VLESS_CONNLIMIT_BREACH_POLLS = '2';
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 1, uuid: 'u1', mark: 2000 }]);
    spawnSync.mockReturnValue(nftMapResult([2000, 2000, 2000])); // count 3 > 2

    poller.poll();
    expect(applySpeedTier).not.toHaveBeenCalled(); // 1st breach poll — not yet

    poller.poll();
    expect(applySpeedTier).toHaveBeenCalledWith('u1', 'user-1 | Laptop', 0); // 2nd — triggers
    expect(applySpeedTier).toHaveBeenCalledTimes(1);
  });

  it('resets the breach streak on a calm poll in between, requiring sustained breach again', () => {
    process.env.VLESS_PEER_CONNLIMIT = '2';
    process.env.VLESS_CONNLIMIT_BREACH_POLLS = '2';
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 1, uuid: 'u1', mark: 2000 }]);

    spawnSync.mockReturnValue(nftMapResult([2000, 2000, 2000]));
    poller.poll(); // breach 1
    spawnSync.mockReturnValue(nftMapResult([2000])); // calm — resets streak
    poller.poll();
    spawnSync.mockReturnValue(nftMapResult([2000, 2000, 2000]));
    poller.poll(); // breach 1 again, not 3rd consecutive

    expect(applySpeedTier).not.toHaveBeenCalled();
  });

  it('does not attempt to downgrade a user who is already on the penalty tier', () => {
    process.env.VLESS_PEER_CONNLIMIT = '2';
    process.env.VLESS_CONNLIMIT_BREACH_POLLS = '1';
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 0, uuid: 'u1', mark: 2500 }]);
    spawnSync.mockReturnValue(nftMapResult([2500, 2500, 2500]));

    poller.poll();

    expect(applySpeedTier).not.toHaveBeenCalled();
  });

  it('skips a peer whose client no longer exists (orphaned outbound) without throwing', () => {
    process.env.VLESS_PEER_CONNLIMIT = '1';
    process.env.VLESS_CONNLIMIT_BREACH_POLLS = '1';
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 1, uuid: 'u1', mark: 2000 }]);
    xrayConfig.findClient.mockReturnValue(null);
    spawnSync.mockReturnValue(nftMapResult([2000, 2000]));

    expect(() => poller.poll()).not.toThrow();
    expect(applySpeedTier).not.toHaveBeenCalled();
  });
});

describe('poll — auto-restore', () => {
  function triggerDowngrade() {
    process.env.VLESS_CONNLIMIT_BREACH_POLLS = '1';
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 3, uuid: 'u1', mark: 2000 }]);
    spawnSync.mockReturnValue(nftMapResult([2000, 2000, 2000]));
    poller.poll();
  }

  it('restores the pre-penalty tier once the connection count stays calm for the required streak', () => {
    process.env.VLESS_PEER_CONNLIMIT = '2';
    process.env.VLESS_CONNLIMIT_CALM_POLLS = '2';
    triggerDowngrade();
    expect(applySpeedTier).toHaveBeenCalledWith('u1', 'user-1 | Laptop', 0); // downgraded to penalty tier
    applySpeedTier.mockClear();

    // Simulate the post-downgrade state: config now shows the penalty tier
    // under a new mark, and the connection count has dropped.
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 0, uuid: 'u1', mark: 2501 }]);
    spawnSync.mockReturnValue(nftMapResult([2501]));

    poller.poll(); // calm 1 — not yet
    expect(applySpeedTier).not.toHaveBeenCalled();

    poller.poll(); // calm 2 — restores to the ORIGINAL tier (3), remembered from downgrade
    expect(applySpeedTier).toHaveBeenCalledWith('u1', 'user-1 | Laptop', 3);
  });

  it('resets the calm streak on a renewed spike, delaying restore', () => {
    process.env.VLESS_PEER_CONNLIMIT = '2';
    process.env.VLESS_CONNLIMIT_CALM_POLLS = '2';
    triggerDowngrade();
    applySpeedTier.mockClear();

    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 0, uuid: 'u1', mark: 2501 }]);
    spawnSync.mockReturnValue(nftMapResult([2501]));
    poller.poll(); // calm 1

    spawnSync.mockReturnValue(nftMapResult([2501, 2501, 2501])); // spike resets calm streak
    poller.poll();

    spawnSync.mockReturnValue(nftMapResult([2501]));
    poller.poll(); // calm 1 again, not 2nd consecutive

    expect(applySpeedTier).not.toHaveBeenCalled();
  });
});

describe('poll — state cleanup', () => {
  it('drops debounce state for a uuid no longer present among peer outbounds (e.g. revoked)', () => {
    process.env.VLESS_PEER_CONNLIMIT = '2';
    process.env.VLESS_CONNLIMIT_BREACH_POLLS = '2';
    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 1, uuid: 'u1', mark: 2000 }]);
    spawnSync.mockReturnValue(nftMapResult([2000, 2000, 2000]));
    poller.poll(); // 1 breach poll recorded for u1

    xrayConfig.listPeerOutbounds.mockReturnValue([]); // u1 gone (revoked) next cycle
    poller.poll();

    xrayConfig.listPeerOutbounds.mockReturnValue([{ tier: 1, uuid: 'u1', mark: 2100 }]); // re-added, fresh mark
    poller.poll(); // should count as breach 1, not 2 — proves state was cleared

    expect(applySpeedTier).not.toHaveBeenCalled();
  });
});

describe('start / stop', () => {
  afterEach(() => {
    poller.stop();
    jest.useRealTimers();
  });

  it('starts and clears an interval without throwing', () => {
    jest.useFakeTimers();
    xrayConfig.listPeerOutbounds.mockReturnValue([]);
    spawnSync.mockReturnValue(nftMapResult([]));

    expect(() => poller.start()).not.toThrow();
    expect(() => poller.stop()).not.toThrow();
  });

  it('does not start a second interval if already running', () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    poller.start();
    poller.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
