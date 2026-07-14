const BaseModel = require('./base');

class User extends BaseModel {
    constructor(core) {
        super(core, 'User');
    }

    // EVERY BOT TOUCHPOINT LANDS HERE - PROFILE FIELDS TRACK DISCORD ON EACH
    // SIGHTING (DM-ONLY USERS STOP DRIFTING), GRANTS ONLY EVER ADD FLAGS, AND
    // A KNOWN GUILD LINK ACCRETES ONTO THE ROW
    async syncFromDiscord(discordUser, { grants = {}, serverId = null, extra = {} } = {}) {
        const profile = {
            username: discordUser.username,
            display_name: discordUser.displayName,
            avatar_url: typeof discordUser.displayAvatarURL === 'function'
                ? discordUser.displayAvatarURL()
                : discordUser.avatar_url,
            is_bot: !!discordUser.bot,
            last_seen_at: new Date(),
            ...extra
        };

        // ONLY MIRRORED GUILDS CAN CONNECT - A DM HAS NO SERVER ROW
        let serverConnect = {};
        if (serverId) {
            const server = await this.prisma.discordServer.findUnique({ where: { server_id: serverId } });
            if (server) serverConnect = { discord_servers: { connect: { server_id: serverId } } };
        }

        const existing = await this.findFirst({ id: discordUser.id });
        const granted = Object.keys(grants).filter(key => grants[key] && !existing?.[key]);
        // ANY ACCESS GRANT SETTLES A PENDING "WANTS ACCESS" ASK
        const settlesAsk = Object.keys(grants).length ? { access_requested_at: null } : {};

        const row = await this.prisma.user.upsert({
            where: { id: discordUser.id },
            create: { id: discordUser.id, ...profile, ...grants, ...serverConnect },
            update: { ...profile, ...grants, ...settlesAsk, ...serverConnect }
        });
        if (granted.length) {
            this.logger.info(`Role mapping granted ${granted.join(', ')} to ${row.username}`);
        }
        return row;
    }

    // WHITELIST FLOW - A DENIED REQUESTER RAISES A HAND THE CONSOLE CAN SEE.
    // THE FIRST ASK KEEPS ITS TIMESTAMP; RETURNS true WHEN THE ASK IS NEW.
    async flagAccessRequest(userId) {
        const result = await this.prisma.user.updateMany({
            where: { id: userId, access_requested_at: null },
            data: { access_requested_at: new Date() }
        });
        return result.count > 0;
    }

    // ROSTER SYNC - MAKE ONE GUILD'S MEMBERSHIP LINKS EXACTLY MATCH DISCORD.
    // ROWS ARE NEVER DELETED (REQUEST HISTORY OUTLIVES MEMBERSHIP); ONLY THE
    // LINKS MOVE. RETURNS { linked, unlinked }.
    async setGuildMembership(serverId, memberIds) {
        const server = await this.prisma.discordServer.findUnique({
            where: { server_id: serverId },
            include: { users: { select: { id: true } } }
        });
        if (!server) return { linked: 0, unlinked: 0 };

        const wanted = new Set(memberIds);
        const current = new Set(server.users.map(user => user.id));
        const connect = memberIds.filter(id => !current.has(id)).map(id => ({ id }));
        const disconnect = [...current].filter(id => !wanted.has(id)).map(id => ({ id }));

        if (connect.length || disconnect.length) {
            await this.prisma.discordServer.update({
                where: { server_id: serverId },
                data: { users: { connect, disconnect } }
            });
        }
        return { linked: connect.length, unlinked: disconnect.length };
    }
}

module.exports = User;
