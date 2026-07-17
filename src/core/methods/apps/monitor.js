const ui = require('../../bot/interactions/ui');

const POLL_INTERVAL_MS = 15 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_BOOT_DELAY_MS = 5 * 1000;

// TWO TIMERS LIVE HERE:
// - THE WATCH MONITOR (15s, SELF-CLEARING): TRACKS OPEN MediaRequests THROUGH
//   AN INSTANCE'S QUEUE UNTIL IMPORT - DISCORD NOTIFY + DASHBOARD ROW PUSH.
// - THE HEARTBEAT (60s, ALWAYS-ON, unref'D): REFRESHES statusCache/queueCache
//   FOR EVERY CONFIGURED+ENABLED INSTANCE AND BROADCASTS RAIL DOTS / TICKER /
//   QUEUE-SECTION FRAGMENTS WHEN SOMETHING ACTUALLY CHANGED.
module.exports = {
  watchRequest({ requestId, appId, arrId, mediaId, title, channelId, requesterIds, featureId, serverId, rearmed }) {
    this.watches.set(requestId, {
      requestId,
      appId,
      arrId,
      mediaId,
      title,
      channelId: channelId || null, // null = CONSOLE-INITIATED, NO DISCORD NOTIFY
      requesterIds: requesterIds || [],
      // FEATURE SCOPE - max_check_time AND dm-notifications RESOLVE AGAINST
      // THE ORIGINATING FEATURE/SERVER RULE (NULLS FALL BACK TO DEFAULTS)
      featureId: featureId || null,
      serverId: serverId || null,
      stage: 'pending',
      rearmed: !!rearmed, // BOOT RE-ARM - FIRST TICK DECIDES IF THE GRAB NOTIFY WAS ALREADY SENT
      startedAt: Date.now()
    });
    this.logger.info(`Watching app queue for request ${requestId} (${title})`);
    this._ensureMonitorTimer();
  },

  // RESTARTS ORPHAN IN-MEMORY WATCHES - REBUILD THEM FROM APPROVED REQUESTS
  // WHOSE MEDIA NEVER IMPORTED. arr_id IS STORED AS TEXT; NUMERIC SERVICE IDS
  // ARE RESTORED SO matchesQueueRecord STRICT-COMPARES CORRECTLY.
  async rearmWatches() {
    const open = await this.core.prisma.mediaRequest.findMany({
      where: {
        status: true,
        arr_id: { not: null },
        appId: { not: null },
        media: { is_available: false }
      },
      include: { media: true, users: true }
    });

    let armed = 0;
    for (const request of open) {
      if (this.watches.has(request.id)) continue;
      this.watchRequest({
        requestId: request.id,
        appId: request.appId,
        arrId: /^\d+$/.test(request.arr_id) ? Number(request.arr_id) : request.arr_id,
        mediaId: request.mediaId,
        title: request.media.title || request.orig_parsed_title,
        channelId: request.orig_channel_id,
        requesterIds: (request.users || []).map(user => user.id),
        featureId: request.orig_parsed_type ? `request.${request.orig_parsed_type}` : null,
        serverId: request.madeInId,
        rearmed: true
      });
      armed++;
    }
    if (armed) this.logger.info(`Re-armed ${armed} queue watches from open requests`);
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
      // RESOLVED FRESH EVERY TICK - SETTINGS/DELETE/DISABLE APPLY IMMEDIATELY
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
        // ALREADY MID-DOWNLOAD ON A RE-ARM'S FIRST LOOK = THE GRAB WAS
        // ANNOUNCED BEFORE THE RESTART - DON'T REPEAT IT
        if (!watch.rearmed) {
          const message = await this._notify(watch, this._progressPayload(watch, queueRow));
          // THE GRAB CARD BECOMES THE LIVE PROGRESS SURFACE - TICKS EDIT IT
          if (message) {
            watch.progressMessage = message;
            watch.lastProgressFrame = this._progressFrameOf(queueRow);
          }
        }
      }
      watch.rearmed = false;

      const item = await client.getById(watch.arrId);
      if (client.isImported(item)) {
        await this.core.models.media.update({ id: watch.mediaId }, { is_available: true });
        // THE IMPORT MOMENT - STAMPED BEFORE THE PUSH SO THE FRESH CARD
        // ALREADY CARRIES ITS TIMESTAMP
        await this.core.models.mediaRequest.update(
          { id: watch.requestId },
          { imported_at: new Date() }
        ).catch(() => {});
        await this._settleProgressMessage(watch, config, true);
        await this._notify(
          watch,
          ui.notice(`${this._mentions(watch)} **${watch.title}** is now available on ${config.media_server_name}!`, { accent: 'ok' })
        );
        await this._dmRequesters(watch, ui.notice(`**${watch.title}** is now available on ${config.media_server_name}!`, { accent: 'ok' }));
        this.watches.delete(watch.requestId);
        await this._pushRowUpdate(watch, null);
        this.core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CHIPS
        return;
      }

      // LIVE PROGRESS TO ANY OPEN DASHBOARD AND ONTO THE DISCORD GRAB CARD
      if (queueRow) {
        await this._pushRowUpdate(watch, queueRow);
        await this._editProgressMessage(watch, queueRow);
      }

      // WATCH DURATION COMES FROM THE ORIGINATING FEATURE'S RULE (SCOPED TO
      // THE REQUEST'S SERVER); WATCHES WITHOUT A FEATURE FALL BACK TO 600s
      const features = require('../../bot/interactions/features');
      const rule = await features.effectiveRule(this.core, watch.featureId || '', watch.serverId);
      const maxCheckSeconds = Number(rule.extents.max_check_time) || 600;
      if (Date.now() - watch.startedAt > maxCheckSeconds * 1000) {
        await this._settleProgressMessage(watch, config, false);
        await this._notify(
          watch,
          ui.notice(`${this._mentions(watch)} **${watch.title}** is still processing - I'll stop watching it for now, check back later.`, { accent: 'warn' })
        );
        this.watches.delete(watch.requestId);
        // OPEN CONSOLES MUST HONESTLY DROP FROM "DOWNLOADING" TO "NO LONGER
        // WATCHED" INSTEAD OF FREEZING AT THE LAST PERCENT
        await this._pushRowUpdate(watch, null);
      }
    } catch (err) {
      this.logger.warn(`App monitor check failed for '${watch.title}': ${err.message}`);
    }
  },

  _mentions(watch) {
    return watch.requesterIds.map(id => `<@${id}>`).join(' ');
  },

  // THE LIVE DOWNLOAD CARD - ONE MESSAGE PER GRAB, EDITED IN PLACE EVERY TICK
  _progressPayload(watch, queueRow) {
    const eta = queueRow?.timeleft ? ` - about ${queueRow.timeleft} remaining` : '';
    return ui.payload(ui.container([
      ui.text(`### ${watch.title}`),
      ui.text(`Downloading${eta}`),
      ui.text(ui.progressBar(queueRow?.percent || 0))
    ]));
  },

  _progressFrameOf(queueRow) {
    return `${Math.round(queueRow?.percent || 0)}|${queueRow?.timeleft || ''}`;
  },

  // EDITS ONLY WHEN THE VISIBLE STATE ACTUALLY MOVED - TICKS ARE 15s APART
  // BUT A STALLED QUEUE MUST NOT RE-EDIT THE SAME FRAME FOREVER
  async _editProgressMessage(watch, queueRow) {
    if (!watch.progressMessage) return;
    const frame = this._progressFrameOf(queueRow);
    if (frame === watch.lastProgressFrame) return;
    watch.lastProgressFrame = frame;
    try {
      await watch.progressMessage.edit(this._progressPayload(watch, queueRow));
    } catch (err) {
      this.logger.debug(`Progress edit failed for '${watch.title}': ${err.message}`);
      watch.progressMessage = null; // DELETED OR INACCESSIBLE - STOP TRYING
    }
  },

  // FINAL FRAME: FULL GREEN BAR ON IMPORT, AMBER HANDOFF NOTE ON TIMEOUT
  async _settleProgressMessage(watch, config, imported) {
    if (!watch.progressMessage) return;
    const payload = imported
      ? ui.payload(ui.container([
        ui.text(`### ${watch.title}`),
        ui.text(`Downloaded and imported - streaming on ${config.media_server_name}`),
        ui.text(ui.progressBar(100))
      ], 'ok'))
      : ui.payload(ui.container([
        ui.text(`### ${watch.title}`),
        ui.text('Still processing - no longer watched here')
      ], 'warn'));
    try {
      await watch.progressMessage.edit(payload);
    } catch (err) {
      this.logger.debug(`Progress settle failed for '${watch.title}': ${err.message}`);
    }
    watch.progressMessage = null;
  },

  // ONE BROADCAST FEEDS EVERY SURFACE - SECTION CARD + CHAT CARD (ID-KEYED)
  async _pushRowUpdate(watch, queueRow) {
    await this.pushRequestCard(watch.requestId, queueRow);
  },

  // SENDS A UI PAYLOAD TO THE ORIGIN CHANNEL - RETURNS THE MESSAGE SO GRAB
  // CARDS CAN BE EDITED IN PLACE LATER, null WHEN NOTHING WAS POSTED
  async _notify(watch, payload) {
    if (!watch.channelId) return null; // CONSOLE-INITIATED - NOTHING TO NOTIFY
    if (!this.core.client || !this.core.client.isReady()) return null;
    try {
      const channel = await this.core.client.channels.fetch(watch.channelId);
      return await channel.send(payload);
    } catch (err) {
      this.logger.warn(`App monitor could not notify channel ${watch.channelId}: ${err.message}`);
      return null;
    }
  },

  // FEATURE-GATED COMPLETION DMs - THE dm-notifications RULE DECIDES PER
  // REQUESTER (OFF BY DEFAULT). CLOSED DM SETTINGS ARE A DEBUG LINE, NEVER
  // AN ERROR, AND ONE FAILED DM NEVER BLOCKS THE REST.
  async _dmRequesters(watch, payload) {
    if (!this.core.client || !this.core.client.isReady()) return;
    const features = require('../../bot/interactions/features');
    for (const userId of watch.requesterIds) {
      try {
        const dbUser = await this.core.models.user.findFirst({ id: userId });
        const gate = await features.resolveFeature(this.core, 'dm-notifications', {
          dbUser,
          roleTokens: [],
          guildId: watch.serverId
        });
        if (!gate.allowed) continue;
        const user = await this.core.client.users.fetch(userId);
        await user.send(payload);
      } catch (err) {
        this.logger.debug(`Completion DM to ${userId} failed: ${err.message}`);
      }
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
    const installed = await this.getInstalled();
    // ONLY ROWS WITH A SERVICE CLIENT GET STATUS/QUEUE CHECKS - THE DISCOFLIX
    // SELF APP HAS NOTHING TO POLL
    const rows = installed.filter(row =>
      row.enabled &&
      this.isConfigured(row) &&
      typeof this.getType(row.app_type)?.buildClient === 'function'
    );

    // PRUNE CACHES FOR REMOVED/DISABLED/UNCONFIGURED INSTANCES - HIDDEN ROWS
    // STAY LIVE, THEIR FEED CACHE IS FED BY THE BOT'S OWN LEDGER
    const liveIds = new Set(rows.map(row => row.id));
    for (const row of installed) {
      if (this.getType(row.app_type)?.hidden) liveIds.add(row.id);
    }
    for (const cache of [this.statusCache, this.queueCache, this.sessionsCache, this.feedCache, this.libraryCache]) {
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

  // EMITS ONLY ON CHANGE. EACH EMIT IS INDEPENDENTLY GUARDED - THE TICKER AND
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
        // PER VIEW - EACH BROWSER'S RAIL KEEPS ITS OWN ACTIVE PILL, AND THE
        // HOME BADGE'S PROBLEM DOT TRACKS THE SAME CACHE
        await this.core.sockets.emitPerView(async (view) => {
          const apps = await this.getRailViewModel(view);
          return this.core.render.compile([
            'sidebar/servers/appRail.pug',
            'sidebar/servers/serverHomeButton.pug'
          ], { apps });
        });
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

    // LIVE TAKEOVER SURFACES - EVERY APP SOME CONNECTED BROWSER HAS OPEN GETS
    // ITS QUEUE/NOW PLAYING/FEED PUSHES, SENT ONLY TO THE SESSIONS INSIDE IT
    try {
      const views = (await this.core.sockets.connectedViews())
        .filter(view => view.id && view.active_app_id);
      const sessionsByApp = new Map();
      for (const view of views) {
        if (!sessionsByApp.has(view.active_app_id)) sessionsByApp.set(view.active_app_id, []);
        sessionsByApp.get(view.active_app_id).push(view.id);
      }

      for (const [appId, sessionIds] of sessionsByApp) {
        const instance = await this.getInstance(appId);
        if (!instance) continue;

        if (instance.active_section === 'queue') {
          const html = await this.core.render.compile(['apps/sections/queueBody.pug'], {
            activeApp: instance,
            queue: this.queueCache.get(instance.id) || [],
            queueActions: this.queueActionsFor(instance)
          });
          await this.core.sockets.emitToSessions(sessionIds, html);
        }

        // AN OPEN NOW PLAYING SECTION GETS FRESH STREAMS EVERY TICK - CHANGE-ONLY
        // SO IDLE SERVERS DON'T RE-SWAP THE LIST FOR NOTHING
        if (instance.active_section === 'sessions') {
          const before = JSON.stringify(this.sessionsCache.get(instance.id) || []);
          const { sessions } = await this.getSessionsFor(instance);
          if (JSON.stringify(sessions) !== before) {
            const html = await this.core.render.compile(['apps/sections/sessionsBody.pug'], {
              activeApp: instance,
              sessions
            });
            await this.core.sockets.emitToSessions(sessionIds, html);
          }
        }

        // CHANGE-ONLY: refreshFeed RETURNS null WHEN PAGE 1 IS UNCHANGED, SO THE
        // RAIL (AND ITS SCROLL POSITION) ISN'T STOMPED EVERY TICK. THE BODY
        // FRAGMENT SWAPS ALONE - THE RAIL SEARCH INPUT ABOVE IT KEEPS ITS FOCUS
        const feed = await this.refreshFeed(instance);
        if (feed) {
          const html = await this.core.render.compile(['apps/appFeedBody.pug'], { activeApp: instance, feed });
          await this.core.sockets.emitToSessions(sessionIds, html);
        }
      }
    } catch (err) {
      this.logger.debug(`Heartbeat takeover push skipped: ${err.message}`);
    }
  }
};
