// MINIMAL DISCORD-MARKDOWN RENDERER FOR THE CHAT MIRROR.
// INPUT IS DISCORD-CONTROLLED TEXT: EVERYTHING IS HTML-ESCAPED FIRST, THEN A
// SMALL TAG WHITELIST IS SUBSTITUTED IN. NO RAW INPUT EVER REACHES THE OUTPUT.

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// ONLY http(s) LINKS RENDER AS ANCHORS; ANYTHING ELSE STAYS PLAIN TEXT
const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s<)]+)\)/g;
const BARE_URL = /(^|[^"=>])(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

// DISCORD ENTITY SYNTAX, MATCHED POST-ESCAPE (SO < IS &lt; AND & IS &amp;)
const USER_MENTION = /&lt;@!?(\d+)&gt;/g;
const ROLE_MENTION = /&lt;@&amp;(\d+)&gt;/g;
const CHANNEL_MENTION = /&lt;#(\d+)&gt;/g;
const CUSTOM_EMOJI = /&lt;(a?):([\w~-]+):(\d+)&gt;/g;
// LEADING BOUNDARY KEEPS EMAILS/URLS (user@here.com) OUT OF THE PILL
const AT_BROADCAST = /(^|[^\w.@])@(everyone|here)\b/g;

// PRIVATE-USE SENTINELS FENCE CODE-SPAN PLACEHOLDERS - CHAT TEXT CANT COLLIDE
const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';
const PH_PATTERN = /\uE000(\d+)\uE001/g;

// ROLE PILLS TINT WITH THE ROLE'S COLOR LIKE DISCORD - #rrggbb TO "r, g, b"
function hexToRgb(hex) {
  const parsed = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!parsed) return null;
  const num = parseInt(parsed[1], 16);
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

// ctx IS THE OPTIONAL MENTION RESOLUTION MAP (discord.mentionContextFor):
// { users: {id: name}, channels: {id: name}, roles: {id: {name, color}} }.
// UNRESOLVED IDS STILL PILL AS @unknown-user/#unknown/@unknown-role -
// ESCAPED SNOWFLAKE SOUP NEVER REACHES THE CHAT AGAIN.
function renderMarkdownLite(text, ctx) {
  if (text === null || text === undefined || text === '') return '';
  const users = (ctx && ctx.users) || {};
  const channels = (ctx && ctx.channels) || {};
  const roles = (ctx && ctx.roles) || {};

  // STRAY SENTINELS IN HOSTILE INPUT GET DROPPED BEFORE THEY CAN CONFUSE US
  let out = escapeHtml(String(text).replace(/[\uE000\uE001]/g, ''));

  // CODE SPANS FIRST SO THEIR CONTENTS ESCAPE FURTHER SUBSTITUTION
  const codeSpans = [];
  const fence = (html) => {
    codeSpans.push(html);
    return `${PH_OPEN}${codeSpans.length - 1}${PH_CLOSE}`;
  };
  out = out.replace(/`([^`\n]+)`/g, (m, code) => fence(`<code>${code}</code>`));

  // ENTITY PILLS RIDE THE SAME FENCE - RESOLVED NAMES ARE USER-CHOSEN TEXT
  // AND MUST NEVER FEED THE MARKDOWN PASSES BELOW ("__nick__" STAYS A NAME).
  // RESOLVED USER PILLS OPEN THE SAME PROFILE MODAL AUTHOR NAMES DO.
  out = out.replace(USER_MENTION, (m, id) => {
    const name = users[id];
    if (!name) return fence('<span class="chatMention">@unknown-user</span>');
    return fence(
      `<span class="chatMention chatMentionUser" role="button" tabindex="0"`
      + ` hx-get="/user/${id}/profile" hx-target="#modals-here"`
      + ` hx-trigger="click, keyup[key=='Enter']"`
      + ` data-bs-toggle="modal" data-bs-target="#modals-here">@${escapeHtml(name)}</span>`
    );
  });
  out = out.replace(ROLE_MENTION, (m, id) => {
    const role = roles[id];
    if (!role) return fence('<span class="chatMention">@unknown-role</span>');
    const rgb = role.color ? hexToRgb(role.color) : null;
    const tint = rgb ? ` style="color: rgb(${rgb}); background-color: rgba(${rgb}, 0.1);"` : '';
    return fence(`<span class="chatMention"${tint}>@${escapeHtml(role.name)}</span>`);
  });
  out = out.replace(CHANNEL_MENTION, (m, id) => fence(
    `<span class="chatMention">#${escapeHtml(channels[id] || 'unknown')}</span>`
  ));
  out = out.replace(CUSTOM_EMOJI, (m, animated, name, id) => fence(
    `<img class="chatEmoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=48"`
    + ` alt=":${name}:" title=":${name}:" loading="lazy">`
  ));
  out = out.replace(AT_BROADCAST, (m, lead, scope) => `${lead}${fence(`<span class="chatMention">@${scope}</span>`)}`);

  // [label](https://url) BEFORE BARE URLS SO HREFS DONT DOUBLE-LINK
  out = out.replace(MD_LINK, (m, label, url) => {
    const href = url.replace(/"/g, '%22');
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(BARE_URL, (m, lead, url) => {
    const href = url.replace(/"/g, '%22');
    return `${lead}<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // UNDERLINE BEFORE ITALIC SO __x__ DOESNT PARSE AS TWO ITALICS
  out = out
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^a-zA-Z0-9_])_([^_\n]+)_(?![a-zA-Z0-9_])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // LINE-LEVEL FORMS - HEADINGS AND -# SUBTEXT ARRIVE FROM THE BOT'S
  // COMPONENTS V2 SURFACES AND RENDER LIKE DISCORD DOES
  out = out.split('\n').map(line => {
    const heading = line.match(/^(#{1,3}) (.+)$/);
    if (heading) return `<span class="mdHeading mdH${heading[1].length}">${heading[2]}</span>`;
    const subtext = line.match(/^-# (.+)$/);
    if (subtext) return `<span class="mdSubtext">${subtext[1]}</span>`;
    return line;
  }).join('\n');

  out = out.replace(PH_PATTERN, (m, idx) => codeSpans[Number(idx)] ?? '');
  return out;
}

module.exports = { renderMarkdownLite, escapeHtml };
