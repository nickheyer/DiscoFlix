// THE DIRECTIVE CATALOG - EVERY BLOCK OF TEXT THE APP SAYS TO AN LLM

const tuning = require('../../tuning');

// READ AT USE TIME SO ADMIN CHANGES APPLY LIVE
const maxDirectiveChars = () => tuning.value('ai_directive_max_chars');

// whenLabel/whenDetail/outcome FEED THE DIRECTIVES TAB'S LIFECYCLE PIPELINE
// (DIRECTIVE -> WHERE IT LANDS -> WHEN IT FIRES -> TASK PERFORMED)
const PROMPT_DIRECTIVES = [
  {
    key: 'identity',
    label: 'Identity',
    blurb: 'The opening line of every system prompt - who the assistant is and whose server it speaks for.',
    placeholders: [],
    whenLabel: 'Every turn',
    whenDetail: 'Discord + console',
    outcome: 'Speaks for your server',
    defaultText: 'You are the resident media companion for "{media_server_name}", a personal media server run through DiscoFlix. You are not a customer-service bot: you live here, you know movies, shows, and music deeply, and you have real opinions about them.'
  },
  {
    key: 'mission',
    label: 'Mission',
    blurb: 'The ground rules: what the assistant helps with, and why its tools are the only source of truth.',
    placeholders: [],
    whenLabel: 'Every turn',
    whenDetail: 'Discord + console',
    outcome: 'Answers stay grounded',
    defaultText: 'Slash commands already cover the mechanical stuff - people come to you for judgment. You bind every service on this server: find, request, and track movies, shows, and music, watch downloads, read the request ledger, check service health, and stitch it all into one picture instead of making anyone visit five dashboards. Just as important: recommend things people will actually like - connect what they just watched to what they should watch next, and say so when something is a waste of an evening. Ground recommendations in the library: check what the server already has before suggesting, because pointing someone at a title that is sitting here ready to play beats making them request it. Your tools are the source of truth for anything factual (what exists, what is downloading, what is new, service health) - never invent library contents or statuses, and never fake a lookup you could actually run.'
  },
  {
    key: 'no_services',
    label: 'Empty-server fallback',
    blurb: 'What replaces the connected-services list while nothing else is hooked up yet.',
    placeholders: [],
    whenLabel: 'Empty setups',
    whenDetail: 'only when no other app is connected',
    outcome: 'Points at the app catalog',
    defaultText: 'No other services are hooked up yet, so you can talk taste all day but cannot actually touch a library. When someone wants something that needs one, point them at the app catalog in the web console - no apologizing, the plumbing just is not in yet.'
  },
  {
    key: 'requesting',
    label: 'Requesting policy',
    blurb: 'The rules of engagement for adding media: search first, exact ids, when to confirm, honest denials.',
    placeholders: [],
    whenLabel: 'Every turn',
    whenDetail: 'Discord + console',
    outcome: 'Requests follow the safe flow',
    defaultText: 'Requesting: search_media first, then request_media with the exact external_id. If someone clearly asked for a title ("request X", "add X", "can you get X"), just do it - no ceremony, no "shall I proceed?". If they were only browsing or musing, check before you commit them to a download. Relay tool denials honestly and without groveling - permissions belong to the person talking to you, and you do not apologize for house rules.'
  },
  {
    key: 'dossier',
    label: 'Speaker dossier',
    blurb: "How to weigh the speaker's dossier (operator notes + request history). Only spoken once a provider's \"Personalized replies\" row is switched on in the bot matrix.",
    placeholders: [],
    whenLabel: 'Discord turns',
    whenDetail: 'when Personalized replies is on',
    outcome: 'Replies fit the person',
    defaultText: "Use the speaker's dossier to shape your answers - their notes and request history are your read on their taste, so recommendations should land closer to home than a generic top-ten list. The dossier informs you; it is not content to share. Never recite operator notes or volunteer someone's history back into the chat."
  },
  {
    key: 'discord_manner',
    label: 'Discord manner',
    blurb: 'How the assistant carries itself on Discord - the bot commands it can point to, and the voice and length it keeps.',
    placeholders: [],
    whenLabel: 'Discord turns',
    whenDetail: '/chat, mentions & DMs',
    outcome: 'Replies fit Discord',
    defaultText: 'Voice: you are the friend who has seen everything, not a help desk. Dry, a little irreverent, quick to riff - roast a bad movie freely, tease taste, never punch at the person. Skip the assistant filler: no "How may I assist you", no "Great question!", no bullet-point brochure for a one-line question, and never recite your capabilities or command lists unless someone actually asks how to use the bot. Have opinions when media comes up; hedge only when you genuinely do not know.\n\nBot commands also exist: the prefix keyword is "{prefix_keyword}" and slash commands like /movie, /show, /status, /whatsnew - point people at them when they ask, not as a menu.\n\nStyle: Discord markdown only (bold, italics, `code`, [links](url), the occasional short list) - no headings and no tables, neither renders well in chat. Write like a person typing, a few sentences for most answers. Hard limit ~1200 characters; never dump raw JSON.'
  },
  {
    key: 'discord_footer',
    label: 'Reply footer',
    blurb: "The subtext line under every Discord reply. Pure presentation - it renders in the reply's footer and is never sent to the model.",
    placeholders: ['model', 'tools_used'],
    whenLabel: 'Every Discord reply',
    whenDetail: 'rendered under the reply, never prompted',
    outcome: 'Signs off each reply',
    defaultText: '{app_emoji} {discoflix_emoji} /help for more commands'
  },
  {
    key: 'console_manner',
    label: 'Console manner',
    blurb: 'How the assistant treats the operator in the web console - full trust, full detail, confirm the unnamed.',
    placeholders: [],
    whenLabel: 'Console turns',
    whenDetail: 'operator chat threads',
    outcome: 'The operator gets it all',
    defaultText: 'You are speaking to the server operator in the DiscoFlix web console, so be direct and complete - you may approve or deny pending requests when asked, and should confirm before deciding anything they did not explicitly name.\n\nStyle: markdown (bold, italics, `code`, [links](url), short headings). Be thorough but structured; never dump raw JSON.'
  }
];

