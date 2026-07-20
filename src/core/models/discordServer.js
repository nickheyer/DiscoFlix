const BaseModel = require('./base');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// LIST LENGTHS READ FROM core.tuning AT BUILD TIME (top_requester_count /
// quota_row_cap) SO ADMIN CHANGES APPLY LIVE

class DiscordServer extends BaseModel {
    constructor(core) {
        super(core, 'DiscordServer');
    }

    // OPS PANELS FOR THE SERVER INFO POPUP - ONE PER RENDERED GUILD CARD
    async getOpsPanels(serverIds = []) {
        const panels = {};
        for (const serverId of serverIds) {
            if (!serverId) continue;
            try {
                panels[serverId] = await this._buildOpsPanel(serverId);
            } catch (err) {
                this.logger.warn(`Ops stats failed for guild ${serverId}: ${err.message}`);
            }
        }
        return panels;
    }

    // REQUEST ACTIVITY + QUOTA USAGE - THE 24h WINDOW MIRRORS limits.js, WHICH
    // COUNTS A USER'S REQUESTS ACROSS EVERY GUILD, AND ADMINS ARE EXEMPT
    async _buildOpsPanel(server_id) {
        const now = Date.now();
        const weekAgo = new Date(now - WEEK_MS);
        const dayAgo = new Date(now - DAY_MS);
        const [weekCount, pendingCount, totalCount, requesters, quotaUsers] = await Promise.all([
            this.prisma.mediaRequest.count({ where: { madeInId: server_id, created_at: { gte: weekAgo } } }),
            this.prisma.mediaRequest.count({ where: { madeInId: server_id, status: null } }),
            this.prisma.mediaRequest.count({ where: { madeInId: server_id } }),
            this.prisma.user.findMany({
                where: { requests: { some: { madeInId: server_id } } },
                select: {
                    display_name: true,
                    username: true,
                    _count: { select: { requests: { where: { madeInId: server_id } } } }
                }
            }),
            this.prisma.user.findMany({
                where: {
                    discord_servers: { some: { server_id } },
                    is_active: true,
                    is_bot: false,
                    is_superuser: false,
                    is_staff: false,
                    max_requests_in_day: { gt: 0 }
                },
                select: {
                    display_name: true,
                    username: true,
                    max_requests_in_day: true,
                    _count: { select: { requests: { where: { created_at: { gte: dayAgo } } } } }
                }
            })
        ]);

        const requesterRows = requesters
            .map(user => ({ name: user.display_name || user.username, count: user._count.requests }))
            .filter(row => row.count > 0)
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            .slice(0, this.core.tuning.value('top_requester_count'))
            .map(row => ({ name: row.name, detail: `${row.count} request${row.count === 1 ? '' : 's'}` }));

        const quotaRows = quotaUsers
            .map(user => {
                const used = user._count.requests;
                const limit = user.max_requests_in_day;
                return {
                    name: user.display_name || user.username,
                    detail: `${used} of ${limit} in the last 24h`,
                    percent: Math.min(100, Math.round((used / limit) * 100))
                };
            })
            .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));

        const quotaRowCap = this.core.tuning.value('quota_row_cap');
        return {
            heading: 'Request Activity',
            stats: [
                { label: 'This Week', value: weekCount },
                { label: 'Pending', value: pendingCount },
                { label: 'All Time', value: totalCount }
            ],
            lists: [
                {
                    label: 'Top Requesters',
                    empty: 'No requests from this server yet',
                    rows: requesterRows
                },
                {
                    label: 'Daily Quota Usage',
                    empty: 'No members carry a daily request limit',
                    rows: quotaRows.slice(0, quotaRowCap),
                    moreCount: Math.max(0, quotaRows.length - quotaRowCap)
                }
            ]
        };
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
