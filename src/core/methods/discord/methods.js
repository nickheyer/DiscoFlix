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
    await this.emitCompiled([
      'chat/discordMessage.pug'
    ], {
      username: `${discordMessage.author.username}`,
      isBot: !!(discordMessage.author.bot),
      timeStamp: discordMessage.createdAt.toLocaleString(),
      avatarUrl: discordMessage.author.displayAvatarURL(),
      messageText: discordMessage.content
    });
  }
};
