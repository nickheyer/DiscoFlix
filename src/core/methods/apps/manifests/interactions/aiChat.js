// THE AI CHAT INTERACTION + ITS PER-PROVIDER FEATURE FAMILY. THE INTERACTION
// DEF IS SHARED BY EVERY ai-provider MANIFEST (ONE /chat COMMAND CAN ONLY
// REGISTER ONCE) BUT CARRIES NO FEATURE OF ITS OWN - EVERY DOOR IN GATES ON
// THE ANSWERING PROVIDER'S OWN MATRIX ROW INSTEAD. EACH PROVIDER CONTRIBUTES
// ONE ROW PER DOOR (COMMANDS / MENTIONS & REPLIES / DMS) VIA botFeatures, SO
// EVERY (PROVIDER, DOOR) PAIR IS INDEPENDENTLY SWITCHABLE, AUDIENCED, ROLE-
// GRANTED, CAPPED, AND SERVER-OVERRIDABLE. WHO ANSWERS IS ROUTING, NOT LUCK:
// core.ai.resolveAiDoor WALKS SERVING PROVIDERS DEFAULT-FIRST (LIKE CONTENT
// ROUTING) AND THE FIRST ROW THAT ADMITS THE CALLER TAKES THE TURN.

// DESCRIPTIONS ARE PROVIDER-NEUTRAL - THE ROUTING BOARD SHOWS EACH DOOR ONCE
// WITH EVERY PROVIDER'S ROW UNDER IT, SO THE DOOR OWNS THE PROSE
const AI_DOORS = [
  {
    door: 'commands',
    label: 'Chat commands',
    description: 'Answers /chat and the prefix keyword (chat, ask, ai)'
  },
  {
    door: 'mentions',
    label: 'Mentions & replies',
    description: 'Answers @mentions of the bot and replies to it in server channels'
  },
  {
    door: 'dms',
    label: 'Direct messages',
    description: 'Answers bare DMs to the bot - no command needed'
  }
];

function aiDoorFeatureId(providerId, door) {
  return `${providerId}.ai-${door}`;
}

function aiDossierFeatureId(providerId) {
  return `${providerId}.ai-dossier`;
}

// THE PER-PROVIDER MATRIX ROWS - EACH ai-provider MANIFEST DECLARES ITS OWN
// SET THROUGH botFeatures: ONE ROW PER DOOR (CAP + MEMORY) PLUS THE
// PERSONALIZATION SWITCH
function aiProviderFeaturesFor(providerId) {
  return [
    ...aiDoorFeaturesFor(providerId),
    // PERSONALIZED REPLIES - WHEN ON, THE SPEAKER'S DOSSIER (OPERATOR NOTES
    // + RECENT REQUESTS) RIDES THE SYSTEM PROMPT SO REPLIES FIT THE PERSON.
    // OFF BY DEFAULT: NOTES ARE PROMISED "ONLY VISIBLE IN THIS CONSOLE", SO
    // SENDING THEM TO A PROVIDER'S API IS AN EXPLICIT CHOICE. AUDIENCE =
    // WHOSE DOSSIER MAY BE READ, NOT WHO MAY CHAT.
    {
      id: aiDossierFeatureId(providerId),
      label: 'Personalized replies',
      description: "Let this provider read the speaker's dossier - operator notes and recent requests - and weight its replies to fit them",
      group: 'ai',
      ai: { provider: providerId, door: 'dossier' },
      requiresInstall: true,
      defaultEnabled: false,
      defaultAudience: 'everyone',
      extents: [
        { key: 'history_items', label: 'Request history (items)', type: 'number', min: 0, max: 20, default: 5, zeroLabel: '0 means no request history' }
      ]
    }
  ];
}

