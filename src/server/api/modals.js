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
            switch (modalName) {
                case 'discord':
                    const discordBot = await ctx.core.discordBot.get();
                    modalParams = {
                        title: 'Discord Settings',
                        icon: 'discord',
                        settings: discordBot,
                        modalName
                    };
                    modalTemplate = `modals/${modalType}/readonly.pug`;
                    break;
                case 'media':
                    const config = await ctx.core.configuration.get();
                    modalParams = {
                        title: 'Media Settings',
                        icon: 'film',
                        settings: config,
                        modalName
                    };
                    modalTemplate = `modals/${modalType}/dynamic.pug`;
                    break;
                case 'user':
                case 'permissions':
                case 'server':
                    modalTemplate = `modals/${modalType}/standard.pug`;
                    modalParams = Object.assign(modalParams, {
                        modalName,
                        modalType,
                        backwardTest: modalName.split('').reverse().join('')
                    })
                    break;
                default:
                    global.logger.debug('Unknown modal type, returning generic stub.')
                    modalTemplate = 'modals/stub.pug';
            }
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

    global.logger.debug({
        modalTemplate,
        modalType,
        modalName,
        modalParams
    });
    return await ctx.compileView(modalTemplate, modalParams);
}

module.exports = {
    settingsModal
}