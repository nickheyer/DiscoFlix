const _ = require('lodash');

const PAGINATION_CONFIG = {
    DEFAULT_PAGE_SIZE: 5,
    DEFAULT_PAGE: 1,
    VALID_PAGE_SIZES: [5, 10, 25, 50, 100]
};

// HELPER FUNCTIONS
function getSafePageSize(rawPageSize) {
    const size = Number(rawPageSize);
    return PAGINATION_CONFIG.VALID_PAGE_SIZES.includes(size) ? size : PAGINATION_CONFIG.DEFAULT_PAGE_SIZE;
}

function getCurrentPage(page) {
    const pageNum = Number(page);
    return !isNaN(pageNum) && pageNum > 0 ? pageNum : PAGINATION_CONFIG.DEFAULT_PAGE;
}

function getSearchQuery(ctx) {
    // Handle both GET query params and POST body
    return ctx.method === 'GET' ? 
        ctx.query.search :
        ctx.request.body.search;
}

async function getPaginatedData(model, currentPage, perPage, searchQuery = '') {
    // GET SEARCH IF QUERY
    const searchCriteria = searchQuery ? await model.searchFields(searchQuery) : {};
    
    // GET COUNT BEFORE PAGINATION
    const totalRecords = model.getModelType() === 'singleton' ? 
        1 : 
        await model.model.count({ where: searchCriteria.where || {} });

    const maxPage = Math.ceil(totalRecords / perPage);
    const safePage = Math.min(Math.max(1, currentPage), maxPage || 1);
    const skip = (safePage - 1) * perPage;
    const data = await model.getPages(
        searchCriteria.where || {}, 
        {}, 
        {}, 
        skip, 
        perPage
    );

    return { 
        data, 
        totalRecords,
        currentPage: safePage 
    };
}

async function renderRecordsView(ctx, model, records, currentPage, perPage, totalRecords, searchQuery = null, message) {
    return ctx.compileView(['modals/settings/_records.pug', 'extra/notification.pug'], {
        type: _.lowerFirst(model.modelName),
        readonly: model.isModelReadonly(),
        isSingleton: model.getModelType() === 'singleton',
        records,
        pg: { currentPage, perPage, totalRecords },
        searchQuery,
        ...(message && { message })
    });
}

// CONTROLLER FUNCTIONS
async function renderModal(ctx) {
    const { type: modalType, modal: modalName } = ctx.params;
    let modalTemplate = `modals/${modalType}/${modalName}.pug`;
    const modalParams = {};

    if (modalType === 'settings') {
        const model = ctx.core[modalName];
        if (!model) {
            global.logger.warn(`MODEL ${modalName} NOT FOUND`);
            return ctx.compileView('modals/stub.pug');
        }

        const perPage = getSafePageSize(ctx.query['page-size']);
        const currentPage = getCurrentPage(ctx.query['current-page']);
        const searchQuery = getSearchQuery(ctx);

        const { data, totalRecords, currentPage: safePage } = 
            await getPaginatedData(model, currentPage, perPage, searchQuery);

        Object.assign(modalParams, {
            title: model.getModelDescription() || `${modalName} Settings`,
            type: modalName,
            readonly: model.isModelReadonly(),
            records: model.getModelType() === 'singleton' ? 
                [{ id: data[model.getPrimaryKeyName()]?.value || null, fields: data }] : data,
            isSingleton: model.getModelType() === 'singleton',
            pg: { currentPage: safePage, perPage, totalRecords },
            searchQuery
        });
        modalTemplate = 'modals/settings/base.pug';
    
    } else if (modalType === 'bot') {
        const [state, discordBot] = await Promise.all([
            ctx.core.state.get(),
            ctx.core.discordBot.get()
        ]);
        Object.assign(modalParams, { discordBot, state, loading: false });
    }

    return ctx.compileView(modalTemplate, modalParams);
}

async function getSettingsPage(ctx) {
    const { type: modelName, page } = ctx.params;
    const model = ctx.core[modelName];
    if (!model) return ctx.status = 404;

    const perPage = getSafePageSize(ctx.query['page-size']);
    const currentPage = getCurrentPage(page);
    const searchQuery = getSearchQuery(ctx);

    const { data, totalRecords, currentPage: safePage } = 
        await getPaginatedData(model, currentPage, perPage, searchQuery);

    return renderRecordsView(ctx, model, data, safePage, perPage, totalRecords, searchQuery);
}

async function saveSettings(ctx) {
    const { type: modelName, id } = ctx.params;
    const model = ctx.core[modelName];
    if (!model || model.isModelReadonly()) return ctx.status = model ? 403 : 404;

    try {
        const perPage = getSafePageSize(ctx.request.body['page-size']);
        const currentPage = getCurrentPage(ctx.request.body['current-page']);
        const searchQuery = getSearchQuery(ctx);

        const modalData = { ...ctx.request.body };
        delete modalData['current-page'];
        delete modalData['page-size'];
        delete modalData['search'];

        const savedData = await (id ?
            model.safeUpdateOne(id, modalData) :
            model.safeUpsertOne(modalData)
        );

        let { data: formData, totalRecords, currentPage: safePage } = 
            await getPaginatedData(model, currentPage, perPage, searchQuery);

        if (model.getModelType() === 'singleton') {
            formData = [{ id: savedData.id, fields: formData }];
        }

        global.logger.debug({ formData });

        return renderRecordsView(ctx, model, formData, safePage, perPage, totalRecords, searchQuery, 'Changes Saved');
    } catch (err) {
        ctx.core.logger.error('SETTINGS SAVE FAILED:', err);
        ctx.status = 400;
        ctx.body = { error: err.message };
    }
}

async function searchSettings(ctx) {
    const { type: modelName } = ctx.params;
    const model = ctx.core[modelName];
    if (!model) return ctx.status = 404;

    const searchQuery = getSearchQuery(ctx);
    const perPage = getSafePageSize(ctx.query['page-size']);
    const currentPage = getCurrentPage(ctx.query['current-page']);

    const { data, totalRecords, currentPage: safePage } = 
        await getPaginatedData(model, currentPage, perPage, searchQuery);
    
    return renderRecordsView(ctx, model, data, safePage, perPage, totalRecords, searchQuery);
}

async function deleteRecord(ctx) {
    const { type: modelName, id } = ctx.params;
    const model = ctx.core[modelName];
    if (!model) return ctx.status = 404;

    try {
        await model.safeDelete(id);
        
        const perPage = getSafePageSize(ctx.query['page-size']);
        const currentPage = getCurrentPage(ctx.query['current-page']);
        const searchQuery = getSearchQuery(ctx);

        const { data, totalRecords, currentPage: safePage } = 
            await getPaginatedData(model, currentPage, perPage, searchQuery);

        return renderRecordsView(ctx, model, data, safePage, perPage, totalRecords, searchQuery);
    } catch (err) {
        ctx.core.logger.error('RECORD DELETE FAILED:', err);
        ctx.status = 400;
        ctx.body = { error: err.message };
    }
}

module.exports = {
    renderModal,
    getSettingsPage,
    saveSettings,
    searchSettings,
    deleteRecord,
    PAGINATION_CONFIG
};