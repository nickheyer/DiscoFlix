// SCROLL-UP CHAT HISTORY - THE SENTINEL SWAPS ITSELF FOR THE NEXT OLDER PAGE.
// THE SEAM ROW (PREVIOUSLY THE OLDEST LOADED) RE-RENDERS OOB SO ITS DIVIDER
// AND GROUPED TREATMENT STAY TRUE NOW THAT OLDER CONTEXT SITS ABOVE IT.
async function fetchChatHistory(ctx) {
  const core = ctx.core;
  const channelId = ctx.params.channelId;
  const beforeId = String(ctx.query.before || '').trim();
  if (!beforeId) {
    ctx.status = 400;
    return;
  }

  const pageSize = core.models.discordChannel.historyPageSize;
  const batch = await core.models.discordChannel.getMessages(channelId, pageSize, beforeId);
  if (!batch.length) {
    // NO OLDER HISTORY - THE SENTINEL DISSOLVES AND NEVER FIRES AGAIN
    ctx.body = '';
    return;
  }

  const seam = await core.prisma.discordMessage.findUnique({
    where: { message_id: beforeId },
    include: { user: true }
  });

  const batchLast = batch[batch.length - 1];
  const fragments = [];

  // FRESH SENTINEL ON TOP WHILE ANOTHER FULL PAGE MIGHT EXIST
  if (batch.length === pageSize) {
    fragments.push(await ctx.core.render.compile('chat/historySentinel.pug', {
      history: { channelId, beforeId: batch[0].message_id }
    }));
  }

  let seamKeepsDivider = true;
  const list = [...batch];
  if (seam) {
    const seamRow = { ...seam };
    seamRow.grouped = core.discord.isGroupedContinuation(seamRow, batchLast);
    seamRow.oobReplace = true;
    seamKeepsDivider =
      new Date(seam.created_at).toDateString() !== new Date(batchLast.created_at).toDateString();
    list.push(seamRow);
  }

  const compiled = await core.discord.compileMessages(list);
  const seamCompiled = seam ? compiled.pop() : null;
  fragments.push(...compiled);

  // THE OLD SEAM DIVIDER LIVES OUTSIDE THE ROW - A SCRIPT PRUNES IT WHEN THE
  // BATCH ABOVE SHARES ITS DAY (OOB ROW SWAPS CANNOT REACH SIBLINGS)
  if (seam && !seamKeepsDivider) {
    fragments.push(`<script>window.dfTrimSeamDivider && dfTrimSeamDivider('msg-${seam.message_id}')</script>`);
  }
  if (seamCompiled) fragments.push(seamCompiled);

  ctx.body = fragments.join('');
  ctx.type = 'html';
}

module.exports = { fetchChatHistory };
