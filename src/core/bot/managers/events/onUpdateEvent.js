const { Events } = require('discord.js');

module.exports = {
	name: 'MiscDiscordUpdateEvent',
  onMultiple: [
    Events.ChannelCreate,
    Events.ChannelDelete,
    Events.ChannelUpdate,
    Events.GuildBanAdd,
    Events.GuildBanRemove,
    Events.GuildCreate,
    Events.GuildDelete,
    Events.GuildMemberAdd,
    Events.GuildMemberRemove,
    Events.GuildMemberUpdate,
    Events.GuildUpdate,
  ],
	once: false,
	async execute(client, ...args) {
    const core = client.core;
    await core.discord.refreshDiscordServers();
    await core.discord.refreshUI();
    core.logger.info(`Bot ${client.user.tag} witnessed server/guild event`);
	},
};
