const BaseModel = require('./base');

class DiscordServerChannel extends BaseModel {
  constructor(core) {
    super(core, 'DiscordServerChannel');
  }

  async create(data = {}, include = {}) {
    const channelType = data.channel_type || 0;
    data.isTextChannel = channelType === 0;
    data.isVoiceChannel = channelType === 2;
    data.isCategory = channelType === 4;
    
    return super.create(data, include);
  }

  async upsert(where = {}, create = {}, update = {}, include = {}) {
    const channelType = create.channel_type || 0;
    create.isTextChannel = channelType === 0;
    create.isVoiceChannel = channelType === 2;
    create.isCategory = channelType === 4;
    
    return super.upsert(where, create, update, include);
  }

  async getServerChannels(discord_server, include = {}) {
    return this.getMany(
      { discord_server },
      include,
      { position: 'asc' }
    );
  }

  async getCategories(discord_server) {
    return this.getMany(
      { 
        discord_server,
        isCategory: true
      },
      {},
      { position: 'asc' }
    );
  }

  async getTextChannels(discord_server) {
    return this.getMany(
      { 
        discord_server,
        isTextChannel: true
      },
      {},
      { position: 'asc' }
    );
  }

  async getVoiceChannels(discord_server) {
    return this.getMany(
      { 
        discord_server,
        isVoiceChannel: true
      },
      {},
      { position: 'asc' }
    );
  }

  async getMessages(channelId) {
    return this.prisma.discordMessage.findMany({
      where: { channel_id: channelId },
      include: {
        user: true,  // INCLUDE USER DETAILS
      }
    });
  }

  async markAsRead(channel_id) {
    return this.update(
      { channel_id },
      { unread_message_count: 0 }
    );
  }

  async getById(channel_id) {
    return this.findFirst({ channel_id });
  }

  async incrementUnread(channel_id) {
    const channel = await this.getById(channel_id);
    return this.update(
      { channel_id },
      { unread_message_count: (channel.unread_message_count || 0) + 1 }
    );
  }

  // UI STUFF
  async reorder(channels = []) {
    const updates = channels.map((channel_id, position) => 
      this.model.update({ where: { channel_id }, data: { position }})
    );
    return this.transaction(updates);
  }

  async setParent(channel_id, parent_id) {
    return this.update(
      { channel_id },
      { parent_id }
    );
  }

  async getChildChannels(parent_id, discord_server) {
    return this.getMany(
      { parent_id, discord_server },
      {},
      { position: 'asc' }
    );
  }

  async deleteServerChannels(discord_server) {
    this.logger.warn('Deleting all channels for server:', discord_server);
    return this.deleteMany({ discord_server });
  }
}

module.exports = DiscordServerChannel;
