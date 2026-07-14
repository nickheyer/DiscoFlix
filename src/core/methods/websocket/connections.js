const uuid = require('uuid');
const WebSocket = require('ws');
const _ = require('lodash');

module.exports = {
  // sessionId = THE df_view VIEW SESSION THE SOCKET'S BROWSER BELONGS TO
  addClient(ws, sessionId = null) {
    const metadata = { id: uuid.v4(), sessionId, color: Math.floor(Math.random() * 360) };
    this.connections.set(ws, metadata);
    this.logger.debug('Registered ws client:', metadata);
    return metadata;
  },

  removeClient(ws) {
    const metadata = this.connections.get(ws);
    this.connections.delete(ws);
    return metadata;
  },

  // OPEN SOCKETS GROUPED BY VIEW SESSION - COOKIELESS SOCKETS SHARE null
  liveSessionGroups() {
    const groups = new Map();
    for (const [client, metadata] of this.connections) {
      if (client.readyState !== WebSocket.OPEN) {
        this.connections.delete(client);
        continue;
      }
      const key = metadata.sessionId || null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(client);
    }
    return groups;
  },

  // MERGED VIEW SHAPES FOR EVERY CONNECTED SESSION (DEDUPED)
  async connectedViews() {
    const views = [];
    for (const sessionId of this.liveSessionGroups().keys()) {
      views.push(await this.core.models.viewSession.viewStateOf(sessionId));
    }
    return views;
  },

  async _sendTo(clients, data) {
    const sends = clients.map(client => new Promise((resolve) => {
      client.send(data, (err) => {
        if (err) this.logger.warn(`Failed to send to ws client: ${err.message}`);
        resolve();
      });
    }));
    await Promise.all(sends);
  },

  // GLOBAL BROADCAST - VIEW-INDEPENDENT FRAGMENTS ONLY (TICKER, MODAL ROWS)
  async emit(data) {
    const clients = [...this.liveSessionGroups().values()].flat();
    await this._sendTo(clients, data);
  },

  async emitCompiled(templateFiles = [], templateValues = {}) {
    const compiledTemplate = await this.core.render.compile(templateFiles, templateValues);
    this.logger.debug(`Sending:\nTemplates:\n${JSON.stringify(templateFiles, 4, 2)}\nWith Values:\n${JSON.stringify(_.keys(templateValues), 4, 2)}`);
    await this.emit(compiledTemplate);
  },

  // PER-VIEW BROADCAST - build(view) COMPILES FOR ONE SESSION'S WORLD AND MAY
  // RETURN null TO SKIP IT. ONE COMPILE SERVES EVERY SOCKET OF A SESSION, AND
  // ONE SESSION'S FAILURE NEVER TAKES DOWN THE REST.
  async emitPerView(build) {
    for (const [sessionId, clients] of this.liveSessionGroups()) {
      let html;
      try {
        const view = await this.core.models.viewSession.viewStateOf(sessionId);
        html = await build(view);
      } catch (err) {
        this.logger.warn(`Per-view emit failed for session ${sessionId}: ${err.message}`);
        continue;
      }
      if (!html) continue;
      await this._sendTo(clients, html);
    }
  },

  // TARGETED SEND - EVERY SOCKET OF ONE VIEW SESSION
  async emitToSession(sessionId, data) {
    if (!sessionId || !data) return;
    const clients = this.liveSessionGroups().get(sessionId) || [];
    await this._sendTo(clients, data);
  },

  async emitToSessions(sessionIds = [], data) {
    const wanted = new Set(sessionIds.filter(Boolean));
    if (!wanted.size || !data) return;
    const groups = this.liveSessionGroups();
    const clients = [];
    for (const id of wanted) clients.push(...(groups.get(id) || []));
    await this._sendTo(clients, data);
  }
};
