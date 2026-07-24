'use strict';
const crypto = require('crypto');
const xrayConfig = require('../services/xrayConfig');
const xrayProcess = require('../services/xrayProcess');
const xrayShaping = require('../services/xrayShaping');
const { withLock } = require('../services/lock');

const notAvailable = (reply) => reply.status(503).send({
  success: false,
  error: { code: 'VLESS_NOT_AVAILABLE', message: 'Xray is not installed on this node' }
});

async function vlessRoutes(fastify) {
  // Applies (or updates, on an upgrade/downgrade) a user's speed-tier: their
  // own personal outbound + tc filter (never shared with another user, even
  // on the same tier — see xraySpeedTiers.js's header comment) and a
  // `user`-matched routing rule. Used by both create and restore so a tier
  // change never needs a fresh UUID (ROADMAP_AWG-VLESS.md Этап 1). No-op when
  // speedTier is absent.
  function applySpeedTier(uuid, email, speedTier) {
    if (speedTier == null) return null;
    const { ruleTag, outboundTag, mark, created, hadPreviousRule, oldMark, oldTag } =
      xrayConfig.setUserSpeedTier(uuid, email, speedTier);

    if (created) xrayProcess.addOutboundToRunning(outboundTag, mark);
    // adrules -append never replaces a same-tagged rule already live in
    // Xray's memory (confirmed live, ROADMAP_AWG-VLESS.md Этап 1) — clear the
    // old one first on a re-assign (tier change, or an idempotent re-confirm
    // via /restore) so Xray never evaluates a stale duplicate. Skipped on a
    // genuinely first-ever assignment since there's nothing live to remove.
    if (hadPreviousRule) xrayProcess.removeRoutingRuleFromRunning(ruleTag);
    xrayProcess.addRoutingRuleToRunning(ruleTag, email, outboundTag);

    xrayShaping.addPeerFilter(mark, speedTier);
    if (oldMark != null) {
      // Tier changed — the old personal outbound/filter belongs to nobody
      // now, clean both up instead of leaking them.
      xrayProcess.removeOutboundFromRunning(oldTag);
      xrayShaping.removePeerFilter(oldMark);
    }
    return { speedTier, mark };
  }

  fastify.post('/vless/user/create', async (req, reply) => {
    const { userId, deviceName, speedTier } = req.body || {};
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
    const { uuid, userId, deviceName, speedTier } = req.body || {};
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
        const removed = xrayConfig.removeUserSpeedTier(uuid);
        if (removed) {
          xrayProcess.removeRoutingRuleFromRunning(removed.ruleTag);
          xrayProcess.removeOutboundFromRunning(removed.outboundTag);
          xrayShaping.removePeerFilter(removed.mark);
        }
      });
      return { success: true, data: {} };
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
