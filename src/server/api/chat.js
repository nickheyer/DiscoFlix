const multer = require('@koa/multer');

// UPLOAD CAP COMES FROM TUNING (upload_max_mb, DEFAULT 8MB - DISCORD'S
// UNBOOSTED BOT CAP); THE PARSER IS BUILT PER REQUEST SO CHANGES APPLY LIVE

// OG-DISCORD ATTACH: THE + STAGES A FILE, ENTER POSTS IT HERE AS MULTIPART;
// THE BOT SENDS IT AND THE MESSAGE MIRRORS BACK VIA MessageCreate. EVERY
// FAILURE ANSWERS 200 + TOAST - THE FORM IS hx-swap="none", ONLY OOB LANDS.
async function uploadChatMedia(ctx) {
  const core = ctx.core;
  const toast = (message) => ctx.compileView(['extra/notification.pug'], { message });
  const uploadMb = core.tuning.value('upload_max_mb');
  const uploadParser = multer({ limits: { fileSize: uploadMb * 1024 * 1024, files: 1 } }).single('file');

  try {
    await uploadParser(ctx, () => {});
  } catch (err) {
    return toast(err.code === 'LIMIT_FILE_SIZE'
      ? `That file is over the ${uploadMb}MB upload cap`
      : `Upload failed: ${err.message}`);
  }

  if (!ctx.file) return toast('Pick a file to upload');
  if (!core.client || !core.client.isReady()) {
    return toast('Uploads send as the bot - it is offline right now');
  }
  const channelId = await core.discord.activeChannelIdFor(ctx.viewState);
  if (!channelId) return toast('Select a channel before uploading');

  const content = String(ctx.request.body?.content || '').trim().slice(0, 2000);
  try {
    const { AttachmentBuilder } = require('discord.js');
    const channel = await core.client.channels.fetch(channelId);
    await channel.send({
      content: content || undefined,
      files: [new AttachmentBuilder(ctx.file.buffer, { name: ctx.file.originalname })]
    });
    core.logger.info(`Relayed browser upload ${ctx.file.originalname} to #${channel.name}`);
    // SILENT SUCCESS - THE ECHOED MESSAGE LANDING IN CHAT IS THE FEEDBACK
    ctx.body = '';
    ctx.type = 'html';
  } catch (err) {
    core.logger.warn(`Chat upload failed: ${err.message}`);
    return toast(`Upload failed: ${err.message}`);
  }
}

// BIDIRECTIONAL CHAT PAGINATION - ?before= IS THE CLASSIC SCROLL-UP PAGE,
// ?after= IS THE ANCHORED (TIME-TRAVEL) WINDOW'S SCROLL-DOWN PAGE
async function fetchChatHistory(ctx) {
  const channelId = ctx.params.channelId;
  const beforeId = String(ctx.query.before || '').trim();
  const afterId = String(ctx.query.after || '').trim();
  if (beforeId) return fetchOlderHistory(ctx, channelId, beforeId);
  if (afterId) return fetchNewerHistory(ctx, channelId, afterId);
  ctx.status = 400;
}

