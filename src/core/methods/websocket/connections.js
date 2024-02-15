const uuid = require('uuid');


module.exports = {
  addClientWS(ws) {
    const id = uuid.v4();
    const color = Math.floor(Math.random() * 360);
    const metadata = { id, color };
    this.connections.set(ws, metadata);
    this.logger.debug('Adding ws client to CoreService.connections: ', metadata);
  },

  async emit(data) {
    await Promise.all([...this.connections.keys()].map(async (client) => {
      this.logger.debug('Sent data to ws client: ', data);
      await client.send(data);
    }));
  },

  async emitCompiled(templateFiles = [], templateValues = {}) {
    const compiledTemplate = await this.compile(templateFiles, templateValues);
    this.logger.debug(compiledTemplate);
    await this.emit(compiledTemplate);
  }
}