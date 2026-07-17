const { memberRoleTokens, roleGrantsFor } = require('../../bot/interactions/access');

// GUILD ROSTER AGGREGATION - THE BOT KNOWS EVERY MEMBER IT SERVES, NOT JUST
// THE ONES WHO HAVE SPOKEN. RUNS ON READY AND RIDES THE GUILD-EVENT DEBOUNCE
// (GuildMemberAdd/Remove/Update), SO LEAVERS UNLINK PROMPTLY.
module.exports = {
  async syncGuildMembers(guild) {
    const config = await this.core.models.configuration.get();
    let members;
    try {
      members = await guild.members.fetch();
    } catch (err) {
      this.logger.warn(`Member sync failed for ${guild.name}: ${err.message}`);
      return null;
    }

    const rows = [...members.values()].map(member => ({
      id: member.user.id,
      username: member.user.username,
      display_name: member.user.displayName,
      avatar_url: member.user.displayAvatarURL(),
      is_bot: !!member.user.bot,
      is_client: member.user.id === this.core.client.user.id,
      grants: roleGrantsFor(config, memberRoleTokens(member))
    }));

    // ONE READ SPLITS NEW ROWS FROM PROFILE REFRESHES - CREATES GO IN BULK
    const existing = await this.core.prisma.user.findMany({
      where: { id: { in: rows.map(row => row.id) } }
    });
    const known = new Map(existing.map(row => [row.id, row]));

    const creates = rows.filter(row => !known.has(row.id));
    if (creates.length) {
      await this.core.prisma.user.createMany({
        data: creates.map(({ grants, ...row }) => ({ ...row, ...grants, last_seen_at: new Date() }))
      });
    }

    // REFRESH ONLY WHERE THE PROFILE DRIFTED OR A MAPPED ROLE PROMOTES -
    // GRANTS NEVER DEMOTE, THE CONSOLE STAYS THE PLACE TO REVOKE
    for (const row of rows) {
      const before = known.get(row.id);
      if (!before) continue;
      const drifted = before.username !== row.username
        || before.display_name !== row.display_name
        || before.avatar_url !== row.avatar_url;
      const granted = Object.keys(row.grants).filter(key => row.grants[key] && !before[key]);
      if (!drifted && !granted.length) continue;
      await this.core.prisma.user.update({
        where: { id: row.id },
        data: {
          username: row.username,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          ...row.grants,
          ...(granted.length ? { access_requested_at: null } : {})
        }
      });
      if (granted.length) {
        this.logger.info(`Role mapping granted ${granted.join(', ')} to ${row.username}`);
      }
    }

    // MEMBERSHIP LINKS BECOME EXACTLY DISCORD'S ROSTER - LEAVERS UNLINK,
    // THEIR ROWS AND REQUEST HISTORY SURVIVE
    const membership = await this.core.models.user.setGuildMembership(guild.id, rows.map(row => row.id));
    if (membership.linked || membership.unlinked) {
      this.logger.info(`Roster sync ${guild.name}: +${membership.linked} / -${membership.unlinked} member links`);
    }
    return { members: rows.length, ...membership };
  },

  async syncAllGuildMembers() {
    for (const guild of this.core.client.guilds.cache.values()) {
      await this.syncGuildMembers(guild);
    }
  }
};