function aiDoorFeaturesFor(providerId) {
  return AI_DOORS.map(({ door, label, description }) => ({
    id: aiDoorFeatureId(providerId, door),
    label,
    description,
    group: 'ai',
    // THE ROUTING BOARD (AND ANY LABEL QUALIFIER) KEYS OFF THIS - WHICH
    // PROVIDER'S ROW THIS IS AND WHICH DOOR IT GUARDS
    ai: { provider: providerId, door },
    // THE MATRIX ONLY SHOWS THIS PROVIDER'S ROWS ONCE THE APP IS ADDED -
    // TWELVE ROWS OF NEVER-INSTALLED PROVIDERS WOULD DROWN THE REAL ONES
    requiresInstall: true,
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: [
      // 0 = UNLIMITED, LIKE EVERY OTHER EXTENT; STAFF+ EXEMPT. THE CAP
      // COUNTS THIS PROVIDER'S MESSAGES ONLY - EACH BUDGET IS ITS OWN.
      { key: 'max_messages_per_day', label: 'Daily message cap', type: 'number', min: 0, default: 0, adminExempt: true },
      // HOW MANY PRIOR TURNS OF THE THREAD THE MODEL SEES
      { key: 'context_turns', label: 'Memory (turns)', type: 'number', min: 2, max: 60, default: 24 },
      // THE NATURAL SESSION BOUNDARY - A CHANNEL QUIET THIS LONG STARTS
      // FRESH ON THE NEXT MESSAGE (THE REPLAY WINDOW CUTS AT THE IDLE SEAM,
      // SEE aiMessage.windowFor). 0 = MEMORY NEVER FADES.
      { key: 'context_idle_hours', label: 'Memory fades after (hours)', type: 'number', min: 0, max: 720, default: 8 }
    ]
  }));
}

// SLASH/PREFIX LAND HERE THROUGH THE NORMAL DISPATCH; @MENTIONS, REPLIES,
// AND BARE DMS ARRIVE VIA interactions.dispatchAiMention - THE SOURCE NAMES
// THE DOOR, THE DOOR NAMES THE ROWS THAT MAY OPEN IT.
const interaction = {
  id: 'ai-chat',
  slash: { name: 'chat', description: 'Talk to the media server assistant' },
  options: [{ name: 'message', description: 'What do you want to ask or do?', type: 'string', required: true }],
  aliases: ['chat', 'ask', 'ai'],
  ephemeral: false,
  // /help GRANT-FILTERS ON THIS - /chat LISTS WHEN AT LEAST ONE PROVIDER'S
  // COMMANDS ROW WOULD ADMIT THE ASKER
  async allowedFor(core, invocation) {
    return !!(await core.ai.resolveAiDoor(invocation, 'commands')).instance;
  },
  async run(ctx) {
    const { core, send, ui } = ctx;
    const text = String(ctx.options.message || '').trim();
    if (!text) {
      await send(ui.notice('Say something after the command - e.g. `/chat what came in this week?`', { accent: 'warn' }));
      return;
    }
    const door = ctx.source === 'mention' ? (ctx.guildId ? 'mentions' : 'dms') : 'commands';
    const route = await core.ai.resolveAiDoor(ctx, door);
    if (!route.instance) {
      // NOTHING SERVES vs EVERY SERVING PROVIDER'S ROW SAID NO - THE USER
      // ADDRESSED THE BOT EITHER WAY, SO BOTH GET AN HONEST ANSWER
      await send(route.gate
        ? ui.notice(route.gate.denialMessage, { accent: 'danger' })
        : ui.notice('No AI provider is connected yet - add one in the web console.', { accent: 'warn' }));
      return;
    }
    // THE WINNING ROW'S EXTENTS RIDE THE INVOCATION IN THE SAME SEAT THE
    // CENTRAL GATE USES (runDiscordTurn READS ctx.feature.extents)
    ctx.feature = route.gate;
    await core.ai.runDiscordTurn(ctx, route.instance, text);
  }
};

module.exports = { interaction, aiProviderFeaturesFor, aiDoorFeatureId, aiDossierFeatureId, AI_DOORS };
