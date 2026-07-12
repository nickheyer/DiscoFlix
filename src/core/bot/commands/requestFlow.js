const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { checkRequestAllowance, checkSeasonLimit, effectiveMaxResults, isAdmin } = require('./limits');

const EMBED_COLOR = 0x5865f2;

const CONTENT_TYPES = {
  movie: { service: 'radarr', label: 'movie' },
  show: { service: 'sonarr', label: 'show' }
};

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
    description.push(`▶️ [Watch trailer](${result.trailerUrl})`);
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
    new ButtonBuilder().setCustomId('df-prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId('df-next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1),
    new ButtonBuilder().setCustomId('df-select').setLabel('Request').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
}

function renderResult(ctx, index) {
  return {
    embeds: [buildResultEmbed(ctx.results[index], index, ctx.results.length, ctx.config, ctx.discordUser.displayName)],
    components: [buildButtonRow(index, ctx.results.length)]
  };
}

// FIND AN EXISTING Media ROW BY STRONGEST AVAILABLE KEY
async function findMediaRow(core, result) {
  if (result.imdbId) {
    const byImdb = await core.models.media.findFirst({ imdb_id: result.imdbId });
    if (byImdb) return byImdb;
  }
  if (result.tmdbId) {
    const byTmdb = await core.models.media.findFirst({ tmdb_id: result.tmdbId });
    if (byTmdb) return byTmdb;
  }
  if (result.tvdbId) {
    const byTvdb = await core.models.media.findFirst({ tvdb_id: result.tvdbId });
    if (byTvdb) return byTvdb;
  }
  return null;
}

async function upsertMediaRow(core, result, added) {
  const data = {
    title: result.title,
    overview: result.overview || null,
    poster_url: result.posterUrl,
    year: result.year,
    path: added.path || null,
    monitored: true,
    runtime: result.runtime,
    added: added.added || new Date().toISOString(),
    season_count: result.seasonCount,
    network: result.network,
    air_time: result.airTime,
    tvdb_id: result.tvdbId || null,
    tmdb_id: result.tmdbId || null,
    imdb_id: result.imdbId || null,
    first_aired: result.firstAired,
    series_type: result.seriesType,
    in_theaters: result.inTheaters,
    website_url: result.websiteUrl,
    trailer_url: result.trailerUrl
  };

  const existing = await findMediaRow(core, result);
  if (existing) return core.models.media.updateMediaInfo(existing.id, data);
  return core.models.media.addMedia(data);
}

// USER PICKS RESULT -> VALIDATE -> ADD TO BAR -> RECORD MEDIA/MEDIA-REQUEST -> HAND TO QUEUE
async function handleSelection(interaction, result, ctx) {
  const { core, config, dbUser, client, service } = ctx;
  const name = displayTitle(result);

  const seasonDenial = checkSeasonLimit(config, dbUser, result.seasonCount || 0);
  if (seasonDenial) {
    await interaction.update({ content: `🚫 ${seasonDenial}`, embeds: [], components: [] });
    return;
  }

  await interaction.update({ content: `⏳ Working on **${name}**...`, embeds: [], components: [] });

  // ALREADY IN THE LIBRARY?
  const existing = await client.getByExternalId(result.externalKey);
  if (existing) {
    if (client.isImported(existing)) {
      await ctx.channel.send(`✅ **${name}** is already available on ${config.media_server_name}!`);
      return;
    }
    const media = await findMediaRow(core, result);
    const openRequest = media
      ? await core.models.mediaRequest.findFirst({ mediaId: media.id, status: null })
      : null;
    if (openRequest) {
      await core.models.mediaRequest.addUser(openRequest.id, dbUser.id);
      await ctx.channel.send(`📌 **${name}** has already been requested — I've added you to it and will post updates here.`);
    } else {
      await ctx.channel.send(`📌 **${name}** is already on the download list — hang tight.`);
    }
    return;
  }

  // ADMIN/STAFF REQUESTS GO STRAIGHT TO THE ARR
  if (isAdmin(dbUser)) {
    const added = await client.add(result);
    const media = await upsertMediaRow(core, result, added);
    const request = await createRequestRow(core, ctx, media, true);

    core.arr.watchRequest({
      requestId: request.id,
      service,
      arrId: added.id,
      mediaId: media.id,
      title: name,
      channelId: ctx.channel.id,
      requesterIds: [dbUser.id]
    });

    core.logger.info(`Media request created: ${name} (${service}) by ${dbUser.username}`);
    await ctx.channel.send(`🎉 **${name}** has been requested! I'll post updates here as it downloads.`);
  } else {
    const media = await upsertMediaRow(core, result, {});
    await createRequestRow(core, ctx, media, null);
    core.logger.info(`Media request pending approval: ${name} (${service}) by ${dbUser.username}`);
    await ctx.channel.send(`📨 **${name}** has been submitted for approval — an admin will review it.`);
  }
  core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CHIPS
}

