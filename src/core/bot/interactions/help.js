const ui = require('./ui');

// COMMAND LIST BUILT OFF THE LIVE REGISTRY - ANYTHING SERVED SHOWS UP, IN
// BOTH ITS SLASH AND PREFIX FORMS
async function buildHelpPayload(core, config) {
  const { availableDefs } = require('./index');
  const defs = await availableDefs(core);
  const prefix = config.prefix_keyword;

  const lines = defs
    .filter(def => def.id !== 'help')
    .map(def => {
      const arg = def.options?.length ? ` <${def.options[0].name}>` : '';
      const alias = def.aliases?.[0] ? ` or \`${prefix} ${def.aliases[0]}${arg}\`` : '';
      return `**/${def.slash.name}${arg}**${alias}\n-# ${def.slash.description}`;
    });

  return ui.payload(ui.container([
    ui.text('### DiscoFlix commands'),
    ui.separator(),
    ...lines.map(line => ui.text(line)),
    ui.separator(),
    ui.text('-# Slash commands work in the bot\'s DMs too')
  ]));
}

module.exports = {
  id: 'help',
  slash: { name: 'help', description: 'How to talk to the bot' },
  options: [],
  aliases: ['help', 'commands'],
  ephemeral: true,
  async available() { return true; },
  async run(ctx) {
    await ctx.send(await buildHelpPayload(ctx.core, ctx.config));
  },
  buildHelpPayload
};
