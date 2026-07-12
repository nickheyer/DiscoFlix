const STATE_LABELS = {
  pending: 'Pending',
  denied: 'Denied',
  approved: 'Approved — searching',
  downloading: 'Downloading',
  available: 'Available'
};

// STATE + VIEW-MODEL DERIVATION FOR MediaRequest
module.exports = {

  // REQUEST MUST INCLUDE MEDIA RELATION
  stateOf(request, queueRecord = null) {
    if (request.status === false) return 'denied';
    if (request.status === null) return 'pending';
    if (request.media?.is_available) return 'available';
    if (queueRecord) return 'downloading';
    const watch = this.watches.get(request.id);
    if (watch && watch.stage === 'grabbed') return 'downloading';
    return 'approved';
  },

  stateLabel(state) {
    return STATE_LABELS[state] || state;
  },

  // QUEUE ROWS ARRIVE PRE-NORMALIZED FROM THE CLIENTS (percent/timeleft)
  progressOf(queueRow) {
    if (!queueRow) return null;
    return { percent: queueRow.percent ?? 0, timeleft: queueRow.timeleft || null };
  },

  // request MUST INCLUDE media + users (+ made_in IF SERVER NAME WANTED)
  buildRequestView(request, queueRecord = null) {
    const state = this.stateOf(request, queueRecord);
    const media = request.media || {};
    return {
      id: request.id,
      title: media.year ? `${media.title} (${media.year})` : (media.title || request.orig_parsed_title),
      posterUrl: media.poster_url || null,
      contentType: request.orig_parsed_type,
      state,
      stateLabel: this.stateLabel(state),
      progress: state === 'downloading' ? this.progressOf(queueRecord) : null,
      appId: request.appId || null,
      appLabel: request.app?.display_name || null,
      requestedBy: (request.users || []).map(user => user.display_name || user.username).join(', '),
      serverName: request.made_in?.server_name || null,
      origMessage: request.orig_message,
      requestedAt: request.created_at
    };
  },

  // CHIP DATA FOR THE CHAT MIRROR, KEYED BY THE TRIGGERING MESSAGE ID
  async chipsForMessages(messageIds = []) {
    if (!messageIds.length) return {};
    const requests = await this.core.models.mediaRequest.getMany(
      { orig_message_id: { in: messageIds } },
      { media: true }
    );
    const chips = {};
    for (const request of requests) {
      const state = this.stateOf(request);
      chips[request.orig_message_id] = {
        id: request.id, // THE CHAT HOVER TRAY POSTS APPROVE/DENY BY REQUEST ID
        state,
        label: this.stateLabel(state),
        title: request.media?.title || request.orig_parsed_title
      };
    }
    return chips;
  }
};
