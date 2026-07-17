'use strict';
jest.mock('../../src/services/config');
jest.mock('../../src/services/wireguard');
jest.mock('../../src/services/keygen');
jest.mock('../../src/services/trafficControl');

const configService = require('../../src/services/config');
const wireguardService = require('../../src/services/wireguard');
const keygenService = require('../../src/services/keygen');
const trafficControlService = require('../../src/services/trafficControl');

let app;

beforeAll(async () => {
  process.env.API_TOKEN = 'test-token';
  process.env.SERVER_PUBLIC_IP = '1.2.3.4';
  process.env.SERVER_PORT = '443';
  process.env.DNS_SERVER = '10.0.0.1';
  process.env.AWG_LOCAL_PORT = '51820';
  process.env.AWG_JC = '4';
  process.env.AWG_JMIN = '40';
  process.env.AWG_JMAX = '70';
  process.env.AWG_S1 = '30';
  process.env.AWG_S2 = '30';
  process.env.AWG_H1 = '11111111';
  process.env.AWG_H2 = '22222222';
  process.env.AWG_H3 = '33333333';
  process.env.AWG_H4 = '44444444';
  process.env.NODE_ENV = 'test';
  app = await require('../../src/app')();
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  jest.clearAllMocks();
  configService.readConfig.mockReturnValue('mock');
  configService.parsePeers.mockReturnValue([]);
  configService.allocateIp.mockReturnValue('10.0.0.2/32');
  configService.getServerPublicKey.mockReturnValue('server-pub-key');
  configService.addPeer.mockReturnValue(undefined);
  configService.removePeer.mockReturnValue(undefined);
  wireguardService.addPeerToRunning.mockReturnValue(undefined);
  wireguardService.removePeerFromRunning.mockReturnValue(undefined);
  keygenService.generateKeyPair.mockReturnValue({
    privateKey: 'client-priv-key',
    publicKey: 'client-pub-key'
  });
});

const AUTH = { Authorization: 'Bearer test-token' };

describe('POST /api/peer/create', () => {
  it('creates a peer and returns keys + AWG client config', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/create',
      headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.publicKey).toBe('client-pub-key');
    expect(body.data.privateKey).toBe('client-priv-key');
    expect(body.data.allowedIp).toBe('10.0.0.2/32');
    expect(body.data.config).toContain('[Interface]');
    expect(body.data.config).toContain('PrivateKey = client-priv-key');
    expect(body.data.config).toContain('PublicKey = server-pub-key');
    expect(body.data.config).toContain('Endpoint = 1.2.3.4:51820');
    expect(body.data.config).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(body.data.config).toContain('Jc = 4');
    expect(body.data.config).toContain('Jmin = 40');
    expect(body.data.config).toContain('Jmax = 70');
    expect(body.data.config).toContain('S1 = 30');
    expect(body.data.config).toContain('S2 = 30');
    expect(body.data.config).toContain('H1 = 11111111');
    expect(body.data.config).toContain('H4 = 44444444');
    expect(body.data.wstunnelServer).toBe('wss://1.2.3.4:443');
  });

  it('falls back to the 127.0.0.1/wstunnel endpoint when AWG_DIRECT_ENDPOINT=0', async () => {
    process.env.AWG_DIRECT_ENDPOINT = '0';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/peer/create',
        headers: AUTH,
        payload: { userId: 'user-123', deviceName: 'My Laptop' }
      });
      const body = JSON.parse(res.body);
      expect(body.data.config).toContain('Endpoint = 127.0.0.1:51820');
    } finally {
      delete process.env.AWG_DIRECT_ENDPOINT;
    }
  });

  it('calls addPeer and addPeerToRunning with correct args', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/peer/create',
      headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(configService.addPeer).toHaveBeenCalledWith('client-pub-key', '10.0.0.2/32', 'user-123', 'My Laptop');
    expect(wireguardService.addPeerToRunning).toHaveBeenCalledWith('client-pub-key', '10.0.0.2/32');
  });

  it('applies the speed limit for the newly allocated peer IP', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/peer/create',
      headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'My Laptop' }
    });

    expect(trafficControlService.addPeerLimit).toHaveBeenCalledWith('10.0.0.2/32');
  });

  it('returns 400 when userId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/create',
      headers: AUTH,
      payload: { deviceName: 'Laptop' }
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('returns 400 when deviceName is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/create',
      headers: AUTH,
      payload: { userId: 'user-123' }
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/create',
      payload: { userId: 'user-123', deviceName: 'Laptop' }
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 when key generation fails', async () => {
    keygenService.generateKeyPair.mockImplementation(() => { throw new Error('awg not installed'); });

    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/create',
      headers: AUTH,
      payload: { userId: 'user-123', deviceName: 'Laptop' }
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('WG_ERROR');
  });
});

