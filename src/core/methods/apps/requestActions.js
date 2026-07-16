// REQUEST DECISIONS AS CORE VERBS - THE CONSOLE'S APPROVE/DENY BUTTONS AND
// THE AI OPERATOR TOOLS RUN THE SAME PATH, SO A DECISION BEHAVES IDENTICALLY
// NO MATTER WHICH SURFACE ASKED FOR IT.
module.exports = {
  // VERDICT NOTICE INTO THE REQUEST'S ORIGIN CHANNEL - NO-OP FOR CONSOLE-BORN
  // REQUESTS OR AN OFFLINE BOT
  async postRequestVerdict(request, approved) {
    if (!request.orig_channel_id) return;
    if (!this.core.client || !this.core.client.isReady()) {
      this.logger.warn('Verdict not posted to Discord: bot offline');
      return;
    }
    try {
      const ui = require('../../bot/interactions/ui');
      const mentions = (request.users || []).map(user => `<@${user.id}>`).join(' ');
      const title = request.media?.title || request.orig_parsed_title;
      const verdict = approved
        ? ui.notice(`${mentions} Your request for **${title}** was approved.`, { accent: 'ok', subtext: 'Updates will land here as it downloads' })
        : ui.notice(`${mentions} Your request for **${title}** was denied.`, { accent: 'danger' });
      const channel = await this.core.client.channels.fetch(request.orig_channel_id);
      await channel.send(verdict);
    } catch (err) {
      this.logger.warn(`Verdict post failed: ${err.message}`);
    }
  },

  // WHICH INSTANCE GETS THE ADD: EXPLICIT OVERRIDE > THE INSTANCE THE SEARCH
  // RAN AGAINST (IF STILL SERVING) > THE CURRENT DEFAULT FOR THE CONTENT TYPE
  async resolveApprovalInstance(request, overrideAppId = null) {
    const candidates = [];
    if (overrideAppId) candidates.push(overrideAppId);
    if (request.appId) candidates.push(request.appId);

    for (const appId of candidates) {
      const instance = await this.getInstance(appId);
      if (instance?.enabled && this.isConfigured(instance)) return instance;
    }
    return this.defaultInstanceFor(request.orig_parsed_type);
  },

  // APPROVE: ADD TO THE SERVICE (UNLESS ALREADY THERE), STAMP THE DECISION,
  // ARM THE QUEUE WATCH, TELL THE REQUESTERS. RETURNS { ok, message }.
  async approveMediaRequest(requestId, { appId = null } = {}) {
    const core = this.core;
    const request = await core.models.mediaRequest.getWithRelations(requestId);
    if (!request) return { ok: false, message: 'Request not found' };
    if (request.status !== null) return { ok: false, message: 'Request was already decided' };

    try {
      const instance = await this.resolveApprovalInstance(request, appId);
      if (!instance) throw new Error(`No connected app handles ${request.orig_parsed_type} requests`);
      const client = this.getClientForInstance(instance);

      const externalKey = request.media[client.externalIdField];
      if (!externalKey) throw new Error('Media row is missing its external id');

      // ALREADY IN THE LIBRARY (E.G. ADDED BY HAND SINCE THE REQUEST)? SKIP THE ADD.
      let added = await client.getByExternalId(externalKey);
      if (!added) {
        const result = await client.lookupByExternalId(externalKey);
        if (!result) throw new Error(`Lookup found nothing for ${instance.display_name} id ${externalKey}`);
        // THE REQUESTER'S SEASON PICK RIDES THE ROW - MONITOR EXACTLY THAT
        let seasons = null;
        try { seasons = request.seasons ? JSON.parse(request.seasons) : null; } catch (err) { seasons = null; }
        added = await client.add(result, { seasons });
      }

      const imported = client.isImported(added);
      await core.models.mediaRequest.updateStatus(requestId, true);
      // PERSIST THE RESOLVED INSTANCE AND SERVICE ITEM ID - THE ROW MAY HAVE
      // BEEN OVERRIDDEN OR ORPHANED, AND A RESTART RE-ARMS WATCHES FROM THESE
      await core.models.mediaRequest.update(
        { id: requestId },
        { appId: instance.id, arr_id: String(added.id) }
      );
      await core.models.media.updateMediaInfo(request.media.id, {
        path: added.path || null,
        monitored: true,
        is_available: imported
      });

      if (!imported) {
        this.watchRequest({
          requestId,
          appId: instance.id,
          arrId: added.id,
          mediaId: request.media.id,
          title: request.media.title,
          channelId: request.orig_channel_id,
          requesterIds: (request.users || []).map(user => user.id),
          featureId: request.orig_parsed_type ? `request.${request.orig_parsed_type}` : null,
          serverId: request.madeInId
        });
      }

      await this.postRequestVerdict(request, true);
      return { ok: true, message: 'Request approved' };
    } catch (err) {
      this.logger.error('Request approval failed:', err);
      return { ok: false, message: `Approval failed: ${err.message}` };
    }
  },

  async denyMediaRequest(requestId) {
    const core = this.core;
    const request = await core.models.mediaRequest.getWithRelations(requestId);
    if (!request) return { ok: false, message: 'Request not found' };
    if (request.status !== null) return { ok: false, message: 'Request was already decided' };

    await core.models.mediaRequest.updateStatus(requestId, false);
    await this.postRequestVerdict(request, false);
    return { ok: true, message: 'Request denied' };
  }
};
