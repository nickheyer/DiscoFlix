// DB-BACKED INSTANCE HELPERS. AN "INSTANCE" IS AN App ROW; ITS app_type KEYS
// INTO THE MANIFEST REGISTRY (MERGED INTO THIS NAMESPACE, SO this.getType ETC.)
module.exports = {
  async getInstalled() {
    return this.core.models.app.getInstalled();
  },

  async getInstance(id) {
    if (!id) return null;
    return this.core.models.app.get({ id });
  },

  isConfigured(row) {
    const manifest = this.getType(row.app_type);
    if (!manifest) return false;
    return manifest.configFields
      .filter(field => field.required)
      .every(field => !!row[field.key]);
  },

  // CLIENTS ARE BUILT PER-USE FROM THE ROW SO SETTINGS CHANGES APPLY
  // IMMEDIATELY. RETURNS null WHEN THE INSTANCE ISN'T FULLY CONFIGURED.
  getClientForInstance(row) {
    if (!row || !this.isConfigured(row)) return null;
    return this.getType(row.app_type).buildClient(row, this.logger);
  },

  // ENABLED + CONFIGURED INSTANCES PROVIDING A CONTENT TYPE, ROUTING ORDER:
  // DEFAULT FIRST, THEN RAIL ORDER
  async instancesForContentType(contentType) {
    const def = this.contentTypeDefs().find(d => d.type === contentType);
    if (!def) return [];
    const rows = await this.core.models.app.getMany(
      { app_type: { in: def.appTypes }, enabled: true },
      {},
      [{ is_default: 'desc' }, { sort_position: 'asc' }, { created_at: 'asc' }]
    );
    return rows.filter(row => this.isConfigured(row));
  },

  async defaultInstanceFor(contentType) {
    const instances = await this.instancesForContentType(contentType);
    return instances[0] || null;
  },

  // CONTENT TYPES THAT CURRENTLY HAVE A SERVING INSTANCE — DRIVES WHICH
  // SLASH COMMANDS GET REGISTERED
  async enabledContentTypes() {
    const rows = await this.core.models.app.getMany({ enabled: true });
    const types = new Set();
    for (const row of rows) {
      if (!this.isConfigured(row)) continue;
      for (const contentType of this.getType(row.app_type)?.contentTypes || []) {
        types.add(contentType.type);
      }
    }
    return [...types];
  },

  // EVERY APP TYPE WHOSE MANIFEST SHARES A CONTENT TYPE WITH appType — PEERS
  // COMPETE FOR is_default ROUTING (A TYPE ALWAYS COUNTS AS ITS OWN PEER)
  peerAppTypes(appType) {
    const myTypes = (this.getType(appType)?.contentTypes || []).map(ct => ct.type);
    const peers = new Set([appType]);
    for (const def of this.contentTypeDefs()) {
      if (myTypes.includes(def.type)) def.appTypes.forEach(t => peers.add(t));
    }
    return [...peers];
  },

  // AT MOST ONE DEFAULT PER CONTENT-TYPE FAMILY: CLEAR is_default ON EVERY
  // INSTANCE WHOSE MANIFEST SHARES ANY CONTENT TYPE WITH THE TARGET
  async setDefaultInstance(id) {
    const row = await this.getInstance(id);
    if (!row) throw new Error('APP_NOT_FOUND');

    await this.core.prisma.$transaction([
      this.core.prisma.app.updateMany({
        where: { app_type: { in: this.peerAppTypes(row.app_type) } },
        data: { is_default: false }
      }),
      this.core.prisma.app.update({ where: { id }, data: { is_default: true } })
    ]);
    return this.getInstance(id);
  },

  // ── ADD / CONFIGURE / REMOVE (THE PICKER + SETTINGS-SECTION FLOWS) ──────

  // CREATE AN App ROW FOR A MANIFEST TYPE. NAMES DISAMBIGUATE LIKE GUILD
  // CHANNELS ("Radarr", "Radarr 2", ...); THE FIRST INSTANCE IN A CONTENT-TYPE
  // FAMILY BECOMES ITS DEFAULT; LANDS ON SETTINGS — NEW APPS NEED CONFIG FIRST
  async installType(appType) {
    const manifest = this.getType(appType);
    if (!manifest) return null;

    const rows = await this.getInstalled();
    const names = new Set(rows.map(row => row.display_name));
    let displayName = manifest.label;
    for (let n = 2; names.has(displayName); n++) displayName = `${manifest.label} ${n}`;

    const peers = this.peerAppTypes(appType);
    return this.core.prisma.app.create({
      data: {
        app_type: appType,
        display_name: displayName,
        enabled: true,
        is_default: !rows.some(row => peers.includes(row.app_type)),
        sort_position: await this.core.models.app.nextSortPosition(),
        active_section: 'settings'
      }
    });
  },

  // MANIFEST-WHITELISTED FORM SAVE. safeUpdateOne ALREADY KEEPS SENSITIVE
  // FIELDS ON BLANK AND CLEARS THEM VIA `<key>__clear`; THE WHITELIST STOPS A
  // FORM FROM TOUCHING FIELDS ITS APP TYPE DOESN'T DECLARE
  async saveInstanceConfig(instance, body) {
    const manifest = this.getType(instance.app_type);
    const allowed = new Set(['display_name', 'enabled']);
    for (const field of manifest.configFields) {
      allowed.add(field.key);
      if (field.sensitive) allowed.add(`${field.key}__clear`);
    }

    const data = {};
    for (const [key, value] of Object.entries(body || {})) {
      if (allowed.has(key)) data[key] = value;
    }
    // A BLANK NAME WOULD BLANK THE RAIL TOOLTIP AND BANNER — KEEP THE OLD ONE
    if (!data.display_name || !String(data.display_name).trim()) {
      data.display_name = instance.display_name;
    }
    return this.core.models.app.safeUpdateOne(instance.id, data);
  },

  // DELETE AN INSTANCE: ITS QUEUE WATCHES AND HEARTBEAT CACHES GO WITH IT.
  // MediaRequest.appId AND State.active_app_id SetNull VIA THE SCHEMA
  async removeInstance(id) {
    this.stopWatchesForInstance(id);
    this.statusCache.delete(id);
    this.queueCache.delete(id);
    return this.core.models.app.safeDelete(id);
  },

  async testInstance(rowOrId) {
    const row = typeof rowOrId === 'string' ? await this.getInstance(rowOrId) : rowOrId;
    if (!row) return { ok: false, error: 'App not found' };
    const client = this.getClientForInstance(row);
    if (!client) return { ok: false, error: `${row.display_name} is not fully configured` };

    let result;
    try {
      const status = await client.getStatus();
      result = { ok: true, version: status.version };
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    this.statusCache.set(row.id, { ...result, checkedAt: Date.now() });
    return result;
  },

  // RE-REGISTER SLASH COMMANDS AFTER APP CRUD — NO-OP WHEN THE BOT IS OFFLINE
  // (ready.js RE-REGISTERS ON EVERY LOGIN ANYWAY)
  async syncSlashCommands() {
    if (!this.core.client || !this.core.client.isReady()) return;
    const { buildSlashCommands } = require('../../bot/commands');
    try {
      const commands = await buildSlashCommands(this.core);
      await this.core.client.application.commands.set(commands);
      this.logger.info(`Slash commands re-synced (${commands.length} registered)`);
    } catch (err) {
      this.logger.warn(`Slash command sync failed: ${err.message}`);
    }
  },

  // RAIL BUBBLE VIEW MODEL. REACHABILITY COMES FROM THE HEARTBEAT'S CACHE —
  // NEVER LIVE-CHECKED AT RENDER TIME (null = NOT CHECKED YET, BE OPTIMISTIC)
  async getRailViewModel(state = null) {
    if (!state) state = await this.core.models.state.get();
    const rows = await this.getInstalled();
    return rows.map(row => {
      const manifest = this.getType(row.app_type) || {};
      const status = this.statusCache.get(row.id);
      return {
        id: row.id,
        app_type: row.app_type,
        label: row.display_name,
        icon: manifest.icon || null,
        configured: this.isConfigured(row),
        enabled: row.enabled,
        reachable: status ? status.ok : null,
        active: state.active_app_id === row.id
      };
    });
  }
};
