const { ActivityType } = require('discord.js');

// GENERATE BOT INVITE LINK
function genInvite(client) {
  return client.generateInvite({ scopes: ['bot'], permissions: ['1689934407138496'] });
}

const PRESENCE_ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing
};

module.exports = {
  // STATUS LINE OFF THE CONFIG - CALLED ON READY AND AFTER SETTINGS SAVES
  async applyPresence() {
    try {
      const config = await this.core.models.configuration.get();
      const type = PRESENCE_ACTIVITY_TYPES[config.bot_presence_activity];
      const text = (config.bot_presence_text || '').trim();
      const activities = type !== undefined && text ? [{ name: text, type }] : [];
      this.core.client.user.setPresence({ status: 'online', activities });
      this.logger.info(activities.length
        ? `Presence set: ${config.bot_presence_activity} ${text}`
        : 'Presence cleared');
    } catch (err) {
      this.logger.warn(`Presence update failed: ${err.message}`);
    }
  },

  // SYNC ALL SERVERS AND CHANNELS
  async refreshAllDiscordServers() {
    try {
      const foundPartialServers = await this.core.client.guilds.fetch();
      const foundServers = await Promise.all(foundPartialServers.map(part => part.fetch()));
      const foundIDs = await this.batchUpsertServers(foundServers);
      await this.syncMissingServers(foundIDs);
      return await this.core.models.discordServer.getSorted();
    } catch (error) {
      this.logger.error('Failed to refresh all Discord servers:', error);
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

      const fetchedServers = await this.core.client.guilds.fetch();
      const foundServers = await Promise.all(fetchedServers.map(part => part.fetch()));
      const foundIDs = await this.batchUpsertServers(foundServers);
      await this.syncMissingServers(foundIDs);
      return foundIDs;
    } catch (error) {
      this.logger.error('Failed to refresh Discord servers:', error);
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

      // UPDATE MUST STAY PARTIAL: sort_position/unread/active_channel ARE
      // UI-OWNED STATE AND MUST SURVIVE RE-SYNCS
      const guildInfo = {
        server_name: server.name,
        server_avatar_url: server.iconURL(),
        available: true
      };

      serverOps.push(
        this.core.models.discordServer.upsert(
          { server_id: server.id },
          { server_id: server.id, sort_position: 0, ...guildInfo },
          guildInfo
        )
      );

      const channels = await server.channels.fetch();
      const channelData = await this.prepareChannelBatch(server, channels);
      channelOps.push(...channelData.ops);

      // ACTIVE CHANNEL SELECT
      await this.core.render.ensureActiveChannel(server.id, channelData.validChannelIds);
    }

    await Promise.all([...serverOps, ...channelOps]);

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
        this.core.models.discordChannel.upsert(
          { channel_id: channel.id },
          { channel_id: channel.id, discord_server: server.id, ...channelData },
          channelData
        )
      );
    }

    // BATCH DELETE INVALID CHANNELS
    ops.push(
      this.core.models.discordChannel.deleteMany({
        channel_id: { notIn: validChannelIds },
        discord_server: server.id
      })
    );

    return { ops, validChannelIds };
  },

  // MARK UNAVAILABLE
  async syncMissingServers(availableServerIDs) {
    try {
      const existingServers = await this.core.models.discordServer.getMany();
      const unavailableServers = existingServers.filter(
        server => server.available && !availableServerIDs.includes(server.server_id)
      );

      if (unavailableServers.length > 0) {
        await Promise.all(
          unavailableServers.map(server =>
            this.core.models.discordServer.update(
              { server_id: server.server_id },
              { available: false }
            )
          )
        );

        unavailableServers.forEach(server => {
          this.logger.warn('Server currently not available or visible:', server);
        });
      }

      return unavailableServers.map(server => server.server_id);
    } catch (error) {
      this.logger.error('Failed to sync missing servers:', error);
      throw error;
    }
  },

  // UPDATE BOT INFO
  async refreshBotInfo(powerOn) {
    try {
      const botClient = this.core.client.user;
      const discordBot = await this.core.models.discordBot.update({
        bot_id: botClient.id,
        bot_username: botClient.displayName,
        bot_discriminator: botClient.discriminator,
        bot_invite_link: genInvite(this.core.client),
        bot_avatar_url: botClient.displayAvatarURL()
      });
      await this.updatePowerState(powerOn, discordBot);
    } catch (error) {
      this.logger.error('Failed to refresh bot info:', error);
      throw error;
    }
  },

  // UPDATE INVITE LINK
  async setInviteLink() {
    try {
      return await this.core.models.discordBot.update({
        bot_invite_link: genInvite(this.core.client)
      });
    } catch (error) {
      this.logger.error('Failed to set invite link:', error);
      throw error;
    }
  },

  // UPDATE UI AFTER GUILD SYNCS - COMPILED PER VIEW SO EVERY BROWSER KEEPS
  // ITS OWN ACTIVE SERVER/CHANNEL
  async updateServerSortOrder() {
    try {
      const [serverRows, discordBot] = await Promise.all([
        this.refreshAllDiscordServers(),
        this.core.models.discordBot.get()
      ]);

      await this.core.sockets.emitPerView(async (view) => {
        const servers = await this.core.render.getServerTemplateObj(serverRows, view);

        // APP TAKEOVER GUARD: GUILD SYNCS MAY ONLY TOUCH THE RAIL - EMITTING THE
        // BANNER/HEADER/CHAT BAR HERE RESURRECTS CHAT CHROME OVER THE APP SURFACE
        const chromeTemplates = view.active_app_id
          ? []
          : [
            'sidebar/servers/serverBannerLabel.pug',
            'sidebar/channels/chatChannels.pug',
            'chat/messageChannelHeader.pug',
            'chat/chatBar.pug'
          ];

        return this.core.render.compile([
          'sidebar/servers/serverSortableContainer.pug',
          ...chromeTemplates,
          'modals/bot/power.pug'
        ], {
          servers,
          discordBot,
          state: view,
          loading: false
        });
      });
    } catch (error) {
      this.logger.error('Failed to update server sort order:', error);
      throw error;
    }
  }
};
