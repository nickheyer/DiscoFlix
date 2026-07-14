const { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const ui = require('./ui');
const { checkRequestAllowance, checkSeasonLimit, effectiveMaxResults, isAdmin } = require('./limits');
const { checkWhitelist } = require('./access');

// DISCORD SELECT MENUS CAP AT 25 OPTIONS - "ALL" TAKES ONE SLOT
const MAX_LISTED_SEASONS = 24;

function displayTitle(result) {
  return result.year ? `${result.title} (${result.year})` : result.title;
}

// THE PER-TYPE FACT STRIP UNDER THE OVERVIEW
function metaEntriesOf(result) {
  const entries = [];
  if (result.contentType === 'movie') {
    if (result.runtime) entries.push(`Runtime ${result.runtime} min`);
    if (result.network) entries.push(`Studio ${result.network}`);
    if (result.inTheaters) entries.push(`In theaters ${result.inTheaters.slice(0, 10)}`);
  } else if (result.contentType === 'music') {
    if (result.network) entries.push(`Artist ${result.network}`);
    if (result.albumType) entries.push(`Type ${result.albumType}`);
    if (result.firstAired) entries.push(`Released ${result.firstAired.slice(0, 10)}`);
    if (result.trackCount) entries.push(`Tracks ${result.trackCount}`);
  } else {
    if (result.seasonCount) entries.push(`Seasons ${result.seasonCount}`);
    if (result.network) entries.push(`Network ${result.network}`);
    if (result.firstAired) entries.push(`First aired ${result.firstAired.slice(0, 10)}`);
  }
  return entries;
}

// TITLE + OVERVIEW + FACTS WITH THE POSTER RIDING THE RIGHT EDGE
function resultParts(flow, index) {
  const result = flow.results[index];
  const lines = [`### ${displayTitle(result)}`];
  if (result.overview) lines.push(ui.truncate(result.overview, 350));
  if (flow.config.is_trailers_enabled && result.trailerUrl) {
    lines.push(`[Watch the trailer](${result.trailerUrl})`);
  }

  const parts = [];
  if (result.posterUrl) parts.push(ui.section(lines, result.posterUrl));
  else parts.push(...lines.map(line => ui.text(line)));

  const meta = metaEntriesOf(result);
  if (meta.length) parts.push(ui.text(`-# ${meta.join(' • ')}`));
  return parts;
}

function footerOf(flow, index) {
  return ui.text(`-# Result ${index + 1} of ${flow.results.length} • Requested by ${flow.requesterName}`);
}

function buttonRow(index, total) {
  return ui.row(
    new ButtonBuilder().setCustomId('df-prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId('df-next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1),
    new ButtonBuilder().setCustomId('df-select').setLabel('Request This').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
}

// JUMP-TO-RESULT SELECT - EVERY RESULT IS ONE PICK AWAY INSTEAD OF A BUTTON
// WALK. DISCORD CAPS OPTIONS AT 25; RESULTS ARE ALREADY CAPPED BY max_results.
function jumpSelect(flow, index) {
  const options = flow.results.slice(0, 25).map((result, i) => ({
    label: ui.truncate(displayTitle(result), 100),
    description: ui.truncate(result.overview || '', 100) || undefined,
    value: String(i),
    default: i === index
  }));
  return ui.row(
    new StringSelectMenuBuilder()
      .setCustomId('df-pick')
      .setPlaceholder('Jump to a result')
      .addOptions(options)
  );
}

function browsePayload(flow, index) {
  const parts = [...resultParts(flow, index), ui.separator()];
  if (flow.results.length > 1) parts.push(jumpSelect(flow, index));
  parts.push(buttonRow(index, flow.results.length));
  parts.push(footerOf(flow, index));
  return ui.payload(ui.container(parts));
}

// SHOWS WITH MORE THAN ONE SEASON GET A PICKER STEP BEFORE THE REQUEST LANDS
function needsSeasonPick(result) {
  return result.contentType === 'show' && (result.seasonCount || 0) > 1;
}

function seasonPayload(flow, index) {
  const result = flow.results[index];
  const listed = Math.min(result.seasonCount, MAX_LISTED_SEASONS);
  const options = [{
    label: 'All seasons',
    value: 'all',
    description: `Every season (${result.seasonCount} total)`
  }];
  for (let season = 1; season <= listed; season++) {
    options.push({ label: `Season ${season}`, value: String(season) });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('df-seasons')
    .setPlaceholder('Pick the seasons you want')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);

  const parts = [
    ...resultParts(flow, index),
    ui.separator(),
    ui.row(select),
    ui.row(
      new ButtonBuilder().setCustomId('df-back').setLabel('Back').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
    ),
    footerOf(flow, index)
  ];
  return ui.payload(ui.container(parts));
}

// OUTCOME CARD - THE HEADLINE KEEPS THE POSTER SO THE CHANNEL READS AT A GLANCE
function outcomeCard(result, headline, accent, subtext = null) {
  const parts = [];
  if (result.posterUrl) parts.push(ui.section([headline], result.posterUrl));
  else parts.push(ui.text(headline));
  if (subtext) parts.push(ui.text(`-# ${subtext}`));
  return ui.payload(ui.container(parts, accent));
}

// SELECT VALUES -> SORTED SEASON NUMBERS, null = ALL SEASONS
function parseSeasonValues(values) {
  if (values.includes('all')) return null;
  const picked = [...new Set(values.map(Number))].sort((a, b) => a - b);
  return picked.length ? picked : null;
}

// USER PICKS RESULT (+ SEASONS FOR SHOWS) -> VALIDATE -> ADD -> RECORD
// MEDIA/MEDIA-REQUEST -> HAND TO QUEUE. seasons null = ALL / NOT A SHOW.
async function handleSelection(interaction, result, flow, seasons = null) {
  const { core, config, dbUser, client, instance } = flow;
  const name = displayTitle(result);

  // THE PICKED COUNT IS WHAT LIMITS APPLY TO - PICKING FEWER SEASONS IS THE
  // WAY UNDER THE CAP FOR BIG SHOWS
  const effectiveSeasonCount = seasons ? seasons.length : (result.seasonCount || 0);
  const seasonDenial = checkSeasonLimit(config, dbUser, effectiveSeasonCount);
  if (seasonDenial) {
    await interaction.update(ui.notice(seasonDenial, { accent: 'danger' }));
    return;
  }

  await interaction.update(ui.notice(`Working on **${name}**...`));

  // ALREADY STREAMABLE? A CONNECTED MEDIA SERVER ANSWERS BEFORE ANYTHING IS
  // REQUESTED - GUARDED, A DEAD SERVER MUST NEVER BLOCK THE FLOW
  try {
    const streaming = await core.apps.findOnMediaServers(result);
    if (streaming) {
      await flow.channel.send(outcomeCard(result, `**${name}** is already on **${streaming.instance.display_name}** - go stream it!`, 'ok'));
      return;
    }
  } catch (err) {
    core.logger.debug(`Availability check skipped: ${err.message}`);
  }

  // ALREADY IN THE LIBRARY?
  const existing = await client.getByExternalId(result.externalKey);
  if (existing) {
    if (client.isImported(existing)) {
      await flow.channel.send(outcomeCard(result, `**${name}** is already available on ${config.media_server_name}.`, 'ok'));
      return;
    }
    const media = await core.models.media.findByResult(result);
    const openRequest = media
      ? await core.models.mediaRequest.findFirst({ mediaId: media.id, status: null })
      : null;
    if (openRequest) {
      await core.models.mediaRequest.addUser(openRequest.id, dbUser.id);
      await flow.channel.send(outcomeCard(result, `**${name}** has already been requested - I've added you to it and will post updates here.`, 'brand'));
    } else {
      await flow.channel.send(outcomeCard(result, `**${name}** is already on the download list - hang tight.`, 'brand'));
    }
    return;
  }

  const seasonNote = seasons ? ` (season${seasons.length === 1 ? '' : 's'} ${seasons.join(', ')})` : '';

  // ADMIN/STAFF REQUESTS GO STRAIGHT TO THE APP
  if (isAdmin(dbUser)) {
    const added = await client.add(result, { seasons });
    const media = await core.models.media.upsertFromResult(result, added);
    const request = await createRequestRow(core, flow, media, true, added.id, seasons);

    core.apps.watchRequest({
      requestId: request.id,
      appId: instance.id,
      arrId: added.id,
      mediaId: media.id,
      title: name,
      channelId: flow.channel.id,
      requesterIds: [dbUser.id]
    });

    core.logger.info(`Media request created: ${name}${seasonNote} (${instance.display_name}) by ${dbUser.username}`);
    await flow.channel.send(outcomeCard(
      result,
      `**${name}**${seasonNote} has been requested.`,
      'ok',
      `Sent to ${instance.display_name} • Updates will land here as it downloads`
    ));
  } else {
    const media = await core.models.media.upsertFromResult(result);
    await createRequestRow(core, flow, media, null, null, seasons);
    core.logger.info(`Media request pending approval: ${name}${seasonNote} (${instance.display_name}) by ${dbUser.username}`);
    await flow.channel.send(outcomeCard(
      result,
      `**${name}**${seasonNote} has been submitted for approval.`,
      'brand',
      'An admin will review it - updates will land here'
    ));
  }
  core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CHIPS
}

async function createRequestRow(core, flow, media, status, arrId = null, seasons = null) {
  return core.models.mediaRequest.createRequest({
    madeInId: flow.guildId,
    mediaId: media.id,
    orig_message: flow.origContent,
    orig_parsed_title: flow.title,
    orig_parsed_type: flow.contentType,
    orig_channel_id: flow.channel.id,
    orig_message_id: flow.messageId || null,
    // SERVICE ITEM ID PERSISTED SO A RESTART CAN RE-ARM THE QUEUE WATCH
    arr_id: arrId === null ? null : String(arrId),
    // PICKED SEASONS PERSISTED SO APPROVAL MONITORS EXACTLY WHAT WAS ASKED
    seasons: seasons ? JSON.stringify(seasons) : null,
    status,
    appId: flow.instance.id, // WHICH INSTANCE THE SEARCH RAN AGAINST - APPROVAL TARGETS THE SAME ONE
    users: { connect: { id: flow.dbUser.id } }
  });
}

// THE FLOW BODY SHARED BY PREFIX AND SLASH - THE DISPATCHER ALREADY RESOLVED
// dbUser (PROFILE SYNC + ROLE GRANTS), SO ONLY THE REQUEST GATES RUN HERE
async function runRequest(ctx, contentDef) {
  const { core, config, dbUser, discordUser, roleTokens, send } = ctx;
  const label = contentDef.label;
  const title = ctx.options.title;

  try {
    // ROUTE TO THE DEFAULT ENABLED+CONFIGURED INSTANCE FOR THIS CONTENT TYPE
    const instance = await core.apps.defaultInstanceFor(contentDef.type);
    if (!instance) {
      await send(ui.notice(`No connected app handles ${label} requests yet - add one in the web console.`, { accent: 'warn' }));
      return;
    }
    const client = core.apps.getClientForInstance(instance);

    // A DENIED ASK RAISES A HAND THE CONSOLE'S USERS SECTION CAN SEE - THE
    // FIRST DENIAL FLAGS, REPEATS JUST POINT AT THE PENDING ASK
    if (checkWhitelist(config, dbUser, roleTokens)) {
      const isNewAsk = await core.models.user.flagAccessRequest(dbUser.id);
      await send(ui.notice(
        isNewAsk
          ? 'Requests are limited to approved members here - the admins have been flagged that you\'d like access.'
          : 'Requests are limited to approved members here - your access ask is still waiting on an admin.',
        { accent: 'danger' }
      ));
      return;
    }

    const denial = await checkRequestAllowance(core, dbUser);
    if (denial) {
      await send(ui.notice(denial, { accent: 'danger' }));
      return;
    }

    let results = await client.search(title);
    const maxResults = effectiveMaxResults(config, dbUser);
    if (maxResults > 0) results = results.slice(0, maxResults);
    if (!results.length) {
      await send(ui.notice(`No ${label} results found for **${title}**.`, { accent: 'warn' }));
      return;
    }

    const flow = {
      core, config, dbUser, client, instance, results,
      contentType: contentDef.type,
      title,
      requesterName: discordUser.displayName,
      guildId: ctx.guildId,
      channel: ctx.channel,
      origContent: ctx.origContent,
      messageId: ctx.messageId || null
    };

    let index = 0;
    const message = await send(browsePayload(flow, index));
    const collector = message.createMessageComponentCollector({
      time: config.session_timeout * 1000
    });

    collector.on('collect', async (interaction) => {
      try {
        if (interaction.user.id !== discordUser.id) {
          await interaction.reply(ui.notice('This selection belongs to someone else - start your own request.', { accent: 'danger', ephemeral: true }));
          return;
        }
        switch (interaction.customId) {
          case 'df-prev':
            index = Math.max(0, index - 1);
            await interaction.update(browsePayload(flow, index));
            break;
          case 'df-next':
            index = Math.min(results.length - 1, index + 1);
            await interaction.update(browsePayload(flow, index));
            break;
          case 'df-back':
            await interaction.update(browsePayload(flow, index));
            break;
          case 'df-pick':
            index = Math.max(0, Math.min(results.length - 1, Number(interaction.values[0]) || 0));
            await interaction.update(browsePayload(flow, index));
            break;
          case 'df-cancel':
            collector.stop('handled');
            await interaction.update(ui.notice('Request cancelled.'));
            break;
          case 'df-select':
            // SHOWS DETOUR THROUGH THE SEASON PICKER - THE COLLECTOR STAYS UP
            if (needsSeasonPick(results[index])) {
              await interaction.update(seasonPayload(flow, index));
              break;
            }
            collector.stop('handled');
            await handleSelection(interaction, results[index], flow);
            break;
          case 'df-seasons': {
            collector.stop('handled');
            const seasons = parseSeasonValues(interaction.values);
            await handleSelection(interaction, results[index], flow, seasons);
            break;
          }
        }
      } catch (err) {
        core.logger.error('Request selection failed:', err);
        await ctx.channel.send(ui.notice(`Something went wrong with that request: ${err.message}`, { accent: 'danger' })).catch(() => {});
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'handled') return;
      await message.edit(ui.notice('Request selection timed out.', { accent: 'warn' })).catch(() => {});
    });
  } catch (err) {
    core.logger.error('Request flow failed:', err);
    await send(ui.notice(`Something went wrong with that request: ${err.message}`, { accent: 'danger' })).catch(() => {});
  }
}

// ONE INTERACTION DEF PER SERVED CONTENT TYPE - BUILT OFF THE MANIFEST
// REGISTRY SO NEW CONTENT TYPES ARRIVE WITH ZERO BOT-CORE EDITS
function requestInteractionFor(contentDef) {
  return {
    id: `request-${contentDef.type}`,
    slash: { name: contentDef.slash.name, description: contentDef.slash.description },
    options: [{ name: 'title', description: 'Title to search for', type: 'string', required: true }],
    aliases: contentDef.aliases,
    ephemeral: false,
    async available(core) {
      return (await core.apps.enabledContentTypes()).includes(contentDef.type);
    },
    run: (ctx) => runRequest(ctx, contentDef)
  };
}

module.exports = { requestInteractionFor };
