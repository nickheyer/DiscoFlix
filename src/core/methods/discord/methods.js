const _ = require('lodash');

module.exports = {
  async updatePowerState(powerOn, discordBotInst = null) {
    const discordBot = discordBotInst || await this.core.models.discordBot.get();
    this.logger.debug('Changing Discord Bot Power State:', discordBot);

    const state = await this.core.models.state.update({ discord_state: powerOn });
    await this.core.sockets.emitCompiled([
      'sidebar/userControls/userControlsLayout.pug',
      'sidebar/servers/addServerButton.pug',
    ], {
      discordBot,
      state
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
    avatarUrl,
    messageText,
    accentColor,
    embedList,
    attachmentList
  }) {
    await this.core.sockets.emitCompiled(['chat/discordMessage.pug'], {
      messageId,
      userId,
      username,
      isBot,
      isClient,
      timeStamp,
      avatarUrl,
      messageText,
      accentColor,
      embedList: embedList || [],
      attachmentList: attachmentList || []
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

    const author = await rawDiscMsg.author.fetch(true);
    const avatarUrl = author.displayAvatarURL();
    const userAccent = (author.hexAccentColor || 'ffffff').replace('#', '');
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
      // DURING AN APP TAKEOVER NOTHING IS "ACTIVE" — MESSAGES ACCRUE UNREAD
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

      // UPSERT USER
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
          discord_servers: {
            connect: { server_id: server.server_id }
          }
        },
        update: {
          username: author.username,
          display_name: author.displayName,
          accent_color: userAccent,
          avatar_url: avatarUrl,
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
      return { isActiveChannel, isSelf };
    });

    // UI UPDATES OUTSIDE TRANSACTION
    if (txRes.isActiveChannel) {
      await this.emitMessage({
        messageId: rawDiscMsg.id,
        userId: author.id,
        username: author.displayName,
        isBot: !!author.bot,
        isClient: txRes.isSelf,
        timeStamp: this.formatTimestamp(rawDiscMsg.createdAt),
        avatarUrl,
        messageText: rawDiscMsg.content,
        accentColor: userAccent,
        embedList: richContent.embedList,
        attachmentList: richContent.attachmentList
      });
    } else {
      // SCOPE THE CHANNEL LIST EMIT (UNREAD BADGES) - ONLY MATTERS WHEN MESSAGE LANDED IN ACTIVE SERVER, ELSE BUBBLE
      const servers = await this.core.render.getServerTemplateObj();
      const isActiveServer = servers.activeServer?.server_id === rawDiscMsg.guildId;
      await this.core.sockets.emitCompiled(
        isActiveServer
          ? ['sidebar/servers/serverSortableContainer.pug', 'sidebar/channels/chatChannels.pug']
          : ['sidebar/servers/serverSortableContainer.pug'],
        { servers }
      );
    }
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
    // NEVER MIRRORED (PREDATES SYNC / BEYOND THE CAP) — LOG IT AS A FRESH ROW
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

    updated.oobReplace = true;
    const [compiledRow] = await this.compileMessages([updated]);
    await this.core.sockets.emit(compiledRow);
  },

  async compileMessages(messages = []) {
    // REQUEST STATUS CHIPS FOR ANY MESSAGE THAT TRIGGERED A MediaRequest
    const chips = await this.core.apps.chipsForMessages(messages.map(msg => msg.message_id));

    const compiledMessages = [];
    let previousDay = null;
    for (const message of messages) {
      // CLASSIC DATE DIVIDER ABOVE THE FIRST MESSAGE OF EACH DAY (SKIPPED ON
      // OOB EDIT PUSHES — A LONE REPLACEMENT ROW HAS NO NEIGHBORS TO DIVIDE)
      const rawDate = new Date(message.created_at);
      if (!message.oobReplace && rawDate.toDateString() !== previousDay) {
        message.dayDivider = rawDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      }
      previousDay = rawDate.toDateString();

      message.created_at = this.formatTimestamp(message.created_at);
      message.requestChip = chips[message.message_id] || null;
      const compiledMessage = await this.core.render.compile('chat/discordMessageShard.pug', message);
      compiledMessages.push(compiledMessage);
    }
    return compiledMessages;
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

    // CAPTURE THE UNREAD COUNT BEFORE ZEROING — IT PLACES THE "NEW" DIVIDER
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

    // MESSAGES ARE OLDEST-FIRST — FLAG THE FIRST OF THE NEWEST `unreadCount`
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

    // APP TAKEOVER GUARD: NEVER STOMP THE APP SURFACE — ONLY THE RAILS KEEP
    // FLOWING (GUILD UNREAD BADGES + APP STATUS DOTS)
    if (state.active_app_id) {
      const servers = await this.core.render.getServerTemplateObj(null, state);
      const apps = await this.core.apps.getRailViewModel(state);
      await this.core.sockets.emitCompiled([
        'sidebar/servers/serverSortableContainer.pug',
        'sidebar/servers/appRail.pug'
      ], { servers, state, apps });
      return;
    }

    if (messageObjects === null) {
      messageObjects = await this.updateMessages(null, state);
    }
    const messages = await this.compileMessages(messageObjects);
    const eomStamp = _.get(_.last(messageObjects), 'created_at');

    const discordBot = await this.core.models.discordBot.get();
    const servers = await this.core.render.getServerTemplateObj(null, state);
    const members = await this.core.render.getServerMembers(state.active_server_id);
    const apps = await this.core.apps.getRailViewModel(state);

    await this.core.sockets.emitCompiled([
      'sidebar/servers/serverSortableContainer.pug',
      'sidebar/servers/appRail.pug',
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
      apps
    });
  }
};
