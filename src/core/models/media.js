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
    // FIND AN EXISTING ROW BY THE STRONGEST EXTERNAL KEY A NORMALIZED LOOKUP
    // RESULT CARRIES (SHARED BY THE BOT REQUEST FLOW AND CONSOLE SEARCH & ADD)
    async findByResult(result) {
        if (result.imdbId) {
            const byImdb = await this.findFirst({ imdb_id: result.imdbId });
            if (byImdb) return byImdb;
        }
        if (result.tmdbId) {
            const byTmdb = await this.findFirst({ tmdb_id: result.tmdbId });
            if (byTmdb) return byTmdb;
        }
        if (result.tvdbId) {
            const byTvdb = await this.findFirst({ tvdb_id: result.tvdbId });
            if (byTvdb) return byTvdb;
        }
        return null;
    }

    // UPSERT FROM A NORMALIZED LOOKUP RESULT (+ THE SERVICE'S ADD RESPONSE,
    // WHEN THE ADD ALREADY HAPPENED)
    async upsertFromResult(result, added = {}) {
        const data = {
            title: result.title,
            overview: result.overview || null,
            poster_url: result.posterUrl,
            year: result.year,
            path: added.path || null,
            monitored: true,
            added: added.added || new Date().toISOString(),
            runtime: result.runtime,
            season_count: result.seasonCount,
            network: result.network,
            air_time: result.airTime,
            tvdb_id: result.tvdbId || null,
            tmdb_id: result.tmdbId || null,
            imdb_id: result.imdbId || null,
            first_aired: result.firstAired,
            series_type: result.seriesType,
            in_theaters: result.inTheaters,
            website_url: result.websiteUrl,
            trailer_url: result.trailerUrl
        };

        const existing = await this.findByResult(result);
        if (existing) return this.updateMediaInfo(existing.id, data);
        return this.addMedia(data);
    }

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