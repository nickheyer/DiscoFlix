const _ = require('lodash');
const { memberRoleTokens, roleGrantsFor } = require('../../bot/commands/access');

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

    const state = await this.core.models.state.update({ discord_state: powerOn });
    // THE HOME BADGE RIDES ALONG - ITS PROBLEM DOT TRACKS BOT POWER/LOGIN
    const apps = await this.core.apps.getRailViewModel(state);
    const config = await this.core.models.configuration.get();
    await this.core.sockets.emitCompiled([
      'sidebar/userControls/userControlsLayout.pug',
      'sidebar/servers/addServerButton.pug',
      'sidebar/servers/serverHomeButton.pug',
    ], {
      discordBot,
      state,
      apps,
      authEnabled: !!config.admin_password
    });
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

  async emitMessage({
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
    grouped
  }) {
    await this.core.sockets.emitCompiled(['chat/discordMessage.pug'], {
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
      grouped: !!grouped
    });
  },

  // SERIALIZE DISCORD EMBEDS/ATTACHMENTS FOR PERSISTENCE + MIRROR RENDERING
  extractRichContent(rawDiscMsg) {
    const embedList = (rawDiscMsg.embeds || []).map(embed =>
      typeof embed.toJSON === 'function' ? embed.toJSON() : embed
    );
    const attachmentList = [...(rawDiscMsg.attachments?.values() || [])].map(att => ({
      url: att.url,
      name: att.name,
      contentType: att.contentType
    }));
    return {
      embedList,
      attachmentList,
      embedsJson: embedList.length ? JSON.stringify(embedList) : null,
      attachmentsJson: attachmentList.length ? JSON.stringify(attachmentList) : null
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

    // ONLY DB OPS HERE, EASY TO MESS UP
    const txRes = await this.core.prisma.$transaction(async (tx) => {
      const bot = await tx.discordBot.findFirst();
      const stateRow = await tx.state.findFirst({
        include: { activeServer: true }
      });
      const activeServer = stateRow?.activeServer;

      const isSelf = author.id === bot.bot_id;
      // DURING AN APP TAKEOVER NOTHING IS "ACTIVE" - MESSAGES ACCRUE UNREAD
      // BADGES INSTEAD OF BEING EMITTED INTO A SURFACE THAT ISN'T SHOWING THEM
      const isActiveChannel = !stateRow?.active_app_id
        && activeServer?.active_channel_id === rawDiscMsg.channelId;

      // UPDATE SERVER
      const server = await tx.discordServer.update({
        where: { server_id: rawDiscMsg.guildId },
        data: {
          unread_message_count: {
            increment: (!isSelf && !isActiveChannel) ? 1 : 0
          }
        }
      });

      // UPDATE CHANNEL
      const channel = await tx.discordServerChannel.update({
        where: { channel_id: rawDiscMsg.channelId },
        data: {
          unread_message_count: {
            increment: (!isSelf && !isActiveChannel) ? 1 : 0
          }
        }
      });

      // UPSERT USER - ROLE GRANTS ONLY EVER ADD FLAGS, NEVER CLEAR THEM
      await tx.user.upsert({
        where: { id: author.id },
        create: {
          id: author.id,
          is_bot: author.bot,
          is_client: isSelf,
          username: author.username,
          display_name: author.displayName,
          accent_color: userAccent,
          avatar_url: avatarUrl,
          ...roleGrants,
          discord_servers: {
            connect: { server_id: server.server_id }
          }
        },
        update: {
          username: author.username,
          display_name: author.displayName,
          accent_color: userAccent,
          avatar_url: avatarUrl,
          ...roleGrants,
          discord_servers: {
            connect: { server_id: server.server_id }
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
          user: { connect: { id: author.id } },
          channel: { connect: { channel_id: channel.channel_id } },
          server: { connect: { server_id: server.server_id } }
        },
        update: {
          content: rawDiscMsg.content,
          embeds: richContent.embedsJson,
          attachments: richContent.attachmentsJson,
          user: { connect: { id: author.id } },
          channel: { connect: { channel_id: channel.channel_id } },
          server: { connect: { server_id: server.server_id } }
        }
      });
      return {
        isActiveChannel,
        isSelf,
        server,
        channel,
        appActive: !!stateRow?.active_app_id,
        activeServerId: activeServer?.server_id || null
      };
    });

    // UI UPDATES OUTSIDE TRANSACTION
    if (txRes.isActiveChannel) {
      // GROUPING NEEDS THE MESSAGE BEFORE THIS ONE - SECOND-NEWEST IN CHANNEL
      const [, previous] = await this.core.prisma.discordMessage.findMany({
        where: { channel_id: rawDiscMsg.channelId },
        orderBy: { created_at: 'desc' },
        take: 2
      });
      await this.emitMessage({
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
        grouped: this.isGroupedContinuation(
          { user_id: author.id, created_at: rawDiscMsg.createdAt },
          previous
        )
      });
    } else if (!txRes.isSelf) {
      // SCOPED PHASE 2: SWAP ONLY THE AFFECTED BUBBLE (AND THE CHANNEL ROW
      // WHEN THE MESSAGE LANDED IN THE ACTIVE SERVER'S SIDEBAR) IN PLACE -
      // SELF MESSAGES CHANGE NO BADGES, SO THEY EMIT NOTHING HERE
      const rowVisible = !txRes.appActive && txRes.activeServerId === rawDiscMsg.guildId;
      await this.emitUnreadBadges(txRes.server, rowVisible ? txRes.channel : null, txRes);
    }
  },

  // PER-BUBBLE/PER-ROW OOB PUSH - THE MESSAGE-VOLUME PATH NEVER RE-RENDERS
  // THE SERVER STRIP OR CHANNEL LIST WHOLESALE ANYMORE
  async emitUnreadBadges(serverRow, channelRow = null, { appActive, activeServerId }) {
    const fragments = [
      await this.core.render.compile('sidebar/servers/serverBubble.pug', {
        ...this.core.render.bubbleLocals(serverRow, activeServerId, appActive),
        oobReplace: true
      })
    ];
    if (channelRow) {
      // BADGE PUSHES ONLY TARGET INACTIVE CHANNELS - THE ACTIVE ONE MIRRORS LIVE
      fragments.push(await this.core.render.compile('sidebar/channels/chatChannel.pug', {
        ...channelRow,
        isActiveChannel: false,
        oobReplace: true
      }));
    }
    await this.core.sockets.emit(fragments.join(''));
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
        ...(contentChanged ? {
          previous_content: existing.content,
          edited_at: newMsg.editedAt || new Date()
        } : {})
      },
      include: { user: true }
    });

    // ONLY THE ACTIVE CHANNEL IS MIRRORED LIVE
    const activeServer = await this.core.models.state.getActiveServer();
    if (activeServer?.active_channel_id !== newMsg.channelId) return;

    // AN EDITED ROW KEEPS ITS GROUPED TREATMENT - REBUILD THE CONTEXT
    const previous = await this.core.prisma.discordMessage.findFirst({
      where: { channel_id: newMsg.channelId, created_at: { lt: updated.created_at } },
      orderBy: { created_at: 'desc' }
    });
    updated.grouped = this.isGroupedContinuation(updated, previous);
    updated.oobReplace = true;
    const [compiledRow] = await this.compileMessages([updated]);
    await this.core.sockets.emit(compiledRow);
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

  async updateMessages(active_channel_id, state = null) {
    if (!state) {
      state = await this.core.models.state.get();
    }

    if (!state.active_server_id) {
      return [];
    }

    if (!active_channel_id) {
      const activeServer = await this.core.models.state.getActiveServer();

      active_channel_id = activeServer.active_channel_id;
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
    const server = await this.core.models.discordServer.getWithChannels(state.active_server_id);

    const unreadServerMsgCount = server.channels.reduce(
      (total, channel) => total + channel.unread_message_count,
      0
    );

    await this.core.models.discordServer.update(
      { server_id: state.active_server_id },
      { active_channel_id, unread_message_count: unreadServerMsgCount }
    );

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

  // EMITS A TEMPLATE OF AN UPDATED GUILD/SERVER/CHANNELS/ETC
  // `null` = "fetch for me"; `[]` IS A VALID RESULT (EMPTY CHANNEL), DON'T REFETCH
  async refreshUI(messageObjects = null) {
    const state = await this.core.models.state.get();

    // APP TAKEOVER GUARD: NEVER STOMP THE APP SURFACE - ONLY THE RAILS KEEP
    // FLOWING (GUILD UNREAD BADGES + APP STATUS DOTS)
    if (state.active_app_id) {
      const servers = await this.core.render.getServerTemplateObj(null, state);
      const apps = await this.core.apps.getRailViewModel(state);
      await this.core.sockets.emitCompiled([
        'sidebar/servers/serverSortableContainer.pug',
        'sidebar/servers/appRail.pug',
        'sidebar/servers/serverHomeButton.pug'
      ], { servers, state, apps });
      return;
    }

    if (messageObjects === null) {
      messageObjects = await this.updateMessages(null, state);
    }
    const history = this.historyCursorOf(messageObjects);
    const messages = await this.compileMessages(messageObjects);
    const eomStamp = _.get(_.last(messageObjects), 'created_at');

    const discordBot = await this.core.models.discordBot.get();
    const servers = await this.core.render.getServerTemplateObj(null, state);
    const members = await this.core.render.getServerMembers(state.active_server_id);
    const apps = await this.core.apps.getRailViewModel(state);
    const onboarding = await this.core.render.getOnboarding(state);

    await this.core.sockets.emitCompiled([
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
      state,
      members,
      apps,
      onboarding,
      history
    });
  }
};
