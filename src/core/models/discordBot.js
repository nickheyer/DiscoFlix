const BaseModel = require('./base');

class DiscordBot extends BaseModel {
    constructor(core) {
        super(core, 'DiscordBot');
        this.defaults = {
            bot_id: "0",
            bot_username: "Unavailable",
            bot_discriminator: "0000"
        };
    }

    async get(include = {}) {
        return this.getSingleton(this.defaults, include);
    }

    async update(fields = {}, include = {}) {
        this.logger.debug('Updating Discord Bot:', fields);
        const current = await this.get();
        
        const processedData = await this._processCacheableFields(fields, current.id);
        return this.model.update({
            where: { id: current.id },
            data: processedData,
            include
        });
    }

    // HELPERS
    async updateIdentity({ id, username, discriminator, avatarUrl }) {
        const updates = {};
        if (id) updates.bot_id = id;
        if (username) updates.bot_username = username;
        if (discriminator) updates.bot_discriminator = discriminator;
        if (avatarUrl) updates.bot_avatar_url = avatarUrl;
        return this.update(updates);
    }

    async updateInviteLink(inviteLink) {
        return this.update({ bot_invite_link: inviteLink });
    }

    async reset() {
        return this.update(this.defaults);
    }
}

module.exports = DiscordBot;