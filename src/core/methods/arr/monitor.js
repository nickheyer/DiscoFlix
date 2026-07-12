const POLL_INTERVAL_MS = 15 * 1000;

// IN-MEMORY QUEUE WATCHER
module.exports = {
  watchRequest({ requestId, service, arrId, mediaId, title, channelId, requesterIds }) {
    this.watches.set(requestId, {
      requestId,
      service,
      arrId,
      mediaId,
      title,
      channelId,
      requesterIds: requesterIds || [],
      stage: 'pending',
      startedAt: Date.now()
    });
    this.logger.info(`Watching arr queue for request ${requestId} (${title})`);
    this._ensureMonitorTimer();
  },

  stopWatch(requestId) {
    this.watches.delete(requestId);
  },

  _ensureMonitorTimer() {
    if (this._monitorTimer) return;
    this._monitorTimer = setInterval(() => {
      this._monitorTick().catch(err => this.logger.error('Arr monitor tick failed:', err));
    }, POLL_INTERVAL_MS);
  },

  async _monitorTick() {
    if (this.watches.size === 0) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
      return;
    }
    // NOTIFICATIONS NEED A LIVE BOT
    if (!this.core.client || !this.core.client.isReady()) return;

    const config = await this.core.models.configuration.get();
    const byService = new Map();
    for (const watch of this.watches.values()) {
      if (!byService.has(watch.service)) byService.set(watch.service, []);
      byService.get(watch.service).push(watch);
    }

    for (const [service, watches] of byService) {
      const client = this.getClientFor(service, config);
      if (!client) {
        watches.forEach(watch => this.watches.delete(watch.requestId));
        this.logger.warn(`Dropped ${watches.length} watches: ${service} no longer configured`);
        continue;
      }

      let queue;
      try {
        queue = await client.getQueue();
      } catch (err) {
        this.logger.warn(`Arr monitor could not read ${service} queue: ${err.message}`);
        continue;
      }

      for (const watch of watches) {
        await this._checkWatch(watch, client, queue, config);
      }
    }
  },

  async _checkWatch(watch, client, queue, config) {
    try {
      const queueRecord = queue.find(record => client.matchesQueueRecord(record, watch.arrId));
      if (queueRecord && watch.stage === 'pending') {
        watch.stage = 'grabbed';
        const eta = queueRecord.timeleft ? ` — about \`${queueRecord.timeleft}\` remaining` : '';
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
      if (queueRecord) {
        await this._pushRowUpdate(watch, queueRecord);
      }

      if (Date.now() - watch.startedAt > config.max_check_time * 1000) {
        await this._notify(
          watch,
          `⏳ ${this._mentions(watch)} **${watch.title}** is still processing — I'll stop watching it for now, check back later.`
        );
        this.watches.delete(watch.requestId);
      }
    } catch (err) {
      this.logger.warn(`Arr monitor check failed for '${watch.title}': ${err.message}`);
    }
  },

  _mentions(watch) {
    return watch.requesterIds.map(id => `<@${id}>`).join(' ');
  },

  async _pushRowUpdate(watch, queueRecord) {
    try {
      const request = await this.core.models.mediaRequest.getWithRelations(watch.requestId);
      if (!request) return;
      const req = this.buildRequestView(request, queueRecord);
      await this.core.sockets.emitCompiled(['modals/requests/rowPush.pug'], { req });
    } catch (err) {
      this.logger.warn(`Arr monitor row push failed: ${err.message}`);
    }
  },

  async _notify(watch, content) {
    try {
      const channel = await this.core.client.channels.fetch(watch.channelId);
      await channel.send(content);
    } catch (err) {
      this.logger.warn(`Arr monitor could not notify channel ${watch.channelId}: ${err.message}`);
    }
  }
};
