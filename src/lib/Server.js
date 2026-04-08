'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const basicAuth = require('basic-auth');
const { createServer } = require('node:http');
const { stat, readFile } = require('node:fs/promises');
const { resolve, sep } = require('node:path');

const expressSession = require('express-session');
const debug = require('debug')('Server');

const {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  fromNodeMiddleware,
  getRouterParam,
  toNodeListener,
  readBody,
  setHeader,
  serveStatic,
  getCookie,
  deleteCookie,
} = require('h3');

const WireGuard = require('../services/WireGuard');

const {
  PORT,
  WEBUI_HOST,
  RELEASE,
  PASSWORD_HASH,
  MAX_AGE,
  LANG,
  UI_TRAFFIC_STATS,
  UI_CHART_TYPE,
  WG_ENABLE_ONE_TIME_LINKS,
  UI_ENABLE_SORT_CLIENTS,
  WG_ENABLE_EXPIRES_TIME,
  ENABLE_PROMETHEUS_METRICS,
  PROMETHEUS_METRICS_PASSWORD,
  DICEBEAR_TYPE,
  USE_GRAVATAR,
} = require('../config');

const requiresPassword = !!PASSWORD_HASH;
const requiresPrometheusPassword = !!PROMETHEUS_METRICS_PASSWORD;

/**
 * Checks if `password` matches the PASSWORD_HASH.
 *
 * If environment variable is not set, the password is always invalid.
 *
 * @param {string} password String to test
 * @returns {boolean} true if matching environment, otherwise false
 */
const isPasswordValid = (password, hash) => {
  if (typeof password !== 'string') {
    return false;
  }
  if (hash) {
    return bcrypt.compareSync(password, hash);
  }

  return false;
};

const cronJobEveryMinute = async () => {
  await WireGuard.cronJobEveryMinute();
  setTimeout(cronJobEveryMinute, 60 * 1000);
};

