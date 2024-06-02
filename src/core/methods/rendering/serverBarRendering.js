const _ = require('lodash');
const { changeActiveServers } = require('../../../server/api/sidebar');

module.exports = {
  async createServerBubbles(serverRows = [], state = null, activeServer = null) {
    const serverBubbles = [];
    activeServer = activeServer || await this.state.getActive(state);
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
        serverUnread: serverRow.unread_ui_state,
        serverImage: serverRow.server_avatar_url,
      });
      
      serverBubbles.push(serverBubbleHTML);
    }
    return serverBubbles;
  },

  async createActiveChannels(channels, currentChannelID = null) {
    const sortedChannels = _.sortBy(channels, ['parent_id', 'position']);
  
    // ORG BY CATEGORY
    const categoriesWithTextChannels = sortedChannels.reduce((acc, channel) => {
      if (channel.isCategory) {
        // INIT CATEGORY-CHANNELS AS ARRAY
        acc[channel.channel_id] = {
          category: channel,
          channels: []
        };
      } else if (channel.isTextChannel && channel.parent_id && acc[channel.parent_id]) {
        // ADD CHANNEL TO PARENT
        acc[channel.parent_id].channels.push(channel);
      }
      return acc;
    }, {});
  
    // FILTER OUT INVALID/EMPTY CATEGORIES
    const validCategories = _.filter(_.values(categoriesWithTextChannels), (ch) => !_.isEmpty(ch.channels));
  
    const channelElems = [];
    for (const { category, channels } of validCategories) {
      // COMPILE HEADER/CATEGORY FIRST
      const categoryHTML = await this.compile([
        'sidebar/channels/chatChannelsHeader.pug'
      ], category);
      channelElems.push(categoryHTML);
  
      // COMPILE CHANNELS UNDER HEADER
      for (const channel of channels) {
        if (!currentChannelID) {
          currentChannelID = channel.channel_id;
        }
        channel.isActiveChannel = channel.channel_id === currentChannelID;
        const channelHTML = await this.compile([
          'sidebar/channels/chatChannel.pug'
        ], channel);
        channelElems.push(channelHTML);
      }
    }
    return channelElems;
  },

  async getOneServerTemplate(serverID) {
    let activeServer;
    let channels = [];
    if (!serverID) {
      activeServer = await this.state.getActive();
      if (activeServer) {
        activeServer = await this.discordServer.get(
          { server_id: activeServer.server_id },
          { channels: true }
        );
      }
    } else {
      activeServer = await this.discordServer.get(
        { server_id: serverID },
        { channels: true }
      );
    }

    const currentChannelView = _.get(activeServer, 'active_channel_id', null);
    const activeChannel = _.find(activeServer.channels, ['channel_id', currentChannelView])
    channels = await this.createActiveChannels(activeServer.channels, currentChannelView);

    return {
      activeServer,
      channels,
      activeChannel
    };
  },

  async getServerTemplateObj(serverRows = [], state = null) {
    if (_.isEmpty(serverRows)) {
      serverRows = await this.discordServer.getSorted();
    }

    let channels = [];
    let activeServer = await this.state.getActive();
    let activeChannel = null;
    if (activeServer) {
      activeServer = await this.discordServer.get(
        { server_id: activeServer.server_id },
        { channels: true }
      );
      const currentChannelView = _.get(activeServer, 'active_channel_id', null);
      activeChannel = _.find(activeServer.channels, ['channel_id', currentChannelView]);
      channels = await this.createActiveChannels(activeServer.channels, currentChannelView);
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
  }

};
