'use strict';
const buildApp = require('../../src/app');

describe('GET /health (no auth required)', () => {
  let app;

  beforeAll(async () => {
    process.env.API_TOKEN = 'test-token-abc123';
    app = await buildApp();
    await app.ready();
  });

  afterAll(() => app.close());

  it('returns 200 with ok status without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});

describe('Auth middleware on /api/*', () => {
  let app;

  beforeAll(async () => {
    process.env.API_TOKEN = 'test-token-abc123';
    app = await buildApp();
    await app.ready();
  });

  afterAll(() => app.close());

  it('returns 401 with no Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { Authorization: 'Bearer wrong-token' }
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' }
    });
    expect(res.statusCode).toBe(401);
  });
});
