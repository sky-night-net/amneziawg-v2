'use strict';

const { createServer } = require('http');
const {
  createApp,
  createRouter,
  defineEventHandler,
  readBody,
  createError,
  toNodeListener,
  fromNodeMiddleware,
} = require('h3');
const debug = require('debug')('Agent');

const {
  AGENT_PORT,
  HUB_TOKEN,
} = require('../config');

const WireGuard = require('./WireGuard');
const wireguard = new WireGuard();

const app = createApp();
const router = createRouter();

// Middleware for Hub Token validation
app.use(
  fromNodeMiddleware((req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${HUB_TOKEN}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'Unauthorized Hub' }));
    }
    next();
  }),
);

// Agent API Endpoints
router.get('/api/agent/status', defineEventHandler(async () => {
  const os = require('os');
  const clients = await wireguard.getClients();
  return {
    os: {
      uptime: os.uptime(),
      load: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem(),
    },
    wireguard: {
      clientCount: clients.length,
      activeClients: clients.filter(c => c.latestHandshakeAt).length,
    }
  };
}));

router.get('/api/agent/config', defineEventHandler(async () => {
  return await wireguard.getConfig();
}));

router.post('/api/agent/setup', defineEventHandler(async (event) => {
  const body = await readBody(event);
  return await wireguard.setupServer(body);
}));

router.get('/api/agent/clients', defineEventHandler(async () => {
  return await wireguard.getClients();
}));

router.post('/api/agent/clients', defineEventHandler(async (event) => {
  const { name, expiredAt } = await readBody(event);
  return await wireguard.createClient({ name, expiredAt });
}));

router.delete('/api/agent/clients/:clientId', defineEventHandler(async (event) => {
  const clientId = event.context.params.clientId;
  return await wireguard.deleteClient({ clientId });
}));

router.post('/api/agent/awg-settings', defineEventHandler(async (event) => {
  const settings = await readBody(event);
  return await wireguard.updateAwgSettings(settings);
}));

app.use(router);

module.exports = {
  start: () => {
    createServer(toNodeListener(app)).listen(parseInt(AGENT_PORT, 10), '0.0.0.0', () => {
      debug(`Amnezia Agent started on port ${AGENT_PORT}`);
      console.log(`Amnezia Agent is running on port ${AGENT_PORT} (MANAGEMENT PORT)`);
    });
  }
};
