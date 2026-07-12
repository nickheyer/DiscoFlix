const { Events } = require('discord.js');

module.exports = {
	name: Events.MessageUpdate,
	once: false,
	async execute(oldMessage, newMessage) {
    const core = newMessage.client.core;
    try {
      await core.discord.logMessageEditToInterface(oldMessage, newMessage);
    } catch (err) {
      core.logger.error('Failed to mirror message edit:', err);
    }
	},
};
