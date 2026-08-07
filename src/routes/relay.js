'use strict';
const xrayConfig = require('../services/xrayConfig');
const { applyRelayRouting, clearRelayRouting } = require('../services/xrayRelayApply');
const { withLock } = require('../services/lock');

const notAvailable = (reply) => reply.status(503).send({
  success: false,
  error: { code: 'VLESS_NOT_AVAILABLE', message: 'Xray is not installed on this node' }
});

// Triggered by backend-api whenever an active RF relay exists (Фаза 3,
// plans/MULTI_REGION_NODES.md) — on this node's own provisioning/backfill
// and whenever the relay is (re-)provisioned. Not client-facing.
async function relayRoutes(fastify) {
  fastify.post('/relay/apply', async (req, reply) => {
    const { host, port, uuid } = req.body || {};
    if (!host || !port || !uuid) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'host, port and uuid are required' }
      });
    }
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      const result = await withLock(() => applyRelayRouting(host, port, uuid));
      return { success: true, data: result };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'RELAY_ERROR', message: err.message } });
    }
  });

  fastify.post('/relay/remove', async (req, reply) => {
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      const removed = await withLock(() => clearRelayRouting());
      return { success: true, data: removed };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'RELAY_ERROR', message: err.message } });
    }
  });
}

module.exports = relayRoutes;
