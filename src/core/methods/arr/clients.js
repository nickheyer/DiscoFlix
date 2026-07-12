const RadarrClient = require('./radarrClient');
const SonarrClient = require('./sonarrClient');

const SERVICES = {
  radarr: { Client: RadarrClient, urlField: 'radarr_url', tokenField: 'radarr_token', enabledField: 'is_radarr_enabled' },
  sonarr: { Client: SonarrClient, urlField: 'sonarr_url', tokenField: 'sonarr_token', enabledField: 'is_sonarr_enabled' }
};

module.exports = {
  // CLIENTS ARE BUILT PER-USE FROM CONFIG SO SETTINGS-MODAL CHANGES APPLY
  // IMMEDIATELY. RETURNS null WHEN THE SERVICE ISN'T FULLY CONFIGURED.
  getClientFor(service, config) {
    const serviceDef = SERVICES[service];
    if (!serviceDef) throw new Error(`Unknown arr service: ${service}`);

    const url = config[serviceDef.urlField];
    const token = config[serviceDef.tokenField];
    if (!url || !token) return null;

    return new serviceDef.Client({ url, token, logger: this.logger });
  },

  async getClient(service) {
    const config = await this.core.models.configuration.get();
    return this.getClientFor(service, config);
  },

  isServiceEnabled(service, config) {
    return !!config[SERVICES[service].enabledField];
  },

  async testConnection(service) {
    try {
      const client = await this.getClient(service);
      if (!client) return { ok: false, error: `${service} URL/token not configured` };
      const status = await client.getStatus();
      return { ok: true, version: status.version };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
};
