'use strict';

async function healthRoutes(fastify) {
  fastify.get('/health', async () => ({ status: 'ok' }));
}

module.exports = healthRoutes;
