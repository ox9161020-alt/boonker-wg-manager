'use strict';
const Fastify = require('fastify');
const authHook = require('./middleware/auth');
const healthRoutes = require('./routes/health');
const peerRoutes = require('./routes/peer');
const statusRoutes = require('./routes/status');

async function buildApp() {
  const fastify = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  fastify.register(healthRoutes);

  fastify.register(async (api) => {
    api.addHook('onRequest', authHook);
    api.register(peerRoutes);
    api.register(statusRoutes);
  }, { prefix: '/api' });

  return fastify;
}

module.exports = buildApp;
