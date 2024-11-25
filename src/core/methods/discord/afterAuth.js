const _ = require('lodash');


function genInvite(client) {
  return client.generateInvite({ scopes: ['bot'], permissions: ['1689934407138496']});
}


module.exports = {

  // PARSES CHANNELS/GUILD ATTRIBUTES OF ALL CONNECTED GUILDS (SERVERS)
  async refreshAllDiscordServers() {
    const foundIDs = [];
    const foundPartialServers = await this.client.guilds.fetch();
    const foundServers = await Promise.all(foundPartialServers.map(part => part.fetch()));
    for (const foundServer of foundServers) {
      await this.upsertDiscordServer(foundServer);
      await this.fetchAndUpsertChannels(foundServer);
      foundIDs.push(foundServer.id);
    }
    await this.syncMissingServers(foundIDs);
    return await this.discordServer.getSorted();
  },

  // PARSES CHANNELS/GUILD ATTRIBUTES OF SINGLE (DEF) GUILD (SERVER) FROM OBJECT(S)
  async refreshDiscordServers(fetchedServer) {
    if (!fetchedServer) {
      const fetchedServers = await this.client.guilds.fetch();
      const foundServers = await Promise.all(fetchedServers.map(part => part.fetch()));
      const foundIDs = [];
      for (const foundServer of foundServers) {
        await this.upsertDiscordServer(foundServer);
        await this.fetchAndUpsertChannels(foundServer);
        foundIDs.push(foundServer.id);
      }
      await this.syncMissingServers(foundIDs);
      return foundIDs;
    } else {
      await this.upsertDiscordServer(fetchedServer);
      await this.fetchAndUpsertChannels(fetchedServer);
    }
  },

  async syncMissingServers(availableServerIDs) {
    const unavailable = [];
    const existingServers = await this.discordServer.getMany();
    for (let i = 0; i < existingServers.length; i++) {
      const existing = existingServers[i];
      if (existing.available && !availableServerIDs.includes(existing.server_id)) {
        await this.discordServer.update(
          { server_id: existing.server_id },
          { available: false }
        );
        unavailable.push(existing.server_id);
        logger.warn(`Server currently not available or visible, marking unavailable: `, existing);
      }
    }
    return unavailable;
  },

  async upsertDiscordServer(server) {
    const guildInfo = {
      server_id: server.id,
      server_name: server.name,
      server_avatar_url: server.iconURL(),
      sort_position: 0,
      available: true
    };

    await this.discordServer.upsert({
      where: { server_id: server.id },
      update: guildInfo,
      create: guildInfo
    });

    const activeServer = await this.state.getActiveServer();
    if (!activeServer) {
      logger.info(`No active server detected, setting active to:  ${server.id}`);
      await this.state.changeActive(server.id);
    }
  
    logger.debug('Fetched Discord Server:', guildInfo);
  },

  async fetchAndUpsertChannels(server) {
    const foundPartialChannels = await server.channels.fetch();
    const foundChannels = await Promise.all(foundPartialChannels.map(part => part.fetch()));
    const visibleChannelIDs = [];
    const createdChannels = [];
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
      createdChannels.push(channelData);
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

    const discordServer = await this.discordServer.get({ server_id: server.id });
    const activeChannel = discordServer.active_channel_id;
    if (!activeChannel || !visibleChannelIDs.includes(activeChannel)) {
      const firstTextChannel = _.find(
        createdChannels,
        (ch) => ch.isTextChannel && ch.parent_id && ch.position === 0
      );
      await this.discordServer.update(
        { server_id: discordServer.server_id },
        { active_channel_id: firstTextChannel ? firstTextChannel.channel_id : null }
      );
    }
  },

  async refreshBotInfo(powerOn) {
    const inviteLink = genInvite(this.client);
    const botClient = this.client.user;
    const clientID = botClient.id;
    const clientName = botClient.displayName;
    const clientDiscrim = botClient.discriminator;
    const clientAvatar = botClient.displayAvatarURL();
    const discordBot = await this.discordBot.update({
      bot_id: clientID,
      bot_username: clientName,
      bot_discriminator: clientDiscrim,
      bot_invite_link: inviteLink,
      bot_avatar_url: clientAvatar
    })
    await this.updatePowerState(powerOn, discordBot)
  },

  async setInviteLink() {
    const inviteLink = genInvite(this.client);
    return await this.discordBot.update({ bot_invite_link: inviteLink });
  },

  async updateServerSortOrder() {
    const serverRows = await this.refreshAllDiscordServers();
    const servers = await this.getServerTemplateObj(serverRows);
    const discordBot = await this.discordBot.get();
    const state = await this.state.get();
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
  },
};
