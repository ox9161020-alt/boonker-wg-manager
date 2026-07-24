'use strict';
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayProcess');

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
  xrayConfig.isAvailable.mockReturnValue(true);
  xrayConfig.buildEmail.mockImplementation((userId, deviceName) => `${userId} | ${deviceName}`);
  xrayConfig.buildVlessUri.mockReturnValue('vless://mock-uri');
  xrayConfig.getRealityPublicParams.mockReturnValue({
    publicKey: 'pub-key', sni: 'www.samsung.com', shortId: 'abc123', port: '443'
  });
  xrayConfig.addClient.mockReturnValue(undefined);
  xrayConfig.removeClient.mockReturnValue(undefined);
  xrayConfig.removeUserSpeedTier.mockReturnValue(null);
  xrayProcess.addClientToRunning.mockReturnValue(undefined);
  xrayProcess.removeClientFromRunning.mockReturnValue(undefined);
});

const AUTH = { Authorization: 'Bearer test-token' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /api/vless/user/create', () => {
  it('creates a VLESS user and returns the URI + Reality params', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/vless/user/create',
      headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.uuid).toMatch(UUID_RE);
    expect(body.data.vlessUri).toBe('vless://mock-uri');
    expect(body.data.reality).toEqual({ publicKey: 'pub-key', sni: 'www.samsung.com', shortId: 'abc123', port: '443' });

    expect(xrayConfig.addClient).toHaveBeenCalledWith(body.data.uuid, 'user-123', 'My Laptop');
    expect(xrayProcess.addClientToRunning).toHaveBeenCalledWith(body.data.uuid, 'user-123 | My Laptop');
  });

  it('returns 400 when userId or deviceName is missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/vless/user/create', headers: AUTH, payload: { userId: 'user-123' }
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('returns 503 when Xray is not installed on this node', async () => {
    xrayConfig.isAvailable.mockReturnValue(false);

    const res = await app.inject({
      method: 'POST', url: '/api/vless/user/create', headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('VLESS_NOT_AVAILABLE');
    expect(xrayConfig.addClient).not.toHaveBeenCalled();
  });

  it('returns 500 when the hot-apply step fails', async () => {
    xrayProcess.addClientToRunning.mockImplementation(() => { throw new Error('xray api unreachable'); });

    const res = await app.inject({
      method: 'POST', url: '/api/vless/user/create', headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('VLESS_ERROR');
  });

  it('applies a speed tier when speedTier is provided', async () => {
    xrayConfig.setUserSpeedTier.mockReturnValue({ ruleTag: 'user-mock-uuid', outboundTag: 'tier-103', mark: 103 });

    const res = await app.inject({
      method: 'POST', url: '/api/vless/user/create', headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop', speedTier: 3 }
    });

    const body = JSON.parse(res.body);
    expect(body.data.speedTier).toBe(3);
    expect(xrayConfig.setUserSpeedTier).toHaveBeenCalledWith(body.data.uuid, 'user-123 | My Laptop', 3);
    expect(xrayProcess.addRoutingRuleToRunning).toHaveBeenCalledWith('user-mock-uuid', 'user-123 | My Laptop', 'tier-103');
  });

  it('does not touch speed-tier routing when speedTier is omitted', async () => {
    await app.inject({
      method: 'POST', url: '/api/vless/user/create', headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(xrayConfig.setUserSpeedTier).not.toHaveBeenCalled();
    expect(xrayProcess.addRoutingRuleToRunning).not.toHaveBeenCalled();
  });
});

describe('POST /api/vless/user/restore', () => {
  it('adds the client back and reports restored:true when the uuid is missing', async () => {
    xrayConfig.findClient.mockReturnValue(null);

    const res = await app.inject({
      method: 'POST', url: '/api/vless/user/restore', headers: AUTH,
      payload: { uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toEqual({
      uuid: 'uuid-aaa', restored: true,
      reality: { publicKey: 'pub-key', sni: 'www.samsung.com', shortId: 'abc123', port: '443' }
    });
    expect(xrayConfig.addClient).toHaveBeenCalledWith('uuid-aaa', 'user-123', 'My Laptop');
    expect(xrayProcess.addClientToRunning).toHaveBeenCalled();
  });

  it('is idempotent: reports restored:false and does nothing when the uuid already exists', async () => {
    xrayConfig.findClient.mockReturnValue({ uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'My Laptop' });

    const res = await app.inject({
      method: 'POST', url: '/api/vless/user/restore', headers: AUTH,
      payload: { uuid: 'uuid-aaa' }
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.restored).toBe(false);
    expect(xrayConfig.addClient).not.toHaveBeenCalled();
    expect(xrayProcess.addClientToRunning).not.toHaveBeenCalled();
  });

  it('returns 400 when uuid is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/vless/user/restore', headers: AUTH, payload: {} });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('applies a speed tier even when the client already existed — this IS the tier-change path, no fresh UUID needed', async () => {
    xrayConfig.findClient.mockReturnValue({ uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'My Laptop' });
    xrayConfig.setUserSpeedTier.mockReturnValue({ ruleTag: 'user-uuid-aaa', outboundTag: 'tier-105', mark: 105 });

    const res = await app.inject({
      method: 'POST', url: '/api/vless/user/restore', headers: AUTH,
      payload: { uuid: 'uuid-aaa', speedTier: 5 }
    });

    const body = JSON.parse(res.body);
    expect(body.data.restored).toBe(false);
    expect(body.data.speedTier).toBe(5);
    expect(xrayConfig.addClient).not.toHaveBeenCalled();
    expect(xrayConfig.setUserSpeedTier).toHaveBeenCalledWith('uuid-aaa', 'user-123 | My Laptop', 5);
    expect(xrayProcess.addRoutingRuleToRunning).toHaveBeenCalledWith('user-uuid-aaa', 'user-123 | My Laptop', 'tier-105');
  });
});

describe('DELETE /api/vless/user/:uuid/revoke', () => {
  it('removes the client from config and the running process', async () => {
    xrayConfig.findClient.mockReturnValue({ uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'My Laptop' });

    const res = await app.inject({ method: 'DELETE', url: '/api/vless/user/uuid-aaa/revoke', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, data: {} });
    expect(xrayConfig.removeClient).toHaveBeenCalledWith('uuid-aaa');
    expect(xrayProcess.removeClientFromRunning).toHaveBeenCalledWith('user-123 | My Laptop');
  });

  it('returns 404 when the uuid is not found', async () => {
    xrayConfig.findClient.mockReturnValue(null);

    const res = await app.inject({ method: 'DELETE', url: '/api/vless/user/missing-uuid/revoke', headers: AUTH });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('VLESS_USER_NOT_FOUND');
    expect(xrayConfig.removeClient).not.toHaveBeenCalled();
  });

  it('returns 503 when Xray is not installed on this node', async () => {
    xrayConfig.isAvailable.mockReturnValue(false);

    const res = await app.inject({ method: 'DELETE', url: '/api/vless/user/uuid-aaa/revoke', headers: AUTH });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('VLESS_NOT_AVAILABLE');
  });

  it('also removes the speed-tier routing rule when one exists', async () => {
    xrayConfig.findClient.mockReturnValue({ uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'My Laptop' });
    xrayConfig.removeUserSpeedTier.mockReturnValue('user-uuid-aaa');

    await app.inject({ method: 'DELETE', url: '/api/vless/user/uuid-aaa/revoke', headers: AUTH });

    expect(xrayConfig.removeUserSpeedTier).toHaveBeenCalledWith('uuid-aaa');
    expect(xrayProcess.removeRoutingRuleFromRunning).toHaveBeenCalledWith('user-uuid-aaa');
  });

  it('skips the hot-remove when the user never had a tier rule', async () => {
    xrayConfig.findClient.mockReturnValue({ uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'My Laptop' });
    xrayConfig.removeUserSpeedTier.mockReturnValue(null);

    await app.inject({ method: 'DELETE', url: '/api/vless/user/uuid-aaa/revoke', headers: AUTH });

    expect(xrayProcess.removeRoutingRuleFromRunning).not.toHaveBeenCalled();
  });
});

describe('GET /api/vless/users', () => {
  it('returns the list of VLESS users', async () => {
    xrayConfig.listClients.mockReturnValue([{ uuid: 'uuid-aaa', userId: 'user-123', deviceName: 'My Laptop' }]);

    const res = await app.inject({ method: 'GET', url: '/api/vless/users', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.users).toHaveLength(1);
  });

  it('returns 503 when Xray is not installed on this node', async () => {
    xrayConfig.isAvailable.mockReturnValue(false);

    const res = await app.inject({ method: 'GET', url: '/api/vless/users', headers: AUTH });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('VLESS_NOT_AVAILABLE');
  });
});
