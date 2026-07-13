const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { checkRequestAllowance, checkSeasonLimit, effectiveMaxResults, isAdmin } = require('./limits');
const { checkWhitelist, roleGrantsFor } = require('./access');
const registry = require('../../methods/apps/registry');

const EMBED_COLOR = 0x5865f2;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function displayTitle(result) {
  return result.year ? `${result.title} (${result.year})` : result.title;
}

function buildResultEmbed(result, index, total, config, requesterName) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(displayTitle(result))
    .setFooter({ text: `Result ${index + 1} of ${total} • Requested by ${requesterName}` });

  const description = [];
  if (result.overview) description.push(truncate(result.overview, 350));
  if (config.is_trailers_enabled && result.trailerUrl) {
    description.push(`[Watch the trailer](${result.trailerUrl})`);
  }
  if (description.length) embed.setDescription(description.join('\n\n'));
  if (result.posterUrl) embed.setThumbnail(result.posterUrl);

  const fields = [];
  if (result.contentType === 'movie') {
    if (result.runtime) fields.push({ name: 'Runtime', value: `${result.runtime} min`, inline: true });
    if (result.network) fields.push({ name: 'Studio', value: result.network, inline: true });
    if (result.inTheaters) fields.push({ name: 'In Theaters', value: result.inTheaters.slice(0, 10), inline: true });
  } else {
    if (result.seasonCount) fields.push({ name: 'Seasons', value: `${result.seasonCount}`, inline: true });
    if (result.network) fields.push({ name: 'Network', value: result.network, inline: true });
    if (result.firstAired) fields.push({ name: 'First Aired', value: result.firstAired.slice(0, 10), inline: true });
  }
  if (fields.length) embed.addFields(fields);

  return embed;
}

function buildButtonRow(index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('df-prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId('df-next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1),
    new ButtonBuilder().setCustomId('df-select').setLabel('Request This').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
}

