// RELAY A BROWSER CHAT MESSAGE INTO THE ACTIVE CHANNEL AS THE BOT
async function relayChatMessage(core, text) {
  const content = String(text).trim().slice(0, 2000);
  if (!content) return;

  if (!core.client || !core.client.isReady()) {
    core.logger.warn('Chat relay skipped: bot is offline');
    return;
  }

  const activeServer = await core.models.state.getActiveServer();
  const channelId = activeServer?.active_channel_id;
  if (!channelId) {
    core.logger.warn('Chat relay skipped: no active channel');
    return;
  }

  const channel = await core.client.channels.fetch(channelId);
  await channel.send(content);
  core.logger.info(`Relayed browser message to #${channel.name}`);
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx > 0) acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    return acc;
  }, {});
}

module.exports = (core) => {
  core.wss.on('connection', async (ws, req) => {
    // WS CARRIES THE WHOLE UI - IT HONORS THE SAME SESSION AS HTTP
    try {
      const config = await core.models.configuration.get();
      if (config.admin_password) {
        const { isValidSession, SESSION_COOKIE } = require('../../server/middlewares/authHandler');
        const cookies = parseCookies(req.headers.cookie);
        if (!isValidSession(cookies[SESSION_COOKIE])) {
          core.logger.warn('Unauthenticated ws connection rejected');
          ws.close(4401, 'Authentication required');
          return;
        }
      }
    } catch (err) {
      core.logger.error('WS auth check failed:', err);
      ws.close(1011, 'Auth check failed');
      return;
    }

    const metadata = core.sockets.addClient(ws);
    core.logger.info('Browser client connected:', metadata);

    ws.on('message', async (messageAsString) => {
      try {
        const data = JSON.parse(messageAsString);
        if (data.chatMessage) {
          await relayChatMessage(core, data.chatMessage);
          return;
        }
        core.logger.debug('WS message received:', data);
      } catch (err) {
        core.logger.debug(`WS message ignored: ${err.message}`);
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
