const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const registry = require('../../methods/apps/registry');
const ui = require('./ui');
const { requestInteractionFor } = require('./request');
const statusInteraction = require('./status');
const helpInteraction = require('./help');
const { memberRoleTokens, roleGrantsFor } = require('./access');

// THE INTERACTION REGISTRY - EVERY BOT FEATURE (BUILT-IN OR APP-CONTRIBUTED)
// IS ONE DEF: { id, slash, options, aliases, ephemeral, available, run }.
// MANIFESTS EXTEND THE BOT BY DECLARING `interactions` - ZERO CORE EDITS.

// SERVING = ENABLED + FULLY CONFIGURED, DEFAULT-FIRST LIKE CONTENT ROUTING
async function servingInstancesFor(core, appTypes) {
  const rows = await core.models.app.getMany(
    { app_type: { in: appTypes }, enabled: true },
    {},
    [{ is_default: 'desc' }, { sort_position: 'asc' }, { created_at: 'asc' }]
  );
  return rows.filter(row => core.apps.isConfigured(row));
}

// MANIFEST DEFS GET AVAILABILITY AND THEIR SERVING INSTANCES FOR FREE
function bindManifestDef(def) {
  return {
    ...def,
    async available(core) {
      return (await servingInstancesFor(core, def.appTypes)).length > 0;
    },
    async run(ctx) {
      ctx.instances = await servingInstancesFor(ctx.core, def.appTypes);
      return def.run(ctx);
    }
  };
}

let _defs = null;
function allDefs() {
  if (!_defs) {
    _defs = [
      ...registry.contentTypeDefs().map(requestInteractionFor),
      statusInteraction,
      helpInteraction,
      ...registry.interactionDefs().map(bindManifestDef)
    ];
  }
  return _defs;
}

async function availableDefs(core) {
  const flags = await Promise.all(allDefs().map(def => def.available(core)));
  return allDefs().filter((_, i) => flags[i]);
}

const OPTION_ADDERS = {
  string: (cmd, opt) => cmd.addStringOption(o => configureOption(o, opt)),
  integer: (cmd, opt) => cmd.addIntegerOption(o => configureOption(o, opt)),
  boolean: (cmd, opt) => cmd.addBooleanOption(o => configureOption(o, opt))
};

function configureOption(builder, opt) {
  return builder.setName(opt.name).setDescription(opt.description).setRequired(!!opt.required);
}

function slashCommandOf(def) {
  const cmd = new SlashCommandBuilder()
    .setName(def.slash.name)
    .setDescription(def.slash.description)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);
  for (const opt of def.options || []) {
    const adder = OPTION_ADDERS[opt.type];
    if (!adder) throw new Error(`Unsupported option type '${opt.type}' on interaction '${def.id}'`);
    adder(cmd, opt);
  }
  return cmd;
}

// ONLY SERVED FEATURES REGISTER - RE-RUN ON EVERY ClientReady AND AFTER APP
// CRUD (core.apps.syncSlashCommands). GUILD + DM CONTEXTS THROUGHOUT.
async function buildSlashCommands(core) {
  return (await availableDefs(core)).map(slashCommandOf);
}

// PARSES `<prefix> <keyword> [args]`. RETURNS null WHEN THE MESSAGE ISN'T
// ADDRESSED TO THE BOT, { help: true } WHEN IT IS BUT ISN'T A VALID FEATURE
// CALL, OR { def, options }. ALIASES PARSE EVEN WHEN NOTHING SERVES THE
// FEATURE - THE RUN REPLIES "NOT CONFIGURED", WHICH BEATS SILENCE.
function parsePrefix(content, prefix) {
  const trimmed = (content || '').trim();
  if (!prefix || !trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;

  // PREFIX MUST BE ITS OWN WORD - `!dfilm` IS NOT `!df ilm`
  const afterPrefix = trimmed[prefix.length];
  if (afterPrefix !== undefined && !/\s/.test(afterPrefix)) return null;

  const rest = trimmed.slice(prefix.length).trim();
  if (!rest) return { help: true };

  const [keyword, ...argParts] = rest.split(/\s+/);
  const def = allDefs().find(candidate =>
    (candidate.aliases || []).some(alias => alias.toLowerCase() === keyword.toLowerCase())
  );
  if (!def) return { help: true };

  // THE REMAINDER OF THE LINE MAPS ONTO THE DEF'S FIRST OPTION
  const options = {};
  const firstOption = (def.options || [])[0];
  if (firstOption) {
    const value = argParts.join(' ');
    if (!value && firstOption.required) return { help: true };
    if (value) options[firstOption.name] = value;
  }
  return { def, options };
}

// SHARED PRELUDE FOR EVERY DISPATCH - ONE PLACE RESOLVES THE DB USER
// (PROFILE SYNC + GRANT-ONLY ROLE PROMOTION + GUILD LINK)
async function buildInvocation(core, config, base) {
  const roleTokens = memberRoleTokens(base.member);
  const grants = roleGrantsFor(config, roleTokens);
  const dbUser = await core.models.user.syncFromDiscord(base.discordUser, {
    grants,
    serverId: base.guildId
  });
  return { core, config, dbUser, roleTokens, ui, ...base };
}

async function dispatchSlash(core, interaction) {
  if (!interaction.isChatInputCommand()) return;
  const def = allDefs().find(candidate => candidate.slash?.name === interaction.commandName);
  if (!def) return;

  try {
    // DEFER, THEN FIRST send() FILLS THE DEFERRED REPLY - DMS WELCOME
    await interaction.deferReply(def.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    let repliedOnce = false;
    const send = (payload) => {
      if (!repliedOnce) {
        repliedOnce = true;
        return interaction.editReply(payload);
      }
      return interaction.followUp(payload);
    };

    const optionGetters = { string: 'getString', integer: 'getInteger', boolean: 'getBoolean' };
    const options = {};
    for (const opt of def.options || []) {
      const value = interaction.options[optionGetters[opt.type]](opt.name, !!opt.required);
      if (value !== null) options[opt.name] = value;
    }

    const config = await core.models.configuration.get();
    const invocation = await buildInvocation(core, config, {
      source: 'slash',
      discordUser: interaction.user,
      member: interaction.member,
      guildId: interaction.guildId || null,
      channel: interaction.channel,
      messageId: null,
      origContent: `/${interaction.commandName} ${Object.values(options).join(' ')}`.trim(),
      options,
      send
    });
    await def.run(invocation);
  } catch (err) {
    core.logger.error(`Slash command '${interaction.commandName}' failed:`, err);
  }
}

// RETURNS true WHEN THE MESSAGE WAS ADDRESSED TO THE BOT
async function dispatchPrefix(core, message) {
  const config = await core.models.configuration.get();
  const parsed = parsePrefix(message.content, config.prefix_keyword);
  if (!parsed) return false;

  if (parsed.help) {
    await message.channel.send(await helpInteraction.buildHelpPayload(core, config));
    return true;
  }

  const invocation = await buildInvocation(core, config, {
    source: 'prefix',
    discordUser: message.author,
    member: message.member,
    guildId: message.guildId || null,
    channel: message.channel,
    messageId: message.id,
    origContent: message.content,
    options: parsed.options,
    send: (payload) => message.channel.send(payload)
  });
  await parsed.def.run(invocation);
  return true;
}

module.exports = {
  allDefs,
  availableDefs,
  buildSlashCommands,
  parsePrefix,
  dispatchSlash,
  dispatchPrefix
};
