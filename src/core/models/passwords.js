const crypto = require('crypto');

// SCRYPT PASSWORD HASHING, FORMAT: scrypt$<salt-hex>$<hash-hex>
const KEY_LENGTH = 64;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function isHashed(value) {
  return typeof value === 'string' && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(value);
}

function verifyPassword(plain, stored) {
  if (!plain || !isHashed(stored)) return false;
  const [, salt, hash] = stored.split('$');
  const candidate = crypto.scryptSync(String(plain), salt, KEY_LENGTH);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

module.exports = { hashPassword, verifyPassword, isHashed };
