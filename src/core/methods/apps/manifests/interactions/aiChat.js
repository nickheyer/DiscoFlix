// THE AI CHAT FEATURE - SHARED BY EVERY ai-provider MANIFEST; INSTANCES POOL
// AND THE DEFAULT-FIRST SERVING ORDER PICKS WHO ANSWERS (SEE bindManifestDef).
// SLASH/PREFIX LAND HERE THROUGH THE NORMAL DISPATCH; @MENTIONS, REPLIES,
// AND BARE DMS ARRIVE VIA interactions.dispatchAiMention, WHICH GATES
// THROUGH THIS SAME DESCRIPTOR - ONE MATRIX ROW RULES EVERY DOOR IN.

module.exports = {
  id: 'ai-chat',
  slash: { name: 'chat', description: 'Talk to the media server assistant' },
  options: [{ name: 'message', description: 'What do you want to ask or do?', type: 'string', required: true }],
  aliases: ['chat', 'ask', 'ai'],
  ephemeral: false,
  feature: {
    id: 'ai-chat',
    label: 'AI chat',
    description: 'Talk to the assistant with /chat, @mentions, replies, or DMs',
    group: 'ai',
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: [
      // 0 = UNLIMITED, LIKE EVERY OTHER EXTENT; STAFF+ EXEMPT
      { key: 'max_messages_per_day', label: 'Daily message cap', type: 'number', min: 0, default: 0, adminExempt: true },
      // HOW MANY PRIOR TURNS OF THE CHANNEL'S THREAD THE MODEL SEES
      { key: 'context_turns', label: 'Memory (turns)', type: 'number', min: 2, max: 60, default: 24 }
    ]
  },
  async run(ctx) {
    const { core, instances, send, ui } = ctx;
    if (!instances.length) {
      await send(ui.notice('No AI provider is connected yet - add one in the web console.', { accent: 'warn' }));
      return;
    }
    const text = String(ctx.options.message || '').trim();
    if (!text) {
      await send(ui.notice('Say something after the command - e.g. `/chat what came in this week?`', { accent: 'warn' }));
      return;
    }
    await core.ai.runDiscordTurn(ctx, instances[0], text);
  }
};
