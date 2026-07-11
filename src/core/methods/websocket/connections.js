const uuid = require('uuid');
const WebSocket = require('ws');
const _ = require('lodash');

module.exports = {
  addClient(ws) {
    const metadata = { id: uuid.v4(), color: Math.floor(Math.random() * 360) };
    this.connections.set(ws, metadata);
    this.logger.debug('Registered ws client:', metadata);
    return metadata;
  },

  removeClient(ws) {
    const metadata = this.connections.get(ws);
    this.connections.delete(ws);
    return metadata;
  },

  async emit(data) {
    const sends = [];
    for (const client of this.connections.keys()) {
      if (client.readyState !== WebSocket.OPEN) {
        this.connections.delete(client);
        continue;
      }
      sends.push(new Promise((resolve) => {
        client.send(data, (err) => {
          if (err) this.logger.warn(`Failed to send to ws client: ${err.message}`);
          resolve();
        });
      }));
    }
    await Promise.all(sends);
  },

  async emitCompiled(templateFiles = [], templateValues = {}) {
    const compiledTemplate = await this.core.render.compile(templateFiles, templateValues);
    this.logger.debug(`Sending:\nTemplates:\n${JSON.stringify(templateFiles, 4, 2)}\nWith Values:\n${JSON.stringify(_.keys(templateValues), 4, 2)}`);
    await this.emit(compiledTemplate);
  }
};
