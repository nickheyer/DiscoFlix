const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// CACHE CONFIG
const DEFAULT_CONFIG = {
    cacheRoot: path.resolve(__dirname, '../../../.cache'),
    maxRetries: 3,
    timeout: 5000,
    maxSize: 5 * 1024 * 1024,
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    defaultExtension: '.png'
};

// VALIDATE IMAGE
const validateImage = async (buffer, maxSize) => {
    return buffer && buffer.length > 0 && buffer.length <= maxSize;
};

// ENSURE DIR EXISTS
const ensureCacheDirectory = async (cacheDir, logger) => {
    try {
        await fs.mkdir(cacheDir, { recursive: true });
        return true;
    } catch (error) {
        logger.error('Failed to create cache directory:', error);
        return false;
    }
};

// CACHE IMAGE
const cacheImage = async (imageUrl, id, cacheFolder, logger) => {
    if (!imageUrl || !cacheFolder) return null;

    const cacheDir = path.join(DEFAULT_CONFIG.cacheRoot, cacheFolder);
    let retries = 0;

    while (retries < DEFAULT_CONFIG.maxRetries) {
        try {
            if (!await ensureCacheDirectory(cacheDir, logger)) {
                return null;
            }

            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: DEFAULT_CONFIG.timeout
            });

            if (!await validateImage(response.data, DEFAULT_CONFIG.maxSize)) {
                logger.warn('Invalid image:', { url: imageUrl, size: response.data.length });
                return null;
            }

            let ext = path.extname(imageUrl).toLowerCase();
            if (!ext || !DEFAULT_CONFIG.allowedExtensions.includes(ext)) {
                ext = DEFAULT_CONFIG.defaultExtension;
            }

            const fileName = `${id}${ext}`;
            const filePath = path.join(cacheDir, fileName);
            await fs.writeFile(filePath, response.data);

            const staticPath = path.join(cacheFolder, fileName);
            logger.debug('Image cached:', { path: staticPath });
            return staticPath;

        } catch (error) {
            retries++;
            logger.warn(`Cache attempt ${retries}/${DEFAULT_CONFIG.maxRetries} failed:`, {
                url: imageUrl,
                error: error.message
            });

            if (retries === DEFAULT_CONFIG.maxRetries) {
                logger.error('Max retries reached:', { url: imageUrl });
                return null;
            }

            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000));
        }
    }

    return null;
};

// CLEAN OLD CACHE
const cleanOldCache = async (logger, maxAge = 7 * 24 * 60 * 60 * 1000) => {
    try {
        const files = await fs.readdir(DEFAULT_CONFIG.cacheRoot);
        const now = Date.now();

        for (const file of files) {
            const filePath = path.join(DEFAULT_CONFIG.cacheRoot, file);
            const stats = await fs.stat(filePath);

            if (now - stats.mtime.getTime() > maxAge) {
                await fs.unlink(filePath);
                logger.debug(`Cleaned old cache: ${file}`);
            }
        }
    } catch (error) {
        logger.warn('Cache cleanup failed:', error);
    }
};

module.exports = {
    cacheImage,
    cleanOldCache
};
