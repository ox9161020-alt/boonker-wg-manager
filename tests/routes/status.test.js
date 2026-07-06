'use strict';
jest.mock('../../src/services/wireguard');
jest.mock('../../src/services/config');

const wireguardService = require('../../src/services/wireguard');
const configService = require('../../src/services/config');

let app;

beforeAll(async () => {
  process.env.API_TOKEN = 'test-token';
  process.env.NODE_ENV = 'test';
  app = await require('../../src/app')();
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  jest.clearAllMocks();
});

const AUTH = { Authorization: 'Bearer test-token' };

describe('GET /api/status', () => {
  it('returns raw wg show output', async () => {
    wireguardService.getStatus.mockReturnValue('interface: wg0\npublic key: abc\n');

    const res = await app.inject({ method: 'GET', url: '/api/status', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      data: { raw: 'interface: wg0\npublic key: abc\n' }
    });
  });

  it('returns 500 when wg command fails', async () => {
    wireguardService.getStatus.mockImplementation(() => { throw new Error('wg not found'); });

    const res = await app.inject({ method: 'GET', url: '/api/status', headers: AUTH });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('WG_ERROR');
  });
});

describe('GET /api/peers', () => {
  it('returns list of peers from config', async () => {
    configService.readConfig.mockReturnValue('mock-config');
    configService.parsePeers.mockReturnValue([
      { publicKey: 'abc', allowedIp: '10.0.0.2/32', userId: 'u1', deviceName: 'Laptop' }
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/peers', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.peers).toHaveLength(1);
    expect(body.data.peers[0].publicKey).toBe('abc');
  });

  it('returns 500 when config read fails', async () => {
    configService.readConfig.mockImplementation(() => { throw new Error('file not found'); });

    const res = await app.inject({ method: 'GET', url: '/api/peers', headers: AUTH });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('CONFIG_ERROR');
  });
});

describe('GET /api/peers/traffic', () => {
  it('joins per-peer transfer bytes (from awg dump) with userId/deviceName (from config)', async () => {
    wireguardService.getDump.mockReturnValue('raw-dump');
    wireguardService.parsePeerDump.mockReturnValue([
      { publicKey: 'abc', allowedIp: '10.0.0.2/32', rx_bytes: 123, tx_bytes: 456 }
    ]);
    configService.readConfig.mockReturnValue('mock-config');
    configService.parsePeers.mockReturnValue([
      { publicKey: 'abc', allowedIp: '10.0.0.2/32', userId: 'u1', deviceName: 'Laptop' }
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/peers/traffic', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      data: {
        peers: [
          { publicKey: 'abc', allowedIp: '10.0.0.2/32', rx_bytes: 123, tx_bytes: 456, userId: 'u1', deviceName: 'Laptop' }
        ]
      }
    });
  });

  it('returns an empty peers array (not 500) when the wg command fails, matching /api/traffic\'s tolerant convention', async () => {
    wireguardService.getDump.mockImplementation(() => { throw new Error('awg not found'); });

    const res = await app.inject({ method: 'GET', url: '/api/peers/traffic', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, data: { peers: [] } });
  });
});
