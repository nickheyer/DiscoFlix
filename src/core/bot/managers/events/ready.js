const { Events } = require('discord.js');

module.exports = {
	name: Events.ClientReady,
	once: false,
	async execute(client) {
    const core = client.core;
    await core.discord.refreshBotInfo(true);
    await core.discord.updateServerSortOrder();
    core.logger.info(`Logged in as ${client.user.tag}!`);
	},
};
