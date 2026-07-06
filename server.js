'use strict';
require('dotenv').config();
const buildApp = require('./src/app');
const trafficControlService = require('./src/services/trafficControl');

const PORT = parseInt(process.env.PORT || '3000', 10);

// Fail fast on a missing/weak API token — better to refuse to boot than to
// serve peer management to anyone (an empty token disables auth entirely).
const apiToken = process.env.API_TOKEN || '';
if (apiToken.length < 16 || apiToken.startsWith('change-me')) {
  console.error('FATAL: API_TOKEN must be set to a strong value (>= 16 chars). Generate one with: openssl rand -hex 32');
  process.exit(1);
}

async function start() {
  // Runs before the app accepts requests so the base qdisc/nftables setup
  // exists by the time the first POST /peer/create lands. VPN connectivity
  // must never depend on QoS bootstrap succeeding, so failures are logged,
  // not fatal.
  try {
    trafficControlService.ensureTrafficControlBase();
  } catch (err) {
    console.error('[trafficControl] bootstrap failed — starting anyway:', err.message);
  }

  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) start();

module.exports = { start };
