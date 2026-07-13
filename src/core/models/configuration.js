const BaseModel = require('./base');
const { hashPassword, isHashed } = require('./passwords');

class Configuration extends BaseModel {
  constructor(core) {
    super(core, 'Configuration');
    this.defaults = {
      media_server_name: "The Server",
      prefix_keyword: "!df",
      session_timeout: 60,
      max_check_time: 600,
      max_results: 0,
      max_seasons_for_non_admin: 0,
      is_debug: false,
      is_trailers_enabled: true,
      is_dm_notifications: false,
      bot_presence_activity: "none",
      bot_presence_text: "",
      request_access: "open",
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

  async toggleTrailers() {
    const config = await this.get();
    return this.update({ is_trailers_enabled: !config.is_trailers_enabled });
  }

  async updateMediaServer(name) {
    return this.update({ media_server_name: name });
  }

  async updatePrefixKeyword(prefix) {
    return this.update({ prefix_keyword: prefix });
  }

  async updateLimits({ session, check, results, seasons }) {
    const updates = {};
    if (session) updates.session_timeout = session;
    if (check) updates.max_check_time = check;
    if (results) updates.max_results = results;
    if (seasons) updates.max_seasons_for_non_admin = seasons;
    return this.update(updates);
  }
}

module.exports = Configuration;
