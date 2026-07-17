// SERVICES APPLY QUEUE VERBS ASYNC - BRIEF PAUSE SO THE RE-PULL SEES THE RESULT
const QUEUE_SETTLE_MS = 300;

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
  // IMMEDIATELY. RETURNS null WHEN THE INSTANCE ISN'T FULLY CONFIGURED OR ITS
  // MANIFEST HAS NO SERVICE CLIENT AT ALL (THE DISCOFLIX SELF APP).
  getClientForInstance(row) {
    if (!row || !this.isConfigured(row)) return null;
    const manifest = this.getType(row.app_type);
    if (typeof manifest.buildClient !== 'function') return null;
    return manifest.buildClient(row, this.logger);
  },

  // DISCOFLIX'S OWN App ROW - THE DISCORD BADGE'S TAKEOVER TARGET, CREATED ON
  // FIRST USE. HIDDEN FROM THE RAIL/PICKER, EXEMPT FROM SORT AND ROUTING.
  async getSelfInstance() {
    const existing = await this.core.models.app.get({ app_type: 'discoflix' });
    if (existing) return existing;
    return this.core.prisma.app.create({
      data: {
        app_type: 'discoflix',
        display_name: 'DiscoFlix',
        enabled: true,
        is_default: false,
        sort_position: -1,
        active_section: 'overview'
      }
    });
  },

  // THE HOME BADGE'S ALERT DOT: DEFINITE FAILURES ONLY - THE BOT SUPPOSED TO
  // BE ON BUT OFFLINE, OR A SERVING INSTANCE THE HEARTBEAT CANNOT REACH
  countSelfProblems(rows, state) {
    let problems = 0;
    if (state.discord_state && !(this.core.client && this.core.client.isReady())) problems++;
    for (const row of rows) {
      if (this.getType(row.app_type)?.hidden) continue;
      if (!row.enabled || !this.isConfigured(row)) continue;
      if (this.statusCache.get(row.id)?.ok === false) problems++;
    }
    return problems;
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

  // CONTENT TYPES THAT CURRENTLY HAVE A SERVING INSTANCE - DRIVES WHICH
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

  // EVERY APP TYPE WHOSE MANIFEST SHARES A CONTENT TYPE WITH appType - PEERS
  // COMPETE FOR is_default ROUTING (A TYPE ALWAYS COUNTS AS ITS OWN PEER).
  // AI PROVIDERS SHARE NO CONTENT TYPES BUT COMPETE ALL THE SAME - THE
  // DEFAULT ONE ANSWERS CHAT, EXACTLY LIKE A CONTENT FAMILY ROUTES REQUESTS.
  peerAppTypes(appType) {
    const manifest = this.getType(appType);
    if (manifest?.kind === 'ai-provider') {
      return this.allTypes().filter(type => type.kind === 'ai-provider').map(type => type.id);
    }
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
  // FAMILY BECOMES ITS DEFAULT; LANDS ON SETTINGS - NEW APPS NEED CONFIG FIRST
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
  // FORM FROM TOUCHING FIELDS ITS APP TYPE DOESN'T DECLARE. MANIFEST
  // instanceOptions LAND IN settings_json VIA PARTIAL UPDATE (computed IN
  // METADATA, SO FORM SEMANTICS CAN NEVER WIPE THEM)
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
    // A BLANK NAME WOULD BLANK THE RAIL TOOLTIP AND BANNER - KEEP THE OLD ONE
    if (!data.display_name || !String(data.display_name).trim()) {
      data.display_name = instance.display_name;
    }
    await this.core.models.app.safeUpdateOne(instance.id, data);

    const optionKeys = (manifest.instanceOptions || []).map(option => option.key);
    if (optionKeys.some(key => key in (body || {}))) {
      let settings = {};
      try { settings = JSON.parse(instance.settings_json || '{}'); } catch (err) { settings = {}; }
      for (const key of optionKeys) {
        if (key in body) settings[key] = String(body[key] || '');
      }
      await this.core.models.app.update(
        { id: instance.id },
        { settings_json: JSON.stringify(settings) }
      );
    }
    return this.getInstance(instance.id);
  },

  // DELETE AN INSTANCE: ITS QUEUE WATCHES AND HEARTBEAT/BROWSE CACHES GO WITH
  // IT. MediaRequest.appId AND State.active_app_id SetNull VIA THE SCHEMA
  async removeInstance(id) {
    this.stopWatchesForInstance(id);
    this.statusCache.delete(id);
    this.queueCache.delete(id);
    this.sessionsCache.delete(id);
    this.feedCache.delete(id);
    this.libraryCache.delete(id);
    return this.core.models.app.safeDelete(id);
  },

  // TEMPLATE-FACING VERB LISTS - EMPTY WHEN THE INSTANCE HAS NO USABLE CLIENT
  queueActionsFor(instance) {
    const client = this.getClientForInstance(instance);
    return client ? client.capabilities.queueActions : { item: [], queue: [] };
  },

  // RUN A QUEUE VERB THEN RE-PULL THE LIVE QUEUE SO EVERY FRAGMENT AGREES
  async performQueueAction(instance, verb, itemId = null) {
    const client = this.getClientForInstance(instance);
    const allowed = client ? client.capabilities.queueActions[itemId ? 'item' : 'queue'] : [];
    if (!allowed.includes(verb)) {
      throw new Error(`${instance.display_name} does not support '${verb}' here`);
    }
    await client.queueAction(verb, itemId);
    await new Promise(resolve => setTimeout(resolve, QUEUE_SETTLE_MS));
    try {
      this.queueCache.set(instance.id, await client.getQueue());
    } catch (err) {
      this.logger.debug(`${instance.display_name} queue re-pull failed: ${err.message}`);
    }
    return this.queueCache.get(instance.id) || [];
  },

  // SERVING DOWNLOAD CLIENTS THAT TAKE A PASTED LINK, GROUPED BY PROTOCOL -
  // RELEASE GRABS AND THE QUEUE'S ADD-BY-LINK BOTH ROUTE THROUGH THESE
  async getGrabTargets() {
    const rows = await this.core.models.app.getMany(
      { enabled: true },
      {},
      [{ is_default: 'desc' }, { sort_position: 'asc' }, { created_at: 'asc' }]
    );
    const targets = { torrent: [], usenet: [] };
    for (const row of rows) {
      const manifest = this.getType(row.app_type);
      if (manifest?.kind !== 'download-client' || !this.isConfigured(row)) continue;
      const client = this.getClientForInstance(row);
      if (!client?.capabilities.addByUrl || !targets[manifest.protocol]) continue;
      targets[manifest.protocol].push({ id: row.id, label: row.display_name });
    }
    return targets;
  },

  // HAND A MAGNET/TORRENT/NZB LINK TO A DOWNLOAD CLIENT AND REFRESH ITS QUEUE
  // CACHE SO THE TICKER AND ANY OPEN QUEUE SECTION SEE THE NEW ITEM
  async addDownloadTo(instance, url) {
    const client = this.getClientForInstance(instance);
    if (!client || !client.capabilities.addByUrl) {
      throw new Error(`${instance.display_name} cannot take a pasted link`);
    }
    await client.addDownload(url);
    await new Promise(resolve => setTimeout(resolve, QUEUE_SETTLE_MS));
    try {
      this.queueCache.set(instance.id, await client.getQueue());
    } catch (err) {
      this.logger.debug(`${instance.display_name} queue re-pull failed: ${err.message}`);
    }
    return this.queueCache.get(instance.id) || [];
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

  // RE-REGISTER SLASH COMMANDS AFTER APP CRUD - NO-OP WHEN THE BOT IS OFFLINE
  // (ready.js RE-REGISTERS ON EVERY LOGIN ANYWAY)
  async syncSlashCommands() {
    if (!this.core.client || !this.core.client.isReady()) return;
    const { buildSlashCommands } = require('../../bot/interactions');
    try {
      const commands = await buildSlashCommands(this.core);
      await this.core.client.application.commands.set(commands);
      this.logger.info(`Slash commands re-synced (${commands.length} registered)`);
    } catch (err) {
      this.logger.warn(`Slash command sync failed: ${err.message}`);
    }
  },

  // RAIL BUBBLE VIEW MODEL. REACHABILITY COMES FROM THE HEARTBEAT'S CACHE -
  // NEVER LIVE-CHECKED AT RENDER TIME (null = NOT CHECKED YET, BE OPTIMISTIC).
  // HIDDEN ENTRIES NEVER RENDER AS BUBBLES - THE DISCOFLIX ONE FEEDS THE HOME
  // BADGE (ACTIVE PILL + PROBLEM DOT) AND IS SYNTHESIZED UNTIL ITS ROW EXISTS.
  async getRailViewModel(state = null) {
    // state IS A MERGED VIEW SHAPE - THE ANONYMOUS DEFAULT CARRIES NO ACTIVE APP
    if (!state) state = await this.core.models.viewSession.viewStateOf(null);
    const rows = await this.getInstalled();
    const viewModels = rows.map(row => {
      const manifest = this.getType(row.app_type) || {};
      const status = this.statusCache.get(row.id);
      return {
        id: row.id,
        app_type: row.app_type,
        hidden: !!manifest.hidden,
        label: row.display_name,
        icon: manifest.icon || null,
        configured: this.isConfigured(row),
        enabled: row.enabled,
        reachable: status ? status.ok : null,
        active: state.active_app_id === row.id,
        problems: manifest.hidden ? this.countSelfProblems(rows, state) : 0
      };
    });
    if (!viewModels.some(vm => vm.app_type === 'discoflix')) {
      viewModels.push({
        id: null,
        app_type: 'discoflix',
        hidden: true,
        label: 'DiscoFlix',
        icon: null,
        configured: true,
        enabled: true,
        reachable: null,
        active: false,
        problems: this.countSelfProblems(rows, state)
      });
    }
    return viewModels;
  }
};
