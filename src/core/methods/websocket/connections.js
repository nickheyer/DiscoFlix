const uuid = require('uuid');
const _ = require('lodash');

module.exports =  {
  addClientWS(ws) {
    const id = uuid.v4();
    const color = Math.floor(Math.random() * 360);
    const metadata = { id, color };
    this.connections.set(ws, metadata);
    this.logger.debug('Adding ws client to CoreService.connections: ', metadata);
  },

  async emit(data) {
    await Promise.all([...this.connections.keys()].map(async (client) => {
      this.logger.debug(`Sent data to ws client`);
      await client.send(data);
    }));
  },

  async emitCompiled(templateFiles = [], templateValues = {}) {
    const compiledTemplate = await this.compile(templateFiles, templateValues);
    this.logger.debug(`Sending:\nTemplates:\n${JSON.stringify(templateFiles, 4, 2)}\nWith Values:\n${JSON.stringify(_.keys(templateValues), 4, 2)}`);
    await this.emit(compiledTemplate);
  }
};
