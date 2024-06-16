const { Events } = require('discord.js');

module.exports = {
	name: 'MiscDiscordUpdateEvent',
  onMultiple: [
    Events.ChannelCreate,
    Events.ChannelDelete,
    Events.ChannelUpdate,
    //Events.GuildMemberAdd,
    //Events.GuildUpdate,
    //Events.ThreadCreate,
    //Events.ThreadDelete,
    //Events.UserUpdate,
    //Events.GuildDelete,
    // Events.GuildUnavailable,
    // Events.GuildMemberRemove,
    //Events.GuildMemberUpdate,
    Events.GuildBanAdd,
    Events.GuildBanRemove,
    //Events.GuildAvailable
    //Events.MessageCreate,
    //Events.MessageDelete
  ],
	once: false,
	async execute(client, ...args) {
    const core = client.core;
    if (core) {
      await core.refreshDiscordServers();
      await core.refreshUI();
      global.logger.info(`Bot ${client.user.tag} witnessed server/guild event`);
    } else {
      global.logger.debug(`Event triggered with args: `, args);
    }
	},
};