// SCROLL-UP CHAT HISTORY - THE SENTINEL SWAPS ITSELF FOR THE NEXT OLDER PAGE.
// THE SEAM ROW (PREVIOUSLY THE OLDEST LOADED) RE-RENDERS OOB SO ITS DIVIDER
// AND GROUPED TREATMENT STAY TRUE NOW THAT OLDER CONTEXT SITS ABOVE IT.
async function fetchOlderHistory(ctx, channelId, beforeId) {
  const core = ctx.core;
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

// SCROLL-DOWN PAGES FOR ANCHORED (TIME-TRAVEL) VIEWS. A SHORT PAGE MEANS THE
// WINDOW CAUGHT THE LIVE HEAD: THE ANCHOR CLEARS, UNREADS SETTLE, AND THE
// RESPONSE GOES LIVE-MODE (END STAMP + AN EMPTIED BAR). THE ~MS RACE (A
// MessageCreate LANDING BETWEEN FETCH AND CLEAR) DEGRADES TO A BADGE AND
// SELF-HEALS ON THE NEXT VISIT.
async function fetchNewerHistory(ctx, channelId, afterId) {
  const core = ctx.core;
  const pageSize = core.models.discordChannel.historyPageSize;
  const batch = await core.models.discordChannel.getMessagesAfter(channelId, pageSize, afterId);
  const seam = await core.prisma.discordMessage.findUnique({
    where: { message_id: afterId },
    include: { user: true }
  });

  const fragments = [];
  if (batch.length) {
    // THE SEAM (PREVIOUSLY-NEWEST LOADED ROW) SITS *ABOVE* THE BATCH -
    // PREPEND A COPY SO THE FIRST NEW ROW'S GROUPING/DIVIDER COMPUTES
    // AGAINST IT, THEN DROP THE COPY'S FRAGMENT (THE REAL ROW IS ON SCREEN)
    const list = seam ? [{ ...seam }, ...batch] : [...batch];
    const compiled = await core.discord.compileMessages(list);
    if (seam) compiled.shift();
    fragments.push(...compiled);
  }

  if (batch.length === pageSize) {
    // ANOTHER FULL PAGE MIGHT EXIST - FRESH SENTINEL BELOW THE BATCH
    fragments.push(await core.render.compile('chat/futureSentinel.pug', {
      future: { channelId, afterId: batch[batch.length - 1].message_id }
    }));
  } else {
    if (ctx.view?.id) await core.models.viewSession.clearAnchor(ctx.view.id);

    const channelRow = await core.models.discordChannel.getById(channelId);
    if (channelRow) {
      const serverRow = await core.discord.markChannelRead(channelRow.discord_server, channelId);
      const freshChannel = await core.models.discordChannel.getById(channelId);
      // EVERY OTHER BROWSER'S BADGES SETTLE TOO - THE CATCH-UP READ THE CHANNEL
      core.discord.emitUnreadBadges(serverRow, freshChannel).catch(() => {});
    }

    // compileMessages ALREADY FORMATTED BATCH TIMESTAMPS FOR DISPLAY - THE
    // SEAM (EMPTY CATCH-UP) STILL CARRIES ITS RAW DATE
    const eomStamp = batch.length
      ? batch[batch.length - 1].created_at
      : (seam ? core.discord.formatTimestamp(seam.created_at) : null);
    fragments.push(await core.render.compile('chat/endOfMessages.pug', { eomStamp }));
    fragments.push(await core.render.compile('chat/jumpToPresentBar.pug', { anchored: false }));
  }

  ctx.body = fragments.join('');
  ctx.type = 'html';
}

// THE BAR'S BUTTON - BACK TO THE LIVE HEAD. THE ANCHOR CLEARS FIRST (THE
// MIRROR BUILDER SKIPS CONTAINERS FOR ANCHORED VIEWS), THEN FULL CHROME
// LANDS SCROLLED TO THE BOTTOM (COLUMN-REVERSE: A FRESH CONTAINER STARTS
// AT THE LIVE HEAD).
async function jumpToPresent(ctx) {
  const core = ctx.core;
  if (ctx.view?.id) await core.models.viewSession.clearAnchor(ctx.view.id);
  const state = await ctx.updateView({});
  ctx.body = await core.discord.buildMirrorFragments(state);
  ctx.type = 'html';

  // READING THE HEAD LOWERED THE CHANNEL'S BADGES - OTHER BROWSERS CATCH UP
  const serverRow = state.active_server_id
    ? await core.models.discordServer.getById(state.active_server_id)
    : null;
  if (serverRow) {
    const channelId = core.models.viewSession.channelPickFor(state, serverRow);
    const channelRow = channelId ? await core.models.discordChannel.getById(channelId) : null;
    core.discord.emitUnreadBadges(serverRow, channelRow, ctx.view?.id).catch(() => {});
  }
}

module.exports = { fetchChatHistory, uploadChatMedia, jumpToPresent };
