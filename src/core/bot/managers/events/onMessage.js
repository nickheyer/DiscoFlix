const { Events } = require('discord.js');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    console.log('ON MESSAGE EVENT STARTED!');
    const client = message.client;
    const core = client.core;
    await core.logMessageToInterface(message);
    if (message.author.bot) {
      return false;
    }
    await message.reply(message.content);
    global.logger.info(`Message from ${message.author.username}: ${message.content}`);
    console.log('ON MESSAGE EVENT ENDED!');
	},
};