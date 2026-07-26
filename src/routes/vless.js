'use strict';
const crypto = require('crypto');
const xrayConfig = require('../services/xrayConfig');
const xrayProcess = require('../services/xrayProcess');
const { applySpeedTier, clearSpeedTier } = require('../services/xraySpeedTierApply');
const xrayDeviceLimitPoller = require('../services/xrayDeviceLimitPoller');
const { withLock } = require('../services/lock');

const notAvailable = (reply) => reply.status(503).send({
  success: false,
  error: { code: 'VLESS_NOT_AVAILABLE', message: 'Xray is not installed on this node' }
});

async function vlessRoutes(fastify) {
  fastify.post('/vless/user/create', async (req, reply) => {
    const { userId, deviceName, speedTier, maxDevices } = req.body || {};
    if (!userId || !deviceName) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'userId and deviceName are required' }
      });
    }
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      const { uuid, tier } = await withLock(() => {
        const id = crypto.randomUUID();
        const email = xrayConfig.buildEmail(userId, deviceName);
        xrayConfig.addClient(id, userId, deviceName);
        xrayProcess.addClientToRunning(id, email);
        const appliedTier = applySpeedTier(id, email, speedTier);
        xrayConfig.setMaxDevices(id, maxDevices);
        return { uuid: id, tier: appliedTier };
      });

      return {
        success: true,
        data: {
          uuid,
          vlessUri: xrayConfig.buildVlessUri(uuid, deviceName),
          reality: xrayConfig.getRealityPublicParams(),
          ...(tier ? { speedTier: tier.speedTier } : {}),
        }
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'VLESS_ERROR', message: err.message } });
    }
  });

  fastify.post('/vless/user/restore', async (req, reply) => {
    const { uuid, userId, deviceName, speedTier, maxDevices } = req.body || {};
    if (!uuid) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'uuid is required' }
      });
    }
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      const { restored, tier } = await withLock(() => {
        const existing = xrayConfig.findClient(uuid);
        const email = existing
          ? xrayConfig.buildEmail(existing.userId, existing.deviceName)
          : xrayConfig.buildEmail(userId || '', deviceName || '');
        if (!existing) {
          xrayConfig.addClient(uuid, userId || '', deviceName || '');
          xrayProcess.addClientToRunning(uuid, email);
        }
        // Applied whether the client was just (re)created or already existed
        // — this IS the tier-change path for an active subscription, no
        // fresh UUID needed (ROADMAP_AWG-VLESS.md Этап 1).
        const appliedTier = applySpeedTier(uuid, email, speedTier);
        // Same "unconditional, whether new or existing" treatment for the
        // device limit — a plan upgrade/downgrade changes max_devices without
        // necessarily going through the suspended/restore branch above.
        xrayConfig.setMaxDevices(uuid, maxDevices);
        return { restored: !existing, tier: appliedTier };
      });

      return {
        success: true,
        data: {
          uuid, restored, reality: xrayConfig.getRealityPublicParams(),
          ...(tier ? { speedTier: tier.speedTier } : {}),
        }
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'VLESS_ERROR', message: err.message } });
    }
  });

  fastify.delete('/vless/user/:uuid/revoke', async (req, reply) => {
    const uuid = decodeURIComponent(req.params.uuid);
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      await withLock(() => {
        const existing = xrayConfig.findClient(uuid);
        if (!existing) throw Object.assign(new Error('VLESS client not found'), { code: 'VLESS_USER_NOT_FOUND' });
        xrayConfig.removeClient(uuid);
        xrayProcess.removeClientFromRunning(xrayConfig.buildEmail(existing.userId, existing.deviceName));
        xrayDeviceLimitPoller.clearState(uuid);
        clearSpeedTier(uuid);
      });
      return { success: true, data: {} };
    } catch (err) {
      if (err.code === 'VLESS_USER_NOT_FOUND') {
        return reply.status(404).send({ success: false, error: { code: 'VLESS_USER_NOT_FOUND', message: err.message } });
      }
      return reply.status(500).send({ success: false, error: { code: 'VLESS_ERROR', message: err.message } });
    }
  });

  // Single-purpose speed-tier override, distinct from create/restore: no
  // maxDevices/lifecycle side effects, so backend-api's hourly volume-quota
  // check (ROADMAP_AWG-VLESS.md — "честная лестница") can call this every
  // cycle without touching device-limit state or emitting a misleading
  // "restored" event for what is really a routine tier re-evaluation, not a
  // suspend/restore transition. `speedTier: null` means "clear any override
  // entirely" (device-count tiers were retired — there's no fallback
  // subscription tier to revert to, only "fully unshaped" or "a quota band"),
  // distinct from the field being missing, which is a client error.
  fastify.post('/vless/user/:uuid/speed-tier', async (req, reply) => {
    const uuid = decodeURIComponent(req.params.uuid);
    const body = req.body || {};
    if (!('speedTier' in body)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'speedTier is required (a tier id, or null to clear)' }
      });
    }
    const { speedTier } = body;
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      const result = await withLock(() => {
        const existing = xrayConfig.findClient(uuid);
        if (!existing) throw Object.assign(new Error('VLESS client not found'), { code: 'VLESS_USER_NOT_FOUND' });
        if (speedTier === null) {
          clearSpeedTier(uuid);
          return { speedTier: null };
        }
        const email = xrayConfig.buildEmail(existing.userId, existing.deviceName);
        return applySpeedTier(uuid, email, speedTier);
      });

      return { success: true, data: { uuid, speedTier: result.speedTier } };
    } catch (err) {
      if (err.code === 'VLESS_USER_NOT_FOUND') {
        return reply.status(404).send({ success: false, error: { code: 'VLESS_USER_NOT_FOUND', message: err.message } });
      }
      return reply.status(500).send({ success: false, error: { code: 'VLESS_ERROR', message: err.message } });
    }
  });

  fastify.get('/vless/users', async (req, reply) => {
    if (!xrayConfig.isAvailable()) return notAvailable(reply);
    try {
      return { success: true, data: { users: xrayConfig.listClients() } };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'VLESS_ERROR', message: err.message } });
    }
  });
}

module.exports = vlessRoutes;
