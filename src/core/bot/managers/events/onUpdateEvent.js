const { Events } = require('discord.js');
const _ = require('lodash');

// GUILD EVENTS ARRIVE IN BURSTS (BULK BANS, CHANNEL REORDERS, ROLE SWEEPS).
// DEBOUNCE PARAMS COME FROM TUNING - A CHANGED VALUE REBUILDS THE DEBOUNCER
// (FLUSHING ANY PENDING BURST FIRST SO NO EVENT IS DROPPED)
function getDebouncedRefresh(core) {
  const debounceMs = core.tuning.value('guild_refresh_debounce_ms');
  const maxWaitMs = core.tuning.value('guild_refresh_max_wait_ms');
  const cached = core._guildRefreshDebounced;
  if (!cached || cached._debounceMs !== debounceMs || cached._maxWaitMs !== maxWaitMs) {
    cached?.flush();
    core._guildRefreshDebounced = _.debounce(async () => {
      try {
        await core.discord.refreshDiscordServers();
        // ROSTER RIDES THE SAME DEBOUNCE - MEMBER JOINS/LEAVES RELINK BEFORE
        // THE MEMBERS PANE RE-RENDERS
        await core.discord.syncAllGuildMembers();
        // A DROPPED CHANNEL TAKES ITS COUNTED MESSAGES WITH IT - RE-SUM THE
        // SERVER ROLL-UPS SO THE RAIL BADGE CAN'T STRAND
        await core.discord.resyncUnreadRollups();
        await core.discord.refreshUI();
        core.logger.info('Guild-event refresh completed');
      } catch (err) {
        core.logger.error('Guild-event refresh failed:', err);
      }
    }, debounceMs, { maxWait: maxWaitMs });
    core._guildRefreshDebounced._debounceMs = debounceMs;
    core._guildRefreshDebounced._maxWaitMs = maxWaitMs;
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
