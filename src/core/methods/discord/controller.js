module.exports = {
  async autoStartBot() {
    this.logger.info('Autostarting Bot');
    const currentState = await this.state.get();
    const initBotState = currentState['discord_state'];
    try {
      if (initBotState) {
        this.logger.info('Attempting to autostart Bot');
        if (await this.startBot()) {
          this.logger.info('Bot was started');
        } else {
          throw new Error('Bot was unable to start');
        }
      }
    } catch (err) {
      await this.state.update({ 'discord_state': false });
      this.logger.error(`Error in autoStartBot: ${err}`);
    }
  },

  // ATTEMPT TO USE ALL THREE AVAILABLE TOKEN PROVIDERS
  async startBot(token) {
    try {
      if (!token) { // TOKEN ARG
        const config = await this.configuration.get();
        token = config.discord_token; // TOKEN CONFIGURATION
        if (!token) {
          token = process.env.DEV_TOKEN; // TOKEN ENV
          if (token) {
            await this.configuration.updateTokens({
              discord: token // UPDATE CONFIGURATION DB IF TOKEN IN ENV
            });
          } else {
            throw new Error('Discord bot token is required.');
          }
        }
      }
      if (!this.client.isReady()) {
        await this.client.login(token);
        this.logger.info('Bot successfully logged in and state updated');
      } else {
        throw new Error('Attempting to login with already logged in bot!');
      }
    } catch (startErr) {
      this.logger.error(startErr.message || startErr);
      await this.updatePowerState(false);
      return false;
    }
    return true;
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