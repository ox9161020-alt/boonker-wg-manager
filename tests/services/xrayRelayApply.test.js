'use strict';
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayProcess');

const xrayConfig = require('../../src/services/xrayConfig');
const xrayProcess = require('../../src/services/xrayProcess');
const { applyRelayRouting, clearRelayRouting } = require('../../src/services/xrayRelayApply');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('applyRelayRouting', () => {
  it('adds the outbound then the routing rule on a first-ever apply (no stale rule to clear)', () => {
    xrayConfig.ensureRelayRouting.mockReturnValue({
      outboundTag: 'relay-out', ruleTag: 'relay-routing', domains: ['domain:youtube.com'], wasNew: true, hadRule: false,
    });

    const result = applyRelayRouting('81.200.158.86', 443, 'relay-uuid');

    expect(xrayConfig.ensureRelayRouting).toHaveBeenCalledWith('81.200.158.86', 443, 'relay-uuid');
    expect(xrayProcess.addRelayOutboundToRunning).toHaveBeenCalledWith('relay-out', '81.200.158.86', 443, 'relay-uuid');
    expect(xrayProcess.removeRoutingRuleFromRunning).not.toHaveBeenCalled();
    expect(xrayProcess.addDomainRoutingRuleToRunning).toHaveBeenCalledWith('relay-routing', ['domain:youtube.com'], 'relay-out');
    expect(result).toEqual({ outboundTag: 'relay-out', ruleTag: 'relay-routing', domains: ['domain:youtube.com'] });
  });

  it('clears the stale live rule first when re-applying (adrules -append never replaces)', () => {
    xrayConfig.ensureRelayRouting.mockReturnValue({
      outboundTag: 'relay-out', ruleTag: 'relay-routing', domains: ['domain:youtube.com'], wasNew: false, hadRule: true,
    });

    applyRelayRouting('81.200.158.86', 443, 'relay-uuid-2');

    expect(xrayProcess.removeRoutingRuleFromRunning).toHaveBeenCalledWith('relay-routing');
    expect(xrayProcess.addDomainRoutingRuleToRunning).toHaveBeenCalledWith('relay-routing', ['domain:youtube.com'], 'relay-out');
  });
});

describe('clearRelayRouting', () => {
  it('tears down the routing rule then the outbound when one existed', () => {
    xrayConfig.removeRelayRouting.mockReturnValue({ outboundTag: 'relay-out', ruleTag: 'relay-routing' });

    const result = clearRelayRouting();

    expect(result).toEqual({ outboundTag: 'relay-out', ruleTag: 'relay-routing' });
    expect(xrayProcess.removeRoutingRuleFromRunning).toHaveBeenCalledWith('relay-routing');
    expect(xrayProcess.removeOutboundFromRunning).toHaveBeenCalledWith('relay-out');
  });

  it('is a harmless no-op when no relay routing existed', () => {
    xrayConfig.removeRelayRouting.mockReturnValue(null);

    const result = clearRelayRouting();

    expect(result).toBeNull();
    expect(xrayProcess.removeRoutingRuleFromRunning).not.toHaveBeenCalled();
    expect(xrayProcess.removeOutboundFromRunning).not.toHaveBeenCalled();
  });
});
