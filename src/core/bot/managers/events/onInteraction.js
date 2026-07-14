const { Events } = require('discord.js');
const interactions = require('../../interactions');

module.exports = {
	name: Events.InteractionCreate,
	once: false,
	async execute(interaction) {
    await interactions.dispatchSlash(interaction.client.core, interaction);
	},
};
