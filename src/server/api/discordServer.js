const { compileView } = require('../../shared/utils/common');
const {
  getServer,
  getServers,
  createServer,
  updateServer
} = require('../../shared/models/discordServer');

async function createMockServers() {
  const mockServerRows = [];
  let imgInd = 0;
  for (let i = 0; i < 9; i++) {
    const mockServerData = {
      server_name: `Test Server ${i}`,
      server_id: `${Math.floor(i * Math.random())}`,
      active_ui_state: i === 0,
      unread_ui_state: i % 2 === 0,
      server_avatar_url: i > 3 ? `https://cdn.discordapp.com/embed/avatars/${imgInd++}.png` : null
    };
    mockServerRows.push(await createServer(mockServerData));
  }
  return mockServerRows;
}

async function createServerBubble(serverParams = {
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

module.exports = {
  createServerBubble,
  createServerBubbles,
  createMockServers
};
