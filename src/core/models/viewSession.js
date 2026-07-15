const BaseModel = require('./base');

// last_seen_at WRITES ARE THROTTLED SO BUSY SESSIONS DON'T WRITE PER REQUEST
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_SESSION_MS = 60 * 24 * 60 * 60 * 1000;
const VIEW_FIELDS = ['sidebar_exp_state', 'active_server_id', 'active_app_id', 'active_channels', 'chat_anchor'];
const VIEW_INCLUDE = { activeServer: true, activeApp: true };

// ONE ROW PER BROWSER (df_view COOKIE). viewStateOf MERGES THE ROW WITH THE
// GLOBAL State SINGLETON INTO THE `state` SHAPE EVERY TEMPLATE ALREADY READS.
class ViewSession extends BaseModel {
    constructor(core) {
        super(core, 'ViewSession');
        this._touchedAt = new Map();
    }

    // THE ROW A COOKIE POINTS AT - UNKNOWN/MISSING IDS MINT A FRESH SESSION
    async resolve(cookieId = null) {
        if (cookieId) {
            const existing = await this.model.findUnique({
                where: { id: cookieId },
                include: VIEW_INCLUDE
            });
            if (existing) {
                await this.touch(existing.id);
                return existing;
            }
        }
        const created = await this.model.create({ data: {}, include: VIEW_INCLUDE });
        this.pruneStale().catch(err => this.logger.debug(`View session prune failed: ${err.message}`));
        return created;
    }

    // MERGED VIEW STATE - GLOBAL discord_state RIDES EVERY PER-SESSION SHAPE.
    // null/UNKNOWN SESSIONS GET AN UNSAVED DEFAULT SHAPE (COOKIELESS SOCKETS).
    async viewStateOf(rowOrId) {
        const row = typeof rowOrId === 'string' || rowOrId === null || rowOrId === undefined
            ? (rowOrId ? await this.model.findUnique({ where: { id: rowOrId }, include: VIEW_INCLUDE }) : null)
            : rowOrId;
        const globalState = await this.core.models.state.get();
        if (!row) {
            return {
                id: null,
                discord_state: globalState.discord_state,
                sidebar_exp_state: true,
                active_server_id: null,
                active_app_id: null,
                active_channels: null,
                chat_anchor: null,
                activeServer: null,
                activeApp: null
            };
        }
        return {
            id: row.id,
            discord_state: globalState.discord_state,
            sidebar_exp_state: row.sidebar_exp_state,
            active_server_id: row.active_server_id,
            active_app_id: row.active_app_id,
            active_channels: row.active_channels,
            chat_anchor: row.chat_anchor || null,
            activeServer: row.activeServer || null,
            activeApp: row.activeApp || null
        };
    }

    // VIEW-FIELD UPDATE THAT ANSWERS WITH THE FRESH MERGED SHAPE
    async updateView(id, fields = {}) {
        const data = {};
        for (const key of VIEW_FIELDS) {
            if (key in fields) data[key] = fields[key];
        }
        if (id && Object.keys(data).length) {
            await this.model.update({ where: { id }, data });
        }
        return this.viewStateOf(id);
    }

    channelMapOf(view) {
        try {
            return JSON.parse(view?.active_channels || '{}') || {};
        } catch (err) {
            return {};
        }
    }

    // THE SESSION'S PICK FOR A SERVER, FALLING BACK TO THE GLOBAL DEFAULT THE
    // SERVER ROW CARRIES (ensureActiveChannel KEEPS THAT ONE VALID)
    channelPickFor(view, serverRow) {
        return this.channelMapOf(view)[serverRow?.server_id] || serverRow?.active_channel_id || null;
    }

    // PARSED TIME-TRAVEL ANCHOR OR null - MALFORMED JSON READS AS LIVE MODE
    anchorOf(view) {
        try {
            const anchor = JSON.parse(view?.chat_anchor || 'null');
            return anchor && anchor.channel_id && anchor.message_id ? anchor : null;
        } catch (err) {
            return null;
        }
    }

    async setAnchor(id, channelId, messageId) {
        if (!id || !channelId || !messageId) return;
        await this.model.update({
            where: { id },
            data: { chat_anchor: JSON.stringify({ channel_id: channelId, message_id: messageId }) }
        });
    }

    async clearAnchor(id) {
        if (!id) return;
        // GUARDED WRITE - MOST MESSAGE LOADS ARE LIVE-MODE AND NEED NO UPDATE
        const row = await this.model.findUnique({ where: { id } });
        if (!row || row.chat_anchor === null) return;
        await this.model.update({ where: { id }, data: { chat_anchor: null } });
    }

    async setChannelPick(id, serverId, channelId) {
        if (!id || !serverId || !channelId) return;
        const row = await this.model.findUnique({ where: { id } });
        if (!row) return;
        const map = this.channelMapOf(row);
        map[serverId] = channelId;
        await this.model.update({ where: { id }, data: { active_channels: JSON.stringify(map) } });
    }

    async touch(id) {
        const last = this._touchedAt.get(id) || 0;
        if (Date.now() - last < TOUCH_INTERVAL_MS) return;
        this._touchedAt.set(id, Date.now());
        await this.model.update({ where: { id }, data: { last_seen_at: new Date() } })
            .catch(err => this.logger.debug(`View session touch failed: ${err.message}`));
    }

    async pruneStale() {
        const cutoff = new Date(Date.now() - STALE_SESSION_MS);
        const { count } = await this.model.deleteMany({ where: { last_seen_at: { lt: cutoff } } });
        if (count) this.logger.info(`Pruned ${count} stale view sessions`);
    }
}

module.exports = ViewSession;
