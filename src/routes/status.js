'use strict';
const wireguardService = require('../services/wireguard');
const configService = require('../services/config');

async function statusRoutes(fastify) {
  fastify.get('/status', async (req, reply) => {
    try {
      const raw = wireguardService.getStatus();
      return { success: true, data: { raw } };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'WG_ERROR', message: err.message }
      });
    }
  });

  fastify.get('/traffic', async (req, reply) => {
    try {
      const raw = wireguardService.getStatus();
      const { rx_bytes, tx_bytes } = wireguardService.parseTrafficBytes(raw);
      return { success: true, data: { rx_bytes, tx_bytes } };
    } catch (err) {
      // Interface may have no peers yet — return zeros instead of error
      return { success: true, data: { rx_bytes: 0, tx_bytes: 0 } };
    }
  });

  fastify.get('/peers', async (req, reply) => {
    try {
      const peers = configService.parsePeers(configService.readConfig());
      return { success: true, data: { peers } };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'CONFIG_ERROR', message: err.message }
      });
    }
  });
}

module.exports = statusRoutes;
