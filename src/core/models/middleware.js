const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const _ = require('lodash');

const DEFAULT_CONFIG = {
  cacheRoot: path.resolve(__dirname, '../../../.cache'),
  maxRetries: 3,
  timeout: 5000,
  maxSize: 5 * 1024 * 1024, // 5MB
  allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  defaultExtension: '.png'
};

// IMAGE CACHE UTILITIES
const validateImage = async (buffer, config) => {
  // SKIP EMPTY OR OVERSIZED IMAGES
  if (!buffer || buffer.length === 0) return false;
  if (buffer.length > config.maxSize) return false;
  return true;
};

const ensureCacheDirectory = async (cacheDir, logger) => {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    return true;
  } catch (error) {
    logger.error('Failed to create cache directory:', error);
    return false;
  }
};

const cleanOldCache = async (cacheDir, logger, maxAge = 7 * 24 * 60 * 60 * 1000) => {
  try {
    const files = await fs.readdir(cacheDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      const stats = await fs.stat(filePath);

      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
        logger.debug(`Cleaned old cached file: ${file}`);
      }
    }
  } catch (error) {
    logger.warn('Old cache not found, skipping:', error);
  }
};

const cacheImage = async (imageUrl, id, folder, config, logger) => {
  if (!imageUrl) return null;

  const cacheDir = path.join(config.cacheRoot, folder);
  let retries = 0;

  while (retries < config.maxRetries) {
    try {
      // ENSURE CACHE DIRECTORY EXISTS
      if (!await ensureCacheDirectory(cacheDir, logger)) {
        return null;
      }

      // FETCH IMAGE WITH TIMEOUT
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: config.timeout
      });

      // VALIDATE IMAGE
      if (!await validateImage(response.data, config)) {
        logger.warn('Invalid image data received:', { url: imageUrl, size: response.data.length });
        return null;
      }

      // DETERMINE FILE EXTENSION
      let ext = path.extname(imageUrl).toLowerCase();
      if (!ext || !config.allowedExtensions.includes(ext)) {
        ext = config.defaultExtension;
      }

      // SAVE IMAGE
      const fileName = `${id}${ext}`;
      const filePath = path.join(cacheDir, fileName);
      await fs.writeFile(filePath, response.data);

      const staticPath = path.join(folder, fileName);
      logger.debug('Image cached successfully:', { path: staticPath, size: response.data.length });
      return staticPath;

    } catch (error) {
      retries++;
      logger.warn(`Failed to cache image (attempt ${retries}/${config.maxRetries}):`, {
        url: imageUrl,
        error: error.message
      });

      if (retries === config.maxRetries) {
        logger.error('Max retries reached for image caching:', { url: imageUrl });
        return null;
      }

      // EXPONENTIAL BACKOFF
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000));
    }
  }

  return null;
};

// MW INITIALIZATION
module.exports = (core) => {
  const prisma = core.prisma;
  const logger = core.logger;
  const config = { ...DEFAULT_CONFIG, ...core.config?.cache };

  // CLEAN OLD CACHE ON STARTUP
  cleanOldCache(config.cacheRoot, logger);

  // REGISTER MW
  prisma.$use(async (params, next) => {
    if (['create', 'update', 'upsert'].includes(params.action)) {
      const model = params.model;
      const operationData = {};
      const operationKeys = params.action === 'upsert' ? ['create', 'update'] : ['data'];

      try {
        // COLLECT OPERATION DATA
        operationKeys.forEach((key) => Object.assign(operationData, params.args[key]));

        if (!_.isEmpty(operationData)) {
          // DETECT IMAGE AND ID FIELDS
          const imageFields = Object.keys(operationData).filter((field) => field.endsWith('_url'));
          if (!imageFields.length) {
            return next(params);
          }

          const idFields = Object.keys(operationData).filter((field) => field.endsWith('_id'));
          logger.debug(`[${params.action}] Processing fields for ${model}:`, { imageFields, idFields });

          // FOR EVERY IMAGE FIELD
          for (const field of imageFields) {
            if (operationData[field]) {
              // ID FOR CACHE
              const id = operationData[idFields[0]] || 
                        params.args.where?.id || 
                        Date.now();

              // CACHE IMAGE
              const cachedPath = await cacheImage(
                operationData[field],
                id,
                `${model.toLowerCase()}_images`,
                config,
                logger
              );

              // UPDATE WITH CACHED PATH
              if (cachedPath) {
                operationKeys.forEach((key) => params.args[key][field] = cachedPath);
                logger.info(`[${params.action}] Cached ${field} for ${model}:`, { id, path: cachedPath });
              }
            }
          }
        }
      } catch (error) {
        logger.error('Error in image caching middleware:', {
          model,
          action: params.action,
          error: error.message
        });
      }
    }

    return next(params);
  });

  logger.info('Prisma middleware initialized with config:', _.omit(config, ['maxSize']));
};
