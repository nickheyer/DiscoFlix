const _ = require('lodash');

module.exports = {

  async refreshDiscordServers() {
    const foundPartialServers = await this.client.guilds.fetch();
    const foundServers = await Promise.all(foundPartialServers.map((part) => part.fetch()));
    await Promise.all(_.forEach(foundServers, async (foundServer) => {
      const guildInfo = {
        server_name: foundServer.name,
        server_id: foundServer.id,
        server_avatar_url: foundServer.iconURL()
      };
      await this.discordServer.upsert(guildInfo);
      logger.debug('Fetched Discord Server: ', guildInfo);

      const foundPartialChannels = await foundServer.channels.fetch();
      const foundChannels = await Promise.all(foundPartialChannels.map((part) => part.fetch()));
      const channels = await Promise.all(_.map(foundChannels, async (foundChannel) => {
        const channel = {
          discord_server: foundServer.id,
          channel_id: foundChannel.id,
          channel_name: foundChannel.name,
          channel_type: foundChannel.type,
          isTextChannel: foundChannel.type === 0,
          isVoiceChannel: foundChannel.type === 2,
          isCategory: foundChannel.type === 4,
          position: foundChannel.rawPosition
        };

        await this.discordChannel.upsert(channel);
        return channel;
      }));

      const channelNames = _.map(channels, 'channel_name');
      logger.debug('Fetch Channels For This Server: ', channelNames);
    }));

    return await this.discordServer.getSorted();
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
    const serverRows = await this.refreshDiscordServers();
    const servers = await this.getServerTemplateObj(serverRows);
    await this.emitCompiled('sidebar/servers/serverSortableContainer.pug', {
      servers
    });
  },

};
