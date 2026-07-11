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
    username,
    isBot,
    isClient,
    timeStamp,
    avatarUrl,
    messageText,
    accentColor
  }) {
    await this.core.sockets.emitCompiled(['chat/discordMessage.pug'], {
      username,
      isBot,
      isClient,
      timeStamp,
      avatarUrl,
      messageText,
      accentColor
    });
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

    // ONLY DB OPS HERE, EASY TO MESS UP
    const txRes = await this.core.prisma.$transaction(async (tx) => {
      const bot = await tx.discordBot.findFirst();
      const { activeServer } = await tx.state.findFirst({
        include: { activeServer: true }
      });

      const isSelf = author.id === bot.bot_id;
      const isActiveChannel = activeServer?.active_channel_id === rawDiscMsg.channelId;

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
          user: { connect: { id: author.id } },
          channel: { connect: { channel_id: channel.channel_id } },
          server: { connect: { server_id: server.server_id } }
        },
        update: {
          content: rawDiscMsg.content,
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
        username: author.displayName,
        isBot: !!author.bot,
        isClient: txRes.isSelf,
        timeStamp: this.formatTimestamp(rawDiscMsg.createdAt),
        avatarUrl,
        messageText: rawDiscMsg.content,
        accentColor: userAccent
      });
    } else {
      const servers = await this.core.render.getServerTemplateObj();
      await this.core.sockets.emitCompiled([
        'sidebar/servers/serverSortableContainer.pug',
        'sidebar/channels/chatChannels.pug'
      ], { servers });
    }
  },

  async compileMessages(messages = []) {
    const compiledMessages = [];
    for (const message of messages) {
      message.created_at = this.formatTimestamp(message.created_at);
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

    return messages;
  },

  // EMITS A TEMPLATE OF AN UPDATED GUILD/SERVER/CHANNELS/ETC
  // `null` = "fetch for me"; `[]` IS A VALID RESULT (EMPTY CHANNEL), DON'T REFETCH
  async refreshUI(messageObjects = null) {
    if (messageObjects === null) {
      messageObjects = await this.updateMessages();
    }
    const messages = await this.compileMessages(messageObjects);
    const eomStamp = _.get(_.last(messageObjects), 'created_at');

    const discordBot = await this.core.models.discordBot.get();
    const servers = await this.core.render.getServerTemplateObj();

    await this.core.sockets.emitCompiled([
      'sidebar/servers/serverSortableContainer.pug',
      'sidebar/servers/serverBannerLabel.pug',
      'sidebar/channels/chatChannels.pug',
      'chat/messageChannelHeader.pug',
      'chat/chatBar.pug',
      'chat/messageContainer.pug'
    ], {
      servers,
      messages,
      discordBot,
      eomStamp
    });
  }
};
