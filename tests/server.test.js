'use strict';

jest.mock('../src/services/trafficControl');
jest.mock('../src/services/xrayConfig');
jest.mock('../src/services/xrayShaping');
jest.mock('../src/services/xrayAccessLog');
jest.mock('../src/app');

const trafficControlService = require('../src/services/trafficControl');
const xrayConfig = require('../src/services/xrayConfig');
const xrayShaping = require('../src/services/xrayShaping');
const xrayAccessLog = require('../src/services/xrayAccessLog');
const buildApp = require('../src/app');

describe('server startup', () => {
  let fakeApp;

  beforeEach(() => {
    process.env.API_TOKEN = 'test-token-0123456789abcdef';
    jest.clearAllMocks();
    fakeApp = { listen: jest.fn().mockResolvedValue(undefined), log: { error: jest.fn() } };
    buildApp.mockResolvedValue(fakeApp);
    xrayConfig.isAvailable.mockReturnValue(false);
  });

  it('applies the traffic-control bootstrap before the app starts listening', async () => {
    const { start } = require('../server');
    await start();

    expect(trafficControlService.ensureTrafficControlBase).toHaveBeenCalled();
    expect(fakeApp.listen).toHaveBeenCalled();
  });

  it('still starts listening even if the traffic-control bootstrap throws (VPN must not depend on QoS setup)', async () => {
    trafficControlService.ensureTrafficControlBase.mockImplementation(() => {
      throw new Error('tc not installed');
    });
    const { start } = require('../server');

    await expect(start()).resolves.not.toThrow();
    expect(fakeApp.listen).toHaveBeenCalled();
  });

  it('bootstraps VLESS shaping and starts the access-log tailer when Xray is available on this node', async () => {
    xrayConfig.isAvailable.mockReturnValue(true);
    const { start } = require('../server');
    await start();

    expect(xrayShaping.ensureVlessShapingBase).toHaveBeenCalled();
    expect(xrayAccessLog.start).toHaveBeenCalled();
  });

  it('skips VLESS shaping bootstrap entirely on an AWG-only node', async () => {
    xrayConfig.isAvailable.mockReturnValue(false);
    const { start } = require('../server');
    await start();

    expect(xrayShaping.ensureVlessShapingBase).not.toHaveBeenCalled();
    expect(xrayAccessLog.start).not.toHaveBeenCalled();
  });

  it('still starts listening even if the VLESS shaping bootstrap throws', async () => {
    xrayConfig.isAvailable.mockReturnValue(true);
    xrayShaping.ensureVlessShapingBase.mockImplementation(() => {
      throw new Error('tc not installed');
    });
    const { start } = require('../server');

    await expect(start()).resolves.not.toThrow();
    expect(fakeApp.listen).toHaveBeenCalled();
  });
});
