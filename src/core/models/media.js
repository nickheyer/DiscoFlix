const BaseModel = require('./base');

class Media extends BaseModel {
    constructor(core) {
        super(core, 'Media');
    }

    async addMedia(mediaData = {}) {
        const required = ['title'];
        for (const field of required) {
            if (!mediaData[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        const processedData = await this._processCacheableFields(mediaData, Date.now());
        return this.create(processedData);
    }

    async updateMediaInfo(mediaId, updates = {}) {
        const processedData = await this._processCacheableFields(updates, mediaId);
        return this.update({ id: mediaId }, processedData);
    }

    // HELPERS
    async findByTitle(title, year = null) {
        const where = {
            title: { contains: title }
        };
        if (year) where.year = year;
        
        return this.getMany(where);
    }

    async findByExternalId(type, id) {
        const where = {};
        switch (type.toLowerCase()) {
            case 'imdb':
                where.imdb_id = id;
                break;
            case 'tvdb':
                where.tvdb_id = id;
                break;
            default:
                throw new Error(`Invalid external ID type: ${type}`);
        }
        return this.findFirst(where);
    }

    async toggleMonitored(mediaId) {
        const media = await this.findFirst({ id: mediaId });
        return this.update(
            { id: mediaId },
            { monitored: !media.monitored }
        );
    }

    // SEARCH & FILTER
    async search(options = {}) {
        const {
            title,
            year,
            type,
            monitored,
            limit = 50
        } = options;

        const where = {};
        if (title) where.title = { contains: title };
        if (year) where.year = year;
        if (type) where.series_type = type;
        if (monitored !== undefined) where.monitored = monitored;

        return this.getMany(
            where,
            {},
            { title: 'asc' },
            { take: limit }
        );
    }

    async getRecent(limit = 10) {
        return this.getMany(
            {},
            {},
            { created_at: 'desc' },
            { take: limit }
        );
    }

    async getRequests(mediaId) {
        return this.prisma.mediaRequest.findMany({
            where: { mediaId },
            include: {
                users: true,
                made_in: true
            }
        });
    }

    // CLEANUP
    async deleteWithRequests(mediaId) {
        await this.prisma.mediaRequest.deleteMany({
            where: { mediaId }
        });

        return this.delete({ id: mediaId });
    }
}

module.exports = Media;