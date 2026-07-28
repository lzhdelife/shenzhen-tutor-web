'use strict';

const { pbkdf2 } = require('@noble/hashes/pbkdf2');
const { sha256 } = require('@noble/hashes/sha256');

function derive(password, salt, iterations = 210000) {
  return pbkdf2(sha256, String(password || ''), String(salt || ''), { c: iterations, dkLen: 32 });
}

module.exports = { derive };
