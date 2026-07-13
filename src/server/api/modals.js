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

async function renderRecordsView(ctx, model, records, currentPage, perPage, totalRecords, searchQuery = null, fullRender = null) {
    // BASE.PUG ALREADY INCLUDES _RECORDS - RENDERING BOTH DUPLICATES THE RECORDS INTO #modals-here
    const templatesToRender = fullRender ?
        ['modals/settings/base.pug'] :
        ['modals/settings/_records.pug'];
    const templateParams = {
        title: model.getModelDescription() || `${model.modelName} Info`,
        type: _.lowerFirst(model?.metadata?.alias || model.modelName),
        isSingleton: model.getModelType() === 'singleton',
        records,
        pg: { currentPage, perPage, totalRecords },
        searchQuery
    };
    return ctx.compileView(templatesToRender, templateParams);
}

// CONTROLLER FUNCTIONS
async function renderModal(ctx) {
    const { type: modalType, modal: modalName } = ctx.params;
    let modalTemplate = `modals/${modalType}/${modalName}.pug`;
    const modalParams = {};

    if (modalType === 'settings') {
        const model = ctx.core.models[modalName];
        if (!model) {
            ctx.core.logger.warn(`MODEL ${modalName} NOT FOUND`);
            return ctx.compileView('modals/stub.pug');
        }

        const perPage = getSafePageSize(ctx.query['page-size']);
        const currentPage = getCurrentPage(ctx.query['current-page']);
        const searchQuery = getSearchQuery(ctx);

        const { data, totalRecords, currentPage: safePage } = 
            await getPaginatedData(model, currentPage, perPage, searchQuery);

        Object.assign(modalParams, {
            title: model.getModelDescription() || `${modalName} Info`,
            type: modalName,
            records: model.getModelType() === 'singleton' ?
                [{ id: data[model.getPrimaryKeyName()]?.value || null, fields: data }] : data,
            isSingleton: model.getModelType() === 'singleton',
            pg: { currentPage: safePage, perPage, totalRecords },
            searchQuery
        });
        modalTemplate = 'modals/settings/base.pug';
    
    } else if (modalType === 'bot') {
        const [state, discordBot] = await Promise.all([
            ctx.core.models.state.get(),
            ctx.core.models.discordBot.get()
        ]);
        Object.assign(modalParams, { discordBot, state, loading: false });
    }

    return ctx.compileView(modalTemplate, modalParams);
}

async function getSettingsPage(ctx) {
    const { type: modelName, page } = ctx.params;
    const model = ctx.core.models[modelName];
    if (!model) return ctx.status = 404;

    const perPage = getSafePageSize(ctx.query['page-size']);
    const currentPage = getCurrentPage(page);
    const searchQuery = getSearchQuery(ctx);

    const { data, totalRecords, currentPage: safePage } = 
        await getPaginatedData(model, currentPage, perPage, searchQuery);

    return renderRecordsView(ctx, model, data, safePage, perPage, totalRecords, searchQuery);
}

async function searchSettings(ctx) {
    const { type: modelName } = ctx.params;
    const model = ctx.core.models[modelName];
    if (!model) return ctx.status = 404;

    const searchQuery = getSearchQuery(ctx);
    const perPage = getSafePageSize(ctx?.query?.['page-size']);
    const currentPage = getCurrentPage(ctx?.query?.['current-page']);
    const includeModal = !!(ctx?.query?.['as-modal']);

    const { data, totalRecords, currentPage: safePage } =
        await getPaginatedData(model, currentPage, perPage, searchQuery);

    return renderRecordsView(ctx, model, data, safePage, perPage, totalRecords, searchQuery, includeModal);
}

module.exports = {
    renderModal,
    getSettingsPage,
    searchSettings,
    PAGINATION_CONFIG
};