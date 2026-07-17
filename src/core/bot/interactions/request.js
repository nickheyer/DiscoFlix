const { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const ui = require('./ui');
const { appEmoji, appBadge } = require('./appEmojis');
const { countRequestsSince } = require('./limits');
const { resolveForCtx } = require('./features');

// DISCORD SELECT MENUS CAP AT 25 OPTIONS - "ALL" TAKES ONE SLOT
const MAX_LISTED_SEASONS = 24;
const MAX_DETAIL_FACTS = 8;
const MAX_DETAIL_SEASON_ROWS = 12;
// COLLECTOR LIFETIME: selection_timeout IS AN IDLE TIMER (EACH CLICK RESETS
// IT - MULTI-STEP PICKS MUST NOT DIE MID-FLOW), THE HARD CAP ENDS IMMORTAL
// SESSIONS
const COLLECTOR_HARD_CAP_MS = 15 * 60 * 1000;

// ── FEATURE DESCRIPTORS ──────────────────────────────────────────────────

// ONE FEATURE PER CONTENT TYPE (request.movie / request.show / request.music)
// - THE MATRIX ROW EVERY GATE AND EXTENT FOR THAT COMMAND HANGS OFF.
// EVERYWHERE IN EXTENTS, 0 MEANS UNLIMITED.
function featureFor(contentDef) {
  const extents = [
    { key: 'max_results', label: 'Max results', type: 'number', min: 0, default: 0, userOverride: 'max_results' }
  ];
  if (contentDef.type === 'show') {
    extents.push({ key: 'max_seasons', label: 'Max seasons', type: 'number', min: 0, default: 0, userOverride: 'max_seasons_for_non_admin', adminExempt: true });
  }
  extents.push(
    { key: 'max_requests_per_day', label: 'Daily request cap', type: 'number', min: 0, default: 0, userOverride: 'max_requests_in_day', adminExempt: true },
    { key: 'selection_timeout', label: 'Selection timeout (s)', type: 'number', min: 30, max: 3600, default: 60 },
    { key: 'max_check_time', label: 'Watch duration (s)', type: 'number', min: 60, max: 3600, default: 600 }
  );
  return {
    id: `request.${contentDef.type}`,
    label: `Request ${contentDef.label}s`,
    description: `Search for and request ${contentDef.label}s with /${contentDef.slash.name}`,
    group: 'requests',
    defaultEnabled: true,
    defaultAudience: 'everyone',
    // A DENIED AUDIENCE RAISES A HAND THE CONSOLE'S USERS SECTION CAN SEE
    accessAskOnDeny: true,
    extents: extents
  };
}

// GRANTABLE REQUEST-CARD CAPABILITIES - NO SLASH COMMANDS OF THEIR OWN, THE
// FLOW RESOLVES THEM PER USER AT START AND THE CARD DEGRADES GRACEFULLY
const REQUEST_CAPABILITIES = [
  {
    id: 'request.trailers',
    label: 'Trailer links',
    description: 'Show a trailer link on request cards',
    group: 'requests',
    providers: ['discoflix'],
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: []
  },
  {
    id: 'request.details',
    label: 'Details view',
    description: 'The "More info" button - ratings, facts, season stats, and external links',
    group: 'requests',
    providers: ['discoflix'],
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: []
  },
  {
    id: 'request.fanart',
    label: 'Fanart backdrop',
    description: 'Show the wide fanart banner on the details view',
    group: 'requests',
    providers: ['discoflix'],
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: []
  },
  {
    id: 'request.availability',
    label: 'Availability badges',
    description: 'Badge every result that is already streamable, in the library, or pending',
    group: 'requests',
    providers: ['discoflix'],
    defaultEnabled: true,
    defaultAudience: 'everyone',
    extents: []
  },
  {
    id: 'request.quality-picker',
    label: 'Quality & folder picker',
    description: 'Pick the quality profile and root folder before the request is sent',
    group: 'requests',
    providers: ['discoflix'],
    defaultEnabled: true,
    defaultAudience: 'staff',
    extents: []
  },
  {
    id: 'request.auto-approve',
    label: 'Auto-approve requests',
    description: 'Requests skip the approval queue and go straight to the app',
    group: 'requests',
    providers: ['discoflix'],
    defaultEnabled: true,
    defaultAudience: 'staff',
    extents: []
  }
];

// ── CARD PIECES ──────────────────────────────────────────────────────────

function displayTitle(result) {
  return result.year ? `${result.title} (${result.year})` : result.title;
}

// LOOKUP DETAIL IS PURE CPU OVER THE RAW ALREADY IN MEMORY - MEMOIZED PER
// RESULT SO PAGING NEVER RE-NORMALIZES
function detailOf(flow, index) {
  if (!(index in flow.details)) {
    try {
      flow.details[index] = flow.client.normalizeLookupDetail(flow.results[index].raw);
    } catch (err) {
      flow.core.logger.debug(`Lookup detail normalize failed: ${err.message}`);
      flow.details[index] = null;
    }
  }
  return flow.details[index];
}

// DATES READ MM-DD-YYYY - LOOKUPS CARRY ISO-ISH STRINGS
function shortDateOf(value) {
  const match = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[2]}-${match[3]}-${match[1]}` : null;
}

// STATUS AND RELEASE DATE SHARE ONE PHRASE - THE VERB CARRIES THE STATUS:
// 'Released 06-25-1982' | 'Releases 12-19-2026' | null WHEN NO DATE
function releasePhraseOf(value, pastVerb, futureVerb) {
  const date = shortDateOf(value);
  if (!date) return null;
  const verb = new Date(String(value).slice(0, 10)).getTime() > Date.now() ? futureVerb : pastVerb;
  return `${verb} ${date}`;
}

// RATING CHIPS AS BRAND BADGES - THE SOURCE'S EMOJI MARK PLUS THE VALUE,
// HYPERLINKED TO ITS PAGE WHEN THE LOOKUP CARRIES ONE. FALLS BACK TO THE
// PLAIN 'IMDb 7.5' TEXT UNTIL AN EMOJI SYNC LANDS.
const RATING_EMOJI = {
  IMDb: 'imdb',
  TMDB: 'tmdb',
  'Rotten Tomatoes': 'rottentomatoes',
  Metacritic: 'metacritic'
};

function ratingChipsOf(detail) {
  const links = detail?.links || [];
  return (detail?.ratings || []).map(rating => {
    const icon = appEmoji(RATING_EMOJI[rating.label]);
    const url = links.find(link => link.label === rating.label)?.url;
    const value = url ? `[${rating.value}](${url})` : rating.value;
    return icon ? `${icon} ${value}` : `${rating.label} ${value}`;
  });
}

// 'A' | 'A and B' | 'A, B and C'
function joinAnd(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// EVERY SERVER THE TITLE STREAMS ON, EACH WITH ITS BRAND EMOJI
function streamingBadgesOf(servers) {
  return servers.map(server => appBadge(server.appType, server.name));
}

// AVAILABILITY BADGE + RATING CHIPS ON ONE LINE - THE CARD'S SECOND LINE.
// A STREAMING BADGE NAMES EVERY SERVER THAT HAS IT, EACH WITH ITS EMOJI.
function badgeLineOf(flow, index) {
  const entries = [];
  const badge = flow.badges?.[index];
  if (badge) {
    const label = badge.servers?.length
      ? `Available on ${streamingBadgesOf(badge.servers).join(', ')}`
      : badge.text;
    entries.push(`**${label}**`);
  }
  entries.push(...ratingChipsOf(detailOf(flow, index)));
  return entries.length ? entries.join(' · ') : null;
}

// THE SMALL META BLOCK UNDER THE OVERVIEW - THREE SHORT LINES, NOT ONE
// PACKED STRIP: GENRES / CERTIFICATION + LENGTH / RELEASE. NO STUDIO OR
// NETWORK (THE DETAILS VIEW'S FACT BLOCK KEEPS THEM); MOVIE STATUS LIVES IN
// THE RELEASE VERB, SHOW STATUS (Continuing/Ended) RIDES BESIDE THE AIR DATE.
function metaLinesOf(flow, index) {
  const result = flow.results[index];
  const detail = detailOf(flow, index);
  const lines = [];

  const genres = (detail?.genres || []).slice(0, 3).join(', ');
  if (genres) lines.push(genres);

  const spec = [];
  if (detail?.certification) spec.push(`\`${detail.certification}\``);
  if (result.contentType === 'movie') {
    if (result.runtime) spec.push(`${result.runtime} min`);
  } else if (result.contentType === 'music') {
    if (result.network) spec.push(`by ${result.network}`);
    if (result.albumType) spec.push(result.albumType);
    if (result.trackCount) spec.push(`${result.trackCount} track${result.trackCount === 1 ? '' : 's'}`);
  } else {
    if (result.seasonCount) spec.push(`${result.seasonCount} season${result.seasonCount === 1 ? '' : 's'}`);
  }
  if (spec.length) lines.push(spec.join(' • '));

  let release = null;
  if (result.contentType === 'movie') {
    release = releasePhraseOf(result.inTheaters, 'Released', 'Releases');
  } else if (result.contentType === 'music') {
    release = releasePhraseOf(result.firstAired, 'Released', 'Releases');
  } else {
    const status = detail?.status ? detail.status[0].toUpperCase() + detail.status.slice(1) : null;
    const aired = releasePhraseOf(result.firstAired, 'First aired', 'First airs');
    release = [status, aired].filter(Boolean).join(' • ') || null;
  }
  if (release) lines.push(release);

  return lines;
}

