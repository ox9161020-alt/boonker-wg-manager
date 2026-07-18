'use strict';
const crypto = require('crypto');
const xrayConfig = require('../services/xrayConfig');
const xrayProcess = require('../services/xrayProcess');
const { withLock } = require('../services/lock');

const notAvailable = (reply) => reply.status(503).send({
  success: false,
  error: { code: 'VLESS_NOT_AVAILABLE', message: 'Xray is not installed on this node' }
});

async function vlessRoutes(fastify) {
  fastify.post('/vless/user/create', async (req, reply) => {
    const { userId, deviceName } = req.body || {};
    if (!userId || !deviceName) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'userId and deviceName are required' }
      });
    }
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      const uuid = await withLock(() => {
        const id = crypto.randomUUID();
        const email = xrayConfig.buildEmail(userId, deviceName);
        xrayConfig.addClient(id, userId, deviceName);
        xrayProcess.addClientToRunning(id, email);
        return id;
      });

      return {
        success: true,
        data: {
          uuid,
          vlessUri: xrayConfig.buildVlessUri(uuid, deviceName),
          reality: xrayConfig.getRealityPublicParams(),
        }
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'VLESS_ERROR', message: err.message } });
    }
  });

  fastify.post('/vless/user/restore', async (req, reply) => {
    const { uuid, userId, deviceName } = req.body || {};
    if (!uuid) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'uuid is required' }
      });
    }
    if (!xrayConfig.isAvailable()) return notAvailable(reply);

    try {
      const restored = await withLock(() => {
        if (xrayConfig.findClient(uuid)) return false;
        const email = xrayConfig.buildEmail(userId || '', deviceName || '');
        xrayConfig.addClient(uuid, userId || '', deviceName || '');
        xrayProcess.addClientToRunning(uuid, email);
        return true;
      });

      return { success: true, data: { uuid, restored, reality: xrayConfig.getRealityPublicParams() } };
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
