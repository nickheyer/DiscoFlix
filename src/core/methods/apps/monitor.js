const POLL_INTERVAL_MS = 15 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_BOOT_DELAY_MS = 5 * 1000;

// TWO TIMERS LIVE HERE:
// - THE WATCH MONITOR (15s, SELF-CLEARING): TRACKS OPEN MediaRequests THROUGH
//   AN INSTANCE'S QUEUE UNTIL IMPORT — DISCORD NOTIFY + DASHBOARD ROW PUSH.
// - THE HEARTBEAT (60s, ALWAYS-ON, unref'D): REFRESHES statusCache/queueCache
//   FOR EVERY CONFIGURED+ENABLED INSTANCE AND BROADCASTS RAIL DOTS / TICKER /
//   QUEUE-SECTION FRAGMENTS WHEN SOMETHING ACTUALLY CHANGED.
module.exports = {
  watchRequest({ requestId, appId, arrId, mediaId, title, channelId, requesterIds }) {
    this.watches.set(requestId, {
      requestId,
      appId,
      arrId,
      mediaId,
      title,
      channelId: channelId || null, // null = CONSOLE-INITIATED, NO DISCORD NOTIFY
      requesterIds: requesterIds || [],
      stage: 'pending',
      startedAt: Date.now()
    });
    this.logger.info(`Watching app queue for request ${requestId} (${title})`);
    this._ensureMonitorTimer();
  },

  stopWatch(requestId) {
    this.watches.delete(requestId);
  },

  stopWatchesForInstance(appId) {
    let dropped = 0;
    for (const [requestId, watch] of this.watches) {
      if (watch.appId === appId) {
        this.watches.delete(requestId);
        dropped++;
      }
    }
    if (dropped) this.logger.info(`Dropped ${dropped} watches for removed app ${appId}`);
  },

  _ensureMonitorTimer() {
    if (this._monitorTimer) return;
    this._monitorTimer = setInterval(() => {
      this._monitorTick().catch(err => this.logger.error('App monitor tick failed:', err));
    }, POLL_INTERVAL_MS);
  },

  async _monitorTick() {
    if (this.watches.size === 0) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
      return;
    }

    // DISCORD-BOUND WATCHES PAUSE WHILE THE BOT IS OFFLINE (THEIR NOTIFICATIONS
    // WOULD BE LOST); CONSOLE-INITIATED (NULL-CHANNEL) WATCHES KEEP MOVING
    const botReady = !!(this.core.client && this.core.client.isReady());

    const config = await this.core.models.configuration.get();
    const byInstance = new Map();
    for (const watch of this.watches.values()) {
      if (!botReady && watch.channelId) continue;
      if (!byInstance.has(watch.appId)) byInstance.set(watch.appId, []);
      byInstance.get(watch.appId).push(watch);
    }

    for (const [appId, watches] of byInstance) {
      // RESOLVED FRESH EVERY TICK — SETTINGS/DELETE/DISABLE APPLY IMMEDIATELY
      const instance = await this.getInstance(appId);
      const client = instance?.enabled ? this.getClientForInstance(instance) : null;
      if (!client) {
        watches.forEach(watch => this.watches.delete(watch.requestId));
        this.logger.warn(`Dropped ${watches.length} watches: app ${appId} removed, disabled, or unconfigured`);
        continue;
      }

      let queue;
      try {
        queue = await client.getQueue();
      } catch (err) {
        this.logger.warn(`App monitor could not read ${instance.display_name} queue: ${err.message}`);
        continue;
      }

      for (const watch of watches) {
        await this._checkWatch(watch, client, queue, config);
      }
    }
  },

  async _checkWatch(watch, client, queue, config) {
    try {
      const queueRow = queue.find(row => client.matchesQueueRecord(row, watch.arrId));
      if (queueRow && watch.stage === 'pending') {
        watch.stage = 'grabbed';
        const eta = queueRow.timeleft ? ` — about \`${queueRow.timeleft}\` remaining` : '';
        await this._notify(watch, `📥 **${watch.title}** is downloading${eta}.`);
      }

      const item = await client.getById(watch.arrId);
      if (client.isImported(item)) {
        await this.core.models.media.update({ id: watch.mediaId }, { is_available: true });
        await this._notify(
          watch,
          `✅ ${this._mentions(watch)} **${watch.title}** is now available on ${config.media_server_name}!`
        );
        this.watches.delete(watch.requestId);
        await this._pushRowUpdate(watch, null);
        this.core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CHIPS
        return;
      }

      // LIVE PROGRESS TO ANY OPEN DASHBOARD
      if (queueRow) {
        await this._pushRowUpdate(watch, queueRow);
      }

      if (Date.now() - watch.startedAt > config.max_check_time * 1000) {
        await this._notify(
          watch,
          `⏳ ${this._mentions(watch)} **${watch.title}** is still processing — I'll stop watching it for now, check back later.`
        );
        this.watches.delete(watch.requestId);
      }
    } catch (err) {
      this.logger.warn(`App monitor check failed for '${watch.title}': ${err.message}`);
    }
  },

  _mentions(watch) {
    return watch.requesterIds.map(id => `<@${id}>`).join(' ');
  },

  async _pushRowUpdate(watch, queueRow) {
    try {
      const request = await this.core.models.mediaRequest.getWithRelations(watch.requestId);
      if (!request) return;
      const req = this.buildRequestView(request, queueRow);
      await this.core.sockets.emitCompiled(['modals/requests/rowPush.pug'], { req });
    } catch (err) {
      this.logger.warn(`App monitor row push failed: ${err.message}`);
    }
  },

  async _notify(watch, content) {
    if (!watch.channelId) return; // CONSOLE-INITIATED — NOTHING TO NOTIFY
    if (!this.core.client || !this.core.client.isReady()) return;
    try {
      const channel = await this.core.client.channels.fetch(watch.channelId);
      await channel.send(content);
    } catch (err) {
      this.logger.warn(`App monitor could not notify channel ${watch.channelId}: ${err.message}`);
    }
  },

  // ── HEARTBEAT ──────────────────────────────────────────────────────────

  startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      this._heartbeatTick().catch(err => this.logger.error('App heartbeat tick failed:', err));
    }, HEARTBEAT_INTERVAL_MS);
    // unref: ONE-OFF SCRIPTS THAT REQUIRE THE CORE MUST STILL BE ABLE TO EXIT
    this._heartbeatTimer.unref?.();
    const boot = setTimeout(() => {
      this._heartbeatTick().catch(err => this.logger.error('App heartbeat boot tick failed:', err));
    }, HEARTBEAT_BOOT_DELAY_MS);
    boot.unref?.();
  },

  async _heartbeatTick() {
    const rows = (await this.getInstalled())
      .filter(row => row.enabled && this.isConfigured(row));

    // PRUNE CACHES FOR REMOVED/DISABLED/UNCONFIGURED INSTANCES
    const liveIds = new Set(rows.map(row => row.id));
    for (const cache of [this.statusCache, this.queueCache, this.feedCache, this.libraryCache]) {
      for (const id of [...cache.keys()]) {
        if (!liveIds.has(id)) cache.delete(id);
      }
    }

    for (const row of rows) {
      const client = this.getClientForInstance(row);
      try {
        const status = await client.getStatus();
        this.statusCache.set(row.id, { ok: true, version: status.version, checkedAt: Date.now() });
      } catch (err) {
        this.statusCache.set(row.id, { ok: false, error: err.message, checkedAt: Date.now() });
        this.queueCache.delete(row.id);
        continue;
      }
      try {
        this.queueCache.set(row.id, await client.getQueue());
      } catch (err) {
        this.logger.debug(`Heartbeat queue fetch failed for ${row.display_name}: ${err.message}`);
        this.queueCache.delete(row.id);
      }
    }

    await this._broadcastHeartbeat();
  },

  // AGGREGATE FOR THE DOWNLOAD TICKER: TOTAL ACTIVE ITEMS + THE ITEM CLOSEST
  // TO COMPLETION ACROSS EVERY INSTANCE QUEUE
  buildTickerAggregate() {
    let count = 0;
    let top = null;
    for (const [appId, queue] of this.queueCache) {
      for (const row of queue) {
        count++;
        if (!top || row.percent > top.percent) {
          top = { appId, title: row.title, percent: row.percent };
        }
      }
    }
    return count ? { count, ...top } : null;
  },

  // EMITS ONLY ON CHANGE. EACH EMIT IS INDEPENDENTLY GUARDED — THE TICKER AND
  // QUEUE-SECTION TEMPLATES LAND IN LATER MILESTONE STEPS AND MUST NOT TAKE
  // THE DOT/RAIL PUSHES DOWN WITH THEM.
  async _broadcastHeartbeat() {
    const railKey = [...this.statusCache.entries()]
      .map(([id, status]) => `${id}:${status.ok}`)
      .sort()
      .join('|');
    if (railKey !== this._lastRailKey) {
      this._lastRailKey = railKey;
      try {
        const apps = await this.getRailViewModel();
        await this.core.sockets.emitCompiled(['sidebar/servers/appRail.pug'], { apps });
      } catch (err) {
        this.logger.debug(`Heartbeat rail push skipped: ${err.message}`);
      }
    }

    const aggregate = this.buildTickerAggregate();
    const tickerKey = JSON.stringify(aggregate);
    if (tickerKey !== this._lastTickerKey) {
      this._lastTickerKey = tickerKey;
      try {
        await this.core.sockets.emitCompiled(['chat/downloadTicker.pug'], { ticker: aggregate });
      } catch (err) {
        this.logger.debug(`Heartbeat ticker push skipped: ${err.message}`);
      }
    }

    // LIVE TAKEOVER SURFACES — THE ACTIVE APP'S QUEUE SECTION, PLUS ITS
    // ACTIVITY FEED RAIL (WHICH RIDES ALONG IN EVERY SECTION)
    try {
      const state = await this.core.models.state.get();
      if (!state.active_app_id) return;
      const instance = await this.getInstance(state.active_app_id);
      if (!instance) return;

      if (instance.active_section === 'queue') {
        await this.core.sockets.emitCompiled(['apps/sections/queueBody.pug'], {
          activeApp: instance,
          queue: this.queueCache.get(instance.id) || []
        });
      }

      // CHANGE-ONLY: refreshFeed RETURNS null WHEN PAGE 1 IS UNCHANGED, SO THE
      // RAIL (AND ITS SCROLL POSITION) ISN'T STOMPED EVERY TICK
      const feed = await this.refreshFeed(instance);
      if (feed) {
        await this.core.sockets.emitCompiled(['apps/appFeed.pug'], { activeApp: instance, feed });
      }
    } catch (err) {
      this.logger.debug(`Heartbeat takeover push skipped: ${err.message}`);
    }
  }
};
