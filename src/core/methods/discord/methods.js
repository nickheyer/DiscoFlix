const _ = require('lodash');

module.exports = {
  async updatePowerState(powerOn, discordBotInst = null) {
    const discordBot = discordBotInst || await this.discordBot.get();
    logger.debug('Changing Discord Bot Power State:', discordBot);

    const state = await this.state.update({ discord_state: powerOn });
    await this.emitCompiled([
      'sidebar/userControls/userControlsLayout.pug',
      'sidebar/servers/addServerButton.pug',
    ], {
      discordBot,
      state
    });
  },

  async getInviteLink() {
    const discordBot = await this.discordBot.get();
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
    await this.emitCompiled(['chat/discordMessage.pug'], {
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

    // CONFIRM CHANNEL EXISTS FIRST
    const targetChannel = await this.discordChannel.get({
      channel_id: rawDiscMsg.channelId
    });

    if (!targetChannel) {
      await this.refreshDiscordServers();
      await this.updateServerSortOrder();
    }

    // FETCH MESSAGE AUTHOR, UPSERT AS USER
    const author = await rawDiscMsg.author.fetch(true);

    const activeServer = await this.state.getActiveServer();
    const isActiveChannel = activeServer.active_channel_id === rawDiscMsg.channelId;

    const bot = await this.discordBot.get();
    const isSelf = author.id === bot.bot_id;

    let discordServer;
    let discordChannel;

    if (!isSelf) {
      // UPDATE UNREAD MESSAGE COUNT
      discordServer = await this.discordServer.update(
        { server_id: rawDiscMsg.guildId },
        { unread_message_count: { increment: isActiveChannel ? 0 : 1 } }
      );

      discordChannel = await this.discordChannel.update(
        { channel_id: rawDiscMsg.channelId },
        { unread_message_count: isActiveChannel ? 0 : { increment: 1 } }
      );
    } else {
      // FETCH SERVER WITHOUT UPDATE
      discordServer = await this.discordServer.get({ server_id: rawDiscMsg.guildId });
      discordChannel = await this.discordChannel.get({ channel_id: rawDiscMsg.channelId });
    }

    const avatarUrl = author.displayAvatarURL();
    const userAccent = (author.hexAccentColor || 'ffffff').replace('#', '');
    const isClient = author.id === bot.bot_id;

    // UPSERT USER DATA
    await this.user.getOrCreate({
      where: { id: author.id },
      update: {
        username: author.username,
        display_name: author.displayName,
        accent_color: userAccent,
        avatar_url: avatarUrl,
        discord_servers: {
          connect: { server_id: discordServer.server_id }
        },
      },
      create: {
        id: author.id,
        is_bot: author.bot,
        is_client: isClient,
        username: author.username,
        display_name: author.displayName,
        accent_color: userAccent,
        avatar_url: avatarUrl,
        discord_servers: {
          connect: { server_id: discordServer.server_id }
        },
      }
    });

    // UPSERT MESSAGE DATA
    await this.discordMessage.upsert({
      where: { message_id: rawDiscMsg.id },
      update: {
        content: rawDiscMsg.content,
        user: { connect: { id: author.id } },
        channel: { connect: { channel_id: discordChannel.channel_id } },
        server: { connect: { server_id: discordServer.server_id } }
      },
      create: {
        message_id: rawDiscMsg.id,
        server: { connect: { server_id: discordServer.server_id } },
        channel: { connect: { channel_id: discordChannel.channel_id } },
        user: { connect: { id: author.id } },
        content: rawDiscMsg.content
      }
    });

    // DETERMINE IF WE SHOULD EMIT CURRENT MESSAGE SHARD
    if (isActiveChannel) {
      await this.emitMessage({
        username: `${author.displayName}`,
        isBot: !!(author.bot),
        isClient,
        timeStamp: this.formatTimestamp(rawDiscMsg.createdAt),
        avatarUrl,
        messageText: rawDiscMsg.content,
        accentColor: userAccent
      });
    } else {
      const servers = await this.getServerTemplateObj();
      await this.emitCompiled([
        'sidebar/servers/serverSortableContainer.pug',
        'sidebar/channels/chatChannels.pug'
      ], { servers });
    }
  },

  async compileMessages(messages = []) {
    const compiledMessages = [];
    for (const message of messages) {
      message.created_at = this.formatTimestamp(message.created_at);
      const compiledMessage = await this.compile('chat/discordMessageShard.pug', message);
      compiledMessages.push(compiledMessage);
    }
    return compiledMessages;
  },

  async updateMessages(active_channel_id, state = null) {
    if (!state) {
      state = await this.state.get();
    }

    if (!state.active_server_id) {
      return [];
    }

    if (!active_channel_id) {
      const activeServer = await this.discordServer.get(
        { server_id: state.active_server_id },
        { channels: true }
      );

      active_channel_id = activeServer.active_channel_id;
      if (!active_channel_id) {
        return [];
      }
    }

    // UPDATE UNREAD MESSAGES FOR CHANNEL
    await this.discordChannel.update(
      { channel_id: active_channel_id },
      { unread_message_count: 0 }
    );

    // UPDATE UNREAD MESSAGES FOR SERVER
    const server = await this.discordServer.get(
      { server_id: state.active_server_id },
      { channels: true }
    );

    const unreadServerMsgCount = server.channels.reduce(
      (total, channel) => total + channel.unread_message_count,
      0
    );

    await this.discordServer.update(
      { server_id: state.active_server_id },
      { active_channel_id, unread_message_count: unreadServerMsgCount }
    );

    // GET ALL MESSAGES TO BE DISPLAYED
    const messages = await this.discordChannel.getMessages(active_channel_id);
    logger.info(`Rendering ${messages.length} messages to UI`);

    return messages;
  },

  // EMITS A TEMPLATE OF AN UPDATED GUILD/SERVER/CHANNELS/ETC
  async refreshUI(messageObjects = []) {
    if (_.isEmpty(messageObjects)) {
      messageObjects = await this.updateMessages();
    }
    const messages = await this.compileMessages(messageObjects);
    const eomStamp = _.get(_.last(messageObjects), 'created_at');

    const discordBot = await this.discordBot.get();
    const servers = await this.getServerTemplateObj();

    await this.emitCompiled([
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
