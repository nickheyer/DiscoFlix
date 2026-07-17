const BaseModel = require('./base');
const { hashPassword, isHashed } = require('./passwords');

class Configuration extends BaseModel {
  constructor(core) {
    super(core, 'Configuration');
    // BOT BEHAVIOR (LIMITS, ACCESS, TOGGLES) LIVES ON BotFeatureRule NOW -
    // ONLY IDENTITY/INFRA SETTINGS AND THE ROLE->TIER MAPPING REMAIN HERE
    this.defaults = {
      media_server_name: "The Server",
      prefix_keyword: "!df",
      is_debug: false,
      bot_presence_activity: "none",
      bot_presence_text: "",
      whitelist_role_ids: "",
      staff_role_ids: "",
      admin_role_ids: ""
    };
  }

  async get(include = {}) {
    return this.getSingleton(this.defaults, include);
  }

  // THE ADMIN PASSWORD IS NEVER STORED IN THE CLEAR
  _hashAdminPassword(fields) {
    if (fields.admin_password && !isHashed(fields.admin_password)) {
      return { ...fields, admin_password: hashPassword(fields.admin_password) };
    }
    return fields;
  }

  async safeUpdateOne(pk, data) {
    return super.safeUpdateOne(pk, this._hashAdminPassword(data));
  }

  async safeUpsertOne(data) {
    return super.safeUpsertOne(this._hashAdminPassword(data));
  }

  async update(fields = {}, include = {}) {
    fields = this._hashAdminPassword(fields);
    this.logger.info('Updating configuration:', Object.keys(fields));
    return this.updateSingleton(fields, include)
      .then(config => {
        this.logger.info('Configuration updated successfully');
        return config;
      })
      .catch(error => {
        this.logger.error('Failed to update configuration:', error);
        throw error;
      });
  }

  // HELPERS
  async toggleDebug() {
    const config = await this.get();
    return this.update({ is_debug: !config.is_debug });
  }
}

module.exports = Configuration;
