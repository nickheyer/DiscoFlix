const BaseModel = require('./base');

class DiscordServerChannel extends BaseModel {
  constructor(core) {
    super(core, 'DiscordServerChannel');
  }

  // ONE PAGE SIZE FOR THE INITIAL LOAD AND EVERY SCROLL-UP BATCH
  get historyPageSize() {
    return require('../tuning').value('history_page_size');
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

  // NEWEST N MESSAGES (OPTIONALLY OLDER THAN beforeId), RETURNED OLDEST-FIRST
  async getMessages(channelId, limit = this.historyPageSize, beforeId = null) {
    const messages = await this.prisma.discordMessage.findMany({
      where: { channel_id: channelId },
      include: {
        user: true,  // INCLUDE USER DETAILS
      },
      orderBy: { created_at: 'desc' },
      take: limit,
      ...(beforeId ? { cursor: { message_id: beforeId }, skip: 1 } : {})
    });
    return messages.reverse();
  }

  // NEXT N MESSAGES NEWER THAN afterId, OLDEST-FIRST (asc NEEDS NO REVERSE) -
  // THE ANCHORED WINDOW'S SCROLL-DOWN PAGES
  async getMessagesAfter(channelId, limit = this.historyPageSize, afterId) {
    return this.prisma.discordMessage.findMany({
      where: { channel_id: channelId },
      include: { user: true },
      orderBy: { created_at: 'asc' },
      take: limit,
      cursor: { message_id: afterId },
      skip: 1
    });
  }

  // THE DEEP-LINK WINDOW - radius OLDER + TARGET + radius NEWER, OLDEST-FIRST.
  // null WHEN THE TARGET WAS NEVER MIRRORED. hasOlder/hasNewer OVER-PROMISE ON
  // EXACT BOUNDARIES LIKE historyCursorOf - AN EMPTY EXTRA PAGE JUST DISSOLVES.
  async getMessagesAround(channelId, messageId, radius = 50) {
    const target = await this.prisma.discordMessage.findUnique({
      where: { message_id: messageId },
      include: { user: true }
    });
    if (!target || target.channel_id !== channelId) return null;

    const older = await this.prisma.discordMessage.findMany({
      where: { channel_id: channelId },
      include: { user: true },
      orderBy: { created_at: 'desc' },
      take: radius,
      cursor: { message_id: messageId },
      skip: 1
    });
    const newer = await this.getMessagesAfter(channelId, radius, messageId);

    return {
      messages: [...older.reverse(), target, ...newer],
      hasOlder: older.length === radius,
      hasNewer: newer.length === radius
    };
  }

  // HOW FAR FROM THE LIVE HEAD A MESSAGE SITS - DECIDES ANCHORED VS PLAIN JUMP
  async countNewerThan(channelId, createdAt) {
    return this.prisma.discordMessage.count({
      where: { channel_id: channelId, created_at: { gt: createdAt } }
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
