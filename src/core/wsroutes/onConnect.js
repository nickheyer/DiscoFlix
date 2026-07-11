module.exports = (core) => {
  core.wss.on('connection', (ws) => {
    const metadata = core.sockets.addClient(ws);
    core.logger.info('Browser client connected:', metadata);

    ws.on('message', (messageAsString) => {
      // BROWSER -> SERVER MESSAGES ARE NOT ACTED ON YET (FUTURE: SEND-AS-BOT)
      try {
        core.logger.debug('WS message received:', JSON.parse(messageAsString));
      } catch {
        core.logger.debug('WS message received (non-JSON)');
      }
    });

    ws.on('close', () => {
      core.sockets.removeClient(ws);
      core.logger.debug('Browser client disconnected:', metadata);
    });

    ws.on('error', (err) => {
      core.logger.warn(`WS client error: ${err.message}`);
    });
  });
};
