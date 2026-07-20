const { Events } = require('discord.js');

// AUTOMOD SWEEPS / MOD "DELETE MESSAGE HISTORY" BANS LAND HERE - ONE
// RECOUNT FOR THE WHOLE BATCH INSTEAD OF ONE PER MESSAGE
module.exports = {
	name: Events.MessageDeleteBulk,
	once: false,
	async execute(messages, channel) {
    const core = channel.client.core;
    if (!channel.guildId) return; // DMS NOT MIRRORED
    await core.discord.logMessageDeleteToInterface(
      channel.guildId,
      channel.id,
      [...messages.keys()]
    );
	},
};
