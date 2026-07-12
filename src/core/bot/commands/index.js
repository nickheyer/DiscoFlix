const { SlashCommandBuilder, InteractionContextType } = require('discord.js');

// EVERY ALIAS A USER MIGHT REACH FOR → CANONICAL CONTENT TYPE
const TYPE_ALIASES = {
  movie: 'movie', movies: 'movie', film: 'movie',
  show: 'show', shows: 'show', tv: 'show', series: 'show', 'tv-show': 'show', anime: 'show'
};

const SLASH_COMMANDS = [
  { name: 'movie', contentType: 'movie', description: 'Search for and request a movie' },
  { name: 'show', contentType: 'show', description: 'Search for and request a TV show' }
];

function buildSlashCommands() {
  return SLASH_COMMANDS.map(cmd =>
    new SlashCommandBuilder()
      .setName(cmd.name)
      .setDescription(cmd.description)
      .setContexts(InteractionContextType.Guild)
      .addStringOption(option =>
        option
          .setName('title')
          .setDescription('Title to search for')
          .setRequired(true)
      )
  );
}

function slashContentType(commandName) {
  return SLASH_COMMANDS.find(cmd => cmd.name === commandName)?.contentType || null;
}

// PARSES `<prefix> movie|show <title>` MESSAGES. RETURNS null WHEN THE MESSAGE
// ISN'T ADDRESSED TO THE BOT, { type: 'help' } WHEN IT IS BUT ISN'T A VALID
// REQUEST, OR { type: 'request', contentType, title }.
function parsePrefixCommand(content, prefix) {
  const trimmed = (content || '').trim();
  if (!prefix || !trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;

  // PREFIX MUST BE ITS OWN WORD — `!dfilm` IS NOT `!df ilm`
  const afterPrefix = trimmed[prefix.length];
  if (afterPrefix !== undefined && !/\s/.test(afterPrefix)) return null;

  const rest = trimmed.slice(prefix.length).trim();
  if (!rest) return { type: 'help' };

  const [keyword, ...titleParts] = rest.split(/\s+/);
  const contentType = TYPE_ALIASES[keyword.toLowerCase()];
  const title = titleParts.join(' ');
  if (!contentType || !title) return { type: 'help' };

  return { type: 'request', contentType, title };
}

function usageText(prefix) {
  return [
    `**${prefix} movie <title>** — search for and request a movie`,
    `**${prefix} show <title>** — search for and request a TV show`,
    'Slash commands `/movie` and `/show` work too.'
  ].join('\n');
}

module.exports = {
  buildSlashCommands,
  slashContentType,
  parsePrefixCommand,
  usageText
};
