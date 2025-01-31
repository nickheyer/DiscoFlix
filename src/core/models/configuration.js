const BaseModel = require('./base');

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
      is_radarr_enabled: true,
      is_sonarr_enabled: true,
      is_trailers_enabled: true
    };
  }

  async get(include = {}) {
    return this.getSingleton(this.defaults, include);
  }

  async update(fields = {}, include = {}) {
    this.logger.info('Updating configuration:', fields);
    return this.base.updateSingleton(fields, include)
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

  async toggleRadarr() {
    const config = await this.get();
    return this.update({ is_radarr_enabled: !config.is_radarr_enabled });
  }

  async toggleSonarr() {
    const config = await this.get();
    return this.update({ is_sonarr_enabled: !config.is_sonarr_enabled });
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

  async updateTokens({ discord, radarr, sonarr }) {
    const updates = {};
    if (discord) updates.discord_token = discord;
    if (radarr) updates.radarr_token = radarr;
    if (sonarr) updates.sonarr_token = sonarr;
    return this.update(updates);
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