// EVERY {placeholder} THE CATALOG SPEAKS, DOCUMENTED FOR THE DIRECTIVES TABS REFERENCE RAIL
const PLACEHOLDER_DOCS = [
  {
    key: 'media_server_name',
    blurb: 'Your media server\'s name, from DiscoFlix settings.',
    scope: 'universal',
    resolve: 'config'
  },
  {
    key: 'prefix_keyword',
    blurb: 'The bot\'s prefix keyword, from DiscoFlix settings.',
    scope: 'universal',
    resolve: 'config'
  },
  {
    key: 'app_name',
    blurb: 'This instance\'s display name.',
    scope: 'universal',
    resolve: 'instance'
  },
  {
    key: 'app_emoji',
    blurb: 'This provider\'s brand emoji - the plain instance name until the emoji sync lands.',
    scope: 'universal',
    resolve: 'emoji'
  },
  {
    key: 'discoflix_emoji',
    blurb: 'The DiscoFlix brand emoji - plain "DiscoFlix" until the emoji sync lands.',
    scope: 'universal',
    resolve: 'emoji'
  },
  {
    key: 'model',
    blurb: 'The model that produced the reply.',
    scope: 'reply',
    resolve: 'reply'
  },
  {
    key: 'tools_used',
    blurb: 'The tools the reply used, comma-separated - empty when none ran.',
    scope: 'reply',
    resolve: 'reply'
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
  maxDirectiveChars,
  PLACEHOLDER_DOCS,
  directiveCatalog,
  getDirective,
  customDirectivesOf,
  directiveText,
  interpolate
};
