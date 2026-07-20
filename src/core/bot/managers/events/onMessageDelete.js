const { Events } = require('discord.js');

// DELETED MESSAGES USUALLY ARRIVE AS PARTIALS (id/channelId/guildId ONLY) -
// THAT'S ALL THE MIRROR NEEDS TO DROP THE ROW AND RECOUNT UNREADS
module.exports = {
	name: Events.MessageDelete,
	once: false,
	async execute(message) {
    const core = message.client.core;
    if (!message.guildId) return; // DMS NOT MIRRORED
    await core.discord.logMessageDeleteToInterface(
      message.guildId,
      message.channelId,
      [message.id]
    );
	},
};