module.exports = class Server {

  constructor() {
    const app = createApp();
    this.app = app;

    app.use(fromNodeMiddleware(expressSession({
      secret: PASSWORD_HASH || 'amneziawg-v2-stable-session-secret',
      resave: true,
      saveUninitialized: true,
    })));

    const router = createRouter();
    app.use(router);

    router
      .get('/api/release', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return RELEASE;
      }))

      .get('/api/lang', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `"${LANG}"`;
      }))

      .get('/api/remember-me', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return MAX_AGE > 0;
      }))

      .get('/api/ui-traffic-stats', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${UI_TRAFFIC_STATS}`;
      }))

      .get('/api/ui-chart-type', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `"${UI_CHART_TYPE}"`;
      }))

      .get('/api/wg-enable-one-time-links', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${WG_ENABLE_ONE_TIME_LINKS}`;
      }))

      .get('/api/ui-sort-clients', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${UI_ENABLE_SORT_CLIENTS}`;
      }))

      .get('/api/wg-enable-expire-time', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${WG_ENABLE_EXPIRES_TIME}`;
      }))

      .get('/api/ui-avatar-settings', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return {
          dicebear: DICEBEAR_TYPE,
          gravatar: USE_GRAVATAR,
        }
      }))

      // Nodes Management
      .get('/api/nodes', defineEventHandler(async (event) => {
        const NodeManager = require('./NodeManager');
        const nodes = new NodeManager();
        return await nodes.loadNodes();
      }))
      .post('/api/nodes', defineEventHandler(async (event) => {
        const NodeManager = require('./NodeManager');
        const nodes = new NodeManager();
        const body = await readBody(event);
        return await nodes.addNode(body);
      }))
      .delete('/api/nodes/:id', defineEventHandler(async (event) => {
        const NodeManager = require('./NodeManager');
        const nodes = new NodeManager();
        const id = getRouterParam(event, 'id');
        await nodes.removeNode(id);
        return { success: true };
      }))
      .post('/api/nodes/select', defineEventHandler(async (event) => {
        const { id } = await readBody(event);
        event.node.req.session.selectedNodeId = id;
        event.node.req.session.save();
        return { success: true };
      }))
      .get('/api/status', defineEventHandler(async (event) => {
        const id = getCookie(event, 'node-id') || 'local';
        if (id === 'local') {
           const os = require('os');
           const clients = await WireGuard.getClients();
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
        }
        
        try {
          const NodeManager = require('./NodeManager');
          const nodes = new NodeManager();
          return await nodes.callAgent(id, '/api/agent/status');
        } catch (e) {
          // If the node cookie represents a deleted node, clear it and return local stats
          deleteCookie(event, 'node-id');
          const os = require('os');
          const clients = await WireGuard.getClients();
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
        }
      }))

      // Authentication
      .get('/api/session', defineEventHandler(async (event) => {
        const config = await WireGuard.getConfig();
        const effectiveHash = config.server.passwordHash || PASSWORD_HASH;
        const currentRequiresPassword = !!effectiveHash;
        
        const authenticated = currentRequiresPassword
          ? !!(event.node.req.session && event.node.req.session.authenticated)
          : true;

        return {
          requiresPassword: currentRequiresPassword,
          authenticated,
          setupComplete: config.server.setupComplete,
          selectedNodeId: event.node.req.session.selectedNodeId || 'local',
          nodeName: require('../config').NODE_NAME,
        };
      }))
      .get('/api/setup-status', defineEventHandler(async () => {
        const config = await WireGuard.getConfig();
        return { setupComplete: config.server.setupComplete };
      }))
      .post('/api/setup', defineEventHandler(async (event) => {
        const config = await WireGuard.getConfig();
        if (config.server.setupComplete) {
          throw createError({ status: 403, message: 'Setup already complete' });
        }
        const { host, port, password } = await readBody(event);
        await WireGuard.setupServer({ host, port, password });
        return { success: true };
      }))
      .get('/cnf/:clientOneTimeLink', defineEventHandler(async (event) => {
        if (WG_ENABLE_ONE_TIME_LINKS === 'false') {
          throw createError({
            status: 404,
            message: 'Invalid state',
          });
        }
        const clientOneTimeLink = getRouterParam(event, 'clientOneTimeLink');
        const clients = await WireGuard.getClients();
        const client = clients.find((client) => client.oneTimeLink === clientOneTimeLink);
        if (!client) return;
        const clientId = client.id;
        const config = await WireGuard.getClientConfiguration({ clientId });
        await WireGuard.eraseOneTimeLink({ clientId });
        setHeader(event, 'Content-Disposition', `attachment; filename="${clientOneTimeLink}.conf"`);
        setHeader(event, 'Content-Type', 'text/plain');
        return config;
      }))
      .post('/api/session', defineEventHandler(async (event) => {
        const { password, remember } = await readBody(event);
        const config = await WireGuard.getConfig();
        const effectiveHash = config.server.passwordHash || PASSWORD_HASH;

        if (!effectiveHash) {
          throw createError({
            status: 401,
            message: 'Invalid state',
          });
        }

        if (!isPasswordValid(password, effectiveHash)) {
          throw createError({
            status: 401,
            message: 'Incorrect Password',
          });
        }

        if (MAX_AGE && remember) {
          event.node.req.session.cookie.maxAge = MAX_AGE;
        }
        event.node.req.session.authenticated = true;
        event.node.req.session.save();

        debug(`New Session: ${event.node.req.session.id}`);

        return { success: true };
      }));

    // WireGuard
    app.use(
      fromNodeMiddleware(async (req, res, next) => {
        const config = await WireGuard.getConfig();
        const effectiveHash = config.server.passwordHash || PASSWORD_HASH;
        const currentRequiresPassword = !!effectiveHash;

        // Allow setup endpoints even if not authenticated
        if (!config.server.setupComplete && (req.url === '/api/setup' || req.url === '/api/setup-status' || req.url === '/api/session')) {
          return next();
        }

        if (!currentRequiresPassword || !req.url.startsWith('/api/')) {
          return next();
        }

        // Hub Bearer Token Authentication
        const { AGENT_TOKEN } = require('../config');
        const authHeader = req.headers['authorization'];
        if (authHeader && AGENT_TOKEN && authHeader === `Bearer ${AGENT_TOKEN}`) {
          return next();
        }

        if (req.session && req.session.authenticated) {
          return next();
        }

        if (req.url.startsWith('/api/') && req.headers['authorization']) {
          if (isPasswordValid(req.headers['authorization'], effectiveHash)) {
            return next();
          }
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Incorrect Password' }));
          return;
        }

        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not Logged In' }));
        return;
      }),
    );

    const router2 = createRouter();
    app.use(router2);

    const getTarget = async (event) => {
      // If request authenticated by Agent Token, force local execution
      if (event.node.req.headers['authorization']?.startsWith('Bearer')) {
        return { nodeId: 'local', isLocal: true };
      }

      let nodeId = event.node.req.session?.selectedNodeId || 'local';
      if (nodeId !== 'local') {
        try {
          const NodeManager = require('./NodeManager');
          const nodes = new NodeManager();
          await nodes.getNode(nodeId);
        } catch (e) {
          nodeId = 'local';
          event.node.req.session.selectedNodeId = 'local';
          event.node.req.session.save();
        }
      }
      return { nodeId, isLocal: nodeId === 'local' };
    };

    router2
      .delete('/api/session', defineEventHandler((event) => {
        const sessionId = event.node.req.session.id;

        event.node.req.session.destroy();

        debug(`Deleted Session: ${sessionId}`);
        return { success: true };
      }))
      .get('/api/agent/status', defineEventHandler(async () => {
        return WireGuard.getState();
      }))
      .get('/api/agent/clients', defineEventHandler(async () => {
        return WireGuard.getClients();
      }))
      .get('/api/awg-settings', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        if (isLocal) return WireGuard.getAwgSettings();
        const NodeManager = require('./NodeManager');
        const config = await (new NodeManager()).callAgent(nodeId, '/api/agent/config');
        return config.server;
      }))
      .put('/api/awg-settings', defineEventHandler(async (event) => {
        const settings = await readBody(event);
        const { nodeId, isLocal } = await getTarget(event);
        if (isLocal) {
          await WireGuard.updateAwgSettings(settings);
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, '/api/agent/awg-settings', 'post', settings);
      }))
      .get('/api/wireguard/status', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        if (isLocal) return WireGuard.getState();
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, '/api/agent/status');
      }))
      .get('/api/wireguard/client', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        if (isLocal) return WireGuard.getClients();
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, '/api/agent/clients');
      }))
      .get('/api/wireguard/client/:clientId/qrcode.svg', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (isLocal) {
          console.log(`[HUB] Local QR Code request for: ${clientId}`);
          const svg = await WireGuard.getClientQRCodeSVG({ clientId });
          setHeader(event, 'Content-Type', 'image/svg+xml');
          return svg;
        }
        const NodeManager = require('./NodeManager');
        // Remote Agent QR code (SVG string)
        setHeader(event, 'Content-Type', 'image/svg+xml');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/qrcode`);
      }))
      .get('/api/wireguard/client/:clientId/configuration', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (isLocal) {
          const client = await WireGuard.getClient({ clientId });
          console.log(`[HUB] Local Config request for client: ${client.id} (${client.name})`);
          const config = await WireGuard.getClientConfiguration({ clientId });
          const configName = client.name
            .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
            .replace(/(-{2,}|-$)/g, '-')
            .replace(/-$/, '')
            .substring(0, 32);
          setHeader(event, 'Content-Disposition', `attachment; filename="${configName || clientId}.conf"`);
          setHeader(event, 'Content-Type', 'text/plain');
          return config;
        }
        const NodeManager = require('./NodeManager');
        const config = await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/config`);
        
        // Fetch client info from agent to get the name for the filename
        const client = await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}`);
        const configName = client.name
          .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
          .replace(/(-{2,}|-$)/g, '-')
          .replace(/-$/, '')
          .substring(0, 32);

        setHeader(event, 'Content-Disposition', `attachment; filename="${configName || clientId}.conf"`);
        setHeader(event, 'Content-Type', 'text/plain');
        return config;
      }))
      .delete('/api/wireguard/client/:clientId', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (isLocal) return await WireGuard.deleteClient({ clientId });
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}`, 'delete');
      }))
      .post('/api/wireguard/client', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const { name, expiredDate } = await readBody(event);
        if (isLocal) {
          await WireGuard.createClient({ name, expiredDate });
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients`, 'post', { name, expiredDate });
      }))
      .post('/api/wireguard/client/:clientId/enable', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') throw createError({ status: 403 });
        if (isLocal) {
          await WireGuard.enableClient({ clientId });
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/enable`, 'post');
      }))
      .post('/api/wireguard/client/:clientId/generateOneTimeLink', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        if (WG_ENABLE_ONE_TIME_LINKS === 'false') throw createError({ status: 404 });
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') throw createError({ status: 403 });
        if (isLocal) {
          await WireGuard.generateOneTimeLink({ clientId });
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/generateOneTimeLink`, 'post');
      }))
      .post('/api/wireguard/client/:clientId/disable', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') throw createError({ status: 403 });
        if (isLocal) {
          await WireGuard.disableClient({ clientId });
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/disable`, 'post');
      }))
      .put('/api/wireguard/client/:clientId/name', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') throw createError({ status: 403 });
        const { name } = await readBody(event);
        if (isLocal) {
          await WireGuard.updateClientName({ clientId, name });
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/name`, 'put', { name });
      }))
      .put('/api/wireguard/client/:clientId/address', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') throw createError({ status: 403 });
        const { address } = await readBody(event);
        if (isLocal) {
          await WireGuard.updateClientAddress({ clientId, address });
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/address`, 'put', { address });
      }))
      .put('/api/wireguard/client/:clientId/expireDate', defineEventHandler(async (event) => {
        const { nodeId, isLocal } = await getTarget(event);
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') throw createError({ status: 403 });
        const { expireDate } = await readBody(event);
        if (isLocal) {
          await WireGuard.updateClientExpireDate({ clientId, expireDate });
          return { success: true };
        }
        const NodeManager = require('./NodeManager');
        return await (new NodeManager()).callAgent(nodeId, `/api/agent/clients/${clientId}/expireDate`, 'put', { expireDate });
      }));

    const safePathJoin = (base, target) => {
      // Manage web root (edge case)
      if (target === '/') {
        return `${base}${sep}`;
      }

      // Prepend './' to prevent absolute paths
      const targetPath = `.${sep}${target}`;

      // Resolve the absolute path
      const resolvedPath = resolve(base, targetPath);

      // Check if resolvedPath is a subpath of base
      if (resolvedPath.startsWith(`${base}${sep}`)) {
        return resolvedPath;
      }

      throw createError({
        status: 400,
        message: 'Bad Request',
      });
    };

    // Check Prometheus credentials
    app.use(
      fromNodeMiddleware((req, res, next) => {
        if (!requiresPrometheusPassword || !req.url.startsWith('/metrics')) {
          return next();
        }
        const user = basicAuth(req);
        if (!user) {
          res.statusCode = 401;
          return { error: 'Not Logged In' };
        }
        if (user.pass) {
          if (isPasswordValid(user.pass, PROMETHEUS_METRICS_PASSWORD)) {
            return next();
          }
          res.statusCode = 401;
          return { error: 'Incorrect Password' };
        }
        res.statusCode = 401;
        return { error: 'Not Logged In' };
      }),
    );

    // Prometheus Metrics API
    const routerPrometheusMetrics = createRouter();
    app.use(routerPrometheusMetrics);

    // Prometheus Routes
    routerPrometheusMetrics
      .get('/metrics', defineEventHandler(async (event) => {
        setHeader(event, 'Content-Type', 'text/plain');
        if (ENABLE_PROMETHEUS_METRICS === 'true') {
          return WireGuard.getMetrics();
        }
        return '';
      }))
      .get('/metrics/json', defineEventHandler(async (event) => {
        setHeader(event, 'Content-Type', 'application/json');
        if (ENABLE_PROMETHEUS_METRICS === 'true') {
          return WireGuard.getMetricsJSON();
        }
        return '';
      }));

    // backup_restore
    const router3 = createRouter();
    app.use(router3);

    router3
      .get('/api/wireguard/backup', defineEventHandler(async (event) => {
        const config = await WireGuard.backupConfiguration();
        setHeader(event, 'Content-Disposition', 'attachment; filename="wg0.json"');
        setHeader(event, 'Content-Type', 'text/json');
        return config;
      }))
      .put('/api/wireguard/restore', defineEventHandler(async (event) => {
        const { file } = await readBody(event);
        await WireGuard.restoreConfiguration(file);
        return { success: true };
      }))
      
      // Agent API Endpoints
      .get('/api/agent/status', defineEventHandler(async () => {
        const os = require('os');
        const clients = await WireGuard.getClients();
        return {
          os: { uptime: os.uptime(), load: os.loadavg(), totalmem: os.totalmem(), freemem: os.freemem() },
          wireguard: { clientCount: clients.length, activeClients: clients.filter(c => c.latestHandshakeAt).length }
        };
      }))
      .get('/api/agent/clients', defineEventHandler(async () => {
        return await WireGuard.getClients();
      }))
      .get('/api/agent/config', defineEventHandler(async () => {
        const config = await WireGuard.getConfig();
        return config;
      }))
      .post('/api/agent/clients', defineEventHandler(async (event) => {
        const { name, expiredDate } = await readBody(event);
        return await WireGuard.createClient({ name, expiredDate });
      }))
      .delete('/api/agent/clients/:clientId', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        return await WireGuard.deleteClient({ clientId });
      }))
      .post('/api/agent/clients/:clientId/enable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        return await WireGuard.enableClient({ clientId });
      }))
      .post('/api/agent/clients/:clientId/disable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        return await WireGuard.disableClient({ clientId });
      }))
      .post('/api/agent/clients/:clientId/generateOneTimeLink', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        return await WireGuard.showOneTimeLink({ clientId });
      }))
      .put('/api/agent/clients/:clientId/name', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const { name } = await readBody(event);
        return await WireGuard.updateClientName({ clientId, name });
      }))
      .put('/api/agent/clients/:clientId/address', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const { address } = await readBody(event);
        return await WireGuard.updateClientAddress({ clientId, address });
      }))
      .put('/api/agent/clients/:clientId/expireDate', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const { expireDate } = await readBody(event);
        return await WireGuard.updateClientExpireDate({ clientId, expireDate });
      }))
      .delete('/api/agent/clients/:clientId', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        await WireGuard.deleteClient({ clientId });
        return { success: true };
      }))
    .get('/api/agent/clients/:clientId/qrcode', defineEventHandler(async (event) => {
      const clientId = getRouterParam(event, 'clientId');
      console.log(`[AGENT] QR Code request for: ${clientId}`);
      const svg = await WireGuard.getClientQRCodeSVG({ clientId });
      setHeader(event, 'Content-Type', 'image/svg+xml');
      return svg;
    }))
    .get('/api/agent/clients/:clientId/qrcode.svg', defineEventHandler(async (event) => {
      const clientId = getRouterParam(event, 'clientId');
      console.log(`[AGENT] QR Code request (with .svg) for: ${clientId}`);
      const svg = await WireGuard.getClientQRCodeSVG({ clientId });
      setHeader(event, 'Content-Type', 'image/svg+xml');
      return svg;
    }))
    .get('/api/agent/clients/:clientId/config', defineEventHandler(async (event) => {
      const clientId = getRouterParam(event, 'clientId');
      console.log(`[AGENT] Config download request for: ${clientId}`);
      return await WireGuard.getClientConfiguration({ clientId });
    }))
    .get('/api/agent/clients/:clientId/configuration', defineEventHandler(async (event) => {
      const clientId = getRouterParam(event, 'clientId');
      console.log(`[AGENT] Config download request (fallback) for: ${clientId}`);
      return await WireGuard.getClientConfiguration({ clientId });
    }))
    .post('/api/agent/awg-settings', defineEventHandler(async (event) => {
        const settings = await readBody(event);
        return await WireGuard.updateAwgSettings(settings);
      }));

    // Static assets
    const publicDir = '/app/www';
    app.use(
      defineEventHandler((event) => {
        return serveStatic(event, {
          getContents: (id) => {
            return readFile(safePathJoin(publicDir, id));
          },
          getMeta: async (id) => {
            const filePath = safePathJoin(publicDir, id);

            const stats = await stat(filePath).catch(() => {});
            if (!stats || !stats.isFile()) {
              return;
            }

            if (id.endsWith('.html')) setHeader(event, 'Content-Type', 'text/html');
            if (id.endsWith('.js')) setHeader(event, 'Content-Type', 'application/javascript');
            if (id.endsWith('.json')) setHeader(event, 'Content-Type', 'application/json');
            if (id.endsWith('.css')) setHeader(event, 'Content-Type', 'text/css');
            if (id.endsWith('.png')) setHeader(event, 'Content-Type', 'image/png');
            if (id.endsWith('.svg')) setHeader(event, 'Content-Type', 'image/svg+xml');

            return {
              size: stats.size,
              mtime: stats.mtimeMs,
            };
          },
        });
      }),
    );

    createServer(toNodeListener(app)).listen(PORT, WEBUI_HOST);
    debug(`Listening on http://${WEBUI_HOST}:${PORT}`);

    cronJobEveryMinute();
  }

};
