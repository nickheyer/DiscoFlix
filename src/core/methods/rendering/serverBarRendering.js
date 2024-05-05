const _ = require('lodash');

module.exports = {
  async createServerBubbles(serverRows = [], state = null, activeServer = null) {
    const serverBubbles = [];
    activeServer = activeServer || await this.state.getActive(state);
    const activeID = activeServer ? activeServer.server_id : null;
    for (const serverRow of serverRows) {
      const serverBubbleHTML = await this.compile('sidebar/servers/serverBubble.pug', {
        id: serverRow.server_id,
        serverSortPosition: serverRow.sort_position,
        serverName: serverRow.server_name,
        serverTrunc: serverRow.server_name.slice(0, 2),
        serverActive: serverRow.server_id === activeID,
        serverUnread: serverRow.unread_ui_state,
        serverImage: serverRow.server_avatar_url
      });
      
      serverBubbles.push(serverBubbleHTML);
    }
    return serverBubbles;
  },

  async getServerTemplateObj(serverRows = [], state = null) {
    if (_.isEmpty(serverRows)) {
      serverRows = await this.discordServer.getSorted();
    }
    const relServer = await this.state.getActive();
    const activeServer = await this.discordServer.get(
      { id: relServer.id },
      { channels: true }
    );
    const serverBubbles = await this.createServerBubbles(
      serverRows,
      state,
      activeServer
    );
    return {
      serverBubbles,
      serverRows,
      activeServer
    };
  },
};