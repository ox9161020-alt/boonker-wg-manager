'use strict';
const configService = require('../services/config');
const wireguardService = require('../services/wireguard');
const keygenService = require('../services/keygen');
const { withLock } = require('../services/lock');

function buildClientConfig(privateKey, allowedIp, serverPublicKey) {
  // Endpoint MUST be 127.0.0.1 so AWG goes through the local wstunnel client
  // (which listens on UDP 127.0.0.1:51820 and forwards over WSS/TCP 443).
  // Pointing AWG at the public IP would bypass wstunnel entirely and expose
  // raw WireGuard traffic to DPI.
  const dns        = process.env.DNS_SERVER      || '10.0.0.1';
  const awgPort    = process.env.AWG_LOCAL_PORT  || '51820';
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
    `Endpoint = 127.0.0.1:${awgPort}`,
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

  fastify.delete('/peer/:pubkey/revoke', async (req, reply) => {
    const pubkey = decodeURIComponent(req.params.pubkey);
    try {
      await withLock(() => {
        configService.removePeer(pubkey);
        wireguardService.removePeerFromRunning(pubkey);
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
