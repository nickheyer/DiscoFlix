const { Events } = require('discord.js');


async function registerBotOnReady(client) {
  await client.core.refreshBotInfo(true);
  await client.core.updateServerSortOrder();
}

module.exports = {
	name: Events.ClientReady,
	once: false,
	async execute(client) {
    await registerBotOnReady(client);
    global.logger.info(`Logged in as ${client.user.tag}!`);
	},
};