const { Events } = require('discord.js');
const interactions = require('../../interactions');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    const core = message.client.core;
    // THE MIRROR IS GUILD-ONLY - DMS SKIP IT INSIDE logMessageToInterface
    await core.discord.logMessageToInterface(message);
    core.logger.info(`Message from ${message.author.username}: ${message.content}`);

    // PREFIX FEATURES (`!df movie|show|status... `) - GUILD CHANNELS AND DMS BOTH
    if (message.author.bot) return;
    const handled = await interactions.dispatchPrefix(core, message);

    // NOT A COMMAND: @MENTIONS, REPLIES TO THE BOT, AND BARE DMS FLOW INTO
    // AI CHAT WHEN AN AI PROVIDER IS SERVING (GATED LIKE EVERY FEATURE)
    if (!handled) {
      await interactions.dispatchAiMention(core, message).catch(err =>
        core.logger.error('AI mention dispatch failed:', err)
      );
    }
	},
};
