'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const localEnvironment = path.join(root, '.env.local');

if (fs.existsSync(localEnvironment)) {
  for (const rawLine of fs.readFileSync(localEnvironment, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

require('../TutorPlatform/server.js');
