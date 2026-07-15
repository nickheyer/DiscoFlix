const path = require('path');
const fs = require('fs');

// APP BRAND ICONS AS DISCORD APPLICATION EMOJIS - THE ONLY WAY A CV2 TEXT
// LINE CARRIES AN INLINE ICON. SYNCED ON ClientReady FROM PNGS RASTERIZED
// OUT OF THE CONSOLE'S SVG SET; RENDER SITES FALL BACK TO PLAIN TEXT WHEN
// THE SYNC NEVER LANDED.
const EMOJI_PREFIX = 'df_';
const ASSET_DIR = path.join(__dirname, '..', '..', '..', '..', 'public', 'images', 'emoji');

const _emojiByType = new Map();

async function syncAppEmojis(client, logger) {
  let files;
  try {
    files = fs.readdirSync(ASSET_DIR).filter(file => file.endsWith('.png'));
  } catch (err) {
    logger?.warn(`App emoji assets unreadable: ${err.message}`);
    return;
  }
  let existing;
  try {
    existing = await client.application.emojis.fetch();
  } catch (err) {
    logger?.warn(`App emoji fetch failed: ${err.message}`);
    return;
  }
  const byName = new Map(existing.map(emoji => [emoji.name, emoji]));
  for (const file of files) {
    const appType = file.slice(0, -'.png'.length);
    const name = `${EMOJI_PREFIX}${appType}`;
    try {
      const emoji = byName.get(name)
        || await client.application.emojis.create({ attachment: path.join(ASSET_DIR, file), name });
      _emojiByType.set(appType, `<:${emoji.name}:${emoji.id}>`);
    } catch (err) {
      logger?.warn(`App emoji '${name}' sync failed: ${err.message}`);
    }
  }
}

// INLINE MARKUP FOR ONE APP TYPE - null WHEN NO EMOJI IS AVAILABLE
function appEmoji(appType) {
  return _emojiByType.get(appType) || null;
}

module.exports = { syncAppEmojis, appEmoji };
