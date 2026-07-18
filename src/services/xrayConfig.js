'use strict';
const fs = require('fs');

const VLESS_TAG = 'vless-in';

const getConfigPath = () => process.env.XRAY_CONFIG_PATH || '/usr/local/etc/xray/config.json';

function isAvailable() {
  return fs.existsSync(getConfigPath());
}

function readConfig() {
  return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function findVlessInbound(config) {
  const inbound = (config.inbounds || []).find((i) => i.tag === VLESS_TAG);
  if (!inbound) throw new Error(`Xray config has no "${VLESS_TAG}" inbound`);
  return inbound;
}

// Same "userId | deviceName" convention as the AWG peer comment in config.js,
// so both protocols stay debuggable the same way from raw config on disk.
const buildEmail = (userId, deviceName) => `${userId} | ${deviceName}`;

function parseEmail(email) {
  const match = String(email || '').match(/^(.+?)\s*\|\s*(.+)$/);
  return match ? { userId: match[1].trim(), deviceName: match[2].trim() } : { userId: null, deviceName: null };
}

function listClients() {
  const inbound = findVlessInbound(readConfig());
  return inbound.settings.clients.map((c) => ({ uuid: c.id, ...parseEmail(c.email) }));
}

function addClient(uuid, userId, deviceName) {
  const config = readConfig();
  const inbound = findVlessInbound(config);
  inbound.settings.clients.push({ id: uuid, email: buildEmail(userId || '', deviceName || '') });
  writeConfig(config);
}

function removeClient(uuid) {
  const config = readConfig();
  const inbound = findVlessInbound(config);
  const before = inbound.settings.clients.length;
  inbound.settings.clients = inbound.settings.clients.filter((c) => c.id !== uuid);
  if (inbound.settings.clients.length === before) throw new Error('VLESS client not found');
  writeConfig(config);
}

function findClient(uuid) {
  return listClients().find((c) => c.uuid === uuid) || null;
}

function buildVlessUri(uuid, label) {
  const host = process.env.SERVER_PUBLIC_IP;
  const port = process.env.XRAY_REALITY_PORT || '443';
  const pbk = process.env.XRAY_REALITY_PUBLIC_KEY;
  const sni = process.env.XRAY_REALITY_SNI;
  const sid = process.env.XRAY_REALITY_SHORT_ID;
  const params = new URLSearchParams({
    security: 'reality',
    pbk,
    sni,
    sid,
    fp: 'chrome',
    type: 'tcp',
    encryption: 'none',
  });
  return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(label || '')}`;
}

function getRealityPublicParams() {
  return {
    publicKey: process.env.XRAY_REALITY_PUBLIC_KEY || null,
    sni: process.env.XRAY_REALITY_SNI || null,
    shortId: process.env.XRAY_REALITY_SHORT_ID || null,
    port: process.env.XRAY_REALITY_PORT || '443',
  };
}

module.exports = {
  VLESS_TAG,
  isAvailable,
  readConfig,
  writeConfig,
  listClients,
  addClient,
  removeClient,
  findClient,
  buildVlessUri,
  buildEmail,
  parseEmail,
  getRealityPublicParams,
};
