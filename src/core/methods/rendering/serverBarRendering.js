const _ = require('lodash');

module.exports = {
  async createServerBubbles(serverRows = [], state = null, activeServer = null) {
    const serverBubbles = [];
    activeServer = activeServer || await this.core.models.state.getActiveServer(state);
    const activeID = activeServer ? activeServer.server_id : null;

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
    let activeServer;
    let channels = [];

    if (!serverID) {
      activeServer = await this.core.models.state.getActiveServer();
      if (activeServer) {
        activeServer = await this.core.models.discordServer.getComplete(activeServer.server_id);
      }
    } else {
      activeServer = await this.core.models.discordServer.getComplete(serverID);
    }

    if (activeServer?.channels) {
      const validChannelIds = activeServer.channels
        .filter(ch => ch.isTextChannel)
        .map(ch => ch.channel_id);

      await this.ensureActiveChannel(activeServer.server_id, validChannelIds);
      activeServer = await this.core.models.discordServer.getComplete(activeServer.server_id);

      const currentChannelView = activeServer.active_channel_id;
      const activeChannel = _.find(activeServer.channels, ['channel_id', currentChannelView]);
      channels = await this.createActiveChannels(activeServer.channels, currentChannelView);

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
      activeServer = await this.core.models.discordServer.getComplete(activeServer.server_id);

      if (activeServer?.channels) {
        const validChannelIds = activeServer.channels
          .filter(ch => ch.isTextChannel)
          .map(ch => ch.channel_id);

        await this.ensureActiveChannel(activeServer.server_id, validChannelIds);
        activeServer = await this.core.models.discordServer.getComplete(activeServer.server_id);

        const currentChannelView = activeServer.active_channel_id;
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

  async ensureActiveChannel(serverId, validChannelIds) {
    const discordServer = await this.core.models.discordServer.getComplete(serverId);
    const activeChannel = discordServer.active_channel_id;

    if (!activeChannel || !validChannelIds.includes(activeChannel)) {
      const channels = await this.core.models.discordChannel.getMany({ discord_server: serverId });
      const firstTextChannel =
        _.find(channels, (ch) => ch.isTextChannel && ch.parent_id && ch.position === 0) ||
        _.find(channels, (ch) => ch.isTextChannel);

      if (firstTextChannel) {
        await this.core.models.discordServer.update(
          { server_id: serverId },
          { active_channel_id: firstTextChannel.channel_id }
        );
      }
    }
  },

  async ensureActiveServer(defaultServerId) {
    const activeServer = await this.core.models.state.getActiveServer();
    if (!activeServer) {
      this.logger.info(`No active server detected, setting active to: ${defaultServerId}`);
      await this.core.models.state.changeActive(defaultServerId);
    }
  },
};
