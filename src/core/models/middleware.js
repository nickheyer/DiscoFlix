const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const _ = require('lodash');

const cacheRoot = path.resolve(__dirname, '../../../.cache');

const cacheImage = async (imageUrl, id, folder = 'images') => {
    if (!imageUrl) return null;

    try {
        const cacheDir = path.join(cacheRoot, folder);
        await fs.mkdir(cacheDir, { recursive: true });

        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const ext = path.extname(imageUrl) || '.png';
        const fileName = `${id}${ext}`;
        const filePath = path.join(cacheDir, fileName);
        await fs.writeFile(filePath, response.data);

        const staticPath = path.join(folder, fileName);
        return staticPath;
    } catch (error) {
        console.error('Error caching image:', error);
        return null;
    }
};

module.exports = (core) => {
    const prisma = core.prisma;
    const logger = core.logger;
    
    prisma.$use(async (params, next) => {
        if (['create', 'update', 'upsert'].includes(params.action)) {
            const model = params.model;
            const operationData = {};
            const operationKeys = params.action === 'upsert' ? ['create', 'update'] : ['data'];
            operationKeys.forEach((key) => Object.assign(operationData, params.args[key]));
     
            if (!_.isEmpty(operationData)) {
                const imageFields = Object.keys(operationData).filter((field) => field.endsWith('_url'));
                if (!imageFields.length > 0) {
                    return next(params);
                }

                const idFields = Object.keys(operationData).filter((field) => field.endsWith('_id'));
                logger.debug(`[${params.action}] Detected fields for model ${model}:`, { imageFields, idFields });

                for (const field of imageFields) {
                    if (operationData[field]) {
                        const id =
                            operationData[idFields[0]] ||
                            params.args.where?.id ||
                            Date.now(); // FALLBACK TO TIMESTAMP ID
    
                        const cachedPath = await cacheImage(
                            operationData[field],
                            id,
                            `${model.toLowerCase()}_images`
                        );
    
                        if (cachedPath) {
                            operationKeys.forEach((key) => params.args[key][field] = cachedPath);
                            logger.info(`[${params.action}] Cached ${field} for ${model} (${id}): ${cachedPath}`);
                        }
                    }
                }
            }
        }
    
        return next(params);
    });
    
    logger.info('Prisma middleware initialized');
};
