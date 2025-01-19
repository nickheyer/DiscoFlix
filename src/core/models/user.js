const BaseModel = require('./base');

class User extends BaseModel {
  constructor(core) {
    super(core, 'User');
  }

  // HELPERS
  async getByUsername(username, include = {}) {
    return this.findFirst({ username }, include);
  }

  async getWithRelations(userId, include = {}) {
    const defaultInclude = {
      discord_servers: Boolean(include?.servers),
      requests: Boolean(include?.requests),
      messages: Boolean(include?.messages),
      ...include
    };

    return this.findFirst({ id: userId }, defaultInclude);
  }

  async addToServer(userId, serverId) {
    return this.update(
      { id: userId },
      {
        discord_servers: {
          connect: { server_id: serverId }
        }
      }
    );
  }

  async removeFromServer(userId, serverId) {
    return this.update(
      { id: userId },
      {
        discord_servers: {
          disconnect: { server_id: serverId }
        }
      }
    );
  }

  async setRole(userId, role) {
    const updates = {};
    switch (role.toLowerCase()) {
      case 'admin':
        updates.is_superuser = true;
        updates.is_staff = true;
        break;
      case 'staff':
        updates.is_superuser = false;
        updates.is_staff = true;
        break;
      case 'user':
        updates.is_superuser = false;
        updates.is_staff = false;
        break;
      default:
        throw new Error(`Invalid role: ${role}`);
    }
    return this.update({ id: userId }, updates);
  }

  async addRequest(userId, requestId) {
    return this.update(
      { id: userId },
      {
        requests: {
          connect: { id: requestId }
        }
      }
    );
  }

  async removeRequest(userId, requestId) {
    return this.update(
      { id: userId },
      {
        requests: {
          disconnect: { id: requestId }
        }
      }
    );
  }

  async updateLimits(userId, limits = {}) {
    const updates = {};
    if (limits.sessionTimeout) updates.session_timeout = limits.sessionTimeout;
    if (limits.maxCheckTime) updates.max_check_time = limits.maxCheckTime;
    if (limits.maxResults) updates.max_results = limits.maxResults;
    if (limits.maxSeasons) updates.max_seasons_for_non_admin = limits.maxSeasons;
    if (limits.maxRequests) updates.max_requests_in_day = limits.maxRequests;
    
    return this.update({ id: userId }, updates);
  }

  async updateProfile(userId, profile = {}) {
    const updates = {};
    if (profile.username) updates.username = profile.username;
    if (profile.displayName) updates.display_name = profile.displayName;
    if (profile.accentColor) updates.accent_color = profile.accentColor;
    if (profile.avatarUrl) updates.avatar_url = profile.avatarUrl;
    
    return this.update({ id: userId }, updates);
  }

  async toggleActive(userId) {
    const user = await this.findFirst({ id: userId });
    return this.update(
      { id: userId },
      { is_active: !user.is_active }
    );
  }

  // CLEANUP
  async deleteWithRelated(userId) {
    // REMOVE USER FROM ALL SERVERS FIRST
    await this.update(
      { id: userId },
      {
        discord_servers: {
          set: []
        },
        requests: {
          set: []
        }
      }
    );

    // DELETE ALL MESSAGES
    await this.prisma.discordMessage.deleteMany({
      where: { user_id: userId }
    });

    return this.delete({ id: userId });
  }
}

module.exports = User;
