module.exports = {
  async autoStartBot() {
    // ENV SEEDING RUNS FIRST SO A HEADLESS FIRST BOOT HAS ITS TOKEN AND APPS
    await this.core.apps.seedFromEnv();
    this.logger.info('Autostarting Bot');
    const currentState = await this.core.models.state.get();
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
      await this.core.models.state.update({ 'discord_state': false });
      this.logger.error(`Error in autoStartBot: ${err}`);
    }
  },

  async startBot(token) {
    try {
      if (!token) { // TOKEN ARG, ELSE CONFIG (WHICH seedFromEnv FILLS ON FIRST BOOT)
        const config = await this.core.models.configuration.get();
        token = config.discord_token;
        if (!token) {
          throw new Error('Discord bot token is required.');
        }
      }
      if (!this.core.client.isReady()) {
        await this.core.client.login(token);
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
    if (this.core.client && this.core.client.isReady()) {
      await this.core.client.destroy();
      this.core.resetClient();
      this.logger.info('Bot has been stopped.');
      return true;
    } else {
      this.logger.warn('Attempting to stop dead bot!');
      return false;
    }
  }
};
