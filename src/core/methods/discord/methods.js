const _ = require('lodash');
const { memberRoleTokens, roleGrantsFor } = require('../../bot/interactions/access');

// ACCENT COLOR ONLY ARRIVES ON A FORCED PROFILE FETCH - CACHE IT SO BUSY
// CHANNELS DON'T COST ONE DISCORD API CALL PER MESSAGE
const AUTHOR_PROFILE_TTL_MS = 15 * 60 * 1000;
const AUTHOR_PROFILE_CACHE_MAX = 500;
// CONSECUTIVE SAME-AUTHOR MESSAGES INSIDE THIS WINDOW COLLAPSE LIKE DISCORD
const GROUP_WINDOW_MS = 7 * 60 * 1000;
// HISTORY PAGES (INITIAL LOAD + SCROLL-UP BATCHES) SHARE ONE SIZE
const HISTORY_PAGE_SIZE = 100;

module.exports = {
  // RETURNS { author, accent } - FORCE-FETCHES AT MOST ONCE PER USER PER TTL,
  // TRUSTS THE GATEWAY-CACHED USER OBJECT INSIDE THE WINDOW
  async fetchAuthorProfile(author) {
    if (!this._authorProfiles) this._authorProfiles = new Map();
    const hit = this._authorProfiles.get(author.id);
    if (hit && Date.now() - hit.fetchedAt < AUTHOR_PROFILE_TTL_MS) {
      return { author, accent: hit.accent };
    }

    const fetched = await author.fetch(true);
    const accent = (fetched.hexAccentColor || 'ffffff').replace('#', '');
    this._authorProfiles.delete(author.id); // RE-INSERT SO MAP ORDER STAYS LRU-ISH
    this._authorProfiles.set(author.id, { fetchedAt: Date.now(), accent });
    if (this._authorProfiles.size > AUTHOR_PROFILE_CACHE_MAX) {
      this._authorProfiles.delete(this._authorProfiles.keys().next().value);
    }
    return { author: fetched, accent };
  },

  async updatePowerState(powerOn, discordBotInst = null) {
    const discordBot = discordBotInst || await this.core.models.discordBot.get();
    this.logger.debug('Changing Discord Bot Power State:', discordBot);

    await this.core.models.state.update({ discord_state: powerOn });
    const config = await this.core.models.configuration.get();
    // EVERY BROWSER'S CONTROLS FLIP - THE HOME BADGE'S PILL/DOT ARE PER-VIEW
    await this.core.sockets.emitPerView(async (view) => {
      const apps = await this.core.apps.getRailViewModel(view);
      return this.core.render.compile([
        'sidebar/userControls/userControlsLayout.pug',
        'sidebar/servers/addServerButton.pug',
        'sidebar/servers/serverHomeButton.pug'
      ], {
        discordBot,
        state: { ...view, discord_state: powerOn },
        apps,
        authEnabled: !!config.admin_password
      });
    });
    // THE ONBOARDING POWER STEP TRACKS THIS FLIP - MIRRORS RE-RENDER TOO
    await this.refreshUI();
  },

  async getInviteLink() {
    const discordBot = await this.core.models.discordBot.get();
    return discordBot.bot_invite_link;
  },

  formatTimestamp(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    const options = { hour: 'numeric', minute: 'numeric', hour12: true };
    const formattedTime = new Intl.DateTimeFormat('en-US', options).format(date);

    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return `Today at ${formattedTime}`;
    } else {
      return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${formattedTime}`;
    }
  },

  // ONE COMPILE, SENT ONLY TO THE SESSIONS ACTUALLY VIEWING THE CHANNEL
  async emitMessage(sessionIds, {
    messageId,
    userId,
    username,
    isBot,
    isClient,
    timeStamp,
    hoverStamp,
    avatarUrl,
    messageText,
    accentColor,
    embedList,
    attachmentList,
    componentList,
    grouped
  }) {
    const html = await this.core.render.compile(['chat/discordMessage.pug'], {
      messageId,
      userId,
      username,
      isBot,
      isClient,
      timeStamp,
      hoverStamp,
      avatarUrl,
      messageText,
      accentColor,
      embedList: embedList || [],
      attachmentList: attachmentList || [],
      componentList: componentList || [],
      grouped: !!grouped
    });
    await this.core.sockets.emitToSessions(sessionIds, html);
  },

  // SERIALIZE DISCORD EMBEDS/ATTACHMENTS/COMPONENTS FOR PERSISTENCE + MIRROR
  extractRichContent(rawDiscMsg) {
    const embedList = (rawDiscMsg.embeds || []).map(embed =>
      typeof embed.toJSON === 'function' ? embed.toJSON() : embed
    );
    const attachmentList = [...(rawDiscMsg.attachments?.values() || [])].map(att => ({
      url: att.url,
      name: att.name,
      contentType: att.contentType
    }));
    const componentList = (rawDiscMsg.components || []).map(component =>
      typeof component.toJSON === 'function' ? component.toJSON() : component
    );
    return {
      embedList,
      attachmentList,
      componentList,
      embedsJson: embedList.length ? JSON.stringify(embedList) : null,
      attachmentsJson: attachmentList.length ? JSON.stringify(attachmentList) : null,
      componentsJson: componentList.length ? JSON.stringify(componentList) : null
    };
  },

  async logMessageToInterface(rawDiscMsg) {
    if (!rawDiscMsg.guildId) return; // DMS NOT SUPPORTED (YET)

    const { author, accent: userAccent } = await this.fetchAuthorProfile(rawDiscMsg.author);
    const avatarUrl = author.displayAvatarURL();

    // GRANT-ONLY ROLE MAPPING RIDES THE SYNC - HOLDING A MAPPED GUILD ROLE
    // PROMOTES ON SIGHT, THE CONSOLE STAYS THE PLACE TO REVOKE
    const config = await this.core.models.configuration.get();
    const roleGrants = roleGrantsFor(config, memberRoleTokens(rawDiscMsg.member));

    let targetChannel = await this.core.models.discordChannel.getById(rawDiscMsg.channelId);

    if (!targetChannel) {
      await this.refreshDiscordServers();
      await this.updateServerSortOrder();
      targetChannel = await this.core.models.discordChannel.getById(rawDiscMsg.channelId);
      if (!targetChannel) {
        this.logger.warn(`Message received for unknown channel ${rawDiscMsg.channelId}, skipping`);
        return;
      }
    }

    const richContent = this.extractRichContent(rawDiscMsg);

    // WHICH CONNECTED BROWSERS HAVE THIS EXACT CHANNEL ON SCREEN - THEY GET
    // THE ROW, EVERYONE ELSE GETS BADGES, UNREADS ONLY ACCRUE WHEN NOBODY SAW IT
    const serverRow = await this.core.models.discordServer.getById(rawDiscMsg.guildId);
    const connectedViews = await this.core.sockets.connectedViews();
    const viewerIds = connectedViews
      .filter(view => view.id
        && !view.active_app_id
        && view.active_server_id === rawDiscMsg.guildId
        && this.core.models.viewSession.channelPickFor(view, serverRow) === rawDiscMsg.channelId)
      .map(view => view.id);

    // ONE WRITE PATH FOR EVERY USER SIGHTING - PROFILE + GRANTS + GUILD LINK
    const bot = await this.core.models.discordBot.get();
    const isSelf = author.id === bot.bot_id;
    await this.core.models.user.syncFromDiscord(author, {
      grants: roleGrants,
      serverId: rawDiscMsg.guildId,
      extra: { accent_color: userAccent, is_client: isSelf }
    });

    // ONLY DB OPS HERE, EASY TO MESS UP
    const txRes = await this.core.prisma.$transaction(async (tx) => {
      const isViewed = viewerIds.length > 0;

      // UPDATE SERVER
      const server = await tx.discordServer.update({
        where: { server_id: rawDiscMsg.guildId },
        data: {
          unread_message_count: {
            increment: (!isSelf && !isViewed) ? 1 : 0
          }
        }
      });

      // UPDATE CHANNEL
      const channel = await tx.discordServerChannel.update({
        where: { channel_id: rawDiscMsg.channelId },
        data: {
          unread_message_count: {
            increment: (!isSelf && !isViewed) ? 1 : 0
          }
        }
      });

      // UPSERT MESSAGE
      await tx.discordMessage.upsert({
        where: { message_id: rawDiscMsg.id },
        create: {
          message_id: rawDiscMsg.id,
          content: rawDiscMsg.content,
          embeds: richContent.embedsJson,
          attachments: richContent.attachmentsJson,
          components: richContent.componentsJson,
          user: { connect: { id: author.id } },
          channel: { connect: { channel_id: channel.channel_id } },
          server: { connect: { server_id: server.server_id } }
        },
        update: {
          content: rawDiscMsg.content,
          embeds: richContent.embedsJson,
          attachments: richContent.attachmentsJson,
          components: richContent.componentsJson,
          user: { connect: { id: author.id } },
          channel: { connect: { channel_id: channel.channel_id } },
          server: { connect: { server_id: server.server_id } }
        }
      });
      return {
        isViewed,
        isSelf,
        server,
        channel
      };
    });

    // UI UPDATES OUTSIDE TRANSACTION
    if (viewerIds.length) {
      // GROUPING NEEDS THE MESSAGE BEFORE THIS ONE - SECOND-NEWEST IN CHANNEL
      const [, previous] = await this.core.prisma.discordMessage.findMany({
        where: { channel_id: rawDiscMsg.channelId },
        orderBy: { created_at: 'desc' },
        take: 2
      });
      await this.emitMessage(viewerIds, {
        messageId: rawDiscMsg.id,
        userId: author.id,
        username: author.displayName,
        isBot: !!author.bot,
        isClient: txRes.isSelf,
        timeStamp: this.formatTimestamp(rawDiscMsg.createdAt),
        hoverStamp: this.formatTimeOnly(rawDiscMsg.createdAt),
        avatarUrl,
        messageText: rawDiscMsg.content,
        accentColor: userAccent,
        embedList: richContent.embedList,
        attachmentList: richContent.attachmentList,
        componentList: richContent.componentList,
        grouped: this.isGroupedContinuation(
          { user_id: author.id, created_at: rawDiscMsg.createdAt },
          previous
        )
      });
    }
    if (!txRes.isSelf && !txRes.isViewed) {
      // SCOPED PHASE 2: SWAP ONLY THE AFFECTED BUBBLE (AND THE CHANNEL ROW
      // WHERE A SESSION'S SIDEBAR SHOWS IT) IN PLACE - SELF MESSAGES CHANGE
      // NO BADGES, SO THEY EMIT NOTHING HERE
      await this.emitUnreadBadges(txRes.server, txRes.channel);
    }
  },

  // PER-BUBBLE/PER-ROW OOB PUSH, COMPILED PER VIEW - EACH BROWSER'S BUBBLE
  // KEEPS ITS OWN ACTIVE RING, THE CHANNEL ROW ONLY LANDS WHERE ITS SIDEBAR
  // IS ON SCREEN. exceptSessionId SKIPS A SESSION THAT JUST GOT FULL CHROME.
  async emitUnreadBadges(serverRow, channelRow = null, exceptSessionId = null) {
    await this.core.sockets.emitPerView(async (view) => {
      if (exceptSessionId && view.id === exceptSessionId) return null;
      const fragments = [
        await this.core.render.compile('sidebar/servers/serverBubble.pug', {
          ...this.core.render.bubbleLocals(serverRow, view.active_server_id, !!view.active_app_id),
          oobReplace: true
        })
      ];
      // BADGE PUSHES ONLY TARGET INACTIVE CHANNELS - A SESSION WHOSE OWN PICK
      // IS THIS CHANNEL MIRRORS LIVE AND MUST KEEP ITS ACTIVE HIGHLIGHT
      if (channelRow
        && !view.active_app_id
        && view.active_server_id === serverRow.server_id
        && this.core.models.viewSession.channelPickFor(view, serverRow) !== channelRow.channel_id) {
        fragments.push(await this.core.render.compile('sidebar/channels/chatChannel.pug', {
          ...channelRow,
          isActiveChannel: false,
          oobReplace: true
        }));
      }
      return fragments.join('');
    });
  },

  // MIRRORS DISCORD MESSAGE EDITS: KEEPS THE PRIOR CONTENT FOR THE
  // BEFORE → AFTER TREATMENT AND SWAPS THE ROW IN PLACE OVER THE SOCKET
  async logMessageEditToInterface(oldMsg, newMsg) {
    if (!newMsg.guildId) return; // DMS NOT SUPPORTED (YET)

    if (newMsg.partial) {
      try {
        newMsg = await newMsg.fetch();
      } catch (err) {
        this.logger.warn(`Could not fetch edited message ${newMsg.id}: ${err.message}`);
        return;
      }
    }

    const existing = await this.core.prisma.discordMessage.findUnique({
      where: { message_id: newMsg.id }
    });
    // NEVER MIRRORED (PREDATES SYNC / BEYOND THE CAP) - LOG IT AS A FRESH ROW
    if (!existing) return this.logMessageToInterface(newMsg);

    const richContent = this.extractRichContent(newMsg);
    const newContent = newMsg.content ?? existing.content;
    // EMBED-ONLY EDITS (BOT PROGRESS UPDATES) DON'T GET THE (edited) TREATMENT
    const contentChanged = newContent !== existing.content;

    const updated = await this.core.prisma.discordMessage.update({
      where: { message_id: newMsg.id },
      data: {
        content: newContent,
        embeds: richContent.embedsJson,
        attachments: richContent.attachmentsJson,
        components: richContent.componentsJson,
        ...(contentChanged ? {
          previous_content: existing.content,
          edited_at: newMsg.editedAt || new Date()
        } : {})
      },
      include: { user: true }
    });

    // ONLY BROWSERS VIEWING THAT CHANNEL GET THE IN-PLACE ROW SWAP
    const serverRow = await this.core.models.discordServer.getById(newMsg.guildId);
    const connectedViews = await this.core.sockets.connectedViews();
    const viewerIds = connectedViews
      .filter(view => view.id
        && !view.active_app_id
        && view.active_server_id === newMsg.guildId
        && this.core.models.viewSession.channelPickFor(view, serverRow) === newMsg.channelId)
      .map(view => view.id);
    if (!viewerIds.length) return;

    // AN EDITED ROW KEEPS ITS GROUPED TREATMENT - REBUILD THE CONTEXT
    const previous = await this.core.prisma.discordMessage.findFirst({
      where: { channel_id: newMsg.channelId, created_at: { lt: updated.created_at } },
      orderBy: { created_at: 'desc' }
    });
    updated.grouped = this.isGroupedContinuation(updated, previous);
    updated.oobReplace = true;
    const [compiledRow] = await this.compileMessages([updated]);
    await this.core.sockets.emitToSessions(viewerIds, compiledRow);
  },

  async compileMessages(messages = []) {
    // REQUEST STATUS CHIPS FOR ANY MESSAGE THAT TRIGGERED A MediaRequest
    const chips = await this.core.apps.chipsForMessages(messages.map(msg => msg.message_id));

    const compiledMessages = [];
    let previousDay = null;
    let previous = null;
    for (const message of messages) {
      // CLASSIC DATE DIVIDER ABOVE THE FIRST MESSAGE OF EACH DAY (SKIPPED ON
      // OOB EDIT PUSHES - A LONE REPLACEMENT ROW HAS NO NEIGHBORS TO DIVIDE)
      const rawDate = new Date(message.created_at);
      if (!message.oobReplace && rawDate.toDateString() !== previousDay) {
        message.dayDivider = rawDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      }
      previousDay = rawDate.toDateString();

      // DISCORD-STYLE GROUPING - SAME AUTHOR INSIDE THE WINDOW COLLAPSES TO A
      // BARE LINE (HOVER SHOWS THE TIME); DIVIDERS AND UNREAD MARKERS BREAK
      // IT. A PRE-SET FLAG WINS - OOB RE-RENDERS CARRY THEIR OWN CONTEXT.
      // SNAPSHOT THE RAW TIMESTAMP - created_at MUTATES TO DISPLAY TEXT BELOW
      message.grouped = message.grouped ?? this.isGroupedContinuation(message, previous);
      previous = { user_id: message.user_id, created_at: rawDate };

      message.hoverStamp = this.formatTimeOnly(message.created_at);
      message.created_at = this.formatTimestamp(message.created_at);
      message.requestChip = chips[message.message_id] || null;
      const compiledMessage = await this.core.render.compile('chat/discordMessageShard.pug', message);
      compiledMessages.push(compiledMessage);
    }
    return compiledMessages;
  },

  // TRUE WHEN message CONTINUES previous - SAME AUTHOR, INSIDE THE WINDOW,
  // NOT SPLIT BY A DAY DIVIDER OR THE UNREAD MARKER
  isGroupedContinuation(message, previous) {
    if (!previous || !message || message.oobReplace) return false;
    if (message.dayDivider || message.isFirstUnread) return false;
    if (message.user_id !== previous.user_id) return false;
    const current = new Date(message.created_at);
    const prior = new Date(previous.created_at);
    if (current.toDateString() !== prior.toDateString()) return false;
    const gap = current - prior;
    return gap >= 0 && gap < GROUP_WINDOW_MS;
  },

  formatTimeOnly(timestamp) {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })
      .format(new Date(timestamp));
  },

  // SENTINEL LOCALS FOR SCROLL-UP PAGINATION - null WHEN THE FIRST PAGE
  // ALREADY HOLDS THE WHOLE CHANNEL. CALL BEFORE compileMessages MUTATES ROWS.
  historyCursorOf(msgObjects = []) {
    if (msgObjects.length < this.core.models.discordChannel.historyPageSize) return null;
    return {
      channelId: msgObjects[0].channel_id,
      beforeId: msgObjects[0].message_id
    };
  },

  // ONE VIEW'S MESSAGE LOAD - ZEROES THE CHANNEL'S GLOBAL UNREADS (SOMEONE IS
  // LOOKING AT IT) AND RECORDS THE PICK ON BOTH THE SESSION MAP AND THE
  // SERVER ROW'S GLOBAL DEFAULT
  async updateMessages(active_channel_id, view) {
    if (!view || !view.active_server_id) {
      return [];
    }

    if (!active_channel_id) {
      const serverRow = await this.core.models.discordServer.getById(view.active_server_id);
      active_channel_id = this.core.models.viewSession.channelPickFor(view, serverRow);
      if (!active_channel_id) {
        return [];
      }
    }

    // CAPTURE THE UNREAD COUNT BEFORE ZEROING - IT PLACES THE "NEW" DIVIDER
    const channelRow = await this.core.models.discordChannel.getById(active_channel_id);
    const unreadCount = channelRow?.unread_message_count || 0;

    // UPDATE UNREAD MESSAGES FOR CHANNEL
    await this.core.models.discordChannel.update(
      { channel_id: active_channel_id },
      { unread_message_count: 0 }
    );

    // UPDATE UNREAD MESSAGES FOR SERVER
    const server = await this.core.models.discordServer.getWithChannels(view.active_server_id);

    const unreadServerMsgCount = server.channels.reduce(
      (total, channel) => total + channel.unread_message_count,
      0
    );

    await this.core.models.discordServer.update(
      { server_id: view.active_server_id },
      { active_channel_id, unread_message_count: unreadServerMsgCount }
    );
    if (view.id) {
      await this.core.models.viewSession.setChannelPick(view.id, view.active_server_id, active_channel_id);
    }

    // GET ALL MESSAGES TO BE DISPLAYED
    const messages = await this.core.models.discordChannel.getMessages(active_channel_id);
    this.logger.info(`Rendering ${messages.length} messages to UI`);

    // MESSAGES ARE OLDEST-FIRST - FLAG THE FIRST OF THE NEWEST `unreadCount`
    // SO THE SHARD TEMPLATE DRAWS THE CLASSIC RED "NEW" DIVIDER ABOVE IT
    if (unreadCount > 0 && messages.length > 0) {
      messages[Math.max(0, messages.length - unreadCount)].isFirstUnread = true;
    }

    return messages;
  },

  // THE FULL MIRROR CHROME FOR ONE VIEW - SHARED BY refreshUI'S PER-VIEW
  // BROADCAST AND THE CHANNEL SWITCH (WHICH TARGETS JUST THE ACTING SESSION).
  // `[]` IS A VALID messageObjects RESULT (EMPTY CHANNEL), null = FETCH.
  async buildMirrorFragments(view, messageObjects = null) {
    if (messageObjects === null) {
      messageObjects = await this.updateMessages(null, view);
    }
    const history = this.historyCursorOf(messageObjects);
    const messages = await this.compileMessages(messageObjects);
    const eomStamp = _.get(_.last(messageObjects), 'created_at');

    const discordBot = await this.core.models.discordBot.get();
    const servers = await this.core.render.getServerTemplateObj(null, view);
    const members = await this.core.render.getServerMembers(view.active_server_id);
    const apps = await this.core.apps.getRailViewModel(view);
    const onboarding = await this.core.render.getOnboarding(view);

    return this.core.render.compile([
      'sidebar/servers/serverSortableContainer.pug',
      'sidebar/servers/appRail.pug',
      'sidebar/servers/serverHomeButton.pug',
      'sidebar/servers/serverBannerLabel.pug',
      'sidebar/channels/chatChannels.pug',
      'chat/messageChannelHeader.pug',
      'chat/chatBar.pug',
      'chat/messageContainer.pug',
      'members/membersLayout.pug'
    ], {
      servers,
      messages,
      discordBot,
      eomStamp,
      state: view,
      members,
      apps,
      onboarding,
      history
    });
  },

  // PER-VIEW UI REFRESH - EVERY CONNECTED BROWSER GETS ITS OWN WORLD: RAILS
  // ONLY DURING A TAKEOVER (NEVER STOMP THE APP SURFACE), FULL MIRROR CHROME
  // OTHERWISE
  async refreshUI() {
    await this.core.sockets.emitPerView(async (view) => {
      if (view.active_app_id) {
        const servers = await this.core.render.getServerTemplateObj(null, view);
        const apps = await this.core.apps.getRailViewModel(view);
        return this.core.render.compile([
          'sidebar/servers/serverSortableContainer.pug',
          'sidebar/servers/appRail.pug',
          'sidebar/servers/serverHomeButton.pug'
        ], { servers, state: view, apps });
      }
      return this.buildMirrorFragments(view);
    });
  }
};
