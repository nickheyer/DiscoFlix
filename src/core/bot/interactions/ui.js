const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SeparatorSpacingSize
} = require('discord.js');

// EVERY BOT-AUTHORED SURFACE IS A COMPONENTS V2 CONTAINER - ONE VISUAL SYSTEM
// FOR PICKERS, NOTICES, STATUS, AND MONITOR UPDATES. NO CONTENT/EMBEDS EVER.
const ACCENTS = {
  brand: 0x5865f2,
  ok: 0x3ba55c,
  warn: 0xfaa61a,
  danger: 0xed4245
};

const PROGRESS_CELLS = 12;

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

function separator({ large = false, divider = true } = {}) {
  return new SeparatorBuilder()
    .setDivider(divider)
    .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
}

// TEXT LINES WITH AN OPTIONAL POSTER RIDING THE RIGHT EDGE
function section(lines, thumbnailUrl = null) {
  const built = new SectionBuilder().addTextDisplayComponents(lines.map(text));
  if (thumbnailUrl) built.setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl));
  return built;
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function gallery(urls) {
  return new MediaGalleryBuilder().addItems(
    urls.slice(0, 10).map(url => new MediaGalleryItemBuilder().setURL(url))
  );
}

// ORDER-PRESERVING ASSEMBLY - THE CONTAINER API IS TYPED PER PART KIND
function container(parts, accent = 'brand') {
  const built = new ContainerBuilder();
  if (accent !== null) built.setAccentColor(ACCENTS[accent] ?? accent);
  for (const part of parts) {
    if (!part) continue;
    if (part instanceof TextDisplayBuilder) built.addTextDisplayComponents(part);
    else if (part instanceof SectionBuilder) built.addSectionComponents(part);
    else if (part instanceof SeparatorBuilder) built.addSeparatorComponents(part);
    else if (part instanceof ActionRowBuilder) built.addActionRowComponents(part);
    else if (part instanceof MediaGalleryBuilder) built.addMediaGalleryComponents(part);
    else throw new Error('Unsupported container part');
  }
  return built;
}

// THE ONLY WAY A PAYLOAD LEAVES THIS MODULE - THE V2 FLAG IS NEVER OPTIONAL
function payload(containers, { ephemeral = false } = {}) {
  let flags = MessageFlags.IsComponentsV2;
  if (ephemeral) flags |= MessageFlags.Ephemeral;
  return {
    components: Array.isArray(containers) ? containers : [containers],
    flags
  };
}

// ONE-CONTAINER MESSAGE: AN OPTIONAL HEADING, BODY LINES, OPTIONAL SUBTEXT
function notice(lines, { accent = 'brand', title = null, subtext = null, ephemeral = false } = {}) {
  const parts = [];
  if (title) parts.push(text(`### ${title}`));
  parts.push(...[].concat(lines).map(line => text(line)));
  if (subtext) parts.push(text(`-# ${subtext}`));
  return payload(container(parts, accent), { ephemeral });
}

function progressBar(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const filled = Math.round((clamped / 100) * PROGRESS_CELLS);
  return `\`${'█'.repeat(filled)}${'░'.repeat(PROGRESS_CELLS - filled)}\` ${clamped}%`;
}

// COMPACT RELATIVE AGE FOR FEED-STYLE LINES
function ageOf(timestamp) {
  if (!timestamp) return null;
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.max(1, Math.floor(minutes))}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  const days = Math.floor(minutes / (60 * 24));
  return days < 365 ? `${days}d ago` : `${(days / 365).toFixed(1)}y ago`;
}

function truncate(value, max) {
  const str = String(value || '');
  return str.length > max ? `${str.slice(0, max - 3)}...` : str;
}

// LINK-OUT BUTTONS FROM [{ label, url }] - NO CUSTOM IDS, NEVER HIT A
// COLLECTOR. DISCORD CAPS ROWS AT 5 BUTTONS.
function linkButtonRow(links) {
  const buttons = (links || []).slice(0, 5).map(link =>
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(truncate(link.label, 80)).setURL(link.url)
  );
  return buttons.length ? row(...buttons) : null;
}

// BOLD-LABEL FACT LINES FROM [{ label, value }] - THE DETAIL VIEWS' FACT BLOCK
function factLines(facts, { max = 8 } = {}) {
  return (facts || []).slice(0, max).map(fact => `**${fact.label}** ${fact.value}`);
}

module.exports = {
  ACCENTS,
  text,
  separator,
  section,
  row,
  gallery,
  container,
  payload,
  notice,
  progressBar,
  ageOf,
  truncate,
  linkButtonRow,
  factLines
};
