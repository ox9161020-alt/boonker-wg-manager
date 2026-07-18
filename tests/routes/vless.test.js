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
