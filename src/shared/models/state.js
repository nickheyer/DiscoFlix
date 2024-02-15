class State {
  constructor(core) {
    this.core = core;
    this.prisma = core.prisma;
    this.logger = core.logger;
  }

  async get(options = {}) {
    return await this.prisma.state.findFirst(options) ||
    await this.prisma.state.create();
  }

  async update(fields = {}) {
    this.logger.debug('Updating Prisma State: ', fields);
    return await this.prisma.state.update({
      where: { id: 1 },
      data: fields,
    });
  }

  async getActive(state = null) {
    if (!state) {
      state = await this.get({
        include: { activeServer: true }
      });
    }
    return state.activeServer;
  }

  async changeActive(active_server_id = null) {
    if (!active_server_id) {
      const firstServer = await this.prisma.discordServer.findFirst();
      active_server_id = firstServer ? firstServer.server_id : null;
    }
  
    const updatedState = await this.prisma.state.update({
      where: { id: 1 },
      data: { active_server_id },
    });
  
    return updatedState;
  }
}

module.exports = State;
