const BaseModel = require('./base');

// INSTALLED APP INSTANCES (RADARR/SONARR/SABNZBD/QBITTORRENT...). WHICH CONFIG
// COLUMNS APPLY TO A ROW IS DECLARED BY ITS app_type's MANIFEST — SEE
// src/core/methods/apps/registry.js. MANIFEST-AWARE HELPERS LIVE ON core.apps;
// THIS CLASS IS THE THIN DATA LAYER ONLY.
class App extends BaseModel {
    constructor(core) {
        super(core, 'App');
    }

    async getInstalled() {
        return this.getMany({}, {}, [
            { sort_position: 'asc' },
            { created_at: 'asc' }
        ]);
    }

    // RAIL DRAG-SORT — SAME SHAPE AS DiscordServer.reorder. KOA GIVES A BARE
    // STRING WHEN THE FORM POSTS A SINGLE item FIELD, SO NORMALIZE FIRST
    async reorder(appIds = []) {
        if (!Array.isArray(appIds)) appIds = appIds ? [appIds] : [];
        const updates = appIds.map((id, index) =>
            this.model.update({
                where: { id },
                data: { sort_position: index }
            })
        );
        return this.transaction(updates);
    }

    async nextSortPosition() {
        const last = await this.model.findFirst({
            orderBy: { sort_position: 'desc' }
        });
        return (last?.sort_position ?? -1) + 1;
    }

    async countByType(appType) {
        return this.model.count({ where: { app_type: appType } });
    }
}

module.exports = App;
