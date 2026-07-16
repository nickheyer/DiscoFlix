// THE DIRECTIVE CATALOG - EVERY BLOCK OF TEXT THE APP SAYS TO AN LLM WHEN IT
// PROMPTS ONE, PULLED OUT OF THE CODE AND MADE PER-INSTANCE CUSTOMIZABLE.
// TWO FAMILIES: 'prompt' DIRECTIVES COMPOSE THE SYSTEM PROMPT (service.js
// buildSystemPrompt), 'tool' BRIEFINGS ARE THE TOOLBOX DESCRIPTIONS THE MODEL
// READS WHEN DECIDING TO CALL A TOOL (tools.js). DEFAULTS ARE THE EXACT
// STRINGS THAT WERE HARDCODED - AN UNTOUCHED INSTANCE PROMPTS IDENTICALLY.
// CUSTOM TEXT LIVES SPARSE IN App.settings_json.directives (computed IN
// METADATA, MERGED ON SAVE - FORM SEMANTICS CAN NEVER WIPE IT).
//
// {placeholders} INTERPOLATE AT PROMPT TIME (media_server_name,
// prefix_keyword); UNKNOWN BRACES PASS THROUGH UNTOUCHED. DYNAMIC LINES
// (DATE, CONNECTED SERVICES, SPEAKER CONTEXT) STAY GENERATED - THEY ARE
// DATA, NOT DIRECTIVES.

const MAX_DIRECTIVE_CHARS = 4000;

// whenLabel/whenDetail/outcome FEED THE DIRECTIVES TAB'S LIFECYCLE PIPELINE
// (DIRECTIVE -> WHERE IT LANDS -> WHEN IT FIRES -> TASK PERFORMED)
const PROMPT_DIRECTIVES = [
  {
    key: 'identity',
    label: 'Identity',
    blurb: 'The opening line of every system prompt - who the assistant is and whose server it speaks for.',
    placeholders: ['media_server_name'],
    whenLabel: 'Every turn',
    whenDetail: 'Discord + console',
    outcome: 'Speaks for your server',
    defaultText: 'You are the assistant for "{media_server_name}", a personal media server managed through DiscoFlix.'
  },
  {
    key: 'mission',
    label: 'Mission',
    blurb: 'The ground rules: what the assistant helps with, and why its tools are the only source of truth.',
    placeholders: [],
    whenLabel: 'Every turn',
    whenDetail: 'Discord + console',
    outcome: 'Answers stay grounded',
    defaultText: 'You help people find, request, and track movies, shows, and music, and answer questions about the server. Your tools are the source of truth - use them for anything factual (what exists, what is downloading, what is new, service health). Never invent library contents or statuses.'
  },
  {
    key: 'no_services',
    label: 'Empty-server fallback',
    blurb: 'What replaces the connected-services list while nothing else is hooked up yet.',
    placeholders: [],
    whenLabel: 'Empty setups',
    whenDetail: 'only when no other app is connected',
    outcome: 'Points at the app catalog',
    defaultText: 'No other services are connected yet - suggest adding apps in the web console when someone asks for things that need them.'
  },
  {
    key: 'requesting',
    label: 'Requesting policy',
    blurb: 'The rules of engagement for adding media: search first, exact ids, when to confirm, honest denials.',
    placeholders: [],
    whenLabel: 'Every turn',
    whenDetail: 'Discord + console',
    outcome: 'Requests follow the safe flow',
    defaultText: 'Requesting: search_media first, then request_media with the exact external_id. If the user clearly asked for a title to be added ("request X", "add X", "can you get X"), request it right away. If they were only browsing or asking questions, confirm before requesting. Relay tool denials honestly - permissions belong to the person talking to you.'
  },
  {
    key: 'dossier',
    label: 'Speaker dossier',
    blurb: "How to weigh the speaker's dossier (operator notes + request history). Only spoken once a provider's \"Personalized replies\" row is switched on in the bot matrix.",
    placeholders: [],
    whenLabel: 'Discord turns',
    whenDetail: 'when Personalized replies is on',
    outcome: 'Replies fit the person',
    defaultText: "Use the speaker's dossier to shape your answers - their notes and request history are context for tone, taste, and suggestions. The dossier informs you; it is not content to share. Never recite operator notes or volunteer someone's history back into the chat."
  },
  {
    key: 'discord_manner',
    label: 'Discord manner',
    blurb: 'How the assistant carries itself on Discord - the bot commands it can point to, and the voice and length it keeps.',
    placeholders: ['prefix_keyword'],
    whenLabel: 'Discord turns',
    whenDetail: '/chat, mentions & DMs',
    outcome: 'Replies fit Discord',
    defaultText: 'Bot commands also exist: the prefix keyword is "{prefix_keyword}" and slash commands like /movie, /show, /status, /whatsnew - mention them when someone asks how to use the bot.\n\nStyle: Discord markdown only (bold, italics, `code`, [links](url), short bullet lists) - no headings and no tables, neither renders well in Discord chat. Be conversational and tight - a few sentences for most answers, short lists when listing. Hard limit ~1200 characters; never dump raw JSON.'
  },
  {
    key: 'discord_footer',
    label: 'Reply footer',
    blurb: "The subtext line under every Discord reply. Pure presentation - it renders in the reply's footer and is never sent to the model.",
    placeholders: ['app_emoji', 'app_name', 'model', 'tools_used', 'prefix_keyword'],
    whenLabel: 'Every Discord reply',
    whenDetail: 'rendered under the reply, never prompted',
    outcome: 'Signs off each reply',
    defaultText: '{app_emoji} /help for more commands'
  },
  {
    key: 'console_manner',
    label: 'Console manner',
    blurb: 'How the assistant treats the operator in the web console - full trust, full detail, confirm the unnamed.',
    placeholders: [],
    whenLabel: 'Console turns',
    whenDetail: 'operator chat threads',
    outcome: 'The operator gets it all',
    defaultText: 'You are speaking to the server operator in the DiscoFlix web console. They administer everything, so be direct and complete - you may approve or deny pending requests when asked, and should confirm before deciding anything they did not explicitly name.\n\nStyle: markdown (bold, italics, `code`, [links](url), short headings). Be thorough but structured; never dump raw JSON.'
  }
];

