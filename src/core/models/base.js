const { MODEL_TYPES, FIELD_TYPES, MODELS_META } = require('./metadata.js');
const { cacheImage } = require('./cacheData');
const { _ } = require('lodash');

class BaseModel {
    constructor(core, modelName) {
        this.core = core;
        this.prisma = core.prisma;
        this.logger = core.logger;
        this.modelName = modelName;
        this.model = this.prisma[modelName];
        this.metadata = MODELS_META[modelName] || { type: MODEL_TYPES.ENTITY, fields: {} };
    }

    // METADATA HELPERS
    getModelType() { return this.metadata.type; }
    isModelReadonly() { return this.metadata.readonly; }
    getModelDescription() { return this.metadata.description; }
    
    getPrimaryKeyName() {
        return Object.entries(this.metadata.fields || {})
            .find(([_, v]) => v.type === 'id')?.[0] || null;
    }

    getFieldMetadata(field) {
        const metadata = this.metadata.fields[field] || {};
        return { ...metadata, readonly: this.isFieldReadonly(field) };
    }

    // FIELD STATE CHECKS
    isFieldHidden(field) { return !!this.metadata.fields[field]?.hidden; }
    isFieldSensitive(field) { return !!this.metadata.fields[field]?.sensitive; }
    isFieldImmutable(field) { return this.metadata.fields[field]?.immutable; }
    isFieldComputed(field) { return !!this.metadata.fields[field]?.computed; }
    isFieldReadonly(field) {
        return this.metadata.fields[field]?.readonly === true || 
               this.isFieldComputed(field) ||
               this.isFieldImmutable(field) ||
               this.isModelReadonly();
    }

    // DATA PROCESSING
    async _processCacheableFields(data, id) {
        const processed = { ...data };
        for (const [field, value] of Object.entries(data)) {
            const fieldMeta = this.metadata.fields[field];
            if (fieldMeta?.type === 'image' && fieldMeta.cacheFolder && value) {
                const cachedPath = await cacheImage(value, id, fieldMeta.cacheFolder, this.logger);
                if (cachedPath) processed[field] = cachedPath;
            }
        }
        return processed;
    }

    // CRUD OPERATIONS
    async create(data = {}, include = {}) {
        return this.model.create({ data, include })
            .catch(this._handleError('create'));
    }

    async findFirst(where = {}, include = {}, select = null) {
        return this.model.findFirst({ where, include, ...(select && { select }) })
            .catch(this._handleError('findFirst'));
    }

    async getMany(where = {}, include = {}, orderBy = {}, select = null) {
        return this.model.findMany({ where, include, orderBy, ...(select && { select }) })
            .catch(this._handleError('getMany'));
    }

    async update(where = {}, data = {}, include = {}) {
        const pkName = this.getPrimaryKeyName();
        if (!where[pkName]) throw new Error('PRIMARY_KEY_REQUIRED');

        const sanitizedData = this._sanitizeData(data);
        const exists = await this.model.findFirst({ where });
        if (!exists) throw new Error('RECORD_NOT_FOUND');

        return this.model.update({ where, data: { ...where, ...data}, include })
            .catch(this._handleError('update'));
    }

    async upsert(where = {}, create = {}, update = {}, include = {}) {
        const sanitizedUpdate = this._sanitizeData(update);
        const pkName = this.getPrimaryKeyName();
        
        if (!where[pkName]) {
            return this.model.create({
                data: create,
                include
            }).catch(err => {
                this.logger.error(`Error creating ${this.modelName}:`, err);
                throw err;
            });
        }
     
        return this.model.upsert({
            where,
            create: create,
            update: {...sanitizedUpdate, ...create},
            include,
        }).catch(err => {
            this.logger.error(`Error upserting ${this.modelName}:`, err); 
            throw err;
        });
     }

    async delete(where = {}) {
        return this.model.delete({ where }).catch(this._handleError('delete'));
    }

    async deleteMany(where = {}) {
        return this.model.deleteMany({ where }).catch(this._handleError('deleteMany'));
    }

    // UTILITY OPERATIONS
    async get(where = {}, include = {}) {
        return this.findFirst(where, include);
    }

    async getOrCreate(where = {}, create = {}, include = {}) {
        const existing = await this.findFirst(where, include);
        return existing || this.create({ ...where, ...create }, include);
    }

    async transaction(operations = []) {
        return this.prisma.$transaction(operations).catch(this._handleError('transaction'));
    }

    async getSingleton(defaultData = {}, include = {}) {
        if (this.getModelType() !== MODEL_TYPES.SINGLETON) {
            throw new Error('NOT_SINGLETON');
        }
        const record = await this.model.findFirst({ include });
        return record || this.create(defaultData, include);
    }

