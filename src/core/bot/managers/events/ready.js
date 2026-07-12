const { Events } = require('discord.js');
const { buildSlashCommands } = require('../../commands');

module.exports = {
	name: Events.ClientReady,
	once: false,
	async execute(client) {
    const core = client.core;
    await core.discord.refreshBotInfo(true);
    await core.discord.updateServerSortOrder();

    try {
      const commands = await client.application.commands.set(buildSlashCommands());
      core.logger.info(`Registered ${commands.size} slash commands`);
    } catch (err) {
      core.logger.error('Slash command registration failed:', err);
    }

    core.logger.info(`Logged in as ${client.user.tag}!`);
	},
};
