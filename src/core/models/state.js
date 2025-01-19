const BaseModel = require('./base');

class State extends BaseModel {
  constructor(core) {
    super(core, 'State');
    this.defaults = {
      discord_state: false,
      sidebar_exp_state: true,
      active_server_id: null
    };
  }

  async get(include = {}) {
    const defaultInclude = {
      activeServer: Boolean(include?.activeServer)
    };

    return this.getSingleton(this.defaults, defaultInclude);
  }

  async update(fields = {}, include = {}) {
    this.logger.debug('Updating State:', fields);
    const current = await this.get();
    return this.model.update({
        where: { id: current.id },
        data: fields,
        include,
    }).catch(err => {
        this.logger.error(`Error updating ${this.modelName}:`, err);
        throw err;
    });
}

  // HELPERS
  async toggleDiscordState() {
    const state = await this.get();
    return this.update({ discord_state: !state.discord_state });
  }

  async toggleSidebar() {
    const state = await this.get();
    return this.update({ sidebar_exp_state: !state.sidebar_exp_state });
  }

  async reset() {
    return this.update(this.defaults);
  }

  async getActiveServer(state = null) {
    if (!state) {
      state = await this.get({ activeServer: true });
    }
    return state.activeServer;
  }

  async changeActive(active_server_id = null) {
    if (!active_server_id) {
      const firstServer = await this.prisma.discordServer.findFirst({
        orderBy: { sort_position: 'asc' }
      });
      active_server_id = firstServer?.server_id ?? null;
    }
    
    return this.update({ active_server_id });
  }
}

module.exports = State;
