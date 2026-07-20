'use strict';
const wireguardService = require('../services/wireguard');
const configService = require('../services/config');
const xrayConfig = require('../services/xrayConfig');
const xrayProcess = require('../services/xrayProcess');

function getVlessStatus() {
  if (!xrayConfig.isAvailable()) return { available: false };
  try {
    return { available: true, ...xrayConfig.getRealityPublicParams(), userCount: xrayConfig.listClients().length };
  } catch (err) {
    return { available: false };
  }
}

async function statusRoutes(fastify) {
  fastify.get('/status', async (req, reply) => {
    try {
      const raw = wireguardService.getStatus();
      return { success: true, data: { raw, vless: getVlessStatus() } };
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

  // VLESS clients have no WireGuard peer at all — this is the Xray equivalent
  // of /peers/traffic above, shaped identically ({publicKey, rx_bytes,
  // tx_bytes}) so backend-api's trafficPoller can treat both protocols'
  // peers the same way. `publicKey` here is the client UUID (Xray's stats
  // are keyed by `email`, not uuid, so the two are joined via
  // xrayConfig.listClients() — same email format both sides build with
  // xrayConfig.buildEmail()).
  fastify.get('/vless/traffic', async (req, reply) => {
    if (!xrayConfig.isAvailable()) return { success: true, data: { peers: [] } };
    try {
      const uuidByEmail = new Map(
        xrayConfig.listClients().map((c) => [xrayConfig.buildEmail(c.userId, c.deviceName), c.uuid])
      );
      const peers = xrayProcess.getClientTraffic()
        .map((s) => ({ publicKey: uuidByEmail.get(s.email), rx_bytes: s.rx_bytes, tx_bytes: s.tx_bytes }))
        .filter((p) => p.publicKey);
      return { success: true, data: { peers } };
    } catch (err) {
      // Xray may be mid-restart, or have zero clients yet — same tolerant-empty
      // convention as /peers/traffic above (polled hourly; a 500 just retries
      // next hour).
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
