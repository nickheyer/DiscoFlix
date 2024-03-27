const { Events } = require('discord.js');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    const client = message.client;
    const core = client.core;
    await core.logMessageToInterface(message);
    if (message.author.bot) {
      return false;
    }
    await message.reply('Im listening!');
    global.logger.info(`Message from ${message.author.username}: ${message.content}`);
	},
};