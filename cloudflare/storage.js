'use strict';

const JSON_FIELDS = new Set(['preferences_json', 'structured_json', 'queries_json', 'candidates_json', 'options_json', 'value_json']);

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function camel(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function mapRow(row) {
  if (!row) return null;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    const outputKey = key === 'preferences_json' ? 'preferences' : camel(key);
    const fallback = ['queries_json', 'candidates_json', 'options_json'].includes(key) ? [] : key === 'value_json' ? null : {};
    result[outputKey] = JSON_FIELDS.has(key) ? parseJson(value, fallback) : value;
  }
  return result;
}

function mapOrder(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  const structured = mapped.structuredJson || {};
  const order = { ...structured, ...mapped };
  delete order.structuredJson;
  if ('verified' in order) order.locationVerified = Boolean(order.verified);
  if ('place' in order) {
    order.placeOriginal = order.originalPlace || '';
    order.locationStatus = order.locationRowStatus || '';
    order.locationPoiId = order.poiId || '';
    order.locationCoordinates = order.coordinates || '';
    order.locationAddress = order.resolvedAddress || '';
    order.locationConfidence = order.confidence;
    order.locationQuery = order.queryText || '';
    order.locationQueries = order.queriesJson || [];
    order.locationCandidates = order.candidatesJson || [];
    order.locationOptions = order.optionsJson || [];
    order.locationRelation = order.relation || '';
    for (const key of ['verified', 'originalPlace', 'locationRowStatus', 'poiId', 'coordinates', 'resolvedAddress', 'confidence', 'queryText', 'queriesJson', 'candidatesJson', 'optionsJson', 'relation']) delete order[key];
  }
  return order;
}

function rowsOf(result) {
  return result && Array.isArray(result.results) ? result.results : [];
}

