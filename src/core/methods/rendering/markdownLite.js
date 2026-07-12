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

// PRIVATE-USE SENTINELS FENCE CODE-SPAN PLACEHOLDERS — CHAT TEXT CANT COLLIDE
const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';
const PH_PATTERN = /\uE000(\d+)\uE001/g;

function renderMarkdownLite(text) {
  if (text === null || text === undefined || text === '') return '';
  // STRAY SENTINELS IN HOSTILE INPUT GET DROPPED BEFORE THEY CAN CONFUSE US
  let out = escapeHtml(String(text).replace(/[\uE000\uE001]/g, ''));

  // CODE SPANS FIRST SO THEIR CONTENTS ESCAPE FURTHER SUBSTITUTION
  const codeSpans = [];
  out = out.replace(/`([^`\n]+)`/g, (m, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `${PH_OPEN}${codeSpans.length - 1}${PH_CLOSE}`;
  });

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

  out = out.replace(PH_PATTERN, (m, idx) => codeSpans[Number(idx)] ?? '');
  return out;
}

module.exports = { renderMarkdownLite, escapeHtml };
