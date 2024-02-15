module.exports = {
  async getDiscordServers() {
    const servers = [];
    const isReady = this.client.isReady();
    if (isReady) {
      const foundServers = await this.client.guilds.fetch();
      this.logger.debug('Discord servers found: ', foundServers.toJSON());
      foundServers.each(async (foundServer) => {
        const guildInfo = {
          server_name: foundServer.name,
          server_id: foundServer.id,
          server_avatar_url: foundServer.iconURL()
        };
        this.logger.debug('PUSHING SERVER TO UPSERT: ', guildInfo);
        servers.push(guildInfo);
      });
    }
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

  async getInviteLink() {
    const discordBot = await this.discordBot.get();
    const inviteLink = discordBot.bot_invite_link;
    return inviteLink;
  },

  async setInviteLink() {
    const inviteLink = this.client.generateInvite({ scopes: ['bot'] });
    return await this.discordBot.update({ bot_invite_link: inviteLink });
  },

  async updateServerSortOrder() {
    const serverRows = await this.refreshDiscordServers();
    const servers = await this.getServerTemplateObj(serverRows);
    const discordBot = await this.discordBot.get();
    await this.emitCompiled('nav/servers/servers.pug', {
      servers, discordBot
    });
  },

  async updatePowerState(powerOn, discordBotInst = null) {
    const discordBot = discordBotInst || await this.discordBot.get();
    this.logger.debug('Changing Discord Bot Power State: ', discordBot);
    await this.emitCompiled([
      'nav/user/buttons/botPowerButton.pug',
      'nav/user/userBoxInfo.pug',
      'nav/servers/addServer.pug'
    ], {
      discordBot,
      state: await this.state.update({ discord_state: powerOn })
    });
  }
}
