const BaseModel = require('./base');

class DiscordMessage extends BaseModel {
  constructor(core) {
    super(core, 'DiscordMessage');
  }

  // HELPERS
  async getChannelMessages(channel_id, options = {}) {
    const { include = {}, limit = 50, before = null } = options;
    const defaultInclude = {
      user: true,
      ...include
    };

    const where = { channel_id };
    if (before) {
      where.created_at = { lt: before };
    }

    return this.getMany(
      where,
      defaultInclude,
      { created_at: 'desc' },
      { take: limit }
    );
  }

  async getServerMessages(server_id, options = {}) {
    const { include = {}, limit = 50 } = options;
    return this.getMany(
      { server_id },
      include,
      { created_at: 'desc' },
      { take: limit }
    );
  }

  async getUserMessages(user_id, options = {}) {
    const { include = {}, limit = 50 } = options;
    return this.getMany(
      { user_id },
      include,
      { created_at: 'desc' },
      { take: limit }
    );
  }

  async createMany(messages = []) {
    this.logger.info(`Creating ${messages.length} messages in bulk`);
    return this.transaction(
      messages.map(msg => this.model.create({ data: msg }))
    );
  }

  async editMessage(message_id, content) {
    return this.update(
      { message_id },
      {
        content,
        updated_at: new Date()
      }
    );
  }

  async searchMessages(query, options = {}) {
    const { server_id, channel_id, user_id, limit = 50 } = options;
    const where = {
      content: { contains: query }
    };

    if (server_id) where.server_id = server_id;
    if (channel_id) where.channel_id = channel_id;
    if (user_id) where.user_id = user_id;

    return this.getMany(
      where,
      { user: true },
      { created_at: 'desc' },
      { take: limit }
    );
  }

  // CLEANUP
  async deleteChannelMessages(channel_id) {
    this.logger.warn('Deleting all messages for channel:', channel_id);
    return this.deleteMany({ channel_id });
  }

  async deleteServerMessages(server_id) {
    this.logger.warn('Deleting all messages for server:', server_id);
    return this.deleteMany({ server_id });
  }

  async deleteUserMessages(user_id) {
    this.logger.warn('Deleting all messages for user:', user_id);
    return this.deleteMany({ user_id });
  }
}

module.exports = DiscordMessage;
