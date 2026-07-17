const BaseModel = require('./base');

// AI CONVERSATION THREADS. CONSOLE THREADS ARE OPERATOR-MADE (context_key
// NULL, MANY PER INSTANCE); DISCORD THREADS ARE ONE PER (INSTANCE, CHANNEL) -
// SHARED CHANNEL MEMORY, THE SAME WAY A GUILD CHANNEL IS A SHARED ROOM.
const TITLE_MAX = 60;

class AiConversation extends BaseModel {
    constructor(core) {
        super(core, 'AiConversation');
    }

    // CONSOLE THREAD LIST FOR ONE INSTANCE'S CHAT SECTION - NEWEST FIRST
    async consoleThreadsFor(appId) {
        return this.getMany(
            { appId, surface: 'console' },
            {},
            [{ updated_at: 'desc' }]
        );
    }

    async createConsoleThread(appId) {
        return this.create({ appId, surface: 'console', title: 'New conversation' });
    }

    // THE CHANNEL'S SHARED THREAD, CREATED ON FIRST USE
    async threadForDiscordChannel(appId, channelId) {
        return this.getOrCreate(
            { appId, surface: 'discord', context_key: String(channelId) },
            { title: 'Discord channel thread' }
        );
    }

    // FIRST USER MESSAGE NAMES THE THREAD - ONLY WHILE IT STILL HAS THE
    // PLACEHOLDER TITLE, A RENAMED THREAD KEEPS ITS NAME
    async adoptTitle(conversationId, text) {
        const row = await this.get({ id: conversationId });
        if (!row || row.title !== 'New conversation') return row;
        const title = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
        if (!title) return row;
        return this.update({ id: conversationId }, { title });
    }

    // EXPLICIT STAMP - PRISMA NO-OPS AN EMPTY UPDATE, SO @updatedAt ALONE
    // WOULD NEVER MOVE; THREAD LISTS SORT BY THIS
    async touch(conversationId) {
        return this.update({ id: conversationId }, { updated_at: new Date() }).catch(() => null);
    }

    async countFor(appId) {
        return this.model.count({ where: { appId } });
    }
}

module.exports = AiConversation;
