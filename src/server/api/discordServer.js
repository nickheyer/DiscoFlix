const { compileView } = require('../../shared/utils/common');
const {
  getServer,
  getServers,
  createServer,
  updateServer
} = require('../../shared/models/discordServer');
const _ = require('lodash');


async function createMockServers() {
  const mockServerRows = [];
  let imgInd = 0;
  for (let i = 0; i < 9; i++) {
    const mockServerData = {
      server_name: `Test Server ${i}`,
      server_id: `${Math.floor(Math.random() * 1000) + i}`,
      active_ui_state: i === 0,
      unread_ui_state: i % 2 === 0,
      server_avatar_url: i > 3 ? `https://cdn.discordapp.com/embed/avatars/${imgInd++}.png` : null
    };
    mockServerRows.push(await createServer(mockServerData));
  }
  return mockServerRows;
}

async function createServerBubble(serverParams = {
  id,
  serverName: 'Discord Server',
  serverTrunc: 'DS',
  serverImage: null,
  serverColor: null,
  serverActive: false,
  serverUnread: false
}) {
  const serverBubbleHTML = await compileView('serverBubble.pug', serverParams);
  return serverBubbleHTML;
};

async function createServerBubbles(serverRows = []) {
  const serverBubbles = [];
  for (const serverRow of serverRows) {
    const serverBubbleHTML = await createServerBubble({
      id: serverRow.id,
      serverName: serverRow.server_name,
      serverTrunc: serverRow.server_name.slice(0, 2),
      serverActive: serverRow.active_ui_state,
      serverUnread: serverRow.unread_ui_state,
      serverImage: serverRow.server_avatar_url
    });
    serverBubbles.push(serverBubbleHTML);
  }
  return serverBubbles;
}

async function getServerTemplateObj() {
  let serverRows = await getServers();
  if (serverRows.length < 1) {
    serverRows = await createMockServers();
  }
  const serverBubbles = await createServerBubbles(serverRows);
  const activeServer = _.find(serverRows, 'active_ui_state');
  return {
    serverBubbles,
    serverRows,
    activeServer
  };
}

module.exports = {
  createServerBubble,
  createServerBubbles,
  createMockServers,
  getServerTemplateObj
};
