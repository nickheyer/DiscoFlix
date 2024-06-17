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
    //Events.ThreadCreate,
    //Events.ThreadDelete,
    //Events.UserUpdate,
    //Events.GuildDelete,
    // Events.GuildUnavailable,
    // Events.GuildMemberRemove,
    //Events.GuildMemberUpdate,

    //Events.MessageCreate,
    //Events.MessageDelete
  ],
	once: false,
	async execute(client, ...args) {
    console.log('ON UPDATE EVENT STARTED!');
    const core = client.core;
    if (core) {
      await core.refreshDiscordServers();
      await core.refreshUI();
      global.logger.info(`Bot ${client.user.tag} witnessed server/guild event`);
    } else {
      global.logger.debug(`Event triggered with args: `, args);
    }
    console.log('ON UPDATE EVENT ENDED!');
	},
};