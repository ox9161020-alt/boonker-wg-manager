'use strict';
jest.mock('../../src/services/xrayConfig');
jest.mock('../../src/services/xrayRelayApply');

const xrayConfig = require('../../src/services/xrayConfig');
const xrayRelayApply = require('../../src/services/xrayRelayApply');

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
});

const AUTH = { Authorization: 'Bearer test-token' };

describe('POST /api/relay/apply', () => {
  it('requires host, port and uuid', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/relay/apply', headers: AUTH, payload: {} });

    expect(res.statusCode).toBe(400);
    expect(xrayRelayApply.applyRelayRouting).not.toHaveBeenCalled();
  });

  it('applies relay routing and returns the result', async () => {
    xrayRelayApply.applyRelayRouting.mockReturnValue({
      outboundTag: 'relay-out', ruleTag: 'relay-routing', domains: ['domain:youtube.com'],
    });

    const res = await app.inject({
      method: 'POST', url: '/api/relay/apply', headers: AUTH,
      payload: { host: '81.200.158.86', port: 443, uuid: 'relay-uuid' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ outboundTag: 'relay-out', ruleTag: 'relay-routing', domains: ['domain:youtube.com'] });
    expect(xrayRelayApply.applyRelayRouting).toHaveBeenCalledWith('81.200.158.86', 443, 'relay-uuid');
  });

  it('returns 503 when Xray is not installed on this node', async () => {
    xrayConfig.isAvailable.mockReturnValue(false);

    const res = await app.inject({
      method: 'POST', url: '/api/relay/apply', headers: AUTH,
      payload: { host: '81.200.158.86', port: 443, uuid: 'relay-uuid' },
    });

    expect(res.statusCode).toBe(503);
    expect(xrayRelayApply.applyRelayRouting).not.toHaveBeenCalled();
  });

  it('returns 401 without a valid bearer token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/relay/apply',
      payload: { host: '81.200.158.86', port: 443, uuid: 'relay-uuid' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 500 when the orchestration throws', async () => {
    xrayRelayApply.applyRelayRouting.mockImplementation(() => { throw new Error('adrules failed'); });

    const res = await app.inject({
      method: 'POST', url: '/api/relay/apply', headers: AUTH,
      payload: { host: '81.200.158.86', port: 443, uuid: 'relay-uuid' },
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.message).toBe('adrules failed');
  });
});

describe('POST /api/relay/remove', () => {
  it('removes relay routing and returns the removed tags', async () => {
    xrayRelayApply.clearRelayRouting.mockReturnValue({ outboundTag: 'relay-out', ruleTag: 'relay-routing' });

    const res = await app.inject({ method: 'POST', url: '/api/relay/remove', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({ outboundTag: 'relay-out', ruleTag: 'relay-routing' });
  });

  it('returns null data when there was nothing to remove', async () => {
    xrayRelayApply.clearRelayRouting.mockReturnValue(null);

    const res = await app.inject({ method: 'POST', url: '/api/relay/remove', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toBeNull();
  });
});
