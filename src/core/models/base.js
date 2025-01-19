const { MODEL_TYPES, FIELD_TYPES, MODELS_META } = require('./metadata.js');

// BASE FOR ALL THE OTHER MODELS
class BaseModel {
    constructor(core, modelName) {
        this.core = core;
        this.prisma = core.prisma;
        this.logger = core.logger;
        this.modelName = modelName;
        this.model = this.prisma[modelName];
        this.metadata = MODELS_META[modelName] || { 
            type: MODEL_TYPES.ENTITY, 
            fields: {} 
        };
    }

    // CHECK FIELD METADATA FOR TYPE RULES + VALIDATION
    getModelType() {
        return this.metadata.type;
    }

    getModelDescription() {
        return this.metadata.description;
    }

    getFieldMetadata(field) {
        return this.metadata.fields[field];
    }

    isFieldHidden(field) {
        return !!this.metadata.fields[field]?.hidden;
    }

    isFieldSensitive(field) {
        return !!this.metadata.fields[field]?.sensitive;
    }

    isFieldImmutable(field) {
        return this.metadata.fields[field]?.immutable === true;
    }

    isFieldComputed(field) {
        return !!this.metadata.fields[field]?.computed;
    }

    _sanitizeData(data) {
        const sanitized = {};
        for (const [key, value] of Object.entries(data)) {
            // SKIP COMPUTED + IMMUTABLE + NON-EXISTENT FIELDS
            if (!this.metadata.fields[key] || 
                this.isFieldComputed(key) || 
                this.isFieldImmutable(key)) {
                this.logger.warn(`Field ${key} in ${this.modelName} (computed, immutable, or invalid)`);
                //continue;
            }

            // VALIDATE TYPE STUFF
            if (this.metadata.fields[key].type === FIELD_TYPES.NUMBER) {
                const { min, max } = this.metadata.fields[key];
                if (min !== undefined && value < min) {
                    this.logger.warn(`Value ${value} below minimum ${min} for ${key}`);
                    sanitized[key] = min;
                    continue;
                }
                if (max !== undefined && value > max) {
                    this.logger.warn(`Value ${value} above maximum ${max} for ${key}`);
                    sanitized[key] = max;
                    continue;
                }
            }

            sanitized[key] = value;
        }
        return sanitized;
    }

    // CRUD
    async create(data = {}, include = {}) {
        if (this.getModelType() === MODEL_TYPES.LOG) {
            this.logger.debug(`Creating log entry in ${this.modelName}:`, data);
        } else {
            this.logger.debug(`Creating ${this.modelName}:`, data);
        }

        return this.model.create({
            data,
            include,
        }).catch(err => {
            this.logger.error(`Error creating ${this.modelName}:`, err);
            throw err;
        });
    }

    async findFirst(where = {}, include = {}, select = null) {
        const options = {
            where,
            include,
            ...(select && { select })
        };

        return this.model.findFirst(options).catch(err => {
            this.logger.error(`Error fetching ${this.modelName}:`, err);
            throw err;
        });
    }

    async getMany(where = {}, include = {}, orderBy = {}, select = null) {
        const options = {
            where,
            include,
            orderBy,
            ...(select && { select })
        };

        return this.model.findMany(options).catch(err => {
            this.logger.error(`Error fetching multiple ${this.modelName}:`, err);
            throw err;
        });
    }

    async update(where = {}, data = {}, include = {}) {
        const sanitizedData = this._sanitizeData(data);
        this.logger.debug(`Updating ${this.modelName}:`, { where, data: sanitizedData });
        return this.model.update({
            where,
            data: sanitizedData,
            include,
        }).catch(err => {
            this.logger.error(`Error updating ${this.modelName}:`, err);
            throw err;
        });
    }

    async upsert(where = {}, create = {}, update = {}, include = {}) {
        const sanitizedUpdate = this._sanitizeData(update);
        this.logger.debug(`Upserting ${this.modelName}:`, { 
            where, 
            create: create, 
            update: sanitizedUpdate 
        });
        return this.model.upsert({
            where,
            create: create,
            update: sanitizedUpdate,
            include,
        }).catch(err => {
            this.logger.error(`Error upserting ${this.modelName}:`, err);
            throw err;
        });
    }

    async delete(where = {}) {
        this.logger.warn(`Deleting ${this.modelName}:`, where);
        return this.model.delete({
            where,
        }).catch(err => {
            this.logger.error(`Error deleting ${this.modelName}:`, err);
            throw err;
        });
    }

    async deleteMany(where = {}) {
        this.logger.warn(`Deleting multiple ${this.modelName}:`, where);
        return this.model.deleteMany({
            where,
        }).catch(err => {
            this.logger.error(`Error deleting multiple ${this.modelName}:`, err);
            throw err;
        });
    }

    async get(where = {}, include = {}) {
        const existing = await this.findFirst(where, include);
        if (!existing) {
            return null;
        }
        return existing;
    }

    async getOrCreate(where = {}, create = {}, include = {}) {
        const existing = await this.findFirst(where, include);
        if (!existing) {
            return this.create({ ...where, ...create }, include);
        }
        return existing;
    }

    async transaction(operations = []) {
        return this.prisma.$transaction(operations).catch(err => {
            this.logger.error(`Error in ${this.modelName} transaction:`, err);
            throw err;
        });
    }

    // SINGLETON MODELS
    async getSingleton(defaultData = {}, include = {}) {
        if (this.getModelType() !== MODEL_TYPES.SINGLETON) {
            throw new Error(`Model ${this.modelName} is not a singleton`);
        }

        const record = await this.model.findFirst({ include });
        if (!record) {
            this.logger.warn(`No ${this.modelName} found. Creating default.`);
            return this.create(defaultData, include);
        }
        return record;
    }

    // HELPERS
    getVisibleFields() {
        return Object.entries(this.metadata.fields)
            .filter(([_, meta]) => !meta.hidden)
            .map(([field]) => field);
    }

    getEditableFields() {
        return Object.entries(this.metadata.fields)
            .filter(([_, meta]) => meta.mutable !== false && !meta.computed)
            .map(([field]) => field);
    }

    getSanitizedData(data, excludeSensitive = true) {
        const sanitized = {};
        for (const [key, value] of Object.entries(this._sanitizeData(data))) {
            if (!this.isFieldHidden(key) && 
                (!excludeSensitive || !this.isFieldSensitive(key))) {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }
}

module.exports = BaseModel;
