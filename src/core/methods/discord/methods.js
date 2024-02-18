module.exports = {
  async updatePowerState(powerOn, discordBotInst = null) {
    this.logger.debug('Changing Discord Bot Power State: ', discordBot);
    const discordBot = discordBotInst || await this.discordBot.get();
    await this.emitCompiled([
      'nav/user/buttons/botPowerButton.pug',
      'nav/user/userBoxInfo.pug',
      'nav/servers/addServer.pug'
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
};
