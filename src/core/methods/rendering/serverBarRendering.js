const _ = require('lodash');

module.exports = {
  async createServerBubbles(serverRows = [], state = null, activeServer = null) {
    const serverBubbles = [];
    state = state || await this.core.models.state.get();
    activeServer = activeServer || await this.core.models.state.getActiveServer(state);
    const activeID = activeServer ? activeServer.server_id : null;
    const appActive = !!state.active_app_id;

    for (const serverRow of serverRows) {
      const serverBubbleHTML = await this.compile(
        [
          'sidebar/servers/serverBubble.pug'
        ], {
        id: serverRow.server_id,
        serverSortPosition: serverRow.sort_position,
        serverName: serverRow.server_name,
        serverTrunc: serverRow.server_name.slice(0, 2),
        serverActive: serverRow.server_id === activeID,
        appActive,
        serverUnread: serverRow.unread_message_count,
        serverImage: serverRow.server_avatar_url,
        serverAvailable: serverRow.available
      });

      serverBubbles.push(serverBubbleHTML);
    }
    return serverBubbles;
  },

  async createActiveChannels(channels, currentChannelID = null) {
    const sortedChannels = _.sortBy(channels, ['parent_id', 'position']);
    const categories = {};
    const uncategorized = [];

    for (const channel of sortedChannels) {
      if (channel.isCategory) {
        categories[channel.channel_id] = { category: channel, channels: [] };
      }
    }

    for (const channel of sortedChannels) {
      if (!channel.isTextChannel) continue;
      if (channel.parent_id && categories[channel.parent_id]) {
        categories[channel.parent_id].channels.push(channel);
      } else {
        // TEXT CHANNELS OUTSIDE ANY CATEGORY RENDER FIRST, LIKE DISCORD
        uncategorized.push(channel);
      }
    }

    const channelElems = [];

    const renderChannel = async (channel) => {
      channel.isActiveChannel = channel.channel_id === currentChannelID;
      return this.compile(['sidebar/channels/chatChannel.pug'], channel);
    };

    for (const channel of uncategorized) {
      channelElems.push(await renderChannel(channel));
    }

    const validCategories = _.filter(_.values(categories), (ch) => !_.isEmpty(ch.channels));
    for (const { category, channels: categoryChannels } of validCategories) {
      const categoryHTML = await this.compile([
        'sidebar/channels/chatChannelsHeader.pug'
      ], category);
      channelElems.push(categoryHTML);

      for (const channel of categoryChannels) {
        channelElems.push(await renderChannel(channel));
      }
    }
    return channelElems;
  },

  async getOneServerTemplate(serverID) {
    const targetId = serverID ||
      (await this.core.models.state.getActiveServer())?.server_id;
    const activeServer = targetId
      ? await this.core.models.discordServer.getComplete(targetId)
      : null;

    if (activeServer?.channels) {
      const validChannelIds = activeServer.channels
        .filter(ch => ch.isTextChannel)
        .map(ch => ch.channel_id);

      const currentChannelView = await this.ensureActiveChannel(activeServer, validChannelIds);
      activeServer.active_channel_id = currentChannelView;

      const activeChannel = _.find(activeServer.channels, ['channel_id', currentChannelView]);
      const channels = await this.createActiveChannels(activeServer.channels, currentChannelView);

      return {
        activeServer,
        channels,
        activeChannel
      };
    }

    return {
      activeServer: {},
      channels: [],
      activeChannel: {}
    };
  },

  async getServerTemplateObj(serverRows = [], state = null) {
    if (_.isEmpty(serverRows)) {
      serverRows = await this.core.models.discordServer.getSorted();
    }

    if (!_.isEmpty(serverRows)) {
      await this.ensureActiveServer(serverRows[0].server_id);
    }

    let channels = [];
    let activeServer = await this.core.models.state.getActiveServer();
    let activeChannel = null;

    if (activeServer) {
      // ONE getComplete PER RENDER PASS; ensureActiveChannel WORKS ON THE
      // ALREADY-LOADED RECORD
      activeServer = await this.core.models.discordServer.getComplete(activeServer.server_id);

      if (activeServer?.channels) {
        const validChannelIds = activeServer.channels
          .filter(ch => ch.isTextChannel)
          .map(ch => ch.channel_id);

        const currentChannelView = await this.ensureActiveChannel(activeServer, validChannelIds);
        activeServer.active_channel_id = currentChannelView;

        activeChannel = _.find(activeServer.channels, ['channel_id', currentChannelView]);
        channels = await this.createActiveChannels(activeServer.channels, currentChannelView);
      }
    }

    const serverBubbles = await this.createServerBubbles(
      serverRows,
      state,
      activeServer
    );

    return {
      serverBubbles,
      serverRows,
      activeServer,
      channels,
      activeChannel
    };
  },

  // MEMBERS PANE VIEW MODEL - USERS THE APP HAS SEEN ON THE ACTIVE SERVER
  // (THE JOIN TABLE FILLS AS MESSAGES SYNC). CLIENT BOT SORTS FIRST.
  async getServerMembers(serverId) {
    if (!serverId) {
      const activeServer = await this.core.models.state.getActiveServer();
      serverId = activeServer?.server_id;
    }
    if (!serverId) return [];
    return this.core.models.user.getMany(
      { discord_servers: { some: { server_id: serverId } } },
      {},
      [{ is_client: 'desc' }, { username: 'asc' }]
    );
  },

  // FIRST-RUN CHECKLIST VIEW MODEL - null UNLESS A TOKEN OR SERVER IS STILL MISSING
  async getOnboarding(state) {
    if (state?.active_app_id) return null;
    const config = await this.core.models.configuration.get();
    const serverCount = await this.core.prisma.discordServer.count();
    if (config.discord_token && serverCount > 0) return null;

    const [appCount, requestCount] = await Promise.all([
      this.core.prisma.app.count(),
      this.core.prisma.mediaRequest.count()
    ]);
    const botOnline = !!(this.core.client && this.core.client.isReady());
    return {
      steps: [
        {
          label: 'Add your Discord bot token',
          done: !!config.discord_token,
          cta: { label: 'Open Configuration', url: '/modal/settings/configuration' }
        },
        {
          label: 'Power the bot on',
          done: botOnline,
          cta: { label: 'Open Power Menu', url: '/modal/bot/power' }
        },
        {
          label: 'Invite the bot to your Discord server',
          done: serverCount > 0,
          cta: { label: 'Get Invite Link', url: '/modal/bot/invite' }
        },
        {
          label: 'Connect an app like Radarr or Sonarr',
          done: appCount > 0,
          cta: { label: 'Add an App', url: '/modal/apps/picker' }
        },
        {
          label: 'Make your first request',
          done: requestCount > 0,
          hint: `Type ${config.prefix_keyword} movie <title> in Discord, or use an app's Search & Add section`
        }
      ]
    };
  },

  // ACCEPTS A LOADED SERVER RECORD (WITH OR WITHOUT CHANNELS) OR AN ID, AND
  // RETURNS THE VALID ACTIVE CHANNEL ID - CALLERS DON'T NEED TO REFETCH.
  async ensureActiveChannel(serverOrId, validChannelIds) {
    const server = typeof serverOrId === 'string'
      ? await this.core.models.discordServer.getById(serverOrId)
      : serverOrId;
    if (!server) return null;

    const current = server.active_channel_id;
    if (current && validChannelIds.includes(current)) return current;

    const channels = server.channels ||
      await this.core.models.discordChannel.getMany({ discord_server: server.server_id });
    const firstTextChannel =
      _.find(channels, (ch) => ch.isTextChannel && ch.parent_id && ch.position === 0) ||
      _.find(channels, (ch) => ch.isTextChannel);
    if (!firstTextChannel) return null;

    await this.core.models.discordServer.update(
      { server_id: server.server_id },
      { active_channel_id: firstTextChannel.channel_id }
    );
    return firstTextChannel.channel_id;
  },

  async ensureActiveServer(defaultServerId) {
    const activeServer = await this.core.models.state.getActiveServer();
    if (!activeServer) {
      this.logger.info(`No active server detected, setting active to: ${defaultServerId}`);
      await this.core.models.state.changeActive(defaultServerId);
    }
  },
};
