const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
// PURE REGISTRY - SAFE TO REQUIRE WITHOUT THE CORE SPINE
const registry = require('../../methods/apps/registry');

// ONLY CONTENT TYPES WITH AN ENABLED+CONFIGURED INSTANCE GET A SLASH COMMAND.
// RE-RUN ON EVERY ClientReady AND AFTER APP CRUD (core.apps.syncSlashCommands).
// GUILD + DM CONTEXTS - REQUESTS AND STATUS WORK IN THE BOT'S DMS TOO.
async function buildSlashCommands(core) {
  const servedTypes = await core.apps.enabledContentTypes();
  const commands = registry.contentTypeDefs()
    .filter(def => servedTypes.includes(def.type))
    .map(def =>
      new SlashCommandBuilder()
        .setName(def.slash.name)
        .setDescription(def.slash.description)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
        .addStringOption(option =>
          option
            .setName('title')
            .setDescription('Title to search for')
            .setRequired(true)
        )
    );
  commands.push(
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Your open requests and their download progress')
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
  );
  return commands;
}

function slashContentType(commandName) {
  return registry.slashDefs()[commandName]?.contentType || null;
}

// PARSES `<prefix> movie|show <title>` MESSAGES. RETURNS null WHEN THE MESSAGE
// ISN'T ADDRESSED TO THE BOT, { type: 'help' } WHEN IT IS BUT ISN'T A VALID
// REQUEST, OR { type: 'request', contentType, title }. ALIASES PARSE EVEN WHEN
// NO INSTANCE SERVES THE TYPE - THE FLOW REPLIES "NOT CONFIGURED", WHICH IS
// FRIENDLIER THAN SILENCE.
function parsePrefixCommand(content, prefix) {
  const trimmed = (content || '').trim();
  if (!prefix || !trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;

  // PREFIX MUST BE ITS OWN WORD - `!dfilm` IS NOT `!df ilm`
  const afterPrefix = trimmed[prefix.length];
  if (afterPrefix !== undefined && !/\s/.test(afterPrefix)) return null;

  const rest = trimmed.slice(prefix.length).trim();
  if (!rest) return { type: 'help' };

  const [keyword, ...titleParts] = rest.split(/\s+/);
  if (keyword.toLowerCase() === 'status') return { type: 'status' };

  const contentType = registry.aliasIndex()[keyword.toLowerCase()];
  const title = titleParts.join(' ');
  if (!contentType || !title) return { type: 'help' };

  return { type: 'request', contentType, title };
}

function usageText(prefix) {
  const defs = registry.contentTypeDefs();
  const lines = defs.map(def =>
    `**${prefix} ${def.slash.name} <title>** - ${def.slash.description.charAt(0).toLowerCase()}${def.slash.description.slice(1)}`
  );
  lines.push(`**${prefix} status** - your open requests and their download progress`);
  const slashNames = [...defs.map(def => `\`/${def.slash.name}\``), '`/status`'].join(' and ');
  lines.push(`Slash commands ${slashNames} work too.`);
  return lines.join('\n');
}

module.exports = {
  buildSlashCommands,
  slashContentType,
  parsePrefixCommand,
  usageText
};