function createRepository(env = {}) {
  const db = env.DB || env.D1;
  const bucket = env.BUCKET || env.R2;
  if (!db || typeof db.prepare !== 'function') throw new Error('Cloudflare D1 binding is required as env.DB (or env.D1)');

  const first = async (sql, values = []) => db.prepare(sql).bind(...values).first();
  const all = async (sql, values = []) => rowsOf(await db.prepare(sql).bind(...values).all());
  const run = async (sql, values = []) => db.prepare(sql).bind(...values).run();
  const locationSelect = `SELECT o.*, l.place, l.address, l.original_place, l.verified,
    l.status AS location_row_status, l.poi_id, l.coordinates, l.resolved_address, l.confidence,
    l.query_text, l.queries_json, l.candidates_json, l.options_json, l.relation
    FROM orders o LEFT JOIN order_locations l ON l.order_id = o.id`;

  async function getUserById(id) {
    return mapRow(await first('SELECT * FROM users WHERE id = ?', [id]));
  }

  async function getUserByPhone(phone) {
    return mapRow(await first('SELECT * FROM users WHERE phone = ? ORDER BY created_at LIMIT 1', [phone]));
  }

  async function getUserByWechatIdentityHash(identityHash) {
    return mapRow(await first('SELECT * FROM users WHERE wechat_identity_hash = ? LIMIT 1', [identityHash]));
  }

  async function listUsers(filters = {}) {
    const clauses = [], values = [];
    for (const [key, column] of [['role', 'role'], ['phone', 'phone'], ['name', 'name']]) {
      if (filters[key] !== undefined) { clauses.push(`${column} = ?`); values.push(filters[key]); }
    }
    return (await all(`SELECT * FROM users${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`, values)).map(mapRow);
  }

  async function createUser(input) {
    const timestamp = input.createdAt || nowIso();
    const user = {
      id: input.id || makeId('u'), role: input.role, name: input.name, phone: input.phone || '',
      passwordHash: input.passwordHash || null, wechatIdentityHash: input.wechatIdentityHash || null,
      preferences: input.preferences || {}, createdAt: timestamp, updatedAt: input.updatedAt || timestamp
    };
    await run(`INSERT INTO users (id, role, name, phone, password_hash, wechat_identity_hash, preferences_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, user.role, user.name, user.phone, user.passwordHash,
      user.wechatIdentityHash, JSON.stringify(user.preferences), user.createdAt, user.updatedAt]);
    return getUserById(user.id);
  }

  async function updateUser(id, patch) {
    const columns = { role: 'role', name: 'name', phone: 'phone', passwordHash: 'password_hash', wechatIdentityHash: 'wechat_identity_hash', preferences: 'preferences_json' };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    if (!entries.length) return getUserById(id);
    const values = entries.map(([key, value]) => key === 'preferences' ? JSON.stringify(value || {}) : value);
    await run(`UPDATE users SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...values, nowIso(), id]);
    return getUserById(id);
  }

  async function deleteUser(id) {
    return run('DELETE FROM users WHERE id = ?', [id]);
  }

  async function createSession(input) {
    if (!input.tokenHash) throw new Error('tokenHash is required; plaintext session tokens must not be persisted');
    const session = { tokenHash: input.tokenHash, userId: input.userId, expiresAt: Number(input.expiresAt), ip: input.ip || '', userAgent: input.userAgent || '', createdAt: input.createdAt || nowIso() };
    await run(`INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET user_id=excluded.user_id,
      expires_at=excluded.expires_at, ip=excluded.ip, user_agent=excluded.user_agent`, Object.values(session));
    return mapRow(await first('SELECT * FROM sessions WHERE token_hash = ?', [session.tokenHash]));
  }

  async function getSessionByTokenHash(tokenHash) {
    return mapRow(await first('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', [tokenHash, Date.now()]));
  }

  async function deleteSessionByTokenHash(tokenHash) {
    return run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  function locationFrom(input, updatedAt) {
    return [input.place || '', input.address || '', input.placeOriginal || '', input.locationVerified ? 1 : 0,
      input.locationStatus || '', input.locationPoiId || '', input.locationCoordinates || '', input.locationAddress || '',
      input.locationConfidence ?? null, input.locationQuery || '', JSON.stringify(input.locationQueries || []),
      JSON.stringify(input.locationCandidates || []), JSON.stringify(input.locationOptions || []), input.locationRelation || '', updatedAt];
  }

  async function getOrderById(id) {
    return mapOrder(await first(`${locationSelect} WHERE o.id = ?`, [id]));
  }

  async function createOrder(input) {
    const timestamp = input.createdAt || nowIso();
    const id = input.id || makeId('o');
    const orderStatement = db.prepare(`INSERT INTO orders (id, agency_id, source, status, district, subject, grade, price,
      import_fingerprint, structured_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id, input.agencyId, input.source || '', input.status || 'open', input.district || '', input.subject || '',
      input.grade || '', Number(input.price || 0), input.importFingerprint || null, JSON.stringify(input.structured || input), timestamp, input.updatedAt || timestamp);
    const locationStatement = db.prepare(`INSERT INTO order_locations (order_id, place, address, original_place, verified, status,
      poi_id, coordinates, resolved_address, confidence, query_text, queries_json, candidates_json, options_json, relation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ...locationFrom(input, input.updatedAt || timestamp));
    if (typeof db.batch === 'function') await db.batch([orderStatement, locationStatement]);
    else { await orderStatement.run(); await locationStatement.run(); }
    return getOrderById(id);
  }

  async function listOrders(filters = {}) {
    const clauses = [];
    const values = [];
    for (const [key, column] of [['status', 'o.status'], ['agencyId', 'o.agency_id'], ['district', 'o.district']]) {
      if (filters[key] !== undefined) { clauses.push(`${column} = ?`); values.push(filters[key]); }
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const rows = await all(`${locationSelect}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY o.created_at DESC LIMIT ?`, [...values, limit]);
    return rows.map(mapOrder);
  }

  async function updateOrder(id, patch) {
    const current = await getOrderById(id);
    if (!current) return null;
    const merged = { ...current, ...patch, id };
    const timestamp = nowIso();
    await run(`UPDATE orders SET agency_id=?, source=?, status=?, district=?, subject=?, grade=?, price=?, import_fingerprint=?,
      structured_json=?, updated_at=? WHERE id=?`, [merged.agencyId, merged.source || '', merged.status || 'open', merged.district || '',
      merged.subject || '', merged.grade || '', Number(merged.price || 0), merged.importFingerprint || null,
      JSON.stringify(patch.structured || merged), timestamp, id]);
    await run(`INSERT INTO order_locations (order_id, place, address, original_place, verified, status, poi_id, coordinates,
      resolved_address, confidence, query_text, queries_json, candidates_json, options_json, relation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET place=excluded.place,address=excluded.address,original_place=excluded.original_place,
      verified=excluded.verified,status=excluded.status,poi_id=excluded.poi_id,coordinates=excluded.coordinates,
      resolved_address=excluded.resolved_address,confidence=excluded.confidence,query_text=excluded.query_text,
      queries_json=excluded.queries_json,candidates_json=excluded.candidates_json,options_json=excluded.options_json,
      relation=excluded.relation,updated_at=excluded.updated_at`, [id, ...locationFrom(merged, timestamp)]);
    return getOrderById(id);
  }

  async function deleteOrder(id) { return run('DELETE FROM orders WHERE id = ?', [id]); }

  async function createApplication(input) {
    const timestamp = input.createdAt || input.at || nowIso();
    const id = input.id || makeId('a');
    await run(`INSERT INTO applications (id, order_id, teacher_id, name, phone, note, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, input.orderId, input.teacherId, input.name || '', input.phone || '',
      input.note || '', input.status || 'pending', timestamp, input.updatedAt || timestamp]);
    return mapRow(await first('SELECT * FROM applications WHERE id = ?', [id]));
  }

  async function listApplications(filters = {}) {
    const clauses = [], values = [];
    for (const [key, column] of [['orderId', 'order_id'], ['teacherId', 'teacher_id'], ['status', 'status']]) {
      if (filters[key] !== undefined) { clauses.push(`${column} = ?`); values.push(filters[key]); }
    }
    return (await all(`SELECT * FROM applications${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`, values)).map(mapRow);
  }

  async function updateApplication(id, patch) {
    const columns = { note: 'note', status: 'status', name: 'name', phone: 'phone' };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    if (entries.length) await run(`UPDATE applications SET ${entries.map(([key]) => `${columns[key]}=?`).join(',')}, updated_at=? WHERE id=?`, [...entries.map(([, value]) => value), nowIso(), id]);
    return mapRow(await first('SELECT * FROM applications WHERE id = ?', [id]));
  }

  async function getSettings() {
    const result = {};
    for (const row of await all('SELECT key, value_json FROM settings')) result[row.key] = parseJson(row.value_json, null);
    return result;
  }

  async function setSetting(key, value) {
    await run(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`, [key, JSON.stringify(value), nowIso()]);
    return value;
  }

  async function createFeedback(input) {
    const id = input.id || makeId('f');
    await run('INSERT INTO feedback (id, name, contact, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.name || '', input.contact || '', input.content, input.status || 'new', input.createdAt || nowIso()]);
    return mapRow(await first('SELECT * FROM feedback WHERE id = ?', [id]));
  }

  async function listFeedback(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
    const rows = filters.status === undefined
      ? await all('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?', [limit])
      : await all('SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC LIMIT ?', [filters.status, limit]);
    return rows.map(mapRow);
  }

  async function createAnnouncement(input) {
    const timestamp = input.createdAt || nowIso();
    const id = input.id || makeId('n');
    if (input.active) await run('UPDATE announcements SET active = 0 WHERE active = 1');
    await run('INSERT INTO announcements (id, title, content, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.title || '', input.content || '', input.active ? 1 : 0, timestamp, input.updatedAt || timestamp]);
    const announcement = mapRow(await first('SELECT * FROM announcements WHERE id = ?', [id]));
    return announcement ? { ...announcement, active: Boolean(announcement.active) } : null;
  }

  async function listAnnouncements(filters = {}) {
    const rows = filters.active === undefined
      ? await all('SELECT * FROM announcements ORDER BY updated_at DESC')
      : await all('SELECT * FROM announcements WHERE active = ? ORDER BY updated_at DESC', [filters.active ? 1 : 0]);
    return rows.map(row => ({ ...mapRow(row), active: Boolean(row.active) }));
  }

  async function getPublicState() {
    const [settings, announcements, orders] = await Promise.all([getSettings(), listAnnouncements({ active: true }), listOrders({ status: 'open' })]);
    const publicOrders = orders.map(order => {
      const { importFingerprint: _fingerprint, sourceImages = [], applicants = [], ...safe } = order;
      return { ...safe, sourceImageCount: Array.isArray(sourceImages) ? sourceImages.length : 0,
        applicantCount: Array.isArray(applicants) ? applicants.length : 0, applicants: [] };
    });
    return {
      settings: { homeAddress: settings.homeAddress || '', maxBikeKm: settings.maxBikeKm ?? 12 },
      adminConfigured: Boolean(settings.adminPasswordHash),
      announcement: announcements[0] || null,
      orders: publicOrders
    };
  }

  function requireBucket() {
    if (!bucket) throw new Error('Cloudflare R2 binding is required as env.BUCKET (or env.R2)');
    return bucket;
  }

  async function putObject(key, body, options = {}) {
    const target = requireBucket();
    return target.put(key, body, { httpMetadata: options.contentType ? { contentType: options.contentType } : undefined, customMetadata: options.metadata });
  }

  async function getObject(key) { return requireBucket().get(key); }
  async function deleteObject(key) { return requireBucket().delete(key); }

  return { objectStorageEnabled: Boolean(bucket),
    getPublicState, getUserById, getUserByPhone, getUserByWechatIdentityHash, listUsers, createUser, updateUser, deleteUser,
    createSession, getSessionByTokenHash, deleteSessionByTokenHash, createOrder, getOrderById, listOrders,
    updateOrder, deleteOrder, createApplication, listApplications, updateApplication, getSettings, setSetting,
    listFeedback, createFeedback, listAnnouncements, createAnnouncement, putObject, getObject, deleteObject };
}

module.exports = { createRepository };
