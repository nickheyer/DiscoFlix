// SETTINGS SEED FROM THE ENVIRONMENT - THE HEADLESS FIRST-BOOT PATH. RUNS
// ONCE PER PROCESS, FILLS ONLY EMPTY SETTINGS, AND NEVER CLOBBERS UI EDITS.
// APP VARS ARE MANIFEST-DERIVED (<TYPE>_<FIELD>, e.g. RADARR_URL,
// RADARR_API_KEY, QBITTORRENT_USERNAME - AND <TYPE>_<OPTION> FOR INSTANCE
// OPTIONS, e.g. DF_OPENAI_MODEL) AND ADDRESS ONE INSTANCE PER TYPE -
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
    // AI PROVIDERS DECLARE A DF_-NAMESPACED PREFIX - A GLOBALLY-EXPORTED
    // ANTHROPIC_API_KEY/OPENAI_API_KEY (COMMON FOR OTHER TOOLING) MUST NEVER
    // SURPRISE-INSTALL AN INSTANCE
    const prefix = (manifest.envPrefix || manifest.id).toUpperCase();
    const envValues = {};
    for (const field of manifest.configFields) {
      const value = (process.env[`${prefix}_${field.key.toUpperCase()}`] || '').trim();
      if (value) envValues[field.key] = value;
    }
    // INSTANCE OPTIONS (MODEL PICKS, ROOT FOLDERS...) SEED THE SAME
    // MANIFEST-DERIVED WAY - DF_OPENAI_MODEL, RADARR_ROOT_FOLDER - BUT LAND
    // IN settings_json INSTEAD OF COLUMNS
    const envOptions = {};
    for (const option of manifest.instanceOptions || []) {
      const value = (process.env[`${prefix}_${option.key.toUpperCase()}`] || '').trim();
      if (value) envOptions[option.key] = value;
    }
    if (!Object.keys(envValues).length && !Object.keys(envOptions).length) return;

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
    // OPTION PICKS FOLLOW THE SAME FILL-ONLY-EMPTY RULE, MERGE-WRITTEN SO
    // SIBLING settings_json KEYS (DIRECTIVE OVERRIDES...) SURVIVE
    let settings = {};
    try { settings = JSON.parse(instance.settings_json || '{}'); } catch (err) { settings = {}; }
    const seededOptions = Object.entries(envOptions).filter(([key]) => !settings[key]);
    if (seededOptions.length) {
      data.settings_json = JSON.stringify({ ...settings, ...Object.fromEntries(seededOptions) });
    }
    // A FRESH ENV-BUILT INSTANCE SKIPS THE CONFIG-FIRST LANDING - IT HAS CONFIG
    if (created) data.active_section = 'overview';
    if (!Object.keys(data).length) return;

    await this.core.models.app.update({ id: instance.id }, data);
    const seededKeys = Object.keys(data)
      .filter(key => key !== 'active_section' && key !== 'settings_json')
      .concat(seededOptions.map(([key]) => key));
    if (!seededKeys.length) return;
    this.logger.info(`Seeded ${manifest.label} from env${created ? ' (new instance)' : ''}: ${seededKeys.join(', ')}`);
  }
};
