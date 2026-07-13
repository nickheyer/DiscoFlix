const { Events } = require('discord.js');
const { parsePrefixCommand, usageText } = require('../../commands');
const { runRequestFlow } = require('../../commands/requestFlow');
const { buildStatusReply } = require('../../commands/status');
const { memberRoleTokens } = require('../../commands/access');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    const core = message.client.core;
    // THE MIRROR IS GUILD-ONLY - DMS SKIP IT INSIDE logMessageToInterface
    await core.discord.logMessageToInterface(message);
    core.logger.info(`Message from ${message.author.username}: ${message.content}`);

    // PREFIX COMMANDS (`!df movie|show <title>`) - GUILD CHANNELS AND DMS BOTH
    if (message.author.bot) return;

    const config = await core.models.configuration.get();
    const command = parsePrefixCommand(message.content, config.prefix_keyword);
    if (!command) return;

    if (command.type === 'help') {
      await message.channel.send(usageText(config.prefix_keyword));
      return;
    }

    if (command.type === 'status') {
      await message.channel.send(await buildStatusReply(core, message.author.id));
      return;
    }

    await runRequestFlow(core, {
      contentType: command.contentType,
      title: command.title,
      discordUser: message.author,
      guildId: message.guildId || null,
      channel: message.channel,
      origContent: message.content,
      messageId: message.id,
      roleTokens: memberRoleTokens(message.member),
      send: (payload) => message.channel.send(payload)
    });
	},
};
