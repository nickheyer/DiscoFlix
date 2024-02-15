const WebSocket = require('ws');

module.exports = (core) => {
  core.wss.on('connection', (ws) => {
    core.logger.info('A user connected');
    core.wss.clients.forEach(function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        core.addClientWS(client);
      }
    });

    ws.on('message', (messageAsString) => {
      const message = JSON.parse(messageAsString);
      core.logger.debug(message);
      const metadata = core.connections.get(ws);
      message.sender = metadata.id;
      message.color = metadata.color;
    });
  
    ws.on('disconnect', () => {
      const metadata = core.connections.get(ws);
      if (!metadata) {
        core.logger.error('User was not recorded as connected, but disconnected. Read logs!')
      } else {
        core.logger.debug('User disconnecting: ', metadata);
        core.connections.delete(ws);
      }
    });
  });
}