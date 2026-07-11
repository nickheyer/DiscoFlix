// BUILDS A core.<namespace> OBJECT FROM ONE OR MORE METHOD BAGS.
// INSIDE A NAMESPACE METHOD: `this.<method>` = sibling in the same namespace,
// `this.core` = the CoreService spine, `this.logger` = shared logger.
module.exports = function createNamespace(core, ...methodBags) {
  return Object.assign({ core, logger: core.logger }, ...methodBags);
};
