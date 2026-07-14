const { Events } = require('discord.js');
const { buildSlashCommands } = require('../../interactions');

module.exports = {
	name: Events.ClientReady,
	once: false,
	async execute(client) {
    const core = client.core;
    await core.discord.refreshBotInfo(true);
    await core.discord.updateServerSortOrder();
    await core.discord.syncAllGuildMembers();
    await core.discord.applyPresence();

    try {
      const commands = await client.application.commands.set(await buildSlashCommands(core));
      core.logger.info(`Registered ${commands.size} slash commands`);
    } catch (err) {
      core.logger.error('Slash command registration failed:', err);
    }

    core.logger.info(`Logged in as ${client.user.tag}!`);
	},
};
