const { GatewayIntentBits, Partials } = require('discord.js');

module.exports = () => {
  return {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    // WITHOUT Partials.Message, EDITS TO UNCACHED MESSAGES NEVER FIRE
    // MessageUpdate — onMessageUpdate FETCHES THE FULL MESSAGE WHEN PARTIAL
    partials: [
      Partials.Message,
    ]
  }
};
