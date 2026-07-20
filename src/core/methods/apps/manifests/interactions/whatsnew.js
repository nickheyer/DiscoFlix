// RECENTLY ADDED ACROSS EVERY SERVING MEDIA SERVER - THE SAME NORMALIZED
// HISTORY FEEDS THE CONSOLE ACTIVITY RAIL READS, MERGED INTO ONE DEDUPED
// LIST KEYED LIKE THE UNIFIED LIBRARY (IDS FIRST, TITLE FALLBACK). THE
// SERVERS THAT CONTRIBUTED ARE BADGED ONCE IN THE HEADER - A RECENT WINDOW
// IS NOT AN INVENTORY, SO NO PER-TITLE "ONLY ON X" CLAIM IS EVER MADE (A
// TITLE ON EVERY SERVER SURFACES IN ONLY THE WINDOWS THAT CAUGHT ITS ADD).
// EACH PAGE LEADS WITH POSTER SECTIONS - ART IS FETCHED THROUGH THE OWNING
// CLIENT AND ATTACHED, SO LAN URLS AND TOKENS NEVER REACH DISCORD - AND THE
// REST STAY COMPACT TEXT ROWS. OVERFLOW PAGES RIDE A PREV/NEXT PAGER ON THE
// REQUEST CARD'S COLLECTOR PATTERN (OWNER-ONLY, PAGES CACHED PER FLIP, THE
// PAGER STRIPS ITSELF WHEN THE COLLECTOR ENDS). SHARED BY THE
// PLEX/EMBY/JELLYFIN MANIFESTS; INSTANCES ARE POOLED.
const { AttachmentBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { appBadge } = require('../../../../bot/interactions/appEmojis');

const POSTER_TIMEOUT_MS = 2500;
const PAGER_IDLE_MS = 2 * 60 * 1000;
const PAGER_TIME_MS = 10 * 60 * 1000; // EPHEMERAL TOKENS DIE AT 15m - STAY UNDER
const KIND_LABELS = { movie: 'Movie', show: 'Show', music: 'Album' };

function comparable(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// MOVIES MATCH ON EXTERNAL IDS THEN TITLE+YEAR; SHOWS MATCH ON TITLE ALONE
// (FEED ROWS ARE SEASON/EPISODE SCOPED, THEIR IDS NEVER NAME THE SERIES)
function groupKeysOf(media) {
  const keys = [];
  const ids = media.externalIds || {};
  if (media.kind === 'movie') {
    if (ids.imdb) keys.push(`imdb:${ids.imdb}`);
    if (ids.tmdb) keys.push(`movie:tmdb:${ids.tmdb}`);
    if (ids.tvdb) keys.push(`movie:tvdb:${ids.tvdb}`);
  }
  const title = comparable(media.title);
  if (title) keys.push(`${media.kind}:title:${title}${media.kind === 'movie' ? `:${media.year || ''}` : ''}`);
  return keys;
}

function buildGroups(feeds) {
  const keyed = new Map();
  const groups = [];
  for (const feed of feeds) {
    for (const row of feed.rows) {
      const media = row.media || { kind: 'movie', title: row.title, year: null };
      const keys = groupKeysOf(media);
      if (!keys.length) continue;
      let group = keys.map(key => keyed.get(key)).find(Boolean);
      if (!group) {
        group = {
          kind: media.kind,
          title: media.title || row.title,
          year: media.year || null,
          at: null,
          art: null,
          instanceIds: new Set(),
          episodePairs: new Set(),
          seasonBulkCounts: new Map(),
          strayEpisodes: 0
        };
        groups.push(group);
      }
      for (const key of keys) keyed.set(key, group);
      group.instanceIds.add(feed.instance.id);
      if (!group.art && row.art) group.art = { instance: feed.instance, path: row.art };
      if (!group.year && media.year) group.year = media.year;
      if (row.at && (!group.at || row.at > group.at)) group.at = row.at;
      if (media.kind === 'show') {
        if (media.season != null && media.episode != null) {
          group.episodePairs.add(`${media.season}:${media.episode}`);
        } else if (media.season != null) {
          // SEASON-LEVEL ROWS (PLEX) COUNT WHOLE SEASONS, NEVER SINGLE EPISODES
          const known = group.seasonBulkCounts.get(media.season) || 0;
          group.seasonBulkCounts.set(media.season, Math.max(known, media.episodeCount || 0));
        } else {
          group.strayEpisodes += 1;
        }
      }
    }
  }
  return groups;
}

// ONE SUBTEXT PHRASE FOR A SHOW GROUP - S02E05 FOR A LONE EPISODE, OTHERWISE
// SEASON SPAN + A NEW-EPISODE COUNT DEDUPED ACROSS SERVERS PER SEASON
function episodeSummaryOf(group) {
  const pairs = [...group.episodePairs].map(pair => {
    const [season, episode] = pair.split(':').map(Number);
    return { season, episode };
  });
  const seasons = new Set(pairs.map(pair => pair.season));
  for (const season of group.seasonBulkCounts.keys()) seasons.add(season);
  if (!seasons.size && !group.strayEpisodes) return null;

  let total = group.strayEpisodes;
  for (const season of seasons) {
    const pairCount = pairs.filter(pair => pair.season === season).length;
    total += Math.max(pairCount, group.seasonBulkCounts.get(season) || 0);
  }
  if (seasons.size === 1 && total === 1 && pairs.length === 1) {
    const only = pairs[0];
    return `S${String(only.season).padStart(2, '0')}E${String(only.episode).padStart(2, '0')}`;
  }
  const scope = seasons.size === 1
    ? `Season ${[...seasons][0]}`
    : (seasons.size ? `${seasons.size} seasons` : null);
  const count = total ? `${total} new episode${total === 1 ? '' : 's'}` : null;
  return [scope, count].filter(Boolean).join(' • ') || null;
}

function titleOf(group) {
  return group.kind === 'movie' && group.year ? `${group.title} (${group.year})` : group.title;
}

function factsOf(group, ui) {
  const facts = [];
  const episodeSummary = group.kind === 'show' ? episodeSummaryOf(group) : null;
  if (episodeSummary) facts.push(episodeSummary);
  else facts.push(KIND_LABELS[group.kind] || 'Media');
  if (group.kind !== 'movie' && group.year) facts.push(String(group.year));
  const age = ui.ageOf(group.at);
  if (age) facts.push(age);
  return facts.join(' • ');
}

// ICON + NAME BADGE PER SERVER - PLAIN NAME UNTIL AN EMOJI SYNC LANDS
function serverBadge(instance) {
  return appBadge(instance.app_type, instance.display_name);
}

// POSTERS FOR ONE PAGE'S FEATURED ROWS, FETCHED IN PARALLEL THROUGH EACH
// GROUP'S OWNING CLIENT. EVERY FAILURE (NO ART, DEAD SERVER, SLOW TRANSCODE)
// JUST COSTS THAT ROW ITS THUMBNAIL - NEVER THE REPLY. nameOffset KEEPS
// attachment:// NAMES UNIQUE ACROSS PAGES.
async function fetchPosters(core, groups, nameOffset = 0) {
  const posters = new Map();
  const files = [];
  await Promise.all(groups.map(async (group, i) => {
    if (!group.art) return;
    const client = core.apps.getClientForInstance(group.art.instance);
    if (!client) return;
    try {
      const image = await Promise.race([
        client.fetchImage(group.art.path),
        new Promise((_, reject) => setTimeout(() => reject(new Error('poster timeout')), POSTER_TIMEOUT_MS))
      ]);
      const name = `whatsnew${nameOffset + i}.${String(image.contentType).includes('png') ? 'png' : 'jpg'}`;
      files.push(new AttachmentBuilder(image.buffer, { name }));
      posters.set(group, `attachment://${name}`);
    } catch (err) {
      core.logger.debug(`whatsnew poster skipped (${group.title}): ${err.message}`);
    }
  }));
  return { posters, files };
}

function pagerRow(ui, page, totalPages) {
  return ui.row(
    new ButtonBuilder().setCustomId('df-wn-prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('df-wn-page').setLabel(`Page ${page + 1} of ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('df-wn-next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
  );
}

module.exports = {
  id: 'whatsnew',
  slash: { name: 'whatsnew', description: 'Recently added titles on the media server' },
  options: [],
  aliases: ['whatsnew', 'new', 'latest'],
  ephemeral: true,
  feature: {
    id: 'whatsnew',
    label: "What's new",
    description: 'List recently added media-server titles with /whatsnew',
    group: 'core',
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: []
  },
  async run(ctx) {
    const { core, instances, send, ui } = ctx;
    if (!instances.length) {
      await send(ui.notice('No media server is connected yet - add one in the web console.', { accent: 'warn' }));
      return;
    }

    const feeds = await Promise.all(instances.map(async instance => {
      const feed = await core.apps.getFeedViewModel(instance);
      return {
        instance,
        rows: (feed.rows || []).filter(row => row.kind === 'added'),
        error: feed.error || null
      };
    }));
    const reachable = feeds.filter(feed => !feed.error);
    const unreachable = feeds.filter(feed => feed.error);
    if (!reachable.length) {
      await send(ui.notice('No media server could be reached right now - try again in a minute.', { accent: 'warn' }));
      return;
    }

    const groups = buildGroups(reachable).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    // ROW COUNTS READ PER RUN - PAGES STAY CONSISTENT WITHIN ONE REPLY WHILE
    // TUNING OVERRIDES STILL LAND ON THE NEXT /whatsnew
    const posterRows = core.tuning.value('whatsnew_poster_rows');
    const pageSize = posterRows + core.tuning.value('whatsnew_compact_rows');
    const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));

    // THE CONTRIBUTOR STRIP - EVERY SERVER WITH A TITLE IN THE MERGED SET,
    // BADGED ONCE UP TOP (EMPTY SET FALLS BACK TO WHO WAS CHECKED)
    const contributors = reachable.filter(feed => groups.some(group => group.instanceIds.has(feed.instance.id)));
    const badges = (contributors.length ? contributors : reachable).map(feed => serverBadge(feed.instance));

    // PAGES ARE BUILT (AND THEIR POSTERS FETCHED) ON FIRST VISIT, THEN CACHED
    // FOR THE COLLECTOR'S LIFETIME SO FLIPPING BACK NEVER REFETCHES ART
    const pageCache = new Map();
    const buildPage = async (page) => {
      if (!pageCache.has(page)) {
        const start = page * pageSize;
        const slice = groups.slice(start, start + pageSize);
        const featured = slice.slice(0, posterRows);
        const compact = slice.slice(posterRows);
        const { posters, files } = await fetchPosters(core, featured, start);
        pageCache.set(page, { featured, compact, posters, files });
      }
      return pageCache.get(page);
    };

    const renderPage = (pageData, page, { pager = totalPages > 1 } = {}) => {
      const parts = [
        ui.text("### What's new"),
        ui.text(`-# ${badges.length > 1 ? 'Across' : 'On'} ${badges.join(' • ')}`),
        ui.separator({ large: true })
      ];
      if (!groups.length) parts.push(ui.text('-# Nothing new here yet'));
      for (const group of pageData.featured) {
        const lines = [`**${titleOf(group)}**`, `-# ${factsOf(group, ui)}`];
        const poster = pageData.posters.get(group);
        if (poster) parts.push(ui.section(lines, poster));
        else parts.push(ui.text(lines.join('\n')));
      }
      if (pageData.compact.length) parts.push(ui.separator());
      for (const group of pageData.compact) {
        parts.push(ui.text(`**${titleOf(group)}**\n-# ${factsOf(group, ui)}`));
      }
      for (const feed of unreachable) {
        parts.push(ui.separator(), ui.text(`-# ${feed.instance.display_name} could not be reached right now`));
      }
      if (pager) parts.push(pagerRow(ui, page, totalPages));
      return ui.payload(ui.container(parts), { files: pageData.files });
    };

    let page = 0;
    const message = await send(renderPage(await buildPage(0), 0));
    if (totalPages <= 1 || !message?.createMessageComponentCollector) return;

    const collector = message.createMessageComponentCollector({
      idle: PAGER_IDLE_MS,
      time: PAGER_TIME_MS
    });

    collector.on('collect', async (interaction) => {
      try {
        if (interaction.user.id !== ctx.discordUser.id) {
          await interaction.reply(ui.notice('This list belongs to someone else - run /whatsnew yourself.', { accent: 'danger', ephemeral: true }));
          return;
        }
        if (interaction.customId === 'df-wn-prev') page = Math.max(0, page - 1);
        else if (interaction.customId === 'df-wn-next') page = Math.min(totalPages - 1, page + 1);
        else return;

        // A COLD PAGE FETCHES POSTERS - LIVE HTTP, SO DEFER FIRST (THE 3s ACK
        // WINDOW IS SHORTER THAN A SLOW TRANSCODE); attachments: [] DROPS THE
        // OUTGOING PAGE'S FILES SO THEY NEVER ACCUMULATE ON THE MESSAGE
        if (pageCache.has(page)) {
          await interaction.update({ ...renderPage(pageCache.get(page), page), attachments: [] });
        } else {
          await interaction.deferUpdate();
          await interaction.editReply({ ...renderPage(await buildPage(page), page), attachments: [] });
        }
      } catch (err) {
        core.logger.error('whatsnew pager failed:', err);
      }
    });

    // THE LIST STAYS READABLE FOREVER - ONLY THE DEAD CONTROLS COME OFF
    collector.on('end', async () => {
      const { files, ...stripped } = renderPage(pageCache.get(page), page, { pager: false });
      await message.edit(stripped).catch(() => {});
    });
  }
};
