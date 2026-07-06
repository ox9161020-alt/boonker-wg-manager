'use strict';
const configService = require('../services/config');
const wireguardService = require('../services/wireguard');
const keygenService = require('../services/keygen');
const trafficControlService = require('../services/trafficControl');
const { withLock } = require('../services/lock');

function buildClientConfig(privateKey, allowedIp, serverPublicKey) {
  // wstunnel is currently disabled everywhere — Windows Smart App Control blocks the
  // unsigned wstunnel.exe binary, see CLAUDE.md Этап 14 — so AWG must point straight
  // at the server's public IP instead of the wstunnel-forwarded 127.0.0.1:<port>.
  // Set AWG_DIRECT_ENDPOINT=0 to restore the 127.0.0.1/wstunnel path once wstunnel
  // is code-signed and back in front of it.
  const directEndpoint = process.env.AWG_DIRECT_ENDPOINT !== '0';
  const endpointHost = directEndpoint ? process.env.SERVER_PUBLIC_IP : '127.0.0.1';

  const dns        = process.env.DNS_SERVER      || '10.0.0.1';
  const awgPort    = process.env.AWG_LOCAL_PORT  || '51820';
  const mtu  = process.env.AWG_MTU  || '1280';
  const jc   = process.env.AWG_JC   || '4';
  const jmin = process.env.AWG_JMIN || '40';
  const jmax = process.env.AWG_JMAX || '70';
  const s1   = process.env.AWG_S1   || '30';
  const s2   = process.env.AWG_S2   || '30';
  const h1 = process.env.AWG_H1;
  const h2 = process.env.AWG_H2;
  const h3 = process.env.AWG_H3;
  const h4 = process.env.AWG_H4;

  return [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    `Address = ${allowedIp}`,
    `DNS = ${dns}`,
    `MTU = ${mtu}`,
    `Jc = ${jc}`,
    `Jmin = ${jmin}`,
    `Jmax = ${jmax}`,
    `S1 = ${s1}`,
    `S2 = ${s2}`,
    `H1 = ${h1}`,
    `H2 = ${h2}`,
    `H3 = ${h3}`,
    `H4 = ${h4}`,
    '',
    '[Peer]',
    `PublicKey = ${serverPublicKey}`,
    `Endpoint = ${endpointHost}:${awgPort}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'PersistentKeepalive = 25',
    ''
  ].join('\n');
}

async function peerRoutes(fastify) {
  fastify.post('/peer/create', async (req, reply) => {
    const { userId, deviceName } = req.body || {};
    if (!userId || !deviceName) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'userId and deviceName are required' }
      });
    }
    try {
      const { privateKey, publicKey, allowedIp, serverPublicKey } = await withLock(() => {
        const keys = keygenService.generateKeyPair();
        const peers = configService.parsePeers(configService.readConfig());
        const ip = configService.allocateIp(peers);
        const srvPub = configService.getServerPublicKey();

        configService.addPeer(keys.publicKey, ip, userId, deviceName);
        wireguardService.addPeerToRunning(keys.publicKey, ip);
        trafficControlService.addPeerLimit(ip);

        return { privateKey: keys.privateKey, publicKey: keys.publicKey, allowedIp: ip, serverPublicKey: srvPub };
      });

      const serverIp = process.env.SERVER_PUBLIC_IP;
      const serverPort = process.env.SERVER_PORT || '443';

      return {
        success: true,
        data: {
          publicKey,
          privateKey,
          allowedIp,
          config: buildClientConfig(privateKey, allowedIp, serverPublicKey),
          wstunnelServer: `wss://${serverIp}:${serverPort}`
        }
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'WG_ERROR', message: err.message }
      });
    }
  });

  fastify.post('/peer/restore', async (req, reply) => {
    const { publicKey, allowedIp, userId, deviceName } = req.body || {};
    if (!publicKey || !allowedIp) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'publicKey and allowedIp are required' }
      });
    }
    try {
      const result = await withLock(() => {
        const peers = configService.parsePeers(configService.readConfig());
        const existing = peers.find(p => p.publicKey === publicKey);
        // Idempotent: echo the peer's actual IP from the config, not the caller-supplied one
        if (existing) return { restored: false, allowedIp: existing.allowedIp };
        if (peers.find(p => p.allowedIp === allowedIp)) {
          const err = new Error('IP already assigned to another peer');
          err.code = 'IP_IN_USE';
          throw err;
        }
        // Default to '' so a missing value never serializes as "undefined" in the peer comment
        configService.addPeer(publicKey, allowedIp, userId || '', deviceName || '');
        wireguardService.addPeerToRunning(publicKey, allowedIp);
        trafficControlService.addPeerLimit(allowedIp);
        return { restored: true, allowedIp };
      });
      return { success: true, data: { publicKey, allowedIp: result.allowedIp, restored: result.restored } };
    } catch (err) {
      if (err.code === 'IP_IN_USE') {
        return reply.status(409).send({ success: false, error: { code: 'IP_IN_USE', message: err.message } });
      }
      return reply.status(500).send({ success: false, error: { code: 'WG_ERROR', message: err.message } });
    }
  });

  fastify.delete('/peer/:pubkey/revoke', async (req, reply) => {
    const pubkey = decodeURIComponent(req.params.pubkey);
    try {
      await withLock(() => {
        const peer = configService.parsePeers(configService.readConfig()).find(p => p.publicKey === pubkey);
        configService.removePeer(pubkey);
        wireguardService.removePeerFromRunning(pubkey);
        if (peer?.allowedIp) trafficControlService.removePeerLimit(peer.allowedIp);
      });
      return { success: true, data: {} };
    } catch (err) {
      if (err.message === 'Peer not found') {
        return reply.status(404).send({
          success: false,
          error: { code: 'PEER_NOT_FOUND', message: 'Peer not found' }
        });
      }
      return reply.status(500).send({
        success: false,
        error: { code: 'WG_ERROR', message: err.message }
      });
    }
  });

  fastify.get('/peer/:pubkey/config', async (req, reply) => {
    const pubkey = decodeURIComponent(req.params.pubkey);
    try {
      const peers = configService.parsePeers(configService.readConfig());
      const peer = peers.find(p => p.publicKey === pubkey);
      if (!peer) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PEER_NOT_FOUND', message: 'Peer not found' }
        });
      }
      return {
        success: true,
        data: {
          publicKey: peer.publicKey,
          allowedIp: peer.allowedIp,
          userId: peer.userId,
          deviceName: peer.deviceName
        }
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'CONFIG_ERROR', message: err.message }
      });
    }
  });
}

module.exports = peerRoutes;
