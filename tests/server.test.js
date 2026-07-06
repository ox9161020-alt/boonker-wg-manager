'use strict';

jest.mock('../src/services/trafficControl');
jest.mock('../src/app');

const trafficControlService = require('../src/services/trafficControl');
const buildApp = require('../src/app');

describe('server startup', () => {
  let fakeApp;

  beforeEach(() => {
    process.env.API_TOKEN = 'test-token-0123456789abcdef';
    jest.clearAllMocks();
    fakeApp = { listen: jest.fn().mockResolvedValue(undefined), log: { error: jest.fn() } };
    buildApp.mockResolvedValue(fakeApp);
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
});
