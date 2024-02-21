module.exports = {
  async getDiscordServers() {
    const servers = [];
    const foundServers = await this.client.guilds.fetch();
    foundServers.each(async (foundServer) => {
      const guildInfo = {
        server_name: foundServer.name,
        server_id: foundServer.id,
        server_avatar_url: foundServer.iconURL()
      };
      logger.debug('Fetch Discord Servers, Upserting to DB: ', guildInfo);
      servers.push(guildInfo);
    });
    return servers;
  },

  async refreshDiscordServers() {
    // GET NEW GUILDS/SERVERS FROM DISCORD API
    const allServersFound = await this.getDiscordServers();
    for (let i = 0; i < allServersFound.length; i++) {
      await this.discordServer.upsert(allServersFound[i]);
    }
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
