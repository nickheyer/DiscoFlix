const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const registry = require('../../methods/apps/registry');
const ui = require('./ui');
const { requestInteractionFor } = require('./request');
const statusInteraction = require('./status');
const helpInteraction = require('./help');
const { memberRoleTokens, roleGrantsFor } = require('./access');
const features = require('./features');

// THE INTERACTION REGISTRY - EVERY BOT FEATURE (BUILT-IN OR APP-CONTRIBUTED)
// IS ONE DEF: { id, slash, options, aliases, ephemeral, available, run,
// feature }. MANIFESTS EXTEND THE BOT BY DECLARING `interactions` - ZERO
// CORE EDITS. THE `feature` DESCRIPTOR PUTS THE DEF ON THE DISCORD BOT TAB'S
// MATRIX AND GATES IT AT DISPATCH (SEE features.js).

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

// THE CENTRAL RBAC GATE - EVERY FEATURED DEF PASSES THROUGH resolveFeature
// BEFORE run(). RETURNS null WHEN ALLOWED (THE GATE RIDES invocation.feature
// SO THE FLOW CAN READ ITS EXTENTS), OTHERWISE THE DENIAL PAYLOAD TO SEND.
// SLASH COMMANDS STAY REGISTERED EVEN WHEN DENIED-FOR-EVERYONE - A CLEAR
// DENIAL AT DISPATCH BEATS COMMANDS THAT SILENTLY VANISH PER GRANT CHANGE.
async function gateInvocation(invocation, def) {
  if (!def.feature) return null;
  const gate = await features.resolveFeature(invocation.core, def.feature.id, invocation);
  invocation.feature = gate;
  if (gate.allowed) return null;

  // A DENIED AUDIENCE ON AN ASK-CAPABLE FEATURE RAISES A HAND THE CONSOLE'S
  // USERS SECTION CAN SEE - FIRST DENIAL FLAGS, REPEATS POINT AT THE ASK
  if (gate.reason === 'audience' && def.feature.accessAskOnDeny) {
    const isNewAsk = await invocation.core.models.user.flagAccessRequest(invocation.dbUser.id);
    return ui.notice(
      isNewAsk
        ? 'Requests are limited to approved members here - the admins have been flagged that you\'d like access.'
        : 'Requests are limited to approved members here - your access ask is still waiting on an admin.',
      { accent: 'danger' }
    );
  }
  return ui.notice(gate.denialMessage, { accent: 'danger' });
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
    const denial = await gateInvocation(invocation, def);
    if (denial) {
      await send(denial);
      return;
    }
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

  const invocation = await buildInvocation(core, config, {
    source: 'prefix',
    discordUser: message.author,
    member: message.member,
    guildId: message.guildId || null,
    channel: message.channel,
    messageId: message.id,
    origContent: message.content,
    options: parsed.help ? {} : parsed.options,
    send: (payload) => message.channel.send(payload)
  });

  // BARE PREFIX / UNKNOWN KEYWORD - HELP, GRANT-FILTERED TO WHAT THIS USER
  // MAY ACTUALLY USE (THE INVOCATION CARRIES THE AUDIENCE CONTEXT)
  if (parsed.help) {
    await message.channel.send(await helpInteraction.buildHelpPayload(core, config, invocation));
    return true;
  }

  const denial = await gateInvocation(invocation, parsed.def);
  if (denial) {
    await message.channel.send(denial);
    return true;
  }
  await parsed.def.run(invocation);
  return true;
}

// THE AI FRONT DOOR BEYOND COMMANDS: A DIRECT @MENTION, A REPLY TO THE BOT,
// OR A BARE DM ROUTES INTO THE ai-chat DEF, WHICH GATES PER PROVIDER ON THE
// DOOR'S OWN MATRIX ROWS (<provider>.ai-mentions / .ai-dms) AND ANSWERS WITH
// THE FIRST PROVIDER WHOSE ROW ADMITS THE CALLER (core.ai.resolveAiDoor).
// MENTIONS ARE CASUAL SPEECH, SO "NOT SERVING" MEANS SILENCE (A DENIED DOOR
// STILL ANSWERS - THE USER EXPLICITLY ADDRESSED THE BOT). RETURNS true WHEN
// THE MESSAGE WAS TAKEN.
async function dispatchAiMention(core, message) {
  const botUser = core.client?.user;
  if (!botUser) return false;

  const isDM = !message.guildId;
  let addressed = isDM || message.mentions?.users?.has(botUser.id);
  // A REPLY TO THE BOT COUNTS EVEN WITH THE REPLY PING SUPPRESSED
  if (!addressed && message.reference?.messageId) {
    try {
      const referenced = await message.channel.messages.fetch(message.reference.messageId);
      addressed = referenced?.author?.id === botUser.id;
    } catch (err) { /* DELETED/UNCACHED PARENT - NOT ADDRESSED */ }
  }
  if (!addressed) return false;

  const def = allDefs().find(candidate => candidate.id === 'ai-chat');
  if (!def || !(await def.available(core))) return false;

  // STRIP THE BOT'S OWN MENTION TOKENS; WHAT REMAINS IS THE MESSAGE
  const text = (message.content || '')
    .replace(new RegExp(`<@!?${botUser.id}>`, 'g'), '')
    .trim();
  if (!text) return false;

  const config = await core.models.configuration.get();
  const invocation = await buildInvocation(core, config, {
    source: 'mention',
    discordUser: message.author,
    member: message.member,
    guildId: message.guildId || null,
    channel: message.channel,
    messageId: message.id,
    origContent: message.content,
    options: { message: text },
    send: (payload) => message.channel.send(payload)
  });
  const denial = await gateInvocation(invocation, def);
  if (denial) {
    await message.channel.send(denial);
    return true;
  }
  await def.run(invocation);
  return true;
}

module.exports = {
  allDefs,
  availableDefs,
  buildSlashCommands,
  parsePrefix,
  dispatchSlash,
  dispatchPrefix,
  dispatchAiMention
};
