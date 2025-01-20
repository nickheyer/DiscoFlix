const _ = require('lodash');

// GENERATE BOT INVITE LINK
function genInvite(client) {
  return client.generateInvite({ scopes: ['bot'], permissions: ['1689934407138496'] });
}

module.exports = {
  // SYNC ALL SERVERS AND CHANNELS
  async refreshAllDiscordServers() {
    try {
      const foundPartialServers = await this.client.guilds.fetch();
      const foundServers = await Promise.all(foundPartialServers.map(part => part.fetch()));
      const foundIDs = await this.batchUpsertServers(foundServers);
      await this.syncMissingServers(foundIDs);
      return await this.discordServer.getSorted();
    } catch (error) {
      logger.error('Failed to refresh all Discord servers:', error);
      throw error;
    }
  },

  // SYNC SPECIFIC SERVER OR ALL IF NONE PROVIDED
  async refreshDiscordServers(fetchedServer) {
    try {
      if (fetchedServer) {
        await this.batchUpsertServers([fetchedServer]);
        return [fetchedServer.id];
      }
      
      const fetchedServers = await this.client.guilds.fetch();
      const foundServers = await Promise.all(fetchedServers.map(part => part.fetch()));
      const foundIDs = await this.batchUpsertServers(foundServers);
      await this.syncMissingServers(foundIDs);
      return foundIDs;
    } catch (error) {
      logger.error('Failed to refresh Discord servers:', error);
      throw error;
    }
  },

  // BATCH UPSERT SERVERS/CHANNELS
  async batchUpsertServers(servers) {
    const serverOps = [];
    const channelOps = [];
    const foundIDs = [];

    for (const server of servers) {
      foundIDs.push(server.id);
      
      const guildInfo = {
        server_name: server.name,
        server_avatar_url: server.iconURL(),
        sort_position: 0,
        available: true
      };

      serverOps.push(
        this.discordServer.upsert(
          { server_id: server.id },
          { server_id: server.id, ...guildInfo },
          guildInfo
        )
      );

      const channels = await server.channels.fetch();
      const channelData = await this.prepareChannelBatch(server, channels);
      channelOps.push(...channelData.ops);
      
      // ACTIVE CHANNEL SELECT
      await this.ensureActiveChannel(server.id, channelData.validChannelIds);
    }

    await Promise.all([...serverOps, ...channelOps]);
    
    // ENSURE ACTIVE SERVER EXISTS
    await this.ensureActiveServer(foundIDs[0]);
    
    return foundIDs;
  },

  // PREP CHANNEL BATCHES
  async prepareChannelBatch(server, channels) {
    const validChannelIds = [];
    const ops = [];

    for (const [, channel] of channels) {
      const channelData = {
        channel_name: channel.name,
        channel_type: channel.type,
        position: channel.rawPosition,
        parent_id: channel.parentId || ''
      };

      validChannelIds.push(channel.id);
      ops.push(
        this.discordChannel.upsert(
          { channel_id: channel.id },
          { channel_id: channel.id, discord_server: server.id, ...channelData },
          channelData
        )
      );
    }

    // BATCH DELETE INVALID CHANNELS
    ops.push(
      this.discordChannel.deleteMany({
        channel_id: { notIn: validChannelIds },
        discord_server: server.id
      })
    );

    return { ops, validChannelIds };
  },

  // ENSURE VALID ACTIVE CHANNEL
  async ensureActiveChannel(serverId, validChannelIds) {
    const discordServer = await this.discordServer.getComplete(serverId);
    const activeChannel = discordServer.active_channel_id;

    if (!activeChannel || !validChannelIds.includes(activeChannel)) {
      const channels = await this.discordChannel.getMany({ discord_server: serverId });
      const firstTextChannel = _.find(
        channels,
        (ch) => ch.isTextChannel && ch.parent_id && ch.position === 0
      );

      if (firstTextChannel) {
        await this.discordServer.update(
          { server_id: serverId },
          { active_channel_id: firstTextChannel.channel_id }
        );
      }
    }
  },

  // ENSURE ACTIVE SERVER EXISTS
  async ensureActiveServer(defaultServerId) {
    const activeServer = await this.state.getActiveServer();
    if (!activeServer) {
      logger.info(`No active server detected, setting active to: ${defaultServerId}`);
      await this.state.changeActive(defaultServerId);
    }
  },

  // MARK UNAVAILABLE
  async syncMissingServers(availableServerIDs) {
    try {
      const existingServers = await this.discordServer.getMany();
      const unavailableServers = existingServers.filter(
        server => server.available && !availableServerIDs.includes(server.server_id)
      );

      if (unavailableServers.length > 0) {
        await Promise.all(
          unavailableServers.map(server =>
            this.discordServer.update(
              { server_id: server.server_id },
              { available: false }
            )
          )
        );

        unavailableServers.forEach(server => {
          logger.warn('Server currently not available or visible:', server);
        });
      }

      return unavailableServers.map(server => server.server_id);
    } catch (error) {
      logger.error('Failed to sync missing servers:', error);
      throw error;
    }
  },

  // UPDATE BOT INFO
  async refreshBotInfo(powerOn) {
    try {
      const botClient = this.client.user;
      const discordBot = await this.discordBot.update({
        bot_id: botClient.id,
        bot_username: botClient.displayName,
        bot_discriminator: botClient.discriminator,
        bot_invite_link: genInvite(this.client),
        bot_avatar_url: botClient.displayAvatarURL()
      });
      await this.updatePowerState(powerOn, discordBot);
    } catch (error) {
      logger.error('Failed to refresh bot info:', error);
      throw error;
    }
  },

  // UPDATE INVITE LINK
  async setInviteLink() {
    try {
      return await this.discordBot.update({
        bot_invite_link: genInvite(this.client)
      });
    } catch (error) {
      logger.error('Failed to set invite link:', error);
      throw error;
    }
  },

  // UPDATE UI AFTER SERVER SORT
  async updateServerSortOrder() {
    try {
      const [serverRows, discordBot, state] = await Promise.all([
        this.refreshAllDiscordServers(),
        this.discordBot.get(),
        this.state.get()
      ]);

      const servers = await this.getServerTemplateObj(serverRows);

      await this.emitCompiled([
        'sidebar/servers/serverSortableContainer.pug',
        'sidebar/servers/serverBannerLabel.pug',
        'sidebar/channels/chatChannels.pug',
        'chat/messageChannelHeader.pug',
        'chat/chatBar.pug',
        'modals/bot/power.pug'
      ], {
        servers,
        discordBot,
        state,
        loading: false
      });
    } catch (error) {
      logger.error('Failed to update server sort order:', error);
      throw error;
    }
  }
};
