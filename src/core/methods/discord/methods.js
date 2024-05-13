module.exports = {
  async updatePowerState(powerOn, discordBotInst = null) {
    const discordBot = discordBotInst || await this.discordBot.get();
    this.logger.debug('Changing Discord Bot Power State: ', discordBot);
    await this.emitCompiled([
      'sidebar/userControls/userControlsLayout.pug',
      'sidebar/servers/addServerButton.pug'
    ], {
      discordBot,
      state: await this.state.update({ discord_state: powerOn })
    });
  },

  async getInviteLink() {
    const discordBot = await this.discordBot.get();
    const inviteLink = discordBot.bot_invite_link;
    return inviteLink;
  },

  async logMessageToInterface(discordMessage) {
    const author = await discordMessage.author.fetch(true);

    await this.emitCompiled([
      'chat/discordMessage.pug'
    ], {
      username: `${author.displayName}`,
      isBot: !!(author.bot),
      timeStamp: discordMessage.createdAt.toLocaleString(),
      avatarUrl: author.displayAvatarURL(),
      messageText: discordMessage.content,
      accentColor: author.hexAccentColor
    });
  },

  async logTextToInterface(textContent, username, avatar) {
    const discordBot = await this.discordBot.get();
    if (!username) {
      username = discordBot ? discordBot.displayName : '...';
    }
    if (!avatar) {
      avatar = discordBot ? discordBot.bot_avatar_url : '';
    }

    const now = new Date(Date.now());

    textContent = `${textContent}`;

    await this.emitCompiled([
      'chat/discordMessage.pug'
    ], {
      username: `${username}`,
      isBot: false,
      timeStamp: now.toLocaleString(),
      avatarUrl: avatar,
      messageText: textContent,
      accentColor: '#43b581'
    });
  },

  // EMITS A TEMPLATE OF AN UPDATED GUILD/SERVER/CHANNELS/ETC
  async refreshUI(serverID) {
    const { server, channels } = await this.getOneServerTemplate(serverID);
    await this.emitCompiled([
      'sidebar/servers/serverBannerLabel.pug',
      'sidebar/channels/chatChannels.pug'
    ], { servers: {
      activeServer: server,
      activeServerChannels: channels
    }});
  }
};
