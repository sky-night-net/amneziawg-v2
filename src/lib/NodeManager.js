'use strict';

const fs = require('node:fs/promises');
const path = require('path');
const { WG_PATH, HUB_TOKEN } = require('../config');
const axios = require('axios');
const debug = require('debug')('NodeManager');

const NODES_FILE = path.join(WG_PATH, 'nodes.json');

module.exports = class NodeManager {
  constructor() {
    const { NODE_NAME } = process.env;
    this.nodes = [];
    this.localNode = {
      id: 'local',
      name: NODE_NAME || 'Local Hub',
      url: 'local',
      token: HUB_TOKEN,
      active: true,
    };
  }

  async loadNodes() {
    try {
      const data = await fs.readFile(NODES_FILE, 'utf8');
      this.nodes = JSON.parse(data);
    } catch (err) {
      this.nodes = [this.localNode];
      try {
        await this.saveNodes();
      } catch (saveErr) {
        debug(`Could not save nodes.json, WG_PATH might not exist yet: ${saveErr.message}`);
      }
    }
    return this.nodes;
  }

  async saveNodes() {
    try {
      await fs.mkdir(WG_PATH, { recursive: true });
    } catch (e) {
      // Ignore directory exists error
    }
    await fs.writeFile(NODES_FILE, JSON.stringify(this.nodes, null, 2));
  }

  async addNode({ name, url, token }) {
    const id = require('node:crypto').randomBytes(4).toString('hex');
    this.nodes.push({ id, name, url, token, active: true });
    await this.saveNodes();
    return { id };
  }

  async removeNode(id) {
    if (id === 'local') throw new Error('Cannot remove local node');
    this.nodes = this.nodes.filter(n => n.id !== id);
    await this.saveNodes();
  }

  async getNode(id) {
    if (this.nodes.length <= 1) await this.loadNodes();
    const node = this.nodes.find(n => n.id === id);
    if (!node) throw new Error(`Node not found: ${id}`);
    return node;
  }

  async callAgent(nodeId, endpoint, method = 'get', data = {}) {
    const node = await this.getNode(nodeId);
    if (node.url === 'local') {
      // Direct call to local WireGuard instance (to be handled by Hub logic)
      return { local: true };
    }

    try {
      const fullUrl = `${node.url.replace(/\/$/, '')}${endpoint}`;
      console.log(`[HUB] Forwarding ${method.toUpperCase()} request to node "${node.name}" (${nodeId}) at: ${fullUrl}`);
      const response = await axios({
        method,
        url: fullUrl,
        headers: {
          'Authorization': `Bearer ${node.token || HUB_TOKEN}`,
        },
        data,
      });
      return response.data;
    } catch (err) {
      debug(`Agent call failed: ${err.message}`);
      throw new Error(`Agent ${node.name} unreachable: ${err.message}`);
    }
  }
};
