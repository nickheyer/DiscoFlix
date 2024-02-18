const { Events } = require('discord.js');

module.exports = {
	name: Events.ClientReady,
	once: false,
	async execute(client) {
    const core = client.core;
    await core.refreshBotInfo(true);
    await core.updateServerSortOrder();
    global.logger.info(`Logged in as ${client.user.tag}!`);
	},
};