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

  fastify.get('/peers/traffic', async (req, reply) => {
    try {
      const dumpPeers = wireguardService.parsePeerDump(wireguardService.getDump());
      const configByKey = new Map(
        configService.parsePeers(configService.readConfig()).map((p) => [p.publicKey, p])
      );
      const peers = dumpPeers.map((p) => ({
        publicKey: p.publicKey,
        allowedIp: p.allowedIp || configByKey.get(p.publicKey)?.allowedIp || null,
        rx_bytes: p.rx_bytes,
        tx_bytes: p.tx_bytes,
        userId: configByKey.get(p.publicKey)?.userId ?? null,
        deviceName: configByKey.get(p.publicKey)?.deviceName ?? null,
      }));
      return { success: true, data: { peers } };
    } catch (err) {
      // Interface may have no peers yet, or command may fail transiently — same
      // tolerant-empty convention as GET /traffic (this is polled hourly, a 500
      // would just get retried next hour anyway).
      return { success: true, data: { peers: [] } };
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
