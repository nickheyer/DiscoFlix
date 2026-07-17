const BaseModel = require('./base');

// TURNS IN AN AI CONVERSATION. content IS THE FLAT RENDERABLE TEXT; THE
// REPLAY WINDOW IS PLAIN user/assistant TEXT (TOOL BLOCKS LIVE ONLY INSIDE
// THE IN-FLIGHT LOOP - blocks_json KEEPS THE TRACE FOR RENDERING/AUDIT).
class AiMessage extends BaseModel {
    constructor(core) {
        super(core, 'AiMessage');
    }

    async append(conversationId, { role, content, blocks = null, authorLabel = null, authorKey = null, usage = null, error = null }) {
        return this.create({
            conversationId,
            role,
            content: String(content || ''),
            blocks_json: blocks ? JSON.stringify(blocks) : null,
            author_label: authorLabel,
            author_key: authorKey,
            usage_json: usage ? JSON.stringify(usage) : null,
            error
        });
    }

    // OLDEST-FIRST WINDOW OF THE NEWEST N TURNS - THE MODEL REPLAY SHAPE.
    // idleMs > 0 MAKES SESSIONS END NATURALLY: WALKING BACK FROM NOW, THE
    // FIRST QUIET GAP LONGER THAN idleMs IS THE SESSION SEAM AND NOTHING
    // BEFORE IT REPLAYS - A LIVE CONVERSATION KEEPS ITS MEMORY INDEFINITELY,
    // A LULL STARTS THE NEXT MESSAGE FRESH. THE GAP BETWEEN NOW AND THE
    // NEWEST ROW COUNTS TOO (A LONG-IDLE CHANNEL WAKES WITH NO WINDOW).
    async windowFor(conversationId, limit = 30, { idleMs = 0 } = {}) {
        const newest = await this.getMany(
            { conversationId },
            {},
            [{ created_at: 'desc' }],
            { take: limit }
        );
        if (idleMs > 0) {
            let previous = Date.now();
            let keep = 0;
            for (const row of newest) {
                const at = new Date(row.created_at).getTime();
                if (previous - at > idleMs) break;
                previous = at;
                keep++;
            }
            newest.length = keep;
        }
        return newest.reverse();
    }

    // FULL THREAD FOR THE CONSOLE CHAT LOG, OLDEST FIRST
    async allFor(conversationId) {
        return this.getMany({ conversationId }, {}, [{ created_at: 'asc' }]);
    }

    // PER-USER DAILY CAP COUNTER - USER TURNS AUTHORED BY authorKey SINCE
    // cutoff, SCOPED TO ONE PROVIDER TYPE WHEN GIVEN (EACH PROVIDER'S CAP
    // COUNTS ONLY ITS OWN TRAFFIC)
    async countAuthoredSince(authorKey, cutoff, appType = null) {
        return this.model.count({
            where: {
                author_key: authorKey,
                role: 'user',
                created_at: { gte: cutoff },
                ...(appType ? { conversation: { app: { app_type: appType } } } : {})
            }
        });
    }

    // TOKEN TOTALS ACROSS EVERY THREAD OF ONE INSTANCE - THE OVERVIEW TILES
    async usageTotalsFor(appId) {
        const rows = await this.model.findMany({
            where: { conversation: { appId }, usage_json: { not: null } },
            select: { usage_json: true }
        });
        const totals = { input: 0, output: 0, turns: rows.length };
        for (const row of rows) {
            try {
                const usage = JSON.parse(row.usage_json);
                totals.input += Number(usage.input) || 0;
                totals.output += Number(usage.output) || 0;
            } catch (err) { /* MALFORMED USAGE NEVER TAKES THE OVERVIEW DOWN */ }
        }
        return totals;
    }
}

module.exports = AiMessage;
