'use strict';
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayProcess');
jest.mock('../../src/services/xrayShaping');

const xrayConfig = require('../../src/services/xrayConfig');
const xrayProcess = require('../../src/services/xrayProcess');
const xrayShaping = require('../../src/services/xrayShaping');
const { applySpeedTier } = require('../../src/services/xraySpeedTierApply');

beforeEach(() => {
  jest.clearAllMocks();
});

it('is a no-op when speedTier is absent', () => {
  const result = applySpeedTier('u1', 'user | Device', null);

  expect(result).toBeNull();
  expect(xrayConfig.setUserSpeedTier).not.toHaveBeenCalled();
});

it('adds the outbound to the running process only on a first-ever assignment (created:true)', () => {
  xrayConfig.setUserSpeedTier.mockReturnValue({
    ruleTag: 'user-u1', outboundTag: 'peer-t1-u1', mark: 2000,
    created: true, hadPreviousRule: false, oldMark: null, oldTag: null,
  });

  applySpeedTier('u1', 'user | Device', 1);

  expect(xrayProcess.addOutboundToRunning).toHaveBeenCalledWith('peer-t1-u1', 2000);
  expect(xrayProcess.removeRoutingRuleFromRunning).not.toHaveBeenCalled();
  expect(xrayProcess.addRoutingRuleToRunning).toHaveBeenCalledWith('user-u1', 'user | Device', 'peer-t1-u1');
  expect(xrayShaping.addPeerFilter).toHaveBeenCalledWith(2000, 1);
});

it('removes the stale live routing rule first when one already existed (adrules -append never replaces)', () => {
  xrayConfig.setUserSpeedTier.mockReturnValue({
    ruleTag: 'user-u1', outboundTag: 'peer-t1-u1', mark: 2000,
    created: false, hadPreviousRule: true, oldMark: null, oldTag: null,
  });

  applySpeedTier('u1', 'user | Device', 1);

  expect(xrayProcess.removeRoutingRuleFromRunning).toHaveBeenCalledWith('user-u1');
  expect(xrayProcess.addRoutingRuleToRunning).toHaveBeenCalledWith('user-u1', 'user | Device', 'peer-t1-u1');
});

describe('tier change cleanup — regression (ROADMAP_AWG-VLESS.md Этап 2 live E2E)', () => {
  it('does NOT remove the just-added filter when the freed old mark is reused for the new outbound', () => {
    // allocateMark() hands out the lowest free mark — freeing the old
    // outbound before allocating the new one means a solo user (no other
    // personal outbound occupying a lower mark) gets the SAME mark back.
    xrayConfig.setUserSpeedTier.mockReturnValue({
      ruleTag: 'user-u1', outboundTag: 'peer-t0-u1', mark: 2000,
      created: true, hadPreviousRule: true, oldMark: 2000, oldTag: 'peer-t1-u1',
    });

    applySpeedTier('u1', 'user | Device', 0);

    expect(xrayShaping.addPeerFilter).toHaveBeenCalledWith(2000, 0);
    // The old outbound (different TAG) still gets cleaned out of Xray's
    // running process...
    expect(xrayProcess.removeOutboundFromRunning).toHaveBeenCalledWith('peer-t1-u1');
    // ...but the tc filter for mark 2000 must survive — it's the SAME mark
    // the line above just (re-)applied for the new tier.
    expect(xrayShaping.removePeerFilter).not.toHaveBeenCalled();
  });

  it('does remove the old filter when the new mark genuinely differs from the old one', () => {
    xrayConfig.setUserSpeedTier.mockReturnValue({
      ruleTag: 'user-u1', outboundTag: 'peer-t5-u1', mark: 2001,
      created: true, hadPreviousRule: true, oldMark: 2000, oldTag: 'peer-t1-u1',
    });

    applySpeedTier('u1', 'user | Device', 5);

    expect(xrayShaping.addPeerFilter).toHaveBeenCalledWith(2001, 5);
    expect(xrayProcess.removeOutboundFromRunning).toHaveBeenCalledWith('peer-t1-u1');
    expect(xrayShaping.removePeerFilter).toHaveBeenCalledWith(2000);
  });

  it('skips all old-mark/old-tag cleanup on a first-ever assignment (nothing to clean)', () => {
    xrayConfig.setUserSpeedTier.mockReturnValue({
      ruleTag: 'user-u1', outboundTag: 'peer-t1-u1', mark: 2000,
      created: true, hadPreviousRule: false, oldMark: null, oldTag: null,
    });

    applySpeedTier('u1', 'user | Device', 1);

    expect(xrayProcess.removeOutboundFromRunning).not.toHaveBeenCalled();
    expect(xrayShaping.removePeerFilter).not.toHaveBeenCalled();
  });
});
