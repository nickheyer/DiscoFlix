const BaseModel = require('./base');

class DiscordServer extends BaseModel {
    constructor(core) {
        super(core, 'DiscordServer');
    }

    // OVERRIDE CRUD METHODS
    async update(where = {}, data = {}) {
        const server = await this.getById(where.server_id);
        if (!server) {
            this.logger.error('Server not found for update:', where);
            return null;
        }

        const processedData = await this._processCacheableFields(data, server.server_id);
        return super.update(where, processedData);
    }

    // HELPERS
    async getById(server_id) {
        return this.model.findFirst({
            where: { server_id }
        });
    }

    async getSorted(where = {}, include = {}) {
        return this.getMany(
            where,
            include,
            { sort_position: 'asc' }
        );
    }

    async getWithChannels(server_id) {
        return this.model.findFirst({
            where: { server_id },
            include: { 
                channels: {
                    orderBy: { position: 'asc' }
                }
            }
        });
    }

    async getWithUsers(server_id) {
        return this.model.findFirst({
            where: { server_id },
            include: { users: true }
        });
    }

    async getComplete(server_id) {
        return this.model.findFirst({
            where: { server_id },
            include: {
                channels: {
                    orderBy: { position: 'asc' }
                },
                users: true,
                messages: {
                    take: 50,
                    orderBy: { created_at: 'desc' },
                    include: { user: true }
                }
            }
        });
    }

    // USER STUFF
    async addUser(server_id, userId) {
        return this.update(
            { server_id },
            {
                users: {
                    connect: { id: userId }
                }
            }
        );
    }

    async removeUser(server_id, userId) {
        return this.update(
            { server_id },
            {
                users: {
                    disconnect: { id: userId }
                }
            }
        );
    }

    // CHANNEL STUFF
    async setActiveChannel(server_id, channel_id) {
        return this.update(
            { server_id },
            { active_channel_id: channel_id }
        );
    }

    async getActiveChannel(server_id) {
        let self = await this.getById(server_id);
        if (!self || !self.active_channel_id) {
            self = await this.getWithChannels(server_id);
            return this.setActiveChannel(server_id, self.channels[0]?.channel_id || null);
        }
        return self;
    }

    // SORTING
    async reorder(serverIds = []) {
        const updates = serverIds.map((server_id, index) => 
            this.model.update({
                where: { server_id },
                data: { sort_position: index }
            })
        );
        return this.transaction(updates);
    }

    // UNREAD STATE
    async incrementUnread(server_id) {
        const server = await this.findFirst({ server_id });
        return this.update(
            { server_id },
            { unread_message_count: (server.unread_message_count || 0) + 1 }
        );
    }

    async markAsRead(server_id) {
        return this.update(
            { server_id },
            { unread_message_count: 0 }
        );
    }

    // AVAILABILITY
    async setAvailable(server_id, available = true) {
        return this.update(
            { server_id },
            { available }
        );
    }

    // CLEANUP
    async deleteWithRelated(server_id) {
        await this.prisma.discordMessage.deleteMany({
            where: { server_id }
        });
        
        await this.prisma.discordServerChannel.deleteMany({
            where: { discord_server: server_id }
        });
        
        return this.delete({ server_id });
    }
}

module.exports = DiscordServer;
