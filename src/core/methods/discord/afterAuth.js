const _ = require('lodash');

module.exports = {

  // PARSES CHANNELS/GUILD ATTRIBUTES OF ALL CONNECTED GUILDS (SERVERS)
  async refreshAllDiscordServers() {
    const foundPartialServers = await this.client.guilds.fetch();
    const foundServers = await Promise.all(foundPartialServers.map(part => part.fetch()));
    for (const foundServer of foundServers) {
      await this.upsertDiscordServer(foundServer);
      await this.fetchAndUpsertChannels(foundServer);
    }
    return await this.discordServer.getSorted();
  },

  // PARSES CHANNELS/GUILD ATTRIBUTES OF SINGLE (DEF) GUILD (SERVER) FROM OBJECT(S)
  async refreshDiscordServers(fetchedServer) {
    if (!fetchedServer) {
      const fetchedServers = await this.client.guilds.fetch();
      const foundServers = await Promise.all(fetchedServers.map(part => part.fetch()));
      for (const foundServer of foundServers) {
        await this.upsertDiscordServer(foundServer);
        await this.fetchAndUpsertChannels(foundServer);
      }
    } else {
      await this.upsertDiscordServer(fetchedServer);
      await this.fetchAndUpsertChannels(fetchedServer);
    }
  },

  async upsertDiscordServer(server) {
    const guildInfo = {
      server_id: server.id,
      server_name: server.name,
      server_avatar_url: server.iconURL(),
      sort_position: 0
    };

    await this.discordServer.upsert({
      where: { server_id: server.id },
      update: guildInfo,
      create: guildInfo
    });
  
    logger.debug('Fetched Discord Server:', guildInfo);
  },

  async fetchAndUpsertChannels(server) {
    const foundPartialChannels = await server.channels.fetch();
    const foundChannels = await Promise.all(foundPartialChannels.map(part => part.fetch()));
    const visibleChannelIDs = [];
    for (const foundChannel of foundChannels) {
      const channelData = {
        discord_server: server.id,
        channel_id: foundChannel.id,
        channel_name: foundChannel.name,
        channel_type: foundChannel.type,
        isTextChannel: foundChannel.type === 0,
        isVoiceChannel: foundChannel.type === 2,
        isCategory: foundChannel.type === 4,
        position: foundChannel.rawPosition,
        parent_id: foundChannel.parentId || ''
      };
  
      await this.discordChannel.upsert({
        where: { channel_id: foundChannel.id },
        update: channelData,
        create: channelData
      });

      visibleChannelIDs.push(foundChannel.id);
    }

    await this.discordChannel.deleteMany({
      where: {
        channel_id: {
          notIn: visibleChannelIDs
        },
        discord_server: server.id
      }
    });
  },

  async refreshBotInfo(powerOn) {
    const inviteLink = this.client.generateInvite({ scopes: ['bot'] });
    const clientName = this.client.user.displayName;
    const clientDiscrim = this.client.user.discriminator;
    const clientAvatar = this.client.user.displayAvatarURL();
    const discordBot = await this.discordBot.update({
      bot_username: clientName,
      bot_discriminator: clientDiscrim,
      bot_invite_link: inviteLink,
      bot_avatar_url: clientAvatar
    })
    await this.updatePowerState(powerOn, discordBot)
  },

  async setInviteLink() {
    const inviteLink = this.client.generateInvite({ scopes: ['bot'] });
    return await this.discordBot.update({ bot_invite_link: inviteLink });
  },

  async updateServerSortOrder() {
    const serverRows = await this.refreshAllDiscordServers();
    const servers = await this.getServerTemplateObj(serverRows);
    await this.emitCompiled([
      'sidebar/servers/serverSortableContainer.pug',
      'sidebar/channels/chatChannels.pug'
    ], {
      servers
    });
  },

};
