const { Events } = require('discord.js');
const { buildSlashCommands } = require('../../interactions');
const { syncAppEmojis } = require('../../interactions/appEmojis');

module.exports = {
	name: Events.ClientReady,
	once: false,
	async execute(client) {
    const core = client.core;
    await core.discord.refreshBotInfo(true);
    await core.discord.updateServerSortOrder();
    await core.discord.syncAllGuildMembers();
    // DELETIONS/CHANNEL DROPS WHILE OFFLINE CAN'T EMIT EVENTS - HEAL THE
    // SERVER BADGES FROM THE CHANNEL COUNTERS BEFORE MIRRORS RENDER
    await core.discord.resyncUnreadRollups();
    await core.discord.applyPresence();
    await syncAppEmojis(client, core.logger);

    try {
      const commands = await client.application.commands.set(await buildSlashCommands(core));
      core.logger.info(`Registered ${commands.size} slash commands`);
    } catch (err) {
      core.logger.error('Slash command registration failed:', err);
    }

    // A FRESH LOGIN CHANGES WHAT MIRRORS CAN SHOW - EVERY MIRROR RE-RENDERS
    await core.discord.refreshUI();

    core.logger.info(`Logged in as ${client.user.tag}!`);
	},
};
