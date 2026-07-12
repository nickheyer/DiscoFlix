const { Events } = require('discord.js');
const { parsePrefixCommand, usageText } = require('../../commands');
const { runRequestFlow } = require('../../commands/requestFlow');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {
    const core = message.client.core;
    await core.discord.logMessageToInterface(message);
    core.logger.info(`Message from ${message.author.username}: ${message.content}`);

    // PREFIX COMMANDS (`!df movie|show <title>`)
    if (message.author.bot || !message.guildId) return;

    const config = await core.models.configuration.get();
    const command = parsePrefixCommand(message.content, config.prefix_keyword);
    if (!command) return;

    if (command.type === 'help') {
      await message.channel.send(usageText(config.prefix_keyword));
      return;
    }

    await runRequestFlow(core, {
      contentType: command.contentType,
      title: command.title,
      discordUser: message.author,
      guildId: message.guildId,
      channel: message.channel,
      origContent: message.content,
      messageId: message.id,
      send: (payload) => message.channel.send(payload)
    });
	},
};