// JUMP-TO-RESULT SELECT - EVERY RESULT IS ONE PICK AWAY INSTEAD OF A BUTTON
// WALK. DISCORD CAPS OPTIONS AT 25; RESULTS ARE ALREADY CAPPED BY max_results.
function buildResultSelect(ctx, index) {
  const options = ctx.results.slice(0, 25).map((result, i) => ({
    label: truncate(displayTitle(result), 100),
    description: truncate(result.overview || '', 100) || undefined,
    value: String(i),
    default: i === index
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('df-pick')
      .setPlaceholder('Jump to a result')
      .addOptions(options)
  );
}

function renderResult(ctx, index) {
  const components = [];
  if (ctx.results.length > 1) components.push(buildResultSelect(ctx, index));
  components.push(buildButtonRow(index, ctx.results.length));
  return {
    embeds: [buildResultEmbed(ctx.results[index], index, ctx.results.length, ctx.config, ctx.discordUser.displayName)],
    components
  };
}

// DISCORD SELECT MENUS CAP AT 25 OPTIONS - "ALL" TAKES ONE SLOT
const MAX_LISTED_SEASONS = 24;

// SHOWS WITH MORE THAN ONE SEASON GET A PICKER STEP BEFORE THE REQUEST LANDS
function needsSeasonPick(result) {
  return result.contentType === 'show' && (result.seasonCount || 0) > 1;
}

function renderSeasonPicker(ctx, index) {
  const result = ctx.results[index];
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

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('df-back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [buildResultEmbed(result, index, ctx.results.length, ctx.config, ctx.discordUser.displayName)],
    components: [new ActionRowBuilder().addComponents(select), buttons]
  };
}

// SELECT VALUES -> SORTED SEASON NUMBERS, null = ALL SEASONS
function parseSeasonValues(values, result) {
  if (values.includes('all')) return null;
  const picked = [...new Set(values.map(Number))].sort((a, b) => a - b);
  return picked.length ? picked : null;
}

// USER PICKS RESULT (+ SEASONS FOR SHOWS) -> VALIDATE -> ADD -> RECORD
// MEDIA/MEDIA-REQUEST -> HAND TO QUEUE. seasons null = ALL / NOT A SHOW.
async function handleSelection(interaction, result, ctx, seasons = null) {
  const { core, config, dbUser, client, instance } = ctx;
  const name = displayTitle(result);

  // THE PICKED COUNT IS WHAT LIMITS APPLY TO - PICKING FEWER SEASONS IS THE
  // WAY UNDER THE CAP FOR BIG SHOWS
  const effectiveSeasonCount = seasons ? seasons.length : (result.seasonCount || 0);
  const seasonDenial = checkSeasonLimit(config, dbUser, effectiveSeasonCount);
  if (seasonDenial) {
    await interaction.update({ content: seasonDenial, embeds: [], components: [] });
    return;
  }

  await interaction.update({ content: `Working on **${name}**...`, embeds: [], components: [] });

  // ALREADY STREAMABLE? A CONNECTED MEDIA SERVER ANSWERS BEFORE ANYTHING IS
  // REQUESTED - GUARDED, A DEAD SERVER MUST NEVER BLOCK THE FLOW
  try {
    const streaming = await core.apps.findOnMediaServers(result);
    if (streaming) {
      await ctx.channel.send(`**${name}** is already on **${streaming.instance.display_name}** - go stream it!`);
      return;
    }
  } catch (err) {
    core.logger.debug(`Availability check skipped: ${err.message}`);
  }

  // ALREADY IN THE LIBRARY?
  const existing = await client.getByExternalId(result.externalKey);
  if (existing) {
    if (client.isImported(existing)) {
      await ctx.channel.send(`**${name}** is already available on ${config.media_server_name}.`);
      return;
    }
    const media = await core.models.media.findByResult(result);
    const openRequest = media
      ? await core.models.mediaRequest.findFirst({ mediaId: media.id, status: null })
      : null;
    if (openRequest) {
      await core.models.mediaRequest.addUser(openRequest.id, dbUser.id);
      await ctx.channel.send(`**${name}** has already been requested - I've added you to it and will post updates here.`);
    } else {
      await ctx.channel.send(`**${name}** is already on the download list - hang tight.`);
    }
    return;
  }

  const seasonNote = seasons ? ` (season${seasons.length === 1 ? '' : 's'} ${seasons.join(', ')})` : '';

  // ADMIN/STAFF REQUESTS GO STRAIGHT TO THE APP
  if (isAdmin(dbUser)) {
    const added = await client.add(result, { seasons });
    const media = await core.models.media.upsertFromResult(result, added);
    const request = await createRequestRow(core, ctx, media, true, added.id, seasons);

    core.apps.watchRequest({
      requestId: request.id,
      appId: instance.id,
      arrId: added.id,
      mediaId: media.id,
      title: name,
      channelId: ctx.channel.id,
      requesterIds: [dbUser.id]
    });

    core.logger.info(`Media request created: ${name}${seasonNote} (${instance.display_name}) by ${dbUser.username}`);
    await ctx.channel.send(`**${name}**${seasonNote} has been requested. I'll post updates here as it downloads.`);
  } else {
    const media = await core.models.media.upsertFromResult(result);
    await createRequestRow(core, ctx, media, null, null, seasons);
    core.logger.info(`Media request pending approval: ${name}${seasonNote} (${instance.display_name}) by ${dbUser.username}`);
    await ctx.channel.send(`**${name}**${seasonNote} has been submitted for approval - an admin will review it.`);
  }
  core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CHIPS
}

async function createRequestRow(core, ctx, media, status, arrId = null, seasons = null) {
  return core.models.mediaRequest.createRequest({
    madeInId: ctx.guildId,
    mediaId: media.id,
    orig_message: ctx.origContent,
    orig_parsed_title: ctx.title,
    orig_parsed_type: ctx.contentType,
    orig_channel_id: ctx.channel.id,
    orig_message_id: ctx.messageId || null,
    // SERVICE ITEM ID PERSISTED SO A RESTART CAN RE-ARM THE QUEUE WATCH
    arr_id: arrId === null ? null : String(arrId),
    // PICKED SEASONS PERSISTED SO APPROVAL MONITORS EXACTLY WHAT WAS ASKED
    seasons: seasons ? JSON.stringify(seasons) : null,
    status,
    appId: ctx.instance.id, // WHICH INSTANCE THE SEARCH RAN AGAINST - APPROVAL TARGETS THE SAME ONE
    users: { connect: { id: ctx.dbUser.id } }
  });
}

// ENTRY POINT SHARED BY PREFIX AND SLASH COMMANDS

async function runRequestFlow(core, request) {
  const { contentType, title, discordUser, send, roleTokens = [] } = request;
  const label = registry.contentTypeDefs().find(def => def.type === contentType)?.label || contentType;

  try {
    const config = await core.models.configuration.get();

    // ROUTE TO THE DEFAULT ENABLED+CONFIGURED INSTANCE FOR THIS CONTENT TYPE
    const instance = await core.apps.defaultInstanceFor(contentType);
    if (!instance) {
      await send(`No connected app handles ${label} requests yet - add one in the web console.`);
      return;
    }
    const client = core.apps.getClientForInstance(instance);

    // SLASH COMMANDS DONT PASS THROUGH THE MESSAGE MIRROR, SO THE USER ROW MIGHT NOT EXIST
    let dbUser = await core.models.user.getOrCreate(
      { id: discordUser.id },
      {
        username: discordUser.username,
        display_name: discordUser.displayName,
        avatar_url: discordUser.displayAvatarURL(),
        is_bot: !!discordUser.bot
      }
    );

    // GUILD ROLES PROMOTE BEFORE ANY GATE RUNS - A MAPPED ROLE IS AS GOOD AS
    // A CONSOLE GRANT
    const grants = roleGrantsFor(config, roleTokens);
    const missing = Object.keys(grants).filter(key => !dbUser[key]);
    if (missing.length) {
      dbUser = await core.models.user.update({ id: dbUser.id }, grants);
      core.logger.info(`Role mapping granted ${missing.join(', ')} to ${dbUser.username}`);
    }

    const whitelistDenial = checkWhitelist(config, dbUser, roleTokens);
    if (whitelistDenial) {
      await send(whitelistDenial);
      return;
    }

    const denial = await checkRequestAllowance(core, dbUser);
    if (denial) {
      await send(denial);
      return;
    }

    let results = await client.search(title);
    const maxResults = effectiveMaxResults(config, dbUser);
    if (maxResults > 0) results = results.slice(0, maxResults);
    if (!results.length) {
      await send(`No ${label} results found for **${title}**.`);
      return;
    }

    const ctx = {
      core, config, dbUser, client, instance,
      contentType, title, results, discordUser,
      guildId: request.guildId,
      channel: request.channel,
      origContent: request.origContent,
      messageId: request.messageId || null
    };

    let index = 0;
    const message = await send(renderResult(ctx, index));
    const collector = message.createMessageComponentCollector({
      time: config.session_timeout * 1000
    });

    collector.on('collect', async (interaction) => {
      try {
        if (interaction.user.id !== discordUser.id) {
          await interaction.reply({ content: 'This selection belongs to someone else - start your own request.', ephemeral: true });
          return;
        }
        switch (interaction.customId) {
          case 'df-prev':
            index = Math.max(0, index - 1);
            await interaction.update(renderResult(ctx, index));
            break;
          case 'df-next':
            index = Math.min(results.length - 1, index + 1);
            await interaction.update(renderResult(ctx, index));
            break;
          case 'df-back':
            await interaction.update(renderResult(ctx, index));
            break;
          case 'df-pick':
            index = Math.max(0, Math.min(results.length - 1, Number(interaction.values[0]) || 0));
            await interaction.update(renderResult(ctx, index));
            break;
          case 'df-cancel':
            collector.stop('handled');
            await interaction.update({ content: 'Request cancelled.', embeds: [], components: [] });
            break;
          case 'df-select':
            // SHOWS DETOUR THROUGH THE SEASON PICKER - THE COLLECTOR STAYS UP
            if (needsSeasonPick(results[index])) {
              await interaction.update(renderSeasonPicker(ctx, index));
              break;
            }
            collector.stop('handled');
            await handleSelection(interaction, results[index], ctx);
            break;
          case 'df-seasons': {
            collector.stop('handled');
            const seasons = parseSeasonValues(interaction.values, results[index]);
            await handleSelection(interaction, results[index], ctx, seasons);
            break;
          }
        }
      } catch (err) {
        core.logger.error('Request selection failed:', err);
        await request.channel.send(`Something went wrong with that request: ${err.message}`).catch(() => {});
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'handled') return;
      await message.edit({ content: 'Request selection timed out.', embeds: [], components: [] }).catch(() => {});
    });
  } catch (err) {
    core.logger.error('Request flow failed:', err);
    await send(`Something went wrong with that request: ${err.message}`).catch(() => {});
  }
}

module.exports = { runRequestFlow };
