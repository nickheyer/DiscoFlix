const { Events } = require('discord.js');
const interactions = require('../../interactions');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    const core = message.client.core;
    // THE MIRROR IS GUILD-ONLY - DMS SKIP IT INSIDE logMessageToInterface
    await core.discord.logMessageToInterface(message);
    core.logger.info(`Message from ${message.author.username}: ${message.content}`);

    // PREFIX FEATURES (`!df movie|show|status... `) - GUILD CHANNELS AND DMS BOTH
    if (message.author.bot) return;
    await interactions.dispatchPrefix(core, message);
	},
};
