async function settingsModal(ctx) {
    global.logger.debug(ctx.params);
    const modalType = ctx.params.type;
    const modalName = ctx.params.modal;
    if (!modalType || !modalName) {
        return await ctx.compileView('modals/stub.pug');
    }

    let modalTemplate = `modals/${modalType}/${modalName}.pug`;
    let modalParams = {};

    switch (modalType) {
        case 'settings':
            modalParams = Object.assign(modalParams, {

            })
            break;
        case 'bot':
            const state = await ctx.core.state.get();
            const discordBot = await ctx.core.discordBot.get();
            modalParams = Object.assign(modalParams, {
                discordBot,
                state,
                loading: false
            })
            break;
        default:
            global.logger.debug('Unknown modal type, returning generic stub.')
            modalTemplate = 'modals/stub.pug';
    }

    return await ctx.compileView(modalTemplate, modalParams);
}

module.exports = {
    settingsModal
}