const ui = require('./ui');

// COMMAND LIST BUILT OFF THE LIVE REGISTRY - ANYTHING SERVED SHOWS UP, IN
// BOTH ITS SLASH AND PREFIX FORMS. WITH AN INVOCATION ON HAND THE LIST IS
// GRANT-FILTERED TO WHAT THAT USER MAY ACTUALLY USE.
async function buildHelpPayload(core, config, invocation = null) {
  const { availableDefs } = require('./index');
  const features = require('./features');
  let defs = await availableDefs(core);
  if (invocation) {
    const gates = await Promise.all(defs.map(def => {
      if (def.feature) return features.resolveFeature(core, def.feature.id, invocation);
      // DEFS THAT GATE INSIDE THEIR OWN RUN (AI CHAT'S PER-PROVIDER DOOR
      // ROWS) EXPOSE allowedFor SO HELP CAN GRANT-FILTER THEM TOO
      if (def.allowedFor) return def.allowedFor(core, invocation).then(allowed => ({ allowed }));
      return { allowed: true };
    }));
    defs = defs.filter((_, i) => gates[i].allowed);
  }
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
  feature: {
    id: 'help',
    label: 'Help',
    description: 'List the bot\'s commands with /help',
    group: 'core',
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: []
  },
  async available() { return true; },
  async run(ctx) {
    await ctx.send(await buildHelpPayload(ctx.core, ctx.config, ctx));
  },
  buildHelpPayload
};
