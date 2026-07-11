const { Events } = require('discord.js');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    const core = message.client.core;
    await core.discord.logMessageToInterface(message);
    core.logger.info(`Message from ${message.author.username}: ${message.content}`);
	},
};
