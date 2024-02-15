const { Events } = require('discord.js');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    if (message.author.bot) {
      return false;
    }
    await message.reply('Im listening!');
    global.logger.info(`Message from ${message.author.username}: ${message.content}`);
	},
};