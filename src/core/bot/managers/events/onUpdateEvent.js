const { Events } = require('discord.js');
const _ = require('lodash');

// GUILD EVENTS ARRIVE IN BURSTS (BULK BANS, CHANNEL REORDERS, ROLE SWEEPS)
const REFRESH_DEBOUNCE_MS = 2000;
const REFRESH_MAX_WAIT_MS = 10000;

function getDebouncedRefresh(core) {
  if (!core._guildRefreshDebounced) {
    core._guildRefreshDebounced = _.debounce(async () => {
      try {
        await core.discord.refreshDiscordServers();
        await core.discord.refreshUI();
        core.logger.info('Guild-event refresh completed');
      } catch (err) {
        core.logger.error('Guild-event refresh failed:', err);
      }
    }, REFRESH_DEBOUNCE_MS, { maxWait: REFRESH_MAX_WAIT_MS });
  }
  return core._guildRefreshDebounced;
}

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
    core.logger.info(`Bot ${client.user.tag} witnessed server/guild event`);
    getDebouncedRefresh(core)();
	},
};
