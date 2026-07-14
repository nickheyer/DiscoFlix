const BaseModel = require('./base');

// GLOBAL PROCESS STATE ONLY (BOT POWER) - PER-BROWSER VIEW STATE LIVES ON
// ViewSession ROWS KEYED BY THE df_view COOKIE
class State extends BaseModel {
  constructor(core) {
    super(core, 'State');
    this.defaults = {
      discord_state: false
    };
  }

  async get() {
    return this.getSingleton(this.defaults);
  }

  async update(fields = {}) {
    this.logger.debug('Updating State:', fields);
    const current = await this.get();
    return this.model.update({
      where: { id: current.id },
      data: fields
    }).catch(err => {
      this.logger.error(`Error updating ${this.modelName}:`, err);
      throw err;
    });
  }

  async toggleDiscordState() {
    const state = await this.get();
    return this.update({ discord_state: !state.discord_state });
  }
}

module.exports = State;
