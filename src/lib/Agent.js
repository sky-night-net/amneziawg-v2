'use strict';

const { createServer } = require('http');
const {
  createApp,
  createRouter,
  defineEventHandler,
  readBody,
  getRouterParam,
  toNodeListener,
  fromNodeMiddleware,
} = require('h3');
const debug = require('debug')('Agent');

// NUCLEAR LOGGING START
console.log('============================================================');
console.log('🚀 [AGENT VERSION 2.1] BOOTING UP...');
console.log('============================================================');

const {
  AGENT_PORT,
  AGENT_TOKEN,
} = require('../config');

const WireGuard = require('./WireGuard');
const wireguard = new WireGuard();

const app = createApp();
const router = createRouter();

// Logic for catch-all logging
app.use(defineEventHandler((event) => {
  console.log(`[AGENT-TRAFFIC] ${event.node.req.method} ${event.node.req.url}`);
}));

// Middleware for Hub Token validation
app.use(
  fromNodeMiddleware((req, res, next) => {
    const auth = req.headers['authorization'];
    console.log(`[AGENT-AUTH] Check: ${auth ? 'Bearer provided' : 'No Header'}`);
    if (!auth || auth !== `Bearer ${AGENT_TOKEN}`) {
      console.log(`[AGENT-AUTH] FAILED! Expected: Bearer ${AGENT_TOKEN}`);
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'Unauthorized Hub' }));
    }
    next();
  }),
);

// Agent API Endpoints
router.get('/api/agent/status', defineEventHandler(async () => {
  console.log('[AGENT] Handling status request');
  const os = require('os');
  const clients = await wireguard.getClients();
  return {
    os: { uptime: os.uptime(), load: os.loadavg(), totalmem: os.totalmem(), freemem: os.freemem() },
    wireguard: { clientCount: clients.length, activeClients: clients.filter(c => c.latestHandshakeAt).length }
  };
}));

router.get('/api/agent/clients', defineEventHandler(async () => {
  console.log('[AGENT] Handling list clients');
  return await wireguard.getClients();
}));

router.get('/api/agent/clients/:clientId/qrcode', defineEventHandler(async (event) => {
  const clientId = getRouterParam(event, 'clientId');
  console.log(`[AGENT] Handling QR request for client: ${clientId}`);
  const svg = await wireguard.getClientQRCodeSVG({ clientId });
  const { setHeader } = require('h3');
  setHeader(event, 'Content-Type', 'image/svg+xml');
  return svg;
}));

router.get('/api/agent/clients/:clientId/config', defineEventHandler(async (event) => {
  const clientId = getRouterParam(event, 'clientId');
  console.log(`[AGENT] Handling Config request for client: ${clientId}`);
  return await wireguard.getClientConfiguration({ clientId });
}));

router.delete('/api/agent/clients/:clientId', defineEventHandler(async (event) => {
  const clientId = getRouterParam(event, 'clientId');
  console.log(`[AGENT] Handling Delete request for client: ${clientId}`);
  return await wireguard.deleteClient({ clientId });
}));

// Fallbacks for legacy paths
router.get('/api/agent/clients/:clientId/qrcode.svg', defineEventHandler(async (event) => {
  const clientId = getRouterParam(event, 'clientId');
  console.log(`[AGENT-LEGACY] Handling QR.svg request for: ${clientId}`);
  const svg = await wireguard.getClientQRCodeSVG({ clientId });
  const { setHeader } = require('h3');
  setHeader(event, 'Content-Type', 'image/svg+xml');
  return svg;
}));

router.get('/api/agent/clients/:clientId/configuration', defineEventHandler(async (event) => {
  const clientId = getRouterParam(event, 'clientId');
  console.log(`[AGENT-LEGACY] Handling Configuration request for: ${clientId}`);
  return await wireguard.getClientConfiguration({ clientId });
}));

app.use(router);

module.exports = {
  start: () => {
    createServer(toNodeListener(app)).listen(parseInt(AGENT_PORT, 10), '0.0.0.0', () => {
      console.log(`🚀 [AGENT-CORE] Running on port ${AGENT_PORT}`);
    });
  }
};
