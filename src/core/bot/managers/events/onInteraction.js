const { Events } = require('discord.js');
const { slashContentType } = require('../../commands');
const { runRequestFlow } = require('../../commands/requestFlow');
const { buildStatusReply } = require('../../commands/status');
const { memberRoleTokens } = require('../../commands/access');

module.exports = {
	name: Events.InteractionCreate,
	once: false,
	async execute(interaction) {
    const core = interaction.client.core;
    if (!interaction.isChatInputCommand()) return;

    // STATUS IS PERSONAL - ALWAYS ANSWERS EPHEMERAL, WORKS IN GUILDS AND DMS
    if (interaction.commandName === 'status') {
      try {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(await buildStatusReply(core, interaction.user.id));
      } catch (err) {
        core.logger.error('Status command failed:', err);
      }
      return;
    }

    const contentType = slashContentType(interaction.commandName);
    if (!contentType) return;

    try {
      // DEFER, THEN FIRST send() FILLS THE DEFERRED REPLY - DMS WELCOME
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
        guildId: interaction.guildId || null,
        channel: interaction.channel,
        origContent: `/${interaction.commandName} ${title}`,
        roleTokens: memberRoleTokens(interaction.member),
        send
      });
    } catch (err) {
      core.logger.error('Slash command failed:', err);
    }
	},
};
