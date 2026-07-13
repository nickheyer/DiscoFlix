// SETTINGS SEED FROM THE ENVIRONMENT - THE HEADLESS FIRST-BOOT PATH. RUNS
// ONCE PER PROCESS, FILLS ONLY EMPTY SETTINGS, AND NEVER CLOBBERS UI EDITS.
// APP VARS ARE MANIFEST-DERIVED (<TYPE>_<FIELD>, e.g. RADARR_URL,
// RADARR_API_KEY, QBITTORRENT_USERNAME) AND ADDRESS ONE INSTANCE PER TYPE -
// MULTI-INSTANCE SETUPS ARE CONFIGURED IN THE UI, ENV VARS CAN'T NAME THEM.
module.exports = {
  async seedFromEnv() {
    if (!this._envSeedPromise) this._envSeedPromise = this._runEnvSeed();
    return this._envSeedPromise;
  },

  async _runEnvSeed() {
    try {
      await this._seedDiscordToken();
      for (const manifest of this.allTypes()) {
        await this._seedAppType(manifest);
      }
    } catch (err) {
      this.logger.error('Env settings seed failed:', err);
    }
  },

  async _seedDiscordToken() {
    const token = (process.env.DISCORD_TOKEN || '').trim();
    if (!token) return;
    const config = await this.core.models.configuration.get();
    if (config.discord_token) return;
    await this.core.models.configuration.update({ discord_token: token });
    this.logger.info('Seeded Discord bot token from DISCORD_TOKEN');
  },

  async _seedAppType(manifest) {
    const prefix = manifest.id.toUpperCase();
    const envValues = {};
    for (const field of manifest.configFields) {
      const value = (process.env[`${prefix}_${field.key.toUpperCase()}`] || '').trim();
      if (value) envValues[field.key] = value;
    }
    if (!Object.keys(envValues).length) return;

    const rows = await this.core.models.app.getMany({ app_type: manifest.id });
    if (rows.length > 1) {
      this.logger.warn(`Ignoring ${prefix}_* env vars - ${rows.length} ${manifest.label} instances exist, configure them in the UI`);
      return;
    }

    const created = rows.length === 0;
    const instance = rows[0] || await this.installType(manifest.id);

    const data = {};
    for (const [key, value] of Object.entries(envValues)) {
      if (!instance[key]) data[key] = value;
    }
    // A FRESH ENV-BUILT INSTANCE SKIPS THE CONFIG-FIRST LANDING - IT HAS CONFIG
    if (created) data.active_section = 'overview';
    if (!Object.keys(data).length) return;

    await this.core.models.app.update({ id: instance.id }, data);
    const seededKeys = Object.keys(data).filter(key => key !== 'active_section');
    this.logger.info(`Seeded ${manifest.label} from env${created ? ' (new instance)' : ''}: ${seededKeys.join(', ')}`);
  }
};
