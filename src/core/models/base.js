const { MODEL_TYPES, FIELD_TYPES, MODELS_META } = require('./metadata.js');
const { cacheImage } = require('./cacheData');

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

    isModelReadonly() {
        return this.metadata.readonly;
    }

    getModelDescription() {
        return this.metadata.description;
    }

    getFieldMetadata(field) {
        const metadata = this.metadata.fields[field] || {};
        return {
            ...metadata,
            readonly: this.isFieldReadonly(field)
        };
    }

    getPrimaryKeyName() {
        const fields = this.metadata.fields || {};
        for (const [name, value] of Object.entries(fields)) {
            if (value.type === 'id') {
                return name;
            }
        }

        this.logger.warn(`Primary key (type) missing from metadata fields for ${this.modelName}`);
        
        return null;
    }

    isFieldHidden(field) {
        return !!this.metadata.fields[field]?.hidden;
    }

    isFieldSensitive(field) {
        return !!this.metadata.fields[field]?.sensitive;
    }

    isFieldImmutable(field) {
        return this.metadata.fields[field]?.immutable;
    }

    isFieldComputed(field) {
        return !!this.metadata.fields[field]?.computed;
    }

    isFieldReadonly(field) {
        return this.metadata.fields[field]?.readonly === true || 
               this.isFieldComputed(field) ||
               this.isFieldImmutable(field) ||
               this.isModelReadonly();
    }

    _sanitizeData(data) {
        const sanitized = {};
        // GET ALL BOOLEAN FIELDS FROM METADATA
        const boolFields = Object.entries(this.metadata.fields)
            .filter(([_, meta]) => meta.type === FIELD_TYPES.BOOLEAN)
            .map(([key]) => key);
        
        // FIRST PASS: SET ALL BOOL FIELDS TO FALSE
        for (const key of boolFields) {
            sanitized[key] = false;
        }
    
        // SECOND PASS: PROCESS ALL FIELDS
        for (const [key, value] of Object.entries(data)) {
            // SKIP COMPUTED + IMMUTABLE + NON-EXISTENT FIELDS
            if (!this.metadata.fields[key] || 
                this.isFieldComputed(key) || 
                this.isFieldImmutable(key)) {
                this.logger.warn(`Field ${key} in ${this.modelName} (computed, immutable, or invalid)`);
                continue;
            }
    
            // GET FIELD TYPE FROM METADATA
            const fieldType = this.metadata.fields[key].type;
    
            // CONVERT VALUE BASED ON TYPE
            let convertedValue = value;
            switch (fieldType) {
                case FIELD_TYPES.BOOLEAN:
                    convertedValue = value === 'on' || value === 'true' || value === true;
                    break;
                case FIELD_TYPES.NUMBER:
                    convertedValue = Number(value);
                    if (isNaN(convertedValue)) {
                        this.logger.warn(`Invalid number value for ${key}: ${value}`);
                        convertedValue = 0;
                    }
                    const { min, max } = this.metadata.fields[key];
                    if (min !== undefined && convertedValue < min) {
                        this.logger.warn(`Value ${convertedValue} below minimum ${min} for ${key}`);
                        convertedValue = min;
                    }
                    if (max !== undefined && convertedValue > max) {
                        this.logger.warn(`Value ${convertedValue} above maximum ${max} for ${key}`);
                        convertedValue = max;
                    }
                    break;
                case FIELD_TYPES.STRING:
                    convertedValue = String(value);
                    break;
                case FIELD_TYPES.JSON:
                    if (typeof value === 'string') {
                        try {
                            convertedValue = JSON.parse(value);
                        } catch (err) {
                            this.logger.warn(`Invalid JSON for ${key}: ${value}`);
                            convertedValue = {};
                        }
                    }
                    break;
            }
    
            sanitized[key] = convertedValue;
        }
        return sanitized;
    }

    async _processCacheableFields(data, id) {
        const processed = { ...data };
        
        for (const [field, value] of Object.entries(data)) {
            const fieldMeta = this.metadata.fields[field];
            if (fieldMeta?.type === 'image' && fieldMeta.cacheFolder && value) {
                const cachedPath = await cacheImage(
                    value,
                    id,
                    fieldMeta.cacheFolder,
                    this.logger
                );
                if (cachedPath) processed[field] = cachedPath;
            }
        }

        return processed;
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

    async safeUpdateOne(pk, data) { // DONT OVERWRITE THIS
        const pkName = this.getPrimaryKeyName();
        
        if (!pk) {
            this.logger.error(`PRIMARY KEY MISSING FOR ${this.modelName}`);
            throw new Error('Primary key is required for update operation');
        }
    
        const sanitizedData = this._sanitizeData(data);
        const where = { [pkName]: pk };
    
        this.logger.debug(`Updating ${this.modelName}:`, { where, data: sanitizedData, raw: data });
        
        // CHECK IF RECORD EXISTS FIRST
        const exists = await this.model.findUnique({ where });
        if (!exists) {
            this.logger.error(`Record not found for ${this.modelName} with ${pkName}: ${pk}`);
            throw new Error(`Record not found with ${pkName}: ${pk}`);
        }
    
        return this.model.update({
            where,
            data: sanitizedData
        }).catch(err => {
            this.logger.error(`Error updating ${this.modelName}:`, err);
            throw err;
        });
    }
    
    async update(where = {}, data = {}, include = {}) {
        const pkName = this.getPrimaryKeyName();
        
        // ENSURE WHERE CLAUSE HAS UNIQUE IDENTIFIER
        if (!where[pkName]) {
            this.logger.error(`Missing ${pkName} in where clause for ${this.modelName} update`);
            throw new Error(`Primary key (${pkName}) is required in where clause`);
        }
    
        const sanitizedData = this._sanitizeData(data);
        
        // CHECK IF RECORD EXISTS
        const exists = await this.model.findFirst({ where });
        if (!exists) {
            this.logger.error(`No matching record found for ${this.modelName}`, where);
            throw new Error('No matching record found for update');
        }
    
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
    async safeUpsertOne(data) { // DONT OVERWRITE THIS
        const sanitizedData = this._sanitizeData(data);
        const pkName = this.getPrimaryKeyName();
        
        // IF NO ID PROVIDED, CREATE NEW
        if (!data[pkName]) {
            this.logger.debug(`Creating new ${this.modelName}:`, { data: sanitizedData });
            return this.model.create({
                data: sanitizedData
            });
        }
    
        // IF ID EXISTS, UPDATE
        this.logger.debug(`Updating ${this.modelName}:`, { 
            where: { [pkName]: data[pkName] },
            data: sanitizedData
        });
        
        return this.model.upsert({
            where: { [pkName]: data[pkName] },
            create: sanitizedData,
            update: sanitizedData
        });
    }

    async upsert(where = {}, create = {}, update = {}, include = {}) {
        const sanitizedUpdate = this._sanitizeData(update);
        const pkName = this.getPrimaryKeyName();
        
        // IF NO ID IN WHERE CLAUSE, FALLBACK TO CREATE
        if (!where[pkName]) {
            this.logger.debug(`No ID provided for upsert, creating new ${this.modelName}:`, { 
                data: create 
            });
            return this.model.create({
                data: create,
                include
            }).catch(err => {
                this.logger.error(`Error creating ${this.modelName}:`, err);
                throw err;
            });
        }
    
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

    // FORM GENERATORS
    getVisibleFields() {
        return Object.entries(this.metadata.fields)
            .filter(([_, meta]) => !meta.hidden)
            .map(([field]) => ({
                key: field,
                metadata: this.getFieldMetadata(field)
            }));
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

    _processRecordFields(record) {
        const fields = {};
        
        for (const [key, meta] of Object.entries(this.metadata.fields)) {
            // SKIP HIDDEN FIELDS AND RELATIONS
            if (meta.hidden || meta.type === 'RELATION') continue;

            fields[key] = {
                value: record[key],
                type: meta.type,
                label: meta.label || this._formatFieldName(key),
                description: meta.description,
                readonly: this.isFieldReadonly(key),
                required: meta.required,
                sensitive: meta.sensitive,
                min: meta.min,
                max: meta.max
            };
        }

        return fields;
    }

    _formatFieldName(key) {
        return key.split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    getFormData(data) {
        if (!data) {
            return null;
        }

        const keyName = this.getPrimaryKeyName();

        // HANDLE ARRAY OF RECORDS VS SINGLE RECORD
        if (Array.isArray(data)) {
            return data.map((record) => ({
                id: record[keyName],
                fields: this._processRecordFields(record)
            }));
        }

        // SINGLE RECORD
        return this._processRecordFields(data);
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
}

module.exports = BaseModel;