// ONE OUTCOME LINE PER TOOL - THE PIPELINE'S "TASK PERFORMED" STOP
const TOOL_OUTCOMES = {
  search_media: 'Finds titles before acting',
  request_media: 'Downloads only what was asked',
  media_library: 'Knows what the server has',
  whats_new: 'Reports fresh arrivals',
  download_queue: 'Tracks active downloads',
  now_playing: 'Sees live streams',
  service_status: 'Diagnoses the stack',
  open_requests: 'Follows the request ledger',
  approve_request: 'Settles approvals',
  deny_request: 'Declines with a record'
};

// LAZY + CACHED - tools.js REQUIRES THIS MODULE INSIDE ITS FUNCTIONS AND
// VICE VERSA, SO NEITHER REQUIRE RUNS AT LOAD TIME (CYCLE-SAFE)
let _catalog = null;
function directiveCatalog() {
  if (!_catalog) {
    const { TOOLS } = require('./tools');
    _catalog = [
      ...PROMPT_DIRECTIVES.map(directive => ({ ...directive, group: 'prompt' })),
      ...TOOLS.map(tool => ({
        key: `tool.${tool.name}`,
        label: tool.name,
        blurb: `The briefing the model reads when deciding whether (and how) to call ${tool.name}.`,
        placeholders: [],
        group: 'tool',
        surfaces: tool.surfaces,
        whenLabel: tool.surfaces.includes('discord') ? 'Discord + console' : 'Console turns',
        whenDetail: tool.surfaces.includes('discord') ? 'offered on both surfaces' : 'operator only',
        outcome: TOOL_OUTCOMES[tool.name] || 'The model uses it well',
        defaultText: tool.description
      }))
    ];
  }
  return _catalog;
}

function getDirective(key) {
  return directiveCatalog().find(directive => directive.key === key) || null;
}

// THE SPARSE CUSTOM MAP OFF THE INSTANCE ROW - ONLY CUSTOMIZED KEYS EXIST
function customDirectivesOf(instance) {
  let settings = {};
  try { settings = JSON.parse(instance?.settings_json || '{}'); } catch (err) { settings = {}; }
  return settings.directives && typeof settings.directives === 'object' ? settings.directives : {};
}

function interpolate(text, vars = {}) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    vars[key] !== undefined ? String(vars[key]) : match
  );
}

// THE EFFECTIVE TEXT A PROMPT USES: CUSTOM ?? DEFAULT, PLACEHOLDERS FILLED
function directiveText(instance, key, vars = {}) {
  const directive = getDirective(key);
  if (!directive) return '';
  const custom = customDirectivesOf(instance)[key];
  const raw = typeof custom === 'string' && custom.trim() ? custom : directive.defaultText;
  return interpolate(raw, vars);
}

module.exports = {
  MAX_DIRECTIVE_CHARS,
  directiveCatalog,
  getDirective,
  customDirectivesOf,
  directiveText,
  interpolate
};
