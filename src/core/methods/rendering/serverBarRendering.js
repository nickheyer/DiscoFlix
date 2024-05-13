const _ = require('lodash');

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

  async createActiveChannels(channels) {
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
        const channelHTML = await this.compile([
          'sidebar/channels/chatChannel.pug'
        ], channel);
        channelElems.push(channelHTML);
      }
    }
    return channelElems;
  },

  async getOneServerTemplate(serverID) {
    let server;
    let channels = [];
    if (!serverID) {
      server = await this.state.getActive();
      if (server) {
        server = await this.discordServer.get(
          { server_id: server.server_id },
          { channels: true }
        );
      }
    } else {
      server = await this.discordServer.get({ server_id: serverID });
    }

    channels = await this.createActiveChannels(server.channels);

    return {
      server,
      channels
    };
  },

  async getServerTemplateObj(serverRows = [], state = null) {
    if (_.isEmpty(serverRows)) {
      serverRows = await this.discordServer.getSorted();
    }

    let activeServerChannels = [];
    let activeServer = await this.state.getActive();
    if (activeServer) {
      activeServer = await this.discordServer.get(
        { server_id: activeServer.server_id },
        { channels: true }
      );
      activeServerChannels = await this.createActiveChannels(activeServer.channels);
    }

    const serverBubbles = await this.createServerBubbles(
      serverRows,
      state,
      activeServer
    );

    console.log(activeServerChannels.length);

    return {
      serverBubbles,
      serverRows,
      activeServer,
      activeServerChannels
    };
  }
};