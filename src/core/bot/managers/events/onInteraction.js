const { Events } = require('discord.js');
const { slashContentType } = require('../../commands');
const { runRequestFlow } = require('../../commands/requestFlow');

module.exports = {
	name: Events.InteractionCreate,
	once: false,
	async execute(interaction) {
    const core = interaction.client.core;
    if (!interaction.isChatInputCommand()) return;

    const contentType = slashContentType(interaction.commandName);
    if (!contentType) return;

    try {
      if (!interaction.guildId) {
        await interaction.reply({ content: 'Requests only work inside a server.', ephemeral: true });
        return;
      }

      // DEFER, THEN FIRST send() FILLS THE DEFERRED REPLY
      await interaction.deferReply();
      let repliedOnce = false;
      const send = (payload) => {
        if (!repliedOnce) {
          repliedOnce = true;
          return interaction.editReply(payload);
        }
        return interaction.followUp(payload);
      };

      const title = interaction.options.getString('title', true);
      await runRequestFlow(core, {
        contentType,
        title,
        discordUser: interaction.user,
        guildId: interaction.guildId,
        channel: interaction.channel,
        origContent: `/${interaction.commandName} ${title}`,
        send
      });
    } catch (err) {
      core.logger.error('Slash command failed:', err);
    }
	},
};