    // SAFE OPS
    async safeUpdateOne(pk, data) {
        const pkName = this.getPrimaryKeyName();
        if (!pk) throw new Error('PRIMARY_KEY_REQUIRED');
    
        const existing = await this.model.findUnique({ where: { [pkName]: pk } });
        if (!existing) throw new Error(`RECORD_NOT_FOUND: ${pkName}=${pk}`);
    
        const sanitizedData = this._sanitizeData(data, existing);
        return this.model.update({
            where: { [pkName]: pk },
            data: {...sanitizedData, [pkName]: pk}
        }).catch(this._handleError('safeUpdateOne'));
    }

    async safeUpsertOne(data) {
        const pkName = this.getPrimaryKeyName();
        const pk = data[pkName];
        if (pk) {
            const existing = await this.model.findUnique({ where: { [pkName]: pk } });
            const sanitizedData = this._sanitizeData(data, existing);
            return this.model.upsert({
                where: { [pkName]: pk },
                create: { [pkName]: pk, ...sanitizedData },
                update: sanitizedData
            })
        }

        return this.model.create({ data: { [pkName]: pk, ...this._sanitizeData(data) }});
            
    }

    // DATA SANITIZATION
    _sanitizeData(data, existingData = {}) {
        const sanitized = { ...existingData };
        const errors = [];
    
        // PROCESS ALL METADATA FIELDS
        Object.entries(this.metadata.fields).forEach(([key, meta]) => {
            if (meta.computed || [FIELD_TYPES.RELATION, FIELD_TYPES.ID].includes(meta.type)) return;
            
            try {
                const value = key in data ? data[key] : null;
                sanitized[key] = this._convertValue(value, meta.type, meta.min);
            } catch (err) {
                errors.push(`${key}: ${err.message}`);
            }
        });
    
        if (errors.length) throw new Error(`VALIDATION_ERRORS: ${errors.join(', ')}`);
        return sanitized;
    }

    _convertValue(value, type, min) {
        // HANDLE ALL FALSY VALUES
        if (!value) {
            return type === FIELD_TYPES.NUMBER ? (min || 0) :
                   type === FIELD_TYPES.BOOLEAN ? false :
                   type === FIELD_TYPES.STRING || type === FIELD_TYPES.IMAGE ? '' : 
                   null;
        }

        // CONVERT NON-FALSY VALUES
        switch (type) {
            case FIELD_TYPES.BOOLEAN:
                return ['true', 'on', 'yes', '1', 1].includes(String(value).toLowerCase().trim());
            case FIELD_TYPES.NUMBER:
                const num = Number(value);
                return isNaN(num) ? (min || 0) : num;
            case FIELD_TYPES.STRING:
            case FIELD_TYPES.IMAGE:
                return String(value).trim();
            case FIELD_TYPES.JSON:
                return typeof value === 'string' ? JSON.parse(value) : value;
            default:
                return value;
        }
    }

    getFormData(data) {
        if (!data) return null;
        const processFields = (record) => Object.entries(this.metadata.fields)
            .reduce((acc, [key, meta]) => {
                if (!meta.hidden && meta.type !== 'RELATION') {
                    acc[key] = {
                        value: record[key],
                        type: meta.type,
                        label: meta.label || key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
                        description: meta.description,
                        readonly: this.isFieldReadonly(key),
                        required: meta.required,
                        sensitive: meta.sensitive,
                        min: meta.min,
                        max: meta.max
                    };
                }
                return acc;
            }, {});

        return Array.isArray(data) ? 
            data.map(record => ({
                id: record[this.getPrimaryKeyName()],
                fields: processFields(record)
            })) : 
            processFields(data);
    }

    _handleError(operation) {
        return err => {
            this.logger.error(`${operation.toUpperCase()}_ERROR: ${this.modelName}`, err);
            throw err;
        };
    }

    async getPages(where = {}, include = {}, orderBy = {}, skip = 0, perPage = 5, select = null) {
        if (this.getModelType() === MODEL_TYPES.SINGLETON) {
            return this.getFormData(await this.getSingleton(this.defaults, include));
        }
    
        const options = {
            take: perPage,
            skip: skip,
            where,
            include,
            orderBy,
            ...(select && { select })
        };
    
        try {
            const query = await this.model.findMany(options);
            return this.getFormData(query);
        } catch (err) {
            this.logger.error(`Error in ${this.modelName}.getPages:`, err);
            throw err;
        }
    }

    async searchFields(query) {
        const searchableFields = Object.entries(this.metadata.fields)
            .filter(([_, meta]) => !meta.hidden && meta.searchable)
            .map(([field]) => field);
    
        return searchableFields.length === 0 ? {} : {
            where: {
                OR: searchableFields.map(field => ({
                    [field]: { contains: query }
                }))
            }
        };
    }
    
    async safeDelete(id) {
        const pkName = this.getPrimaryKeyName();
        if (!id) throw new Error('PRIMARY_KEY_REQUIRED');
    
        const record = await this.model.findUnique({ where: { [pkName]: id } });
        if (!record) throw new Error(`RECORD_NOT_FOUND: ${pkName}=${id}`);
        if (this.isModelReadonly()) throw new Error('READONLY_MODEL');
    
        return this.delete({ [pkName]: id });
    }
}

module.exports = BaseModel;