describe('DELETE /api/peer/:pubkey/revoke', () => {
  it('removes peer from config and running AmneziaWG', async () => {
    const pubkey = encodeURIComponent('some+public/key==');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/peer/${pubkey}/revoke`,
      headers: AUTH
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(configService.removePeer).toHaveBeenCalledWith('some+public/key==');
    expect(wireguardService.removePeerFromRunning).toHaveBeenCalledWith('some+public/key==');
  });

  it('returns 404 when peer not found', async () => {
    configService.removePeer.mockImplementation(() => { throw new Error('Peer not found'); });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/peer/unknown-key/revoke',
      headers: AUTH
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('PEER_NOT_FOUND');
  });

  it('returns 500 on unexpected wireguard error', async () => {
    configService.removePeer.mockReturnValue(undefined);
    wireguardService.removePeerFromRunning.mockImplementation(() => { throw new Error('device busy'); });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/peer/some-key/revoke',
      headers: AUTH
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('WG_ERROR');
  });

  it("removes the speed limit for the peer's allocated IP", async () => {
    configService.parsePeers.mockReturnValue([
      { publicKey: 'known-key', allowedIp: '10.0.0.9/32', userId: 'u1', deviceName: 'Laptop' }
    ]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/peer/${encodeURIComponent('known-key')}/revoke`,
      headers: AUTH
    });

    expect(res.statusCode).toBe(200);
    expect(trafficControlService.removePeerLimit).toHaveBeenCalledWith('10.0.0.9/32');
  });
});

describe('GET /api/peer/:pubkey/config', () => {
  it('returns peer info when found', async () => {
    configService.parsePeers.mockReturnValue([
      { publicKey: 'known-key', allowedIp: '10.0.0.2/32', userId: 'u1', deviceName: 'Laptop' }
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/peer/${encodeURIComponent('known-key')}/config`,
      headers: AUTH
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.publicKey).toBe('known-key');
    expect(body.data.allowedIp).toBe('10.0.0.2/32');
    expect(body.data.userId).toBe('u1');
    expect(body.data.deviceName).toBe('Laptop');
  });

  it('returns 404 when peer not found', async () => {
    configService.parsePeers.mockReturnValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/peer/ghost-key/config',
      headers: AUTH
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('PEER_NOT_FOUND');
  });

  it('returns 500 when config read fails', async () => {
    configService.readConfig.mockImplementation(() => { throw new Error('permission denied'); });

    const res = await app.inject({
      method: 'GET',
      url: '/api/peer/some-key/config',
      headers: AUTH
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('CONFIG_ERROR');
  });
});

describe('POST /api/peer/restore', () => {
  it('re-adds a peer with existing key and ip', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/restore',
      headers: AUTH,
      payload: { publicKey: 'client-pub-key', allowedIp: '10.0.0.5/32', userId: 'u1', deviceName: 'Laptop' }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.restored).toBe(true);
    expect(body.data.serverPublicKey).toBe('server-pub-key');
    expect(configService.addPeer).toHaveBeenCalledWith('client-pub-key', '10.0.0.5/32', 'u1', 'Laptop');
    expect(wireguardService.addPeerToRunning).toHaveBeenCalledWith('client-pub-key', '10.0.0.5/32');
    expect(trafficControlService.addPeerLimit).toHaveBeenCalledWith('10.0.0.5/32');
  });

  it('is idempotent when the peer already exists', async () => {
    configService.parsePeers.mockReturnValue([{ publicKey: 'client-pub-key', allowedIp: '10.0.0.7/32' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/restore',
      headers: AUTH,
      payload: { publicKey: 'client-pub-key', allowedIp: '10.0.0.5/32' }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.restored).toBe(false);
    // Must echo the peer's actual IP from the config, not the caller-supplied one
    expect(body.data.allowedIp).toBe('10.0.0.7/32');
    expect(body.data.serverPublicKey).toBe('server-pub-key');
    expect(configService.addPeer).not.toHaveBeenCalled();
  });

  it('defaults userId and deviceName to empty strings when omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/restore',
      headers: AUTH,
      payload: { publicKey: 'client-pub-key', allowedIp: '10.0.0.9/32' }
    });
    expect(res.statusCode).toBe(200);
    expect(configService.addPeer).toHaveBeenCalledWith('client-pub-key', '10.0.0.9/32', '', '');
  });

  it('rejects when the ip is taken by another peer', async () => {
    configService.parsePeers.mockReturnValue([{ publicKey: 'other-key', allowedIp: '10.0.0.5/32' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/peer/restore',
      headers: AUTH,
      payload: { publicKey: 'client-pub-key', allowedIp: '10.0.0.5/32' }
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('IP_IN_USE');
  });

  it('rejects missing params', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/peer/restore', headers: AUTH, payload: { publicKey: 'x' }
    });
    expect(res.statusCode).toBe(400);
  });
});