async function createRequestRow(core, ctx, media, status) {
  return core.models.mediaRequest.createRequest({
    madeInId: ctx.guildId,
    mediaId: media.id,
    orig_message: ctx.origContent,
    orig_parsed_title: ctx.title,
    orig_parsed_type: ctx.contentType,
    orig_channel_id: ctx.channel.id,
    orig_message_id: ctx.messageId || null,
    status,
    users: { connect: { id: ctx.dbUser.id } }
  });
}

// ENTRY POINT SHARED BY PREFIX AND SLASH COMMANDS

async function runRequestFlow(core, request) {
  const { contentType, title, discordUser, send } = request;
  const { service, label } = CONTENT_TYPES[contentType];

  try {
    const config = await core.models.configuration.get();

    if (!core.arr.isServiceEnabled(service, config)) {
      await send(`🚫 ${label === 'movie' ? 'Movie' : 'Show'} requests are currently disabled.`);
      return;
    }
    const client = core.arr.getClientFor(service, config);
    if (!client) {
      await send(`⚙️ ${capitalize(service)} isn't configured yet — set its URL and API key in the web console settings.`);
      return;
    }

    // SLASH COMMANDS DONT PASS THROUGH THE MESSAGE MIRROR, SO THE USER ROW MIGHT NOT EXIST
    const dbUser = await core.models.user.getOrCreate(
      { id: discordUser.id },
      {
        username: discordUser.username,
        display_name: discordUser.displayName,
        avatar_url: discordUser.displayAvatarURL(),
        is_bot: !!discordUser.bot
      }
    );

    const denial = await checkRequestAllowance(core, dbUser);
    if (denial) {
      await send(`🚫 ${denial}`);
      return;
    }

    let results = await client.search(title);
    const maxResults = effectiveMaxResults(config, dbUser);
    if (maxResults > 0) results = results.slice(0, maxResults);
    if (!results.length) {
      await send(`🔍 No ${label} results found for **${title}**.`);
      return;
    }

    const ctx = {
      core, config, dbUser, client, service,
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
          await interaction.reply({ content: 'This selection belongs to someone else — start your own request.', ephemeral: true });
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
          case 'df-cancel':
            collector.stop('handled');
            await interaction.update({ content: '🚫 Request cancelled.', embeds: [], components: [] });
            break;
          case 'df-select':
            collector.stop('handled');
            await handleSelection(interaction, results[index], ctx);
            break;
        }
      } catch (err) {
        core.logger.error('Request selection failed:', err);
        await request.channel.send(`❌ Something went wrong with that request: ${err.message}`).catch(() => {});
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'handled') return;
      await message.edit({ content: '⏲️ Request selection timed out.', embeds: [], components: [] }).catch(() => {});
    });
  } catch (err) {
    core.logger.error('Request flow failed:', err);
    await send(`❌ Something went wrong with that request: ${err.message}`).catch(() => {});
  }
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

module.exports = { runRequestFlow };
