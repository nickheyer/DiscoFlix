const PAGINATION_CONFIG = {
    DEFAULT_PAGE_SIZE: 5,
    DEFAULT_PAGE: 1,
    VALID_PAGE_SIZES: [5, 10, 25, 50, 100]
};

function getSafePageSize(rawPageSize) {
    const size = Number(rawPageSize);
    return PAGINATION_CONFIG.VALID_PAGE_SIZES.includes(size) ? size : PAGINATION_CONFIG.DEFAULT_PAGE_SIZE;
}

function getCurrentPage(page) {
    const pageNum = Number(page);
    return !isNaN(pageNum) && pageNum > 0 ? pageNum : PAGINATION_CONFIG.DEFAULT_PAGE;
}

async function getSettingsPage(ctx) {
    const { type: modelName, page } = ctx.params;
    const model = ctx.core[modelName];
    
    if (!model) {
        ctx.status = 404;
        return;
    }

    const perPage = getSafePageSize(ctx.query['page-size']);
    let currentPage = Number(page) || 1;
    
    const totalRecords = await model.model.count();
    const maxPage = Math.ceil(totalRecords / perPage);
    currentPage = Math.min(Math.max(1, currentPage), maxPage);

    const skip = (currentPage - 1) * perPage;
    const data = await model.getPages({}, {}, {}, skip, perPage);

    return await ctx.compileView('modals/settings/_records.pug', {
        type: modelName,
        readonly: model.isModelReadonly(),
        isSingleton: false,
        records: data || [],
        pg: { currentPage, perPage, totalRecords }
    });
}

async function saveSettings(ctx) {
    const { type: modelName, id } = ctx.params;
    const model = ctx.core[modelName];
    
    if (!model || model.isModelReadonly()) {
        ctx.status = model ? 403 : 404;
        return;
    }

    let perPage = getSafePageSize(ctx.query['page-size']);
    let currentPage = Number(ctx.query['current-page']) || 1;

    if (!ctx.query['page-size']) {
        perPage = getSafePageSize(ctx.request.body['page-size']);
        currentPage = Number(ctx.request.body['current-page']) || 1;
    }

    const modelData = { ...ctx.request.body };
    delete modelData['current-page'];
    delete modelData['page-size'];

    try {
        const savedData = id ? 
            await model.safeUpdateOne(id, modelData) :
            await model.safeUpsertOne(modelData);

        const [formData, totalRecords] = await Promise.all([
            model.getPages({}, {}, {}, (currentPage - 1) * perPage, perPage),
            model.model.count()
        ]);

        const maxPage = Math.ceil(totalRecords / perPage);
        currentPage = Math.min(Math.max(1, currentPage), maxPage);

        return await ctx.compileView('modals/settings/_records.pug', {
            type: modelName,
            readonly: model.isModelReadonly(),
            isSingleton: model.getModelType() === 'singleton',
            records: model.getModelType() === 'singleton' ? [{ id: savedData.id, fields: formData }] : formData,
            pg: { currentPage, perPage, totalRecords }
        });

    } catch (err) {
        ctx.core.logger.error('SETTINGS SAVE FAILED:', err);
        ctx.status = 400;
        ctx.body = { error: err.message };
    }
}

async function renderModal(ctx) {
    const { type: modalType, modal: modalName } = ctx.params;
    const modalParams = {};
    let modalTemplate = `modals/${modalType}/${modalName}.pug`;

    if (modalType === 'settings') {
        const model = ctx.core[modalName];
        if (!model) {
            global.logger.warn(`MODEL ${modalName} NOT FOUND`);
            return await ctx.compileView('modals/stub.pug');
        }

        const modelType = model.getModelType();
        const pkName = model.getPrimaryKeyName();
        const isSingleton = modelType === 'singleton';
        const perPage = getSafePageSize(ctx.query['page-size']);
        const currentPage = getCurrentPage(null, ctx.query['current-page']);
        
        const [data, totalRecords] = await Promise.all([
            model.getPages({}, {}, {}, currentPage, perPage),
            isSingleton ? 1 : model.model.count()
        ]);

        Object.assign(modalParams, {
            title: model.getModelDescription() || `${modalName} Settings`,
            type: modalName,
            readonly: model.isModelReadonly(),
            records: isSingleton ? [{ id: data[pkName]?.value || null, fields: data }] : data,
            isSingleton,
            pg: { currentPage, perPage, totalRecords }
        });

        modalTemplate = 'modals/settings/base.pug';
    
    } else if (modalType === 'bot') {
        const [state, discordBot] = await Promise.all([
            ctx.core.state.get(),
            ctx.core.discordBot.get()
        ]);

        Object.assign(modalParams, {
            discordBot,
            state,
            loading: false
        });
    }

    return await ctx.compileView(modalTemplate, modalParams);
}

module.exports = {
    renderModal,
    getSettingsPage,
    saveSettings,
    PAGINATION_CONFIG
};
