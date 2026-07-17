const { GatewayIntentBits, Partials } = require('discord.js');

module.exports = () => {
  return {
    // GuildPresences IS PRIVILEGED AND FAILS LOGIN UNLESS THE DEV PORTAL
    // TOGGLE IS ON - OPT IN VIA DF_PRESENCE_INTENT=1 FOR MEMBERS-PANE DOTS
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      ...(process.env.DF_PRESENCE_INTENT === '1' ? [GatewayIntentBits.GuildPresences] : []),
    ],
    // WITHOUT Partials.Message, EDITS TO UNCACHED MESSAGES NEVER FIRE
    // MessageUpdate - onMessageUpdate FETCHES THE FULL MESSAGE WHEN PARTIAL.
    // Partials.Channel IS REQUIRED OR DM MessageCreate EVENTS NEVER ARRIVE.
    partials: [
      Partials.Message,
      Partials.Channel,
    ]
  }
};
