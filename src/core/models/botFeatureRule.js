const BaseModel = require('./base');

// PER-FEATURE BOT GRANTS - ONE ROW PER (feature_id, server_id) SCOPE.
// server_id NULL = THE GLOBAL RULE, SET = A PER-SERVER OVERRIDE THAT WINS
// OUTRIGHT. SQLITE'S UNIQUE INDEX TREATS NULLS AS DISTINCT, SO upsertRule'S
// findFirst -> update/create PATH IS THE REAL DUPLICATE-GLOBAL GUARD - KEEP
// EVERY WRITE ON IT.
class BotFeatureRule extends BaseModel {
  constructor(core) {
    super(core, 'BotFeatureRule');
  }

  async allRules() {
    return this.getMany({});
  }

  async upsertRule(featureId, serverId, data = {}) {
    const scope = { feature_id: featureId, server_id: serverId || null };
    const existing = await this.findFirst(scope);
    if (existing) return this.update({ id: existing.id }, data);
    return this.create({ ...scope, ...data });
  }

  async deleteRule(featureId, serverId) {
    return this.deleteMany({ feature_id: featureId, server_id: serverId || null });
  }
}

module.exports = BotFeatureRule;