function footerOf(flow) {
  return ui.text(`-# Result ${flow.index + 1} of ${flow.results.length} • Requested by ${flow.requesterName}`);
}

function browseButtons(flow) {
  const buttons = [
    new ButtonBuilder().setCustomId('df-prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(flow.index === 0),
    new ButtonBuilder().setCustomId('df-next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(flow.index >= flow.results.length - 1)
  ];
  if (flow.features.details) {
    buttons.push(new ButtonBuilder().setCustomId('df-details').setLabel('More Info').setStyle(ButtonStyle.Secondary));
  }
  buttons.push(
    new ButtonBuilder().setCustomId('df-select').setLabel('Request This').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
  return ui.row(...buttons);
}

// JUMP-TO-RESULT SELECT - EVERY RESULT IS ONE PICK AWAY INSTEAD OF A BUTTON
// WALK. DISCORD CAPS OPTIONS AT 25; RESULTS ARE ALREADY CAPPED BY max_results
// BUT THE SLICE STAYS AS A HARD GUARD.
function jumpSelect(flow) {
  const options = flow.results.slice(0, 25).map((result, i) => {
    const badge = flow.badges?.[i];
    const description = [badge?.text, result.overview].filter(Boolean).join(' - ');
    return {
      label: ui.truncate(displayTitle(result), 100),
      description: ui.truncate(description, 100) || undefined,
      value: String(i),
      default: i === flow.index
    };
  });
  return ui.row(
    new StringSelectMenuBuilder()
      .setCustomId('df-pick')
      .setPlaceholder('Jump to a result')
      .addOptions(options)
  );
}

// THE BROWSE CARD - LARGE POSTER (SINGLE-ITEM GALLERY RENDERS BIG AND
// ASPECT-TRUE), BADGES + RATING CHIPS, OVERVIEW, META STRIP, CONTROLS
function browsePayload(flow) {
  const result = flow.results[flow.index];
  const parts = [];
  if (result.posterUrl) parts.push(ui.gallery([result.posterUrl]));
  parts.push(ui.text(`### ${displayTitle(result)}`));
  const badgeLine = badgeLineOf(flow, flow.index);
  if (badgeLine) parts.push(ui.text(badgeLine));
  if (result.overview) parts.push(ui.text(ui.truncate(result.overview, 350)));
  // WITH NO DETAILS VIEW TO HOLD IT, THE TRAILER LINK STAYS INLINE
  if (!flow.features.details && flow.features.trailers && result.trailerUrl) {
    parts.push(ui.text(`[Watch the trailer](${result.trailerUrl})`));
  }
  const meta = metaLinesOf(flow, flow.index);
  if (meta.length) parts.push(ui.text(meta.map(line => `-# ${line}`).join('\n')));
  parts.push(ui.separator());
  if (flow.results.length > 1) parts.push(jumpSelect(flow));
  parts.push(browseButtons(flow));
  parts.push(footerOf(flow));
  return ui.payload(ui.container(parts));
}

// IN-LIBRARY SHOWS RENDER REAL PER-SEASON STATS (FETCHED LAZILY ON ENTRY);
// LOOKUP-ONLY SHOWS GET THE HONEST ONE-LINER - LOOKUPS CARRY NO SEASON STATS
function seasonBlockOf(flow, index) {
  const result = flow.results[index];
  if (result.contentType !== 'show') return null;
  const library = flow.libraryDetails[index];
  if (library?.seasons?.length) {
    const rows = library.seasons.slice(0, MAX_DETAIL_SEASON_ROWS).map(season => {
      const total = season.totalEpisodeCount || season.episodeCount || 0;
      const size = season.size ? ` • ${season.size}` : '';
      return `${season.label} - ${season.episodeFileCount}/${total} episodes${size}`;
    });
    const more = library.seasons.length > MAX_DETAIL_SEASON_ROWS
      ? `\n-# ...and ${library.seasons.length - MAX_DETAIL_SEASON_ROWS} more`
      : '';
    return `**Seasons**\n${rows.join('\n')}${more}`;
  }
  return result.seasonCount ? `**Seasons** ${result.seasonCount}` : null;
}

function detailLinksOf(flow, index) {
  const result = flow.results[index];
  const detail = detailOf(flow, index);
  const links = [...(detail?.links || [])];
  if (flow.features.trailers && result.trailerUrl && !links.some(link => link.label === 'Trailer')) {
    links.push({ label: 'Trailer', url: result.trailerUrl });
  }
  return links;
}

// THE DETAILS VIEW - FANART BANNER, POSTER-THUMBED HEADLINE, LONG OVERVIEW,
// FACT BLOCK, SEASON STATS, AND LINK-OUT BUTTONS
function detailsPayload(flow) {
  const result = flow.results[flow.index];
  const detail = detailOf(flow, flow.index);
  const parts = [];
  if (flow.features.fanart && detail?.fanartUrl) parts.push(ui.gallery([detail.fanartUrl]));

  const headLines = [`### ${displayTitle(result)}`];
  const badgeLine = badgeLineOf(flow, flow.index);
  if (badgeLine) headLines.push(badgeLine);
  const sub = [
    (detail?.genres || []).slice(0, 3).join(', '),
    detail?.certification ? `\`${detail.certification}\`` : null,
    detail?.runtime
  ].filter(Boolean).join(' • ');
  if (sub) headLines.push(`-# ${sub}`);
  if (result.posterUrl) parts.push(ui.section(headLines, result.posterUrl));
  else parts.push(...headLines.map(line => ui.text(line)));

  if (result.overview) parts.push(ui.text(ui.truncate(result.overview, 1000)));
  const facts = ui.factLines(detail?.facts, { max: MAX_DETAIL_FACTS });
  if (facts.length) parts.push(ui.text(facts.join('\n')));
  const seasonBlock = seasonBlockOf(flow, flow.index);
  if (seasonBlock) parts.push(ui.text(seasonBlock));

  parts.push(ui.separator());
  const linkRow = ui.linkButtonRow(detailLinksOf(flow, flow.index));
  if (linkRow) parts.push(linkRow);
  parts.push(ui.row(
    new ButtonBuilder().setCustomId('df-back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('df-select').setLabel('Request This').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  ));
  parts.push(footerOf(flow));
  return ui.payload(ui.container(parts));
}

// SHOWS WITH MORE THAN ONE SEASON GET A PICKER STEP BEFORE THE REQUEST LANDS
function needsSeasonPick(result) {
  return result.contentType === 'show' && (result.seasonCount || 0) > 1;
}

function seasonPayload(flow) {
  const result = flow.results[flow.index];
  // THE RAW LOOKUP CARRIES THE REAL SEASON LIST - SPECIALS EXCLUDED, GAPS AND
  // PER-SEASON STATS HONORED; THE 1..N SYNTHESIS ONLY BACKSTOPS BARE RESULTS
  const realSeasons = (result.raw?.seasons || []).filter(season => season.seasonNumber > 0);
  const seasons = realSeasons.length
    ? realSeasons
    : Array.from({ length: result.seasonCount || 0 }, (_, i) => ({ seasonNumber: i + 1 }));
  const listed = seasons.slice(0, MAX_LISTED_SEASONS);
  const totalEpisodes = seasons.reduce(
    (sum, season) => sum + (season.statistics?.totalEpisodeCount || season.statistics?.episodeCount || 0), 0
  );
  const options = [{
    label: 'All seasons',
    value: 'all',
    description: [
      `Every season (${seasons.length} total)`,
      totalEpisodes ? `${totalEpisodes} episodes` : null
    ].filter(Boolean).join(' • ')
  }];
  for (const season of listed) {
    const stats = season.statistics || {};
    const total = stats.totalEpisodeCount || stats.episodeCount || 0;
    const bits = [];
    if (total) bits.push(`${total} episode${total === 1 ? '' : 's'}`);
    if (total && result.libraryId) bits.push(`${stats.episodeFileCount || 0} on disk`);
    options.push({
      label: `Season ${season.seasonNumber}`,
      value: String(season.seasonNumber),
      description: bits.join(' • ') || undefined
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('df-seasons')
    .setPlaceholder('Pick the seasons you want')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);

  const parts = [];
  if (result.posterUrl) parts.push(ui.gallery([result.posterUrl]));
  parts.push(ui.text(`### ${displayTitle(result)}`));
  const badgeLine = badgeLineOf(flow, flow.index);
  if (badgeLine) parts.push(ui.text(badgeLine));
  parts.push(
    ui.separator(),
    ui.row(select),
    ui.row(
      new ButtonBuilder().setCustomId('df-back').setLabel('Back').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
    ),
    footerOf(flow)
  );
  return ui.payload(ui.container(parts));
}

// ── OPTIONS (QUALITY/ROOT PICKER) ────────────────────────────────────────

// SERVER OPTION LISTS FETCHED ONCE PER FLOW, ONLY WHEN THE PICKER IS ENTERED
async function loadAddOptions(flow) {
  if (flow.addOptions) return flow.addOptions;
  flow.addOptions = await flow.client.getAddOptions();
  return flow.addOptions;
}

function pickedQualityId(flow) {
  const profiles = flow.addOptions?.profiles || [];
  if (flow.picks.qualityProfileId && profiles.some(profile => profile.id === flow.picks.qualityProfileId)) {
    return flow.picks.qualityProfileId;
  }
  const wanted = Number(flow.client.instanceSettings.quality_profile);
  return profiles.find(profile => profile.id === wanted)?.id ?? profiles[0]?.id ?? null;
}

function pickedRootPath(flow) {
  const roots = flow.addOptions?.rootFolders || [];
  if (flow.picks.rootFolderPath && roots.some(root => root.path === flow.picks.rootFolderPath)) {
    return flow.picks.rootFolderPath;
  }
  const wanted = flow.client.instanceSettings.root_folder;
  return roots.find(root => root.path === wanted)?.path ?? roots[0]?.path ?? null;
}

function pickedMetadataId(flow) {
  const profiles = flow.addOptions?.metadataProfiles || [];
  if (!profiles.length) return null;
  if (flow.picks.metadataProfileId && profiles.some(profile => profile.id === flow.picks.metadataProfileId)) {
    return flow.picks.metadataProfileId;
  }
  const wanted = Number(flow.client.instanceSettings.metadata_profile);
  return profiles.find(profile => profile.id === wanted)?.id ?? profiles[0]?.id ?? null;
}

// ONE CARD IS BOTH PICKER AND CONFIRM STEP - SELECTS DEFAULT TO THE INSTANCE
// SETTINGS SO "JUST HIT CONFIRM" EQUALS TODAY'S AUTOMATIC BEHAVIOR
function optionsPayload(flow) {
  const result = flow.results[flow.index];
  const lines = [`### Requesting: ${displayTitle(result)}`];
  if (flow.seasons) lines.push(`-# Season${flow.seasons.length === 1 ? '' : 's'} ${flow.seasons.join(', ')}`);
  lines.push(`-# Sends to ${appBadge(flow.instance.app_type, flow.instance.display_name)}`);

  const parts = [];
  if (result.posterUrl) parts.push(ui.section(lines, result.posterUrl));
  else parts.push(...lines.map(line => ui.text(line)));
  parts.push(ui.separator());

  const qualityId = pickedQualityId(flow);
  parts.push(ui.row(new StringSelectMenuBuilder()
    .setCustomId('df-quality')
    .setPlaceholder('Quality profile')
    .addOptions((flow.addOptions.profiles || []).slice(0, 25).map(profile => ({
      label: ui.truncate(profile.name, 100),
      value: String(profile.id),
      default: profile.id === qualityId
    })))));

  const rootPath = pickedRootPath(flow);
  parts.push(ui.row(new StringSelectMenuBuilder()
    .setCustomId('df-root')
    .setPlaceholder('Root folder')
    .addOptions((flow.addOptions.rootFolders || []).slice(0, 25).map(root => ({
      label: ui.truncate(root.path, 100),
      description: root.freeSpace ? `${flow.client.constructor.humanSize(root.freeSpace)} free` : undefined,
      value: root.path,
      default: root.path === rootPath
    })))));

  if (flow.addOptions.metadataProfiles?.length) {
    const metadataId = pickedMetadataId(flow);
    parts.push(ui.row(new StringSelectMenuBuilder()
      .setCustomId('df-metadata')
      .setPlaceholder('Metadata profile')
      .addOptions(flow.addOptions.metadataProfiles.slice(0, 25).map(profile => ({
        label: ui.truncate(profile.name, 100),
        value: String(profile.id),
        default: profile.id === metadataId
      })))));
  }

  parts.push(ui.row(
    new ButtonBuilder().setCustomId('df-confirm').setLabel('Confirm Request').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('df-back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('df-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  ));
  parts.push(ui.text('-# Leave the selects as-is to use the server defaults'));
  return ui.payload(ui.container(parts));
}

// ONE DISPATCHER MAPS VIEW STATE -> PAYLOAD; EVERY COLLECTOR CASE MUTATES
// flow AND RE-RENDERS THROUGH IT
function renderView(flow) {
  switch (flow.view) {
    case 'details': return detailsPayload(flow);
    case 'seasons': return seasonPayload(flow);
    case 'options': return optionsPayload(flow);
    default: return browsePayload(flow);
  }
}

// OUTCOME CARD - THE HEADLINE KEEPS THE POSTER THUMB SO THE CHANNEL READS AT
// A GLANCE (RECEIPTS STAY COMPACT - THE BROWSE CARD WAS THE SIZE PROBLEM)
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

// ── FULFILLMENT ──────────────────────────────────────────────────────────

// VALIDATE -> ADD -> RECORD MEDIA/MEDIA-REQUEST -> HAND TO QUEUE WATCH.
// flow.seasons null = ALL / NOT A SHOW; flow.picks CARRIES QUALITY/ROOT
// OVERRIDES WHEN THE PICKER RAN (EMPTY = INSTANCE DEFAULTS, TODAY'S PATH).
async function finalizeSelection(interaction, flow) {
  const { core, config, dbUser, client, instance } = flow;
  const result = flow.results[flow.index];
  const seasons = flow.seasons;
  const name = displayTitle(result);
  // A DEFERRED INTERACTION (FAILED OPTIONS FETCH) MUST EDIT, NOT UPDATE
  const redraw = (payload) => interaction.deferred ? interaction.editReply(payload) : interaction.update(payload);

  // THE PICKED COUNT IS WHAT LIMITS APPLY TO - PICKING FEWER SEASONS IS THE
  // WAY UNDER THE CAP FOR BIG SHOWS. staff+ ARE EXEMPT (THE RESOLVER ZEROES
  // THE EXTENT FOR THEM).
  const seasonLimit = Number(flow.extents.max_seasons) || 0;
  const effectiveSeasonCount = seasons ? seasons.length : (result.seasonCount || 0);
  if (seasonLimit > 0 && effectiveSeasonCount > seasonLimit) {
    await redraw(ui.notice(
      `That show has ${effectiveSeasonCount} seasons - you can only request shows with up to ${seasonLimit}.`,
      { accent: 'danger' }
    ));
    return;
  }

  await redraw(ui.notice(`Working on **${name}**...`));

  // ALREADY STREAMABLE? EVERY CONNECTED MEDIA SERVER ANSWERS BEFORE ANYTHING
  // IS REQUESTED - THE CARD NAMES EACH ONE THAT HAS IT (NEVER JUST THE
  // FIRST). GUARDED, A DEAD SERVER MUST NEVER BLOCK THE FLOW. BADGES ARE
  // ADVISORY; THIS CHECK STAYS AUTHORITATIVE.
  try {
    const streaming = await core.apps.findOnMediaServers(result);
    if (streaming.length) {
      const where = joinAnd(streaming.map(match =>
        `**${appBadge(match.instance.app_type, match.instance.display_name)}**`
      ));
      await flow.channel.send(outcomeCard(result, `**${name}** is already on ${where} - go stream it!`, 'ok'));
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

  // AUTO-APPROVED REQUESTS GO STRAIGHT TO THE APP (staff+ BY DEFAULT, BUT
  // THE MATRIX CAN GRANT IT TO ANY AUDIENCE OR ROLE)
  if (flow.features.autoApprove) {
    const added = await client.add(result, { seasons, ...flow.picks });
    const media = await core.models.media.upsertFromResult(result, added);
    const request = await createRequestRow(core, flow, media, true, added.id, seasons);

    core.apps.watchRequest({
      requestId: request.id,
      appId: instance.id,
      arrId: added.id,
      mediaId: media.id,
      title: name,
      channelId: flow.channel.id,
      requesterIds: [dbUser.id],
      featureId: `request.${flow.contentType}`,
      serverId: flow.guildId
    });

    const pickNote = flow.picks.qualityProfileId || flow.picks.rootFolderPath
      ? pickSummaryOf(flow)
      : null;
    core.logger.info(`Media request created: ${name}${seasonNote} (${instance.display_name}) by ${dbUser.username}`);
    const sent = await flow.channel.send(outcomeCard(
      result,
      `**${name}**${seasonNote} has been requested.`,
      'ok',
      [`Sent to ${appBadge(instance.app_type, instance.display_name)}`, pickNote, 'Updates will land here as it downloads'].filter(Boolean).join(' • ')
    ));
    // SLASH FLOWS HAVE NO TRIGGERING USER MESSAGE - THE OUTCOME CARD (WHICH
    // MIRRORS LIKE ANY BOT MESSAGE) BECOMES THE JUMP ANCHOR. refreshUI BELOW
    // RUNS AFTER THE STAMP, SO THE MIRRORED CARD ROW PICKS IT UP.
    if (!flow.messageId && sent) {
      await core.models.mediaRequest.stampAnchor(request.id, sent.id);
    }
  } else {
    const media = await core.models.media.upsertFromResult(result);
    const request = await createRequestRow(core, flow, media, null, null, seasons);
    core.logger.info(`Media request pending approval: ${name}${seasonNote} (${instance.display_name}) by ${dbUser.username}`);
    const sent = await flow.channel.send(outcomeCard(
      result,
      `**${name}**${seasonNote} has been submitted for approval.`,
      'brand',
      'An admin will review it - updates will land here'
    ));
    if (!flow.messageId && sent) {
      await core.models.mediaRequest.stampAnchor(request.id, sent.id);
    }
  }
  core.discord.refreshUI().catch(() => {}); // UPDATE CHAT-MIRROR CARDS
}

function pickSummaryOf(flow) {
  const parts = [];
  const profile = (flow.addOptions?.profiles || []).find(p => p.id === flow.picks.qualityProfileId);
  if (profile) parts.push(`Quality: ${profile.name}`);
  if (flow.picks.rootFolderPath) parts.push(`Root: ${flow.picks.rootFolderPath}`);
  return parts.join(' • ') || null;
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

// ── THE FLOW BODY ────────────────────────────────────────────────────────

// SELECTION ROUTING: SEASON PICK (SHOWS) -> QUALITY/ROOT PICKER (WHEN
// GRANTED) -> FINALIZE. THE PICKER'S OPTION LISTS ARE LIVE HTTP, SO ENTRY
// DEFERS FIRST AND FALLS THROUGH TO DEFAULTS IF THE ARR WON'T ANSWER.
async function nextAfterSelect(interaction, flow, collector) {
  if (flow.features.qualityPicker) {
    if (!flow.addOptions) {
      await interaction.deferUpdate();
      try {
        await loadAddOptions(flow);
      } catch (err) {
        flow.core.logger.warn(`Add options fetch failed, using defaults: ${err.message}`);
      }
    }
    if (flow.addOptions) {
      flow.view = 'options';
      if (interaction.deferred) await interaction.editReply(renderView(flow));
      else await interaction.update(renderView(flow));
      return;
    }
  }
  collector.stop('handled');
  await finalizeSelection(interaction, flow);
}

// THE FLOW BODY SHARED BY PREFIX AND SLASH - THE DISPATCHER ALREADY GATED
// THE FEATURE (ctx.feature CARRIES ITS EXTENTS) AND RESOLVED dbUser
async function runRequest(ctx, contentDef) {
  const { core, config, dbUser, discordUser, send } = ctx;
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
    const extents = ctx.feature?.extents || {};

    // DAILY CAP - AN EXTENT NOW (staff+ EXEMPT VIA adminExempt)
    const dailyLimit = Number(extents.max_requests_per_day) || 0;
    if (dailyLimit > 0) {
      const recentCount = await countRequestsSince(core, dbUser);
      if (recentCount >= dailyLimit) {
        await send(ui.notice(
          `You've hit your limit of ${dailyLimit} request${dailyLimit === 1 ? '' : 's'} per day - try again later.`,
          { accent: 'danger' }
        ));
        return;
      }
    }

    let results = await client.search(title);
    const maxResults = Number(extents.max_results) || 0;
    if (maxResults > 0) results = results.slice(0, maxResults);
    if (!results.length) {
      await send(ui.notice(`No ${label} results found for **${title}**.`, { accent: 'warn' }));
      return;
    }

    // GRANTABLE CARD CAPABILITIES, RESOLVED ONCE PER FLOW
    const [trailers, details, fanart, availability, qualityPicker, autoApprove] = await Promise.all([
      resolveForCtx(ctx, 'request.trailers'),
      resolveForCtx(ctx, 'request.details'),
      resolveForCtx(ctx, 'request.fanart'),
      resolveForCtx(ctx, 'request.availability'),
      resolveForCtx(ctx, 'request.quality-picker'),
      resolveForCtx(ctx, 'request.auto-approve')
    ]);

    const flow = {
      core, config, dbUser, client, instance, results,
      contentType: contentDef.type,
      title,
      requesterName: discordUser.displayName,
      guildId: ctx.guildId,
      channel: ctx.channel,
      origContent: ctx.origContent,
      messageId: ctx.messageId || null,
      extents,
      features: {
        trailers: trailers.allowed,
        details: details.allowed,
        fanart: fanart.allowed,
        availability: availability.allowed,
        qualityPicker: qualityPicker.allowed,
        autoApprove: autoApprove.allowed
      },
      view: 'browse',
      index: 0,
      details: {},
      libraryDetails: {},
      badges: null,
      addOptions: null,
      seasons: null,
      picks: {}
    };

    // AVAILABILITY BADGES - CACHE-BACKED AND RACED SO A COLD MEDIA-SERVER
    // LIBRARY NEVER DELAYS FIRST PAINT; THE MEMOIZED RESULT LANDS ON THE
    // NEXT RE-RENDER
    if (flow.features.availability) {
      const badgesPromise = core.apps.annotateAvailability(results, client)
        .then(badges => { flow.badges = badges; return badges; })
        .catch(err => {
          core.logger.debug(`Availability badges skipped: ${err.message}`);
          return null;
        });
      await Promise.race([badgesPromise, new Promise(resolve => setTimeout(resolve, 1500))]);
    }

    const selectionTimeout = Number(extents.selection_timeout) || 60;
    const message = await send(renderView(flow));
    const collector = message.createMessageComponentCollector({
      idle: selectionTimeout * 1000,
      time: COLLECTOR_HARD_CAP_MS
    });

    collector.on('collect', async (interaction) => {
      try {
        if (interaction.user.id !== discordUser.id) {
          await interaction.reply(ui.notice('This selection belongs to someone else - start your own request.', { accent: 'danger', ephemeral: true }));
          return;
        }
        const result = flow.results[flow.index];
        switch (interaction.customId) {
          case 'df-prev':
            flow.index = Math.max(0, flow.index - 1);
            flow.view = 'browse';
            await interaction.update(renderView(flow));
            break;
          case 'df-next':
            flow.index = Math.min(results.length - 1, flow.index + 1);
            flow.view = 'browse';
            await interaction.update(renderView(flow));
            break;
          case 'df-pick':
            flow.index = Math.max(0, Math.min(results.length - 1, Number(interaction.values[0]) || 0));
            flow.view = 'browse';
            await interaction.update(renderView(flow));
            break;
          case 'df-details': {
            // DEFENSE IN DEPTH - THE BUTTON ONLY RENDERS WHEN GRANTED, BUT A
            // STALE MESSAGE CAN STILL DELIVER THE CLICK
            if (!flow.features.details) {
              await interaction.reply(ui.notice("You don't have access to the details view here.", { accent: 'danger', ephemeral: true }));
              break;
            }
            // IN-LIBRARY SHOWS FETCH REAL SEASON STATS - LIVE HTTP, SO DEFER
            // FIRST (THE 3s ACK WINDOW IS SHORTER THAN A SLOW ARR)
            if (result.contentType === 'show' && result.libraryId && !(flow.index in flow.libraryDetails)) {
              await interaction.deferUpdate();
              try {
                flow.libraryDetails[flow.index] = await client.getLibraryItemDetail(result.libraryId);
              } catch (err) {
                core.logger.debug(`Library detail fetch failed: ${err.message}`);
                flow.libraryDetails[flow.index] = null;
              }
              flow.view = 'details';
              await interaction.editReply(renderView(flow));
              break;
            }
            flow.view = 'details';
            await interaction.update(renderView(flow));
            break;
          }
          case 'df-back':
            // VIEW-AWARE: THE PICKER BACKS OUT TO THE SEASON STEP WHEN ONE
            // HAPPENED, EVERYTHING ELSE RETURNS TO BROWSE
            flow.view = flow.view === 'options' && needsSeasonPick(result) ? 'seasons' : 'browse';
            await interaction.update(renderView(flow));
            break;
          case 'df-cancel':
            collector.stop('handled');
            await interaction.update(ui.notice('Request cancelled.'));
            break;
          case 'df-select':
            // SHOWS DETOUR THROUGH THE SEASON PICKER - THE COLLECTOR STAYS UP
            if (needsSeasonPick(result)) {
              flow.view = 'seasons';
              await interaction.update(renderView(flow));
              break;
            }
            flow.seasons = null;
            await nextAfterSelect(interaction, flow, collector);
            break;
          case 'df-seasons':
            flow.seasons = parseSeasonValues(interaction.values);
            await nextAfterSelect(interaction, flow, collector);
            break;
          case 'df-quality':
            flow.picks.qualityProfileId = Number(interaction.values[0]) || null;
            await interaction.update(renderView(flow));
            break;
          case 'df-root':
            flow.picks.rootFolderPath = interaction.values[0] || null;
            await interaction.update(renderView(flow));
            break;
          case 'df-metadata':
            flow.picks.metadataProfileId = Number(interaction.values[0]) || null;
            await interaction.update(renderView(flow));
            break;
          case 'df-confirm':
            collector.stop('handled');
            await finalizeSelection(interaction, flow);
            break;
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
    // PROVIDER ATTRIBUTION FOR THE FEATURE MATRIX (radarr/sonarr/lidarr)
    appTypes: contentDef.appTypes,
    feature: featureFor(contentDef),
    async available(core) {
      return (await core.apps.enabledContentTypes()).includes(contentDef.type);
    },
    run: (ctx) => runRequest(ctx, contentDef)
  };
}

module.exports = { requestInteractionFor, REQUEST_CAPABILITIES };
