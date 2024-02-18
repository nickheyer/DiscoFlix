module.exports = {
  async autoStartBot() {
    this.logger.info('Autostarting Bot');
    const currentState = await this.state.get();
    const initBotState = currentState['discord_state'];
    try {
      if (initBotState) {
        this.logger.info('Attempting to autostart Bot');
        await this.startBot();
      }
    } catch (err) {
      await this.state.update({ 'discord_state': false });
      this.logger.error(`Error in autoStartBot: ${err}`);
    }
  },

  async startBot(token = process.env.DEV_TOKEN) {
    if (!token) {
      const config = await this.configuration.get();
      token = config.discord_token;
    }
    if (!token) {
      this.logger.warn('Discord bot token is required.');
      return;
    }
    if (!this.client.isReady()) {
      await this.client.login(token);
      this.logger.info('Bot successfully logged in and state updated');
    } else {
      this.logger.warn('Attempting to login with already logged in bot!');
    }
  },

  async stopBot() {
    await this.updatePowerState(false);
    if (this.client && this.client.isReady()) {
      await this.client.destroy();
      this._client = null;
      this.logger.info('Bot has been stopped.');
      return true;
    } else {
      this.logger.warn('Attempting to stop dead bot!');
      return false;
    }
  }
};