// DISCOFLIX ITSELF AS A PLATFORM APP - THE DISCORD BADGE IS ITS RAIL BUBBLE.
// hidden KEEPS IT OUT OF THE PICKER, THE RAIL, ENV SEEDING, AND REMOVAL; IT
// HAS NO SERVICE CLIENT, ITS SECTIONS READ THE BOT'S OWN STATE INSTEAD.
module.exports = {
  id: 'discoflix',
  label: 'DiscoFlix',
  icon: '/images/favicon.png',
  blurb: 'Bot health, users, and configuration',
  kind: 'platform',
  hidden: true,
  contentTypes: [],
  configFields: [],
  // database IS CONFIG-GATED (Configuration.db_admin_enabled) - THE NAV AND
  // SECTION ROUTES FILTER IT VIA visibleSectionsOf, NOT THIS LIST
  sections: ['overview', 'requests', 'bot', 'library', 'users', 'logs', 'database', 'settings']
};
