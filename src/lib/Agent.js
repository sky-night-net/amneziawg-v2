'use strict';

const { createServer } = require('http');
const {
  createApp,
  createRouter,
  defineEventHandler,
  readBody,
  getRouterParam,
  setHeader,
  toNodeListener,
  fromNodeMiddleware,
} = require('h3');
const debug = require('debug')('Agent');

console.log('============================================================');
console.log('🚀 [AGENT VERSION 2.5] FULL FEATURE COMPLETE...');
console.log('============================================================');

const {
  AGENT_PORT,
  AGENT_TOKEN,
} = require('../config');

const wireguard = require('../services/WireGuard');

const app = createApp();
const router = createRouter();

// Traffic logger
app.use(defineEventHandler((event) => {
  console.log(`[AGENT-REQ] ${event.node.req.method} ${event.node.req.url}`);
}));

// Hub Authentication
app.use(
  fromNodeMiddleware((req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${AGENT_TOKEN}`) {
      console.log(`[AGENT-AUTH] DENIED: ${auth ? 'Invalid Token' : 'No Header'}`);
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'Unauthorized Hub' }));
    }
    next();
  }),
);

// --- AGENT API ROUTES ---

// Server Status
router.get('/api/agent/status', defineEventHandler(async () => {
    const os = require('os');
    const clients = await wireguard.getClients();
    return {
        os: { uptime: os.uptime(), load: os.loadavg(), totalmem: os.totalmem(), freemem: os.freemem() },
        wireguard: { clientCount: clients.length, activeClients: clients.filter(c => c.latestHandshakeAt).length }
    };
}));

// Global Configuration
router.get('/api/agent/config', defineEventHandler(async () => {
    return await wireguard.getConfig();
}));

router.post('/api/agent/setup', defineEventHandler(async (event) => {
    const body = await readBody(event);
    return await wireguard.setupServer(body);
}));

router.post('/api/agent/awg-settings', defineEventHandler(async (event) => {
    const settings = await readBody(event);
    return await wireguard.updateAwgSettings(settings);
}));

// Client Operations (Collection)
router.get('/api/agent/clients', defineEventHandler(async () => {
    return await wireguard.getClients();
}));

router.post('/api/agent/clients', defineEventHandler(async (event) => {
    const { name, expiredDate } = await readBody(event);
    console.log(`[AGENT] Creating client: ${name}`);
    return await wireguard.createClient({ name, expiredDate });
}));

// Client Operations (Individual)
router.get('/api/agent/clients/:clientId', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    console.log(`[AGENT] Get info for: ${clientId}`);
    return await wireguard.getClient({ clientId });
}));

router.delete('/api/agent/clients/:clientId', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    console.log(`[AGENT] Delete request: ${clientId}`);
    await wireguard.deleteClient({ clientId });
    return { success: true };
}));

router.post('/api/agent/clients/:clientId/enable', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    console.log(`[AGENT] Enable client: ${clientId}`);
    return await wireguard.enableClient({ clientId });
}));

router.post('/api/agent/clients/:clientId/disable', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    console.log(`[AGENT] Disable client: ${clientId}`);
    return await wireguard.disableClient({ clientId });
}));

// Client Updates
router.put('/api/agent/clients/:clientId/name', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    const { name } = await readBody(event);
    return await wireguard.updateClientName({ clientId, name });
}));

router.put('/api/agent/clients/:clientId/address', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    const { address } = await readBody(event);
    return await wireguard.updateClientAddress({ clientId, address });
}));

router.put('/api/agent/clients/:clientId/expireDate', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    const { expireDate } = await readBody(event);
    return await wireguard.updateClientExpireDate({ clientId, expireDate });
}));

// Configuration & QR
router.get('/api/agent/clients/:clientId/qrcode', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    console.log(`[AGENT] Providing QR for: ${clientId}`);
    const svg = await wireguard.getClientQRCodeSVG({ clientId });
    setHeader(event, 'Content-Type', 'image/svg+xml');
    return svg;
}));

router.get('/api/agent/clients/:clientId/config', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    console.log(`[AGENT] Providing Config for: ${clientId}`);
    const config = await wireguard.getClientConfiguration({ clientId });
    setHeader(event, 'Content-Type', 'text/plain');
    return config;
}));

// One-time Link
router.post('/api/agent/clients/:clientId/generateOneTimeLink', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    return await wireguard.generateOneTimeLink({ clientId });
}));

// --- LEGACIES for older Hub versions ---
router.get('/api/agent/clients/:clientId/qrcode.svg', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    const svg = await wireguard.getClientQRCodeSVG({ clientId });
    setHeader(event, 'Content-Type', 'image/svg+xml');
    return svg;
}));

router.get('/api/agent/clients/:clientId/configuration', defineEventHandler(async (event) => {
    const clientId = getRouterParam(event, 'clientId');
    const config = await wireguard.getClientConfiguration({ clientId });
    setHeader(event, 'Content-Type', 'text/plain');
    return config;
}));

app.use(router);

module.exports = {
    start: () => {
        createServer(toNodeListener(app)).listen(parseInt(AGENT_PORT, 10), '0.0.0.0', () => {
            console.log(`🚀 [AGENT-CORE] Running on port ${AGENT_PORT}`);
        });
    }
};
