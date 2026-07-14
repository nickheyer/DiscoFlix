// RECENTLY ADDED TITLES ACROSS EVERY SERVING MEDIA SERVER - THE SAME
// NORMALIZED HISTORY FEED THE CONSOLE ACTIVITY RAIL READS, ANSWERED IN
// DISCORD. SHARED BY PLEX/EMBY/JELLYFIN MANIFESTS; INSTANCES ARE POOLED.
const ROWS_PER_SERVER = 8;

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

    const parts = [];
    for (const instance of instances) {
      const feed = await core.apps.getFeedViewModel(instance);
      const rows = (feed.rows || []).filter(row => row.kind === 'added').slice(0, ROWS_PER_SERVER);

      if (parts.length) parts.push(ui.separator({ large: true }));
      parts.push(ui.text(`### New on ${instance.display_name}`), ui.separator());

      if (feed.error) {
        parts.push(ui.text(`-# ${instance.display_name} could not be reached right now`));
        continue;
      }
      if (!rows.length) {
        parts.push(ui.text('-# Nothing new here yet'));
        continue;
      }
      for (const row of rows) {
        const facts = [row.detail, ui.ageOf(row.at)].filter(Boolean).join(' • ');
        parts.push(ui.text(`**${row.title}**${facts ? `\n-# ${facts}` : ''}`));
      }
    }
    await send(ui.payload(ui.container(parts)));
  }
};
