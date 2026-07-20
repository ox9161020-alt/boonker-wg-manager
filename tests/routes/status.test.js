'use strict';
jest.mock('../../src/services/wireguard');
jest.mock('../../src/services/config');
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayProcess');

const wireguardService = require('../../src/services/wireguard');
const configService = require('../../src/services/config');
const xrayConfig = require('../../src/services/xrayConfig');
const xrayProcess = require('../../src/services/xrayProcess');

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
  xrayConfig.isAvailable.mockReturnValue(false);
});

const AUTH = { Authorization: 'Bearer test-token' };

describe('GET /api/status', () => {
  it('returns raw wg show output plus vless availability', async () => {
    wireguardService.getStatus.mockReturnValue('interface: wg0\npublic key: abc\n');

    const res = await app.inject({ method: 'GET', url: '/api/status', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      data: { raw: 'interface: wg0\npublic key: abc\n', vless: { available: false } }
    });
  });

  it('includes Reality public params and user count when Xray is installed', async () => {
    wireguardService.getStatus.mockReturnValue('interface: wg0\n');
    xrayConfig.isAvailable.mockReturnValue(true);
    xrayConfig.getRealityPublicParams.mockReturnValue({
      publicKey: 'pub-key', sni: 'www.samsung.com', shortId: 'abc123', port: '443'
    });
    xrayConfig.listClients.mockReturnValue([{ uuid: 'u1' }, { uuid: 'u2' }]);

    const res = await app.inject({ method: 'GET', url: '/api/status', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.vless).toEqual({
      available: true, publicKey: 'pub-key', sni: 'www.samsung.com', shortId: 'abc123', port: '443', userCount: 2
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

describe('GET /api/vless/traffic', () => {
  it('joins per-client stats (keyed by email) with the client list (keyed by uuid), returning publicKey=uuid like AWG peers', async () => {
    xrayConfig.isAvailable.mockReturnValue(true);
    xrayConfig.buildEmail.mockImplementation((userId, deviceName) => `${userId} | ${deviceName}`);
    xrayConfig.listClients.mockReturnValue([
      { uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'iPhone' },
    ]);
    xrayProcess.getClientTraffic.mockReturnValue([
      { email: 'user-123 | iPhone', rx_bytes: 300, tx_bytes: 700 },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/vless/traffic', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      data: { peers: [{ publicKey: 'uuid-aaa', rx_bytes: 300, tx_bytes: 700 }] },
    });
  });

  it('drops a stats entry whose email has no matching client (e.g. a just-revoked user)', async () => {
    xrayConfig.isAvailable.mockReturnValue(true);
    xrayConfig.buildEmail.mockImplementation((userId, deviceName) => `${userId} | ${deviceName}`);
    xrayConfig.listClients.mockReturnValue([]);
    xrayProcess.getClientTraffic.mockReturnValue([
      { email: 'ghost-user | Old Phone', rx_bytes: 300, tx_bytes: 700 },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/vless/traffic', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, data: { peers: [] } });
  });

  it('returns an empty peers array when Xray is not installed on this node', async () => {
    xrayConfig.isAvailable.mockReturnValue(false);

    const res = await app.inject({ method: 'GET', url: '/api/vless/traffic', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, data: { peers: [] } });
    expect(xrayProcess.getClientTraffic).not.toHaveBeenCalled();
  });

  it('returns an empty peers array (not 500) when the xray CLI call fails, matching /api/peers/traffic\'s tolerant convention', async () => {
    xrayConfig.isAvailable.mockReturnValue(true);
    xrayProcess.getClientTraffic.mockImplementation(() => { throw new Error('xray api unreachable'); });

    const res = await app.inject({ method: 'GET', url: '/api/vless/traffic', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, data: { peers: [] } });
  });
});
