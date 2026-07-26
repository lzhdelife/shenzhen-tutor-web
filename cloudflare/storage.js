'use strict';

const JSON_FIELDS = new Set(['preferences_json', 'structured_json', 'queries_json', 'candidates_json', 'options_json', 'value_json', 'parsed_snapshot_json']);

function nowIso() {
  return new Date().toISOString();
}

function shanghaiDate(value = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
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
    const outputKey = key === 'preferences_json' ? 'preferences'
      : key === 'parsed_snapshot_json' ? 'parsedSnapshot'
        : camel(key);
    const fallback = ['queries_json', 'candidates_json', 'options_json'].includes(key) ? [] : key === 'value_json' ? null : {};
    result[outputKey] = JSON_FIELDS.has(key) ? parseJson(value, fallback) : value;
  }
  return result;
}

function evidenceValue(field, fallback = '') {
  const value = field && typeof field === 'object' && !Array.isArray(field) ? field.value : field;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim()).join('、');
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : fallback;
}

function flatOrderFromEvidence(structured) {
  const schedule = Array.isArray(structured.schedulePhases)
    ? structured.schedulePhases.map(phase => phase?.rawEvidence).filter(Boolean).join('；')
    : '';
  const requirements = evidenceValue(structured.requirements);
  return {
    raw: structured.rawText || structured.normalizedText || '',
    gradeDescription: evidenceValue(structured.gradeContext),
    student: evidenceValue(structured.studentSituation),
    studentGender: evidenceValue(structured.studentGender),
    gender: evidenceValue(structured.teacherGender),
    priceMin: evidenceValue(structured.priceMin, 0),
    priceMax: evidenceValue(structured.priceMax, 0),
    priceApproximate: Boolean(evidenceValue(structured.priceApproximate, false)),
    priceUnit: evidenceValue(structured.priceUnit),
    priceText: structured.priceMin?.rawEvidence || structured.priceUnit?.rawEvidence || '',
    schedule,
    requirements,
    teacherRequirement: requirements,
    structured
  };
}

function mapOrder(row) {
  if (!row) return null;
  const mapped = mapRow(row);
  const structured = mapped.structuredJson || {};
  const evidenceOnly = Boolean(structured.rawText && structured.parserVersion && !structured.structured);
  const order = { ...(evidenceOnly ? flatOrderFromEvidence(structured) : structured), ...mapped };
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
      passwordHash: input.passwordHash || null,
      preferences: input.preferences || {}, createdAt: timestamp, updatedAt: input.updatedAt || timestamp
    };
    await run(`INSERT INTO users (id, role, name, phone, password_hash, preferences_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, user.role, user.name, user.phone, user.passwordHash,
      JSON.stringify(user.preferences), user.createdAt, user.updatedAt]);
    return getUserById(user.id);
  }

  async function updateUser(id, patch) {
    const columns = { role: 'role', name: 'name', phone: 'phone', passwordHash: 'password_hash', preferences: 'preferences_json' };
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

  async function getOrderContact(id) {
    const row = await first(`SELECT o.*, pa.display_name AS publisher_display_name,
      pa.contact AS publisher_contact
      FROM orders o LEFT JOIN publisher_access pa ON pa.user_id = o.agency_id
      WHERE o.id = ?`, [id]);
    if (!row) return null;
    const order = mapOrder(row);
    const publisher = {
      displayName: order.publisherDisplayName || '',
      contact: order.publisherContact || ''
    };
    delete order.publisherDisplayName;
    delete order.publisherContact;
    return { order, publisher };
  }

  async function createOrder(input) {
    const timestamp = input.createdAt || nowIso();
    const id = input.id || makeId('o');
    const orderStatement = db.prepare(`INSERT INTO orders (id, agency_id, source, status, district, subject, grade, price,
      import_fingerprint, structured_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id, input.agencyId, input.source || '', input.status || 'open', input.district || '', input.subject || '',
      input.grade || '', Number(input.price || 0), input.importFingerprint || null,
      JSON.stringify({ ...input, structured: input.structured || null }), timestamp, input.updatedAt || timestamp);
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
    const limit = Math.min(Math.max(Number(filters.limit) || 500, 1), 500);
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
      JSON.stringify({ ...merged, structured: patch.structured || merged.structured || null }), timestamp, id]);
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

  async function deleteOrdersOlderThan(cutoff) {
    const result = await run('DELETE FROM orders WHERE created_at <= ?', [cutoff]);
    return Number(result?.meta?.changes || result?.changes || 0);
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

  async function incrementSetting(key) {
    await run(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json=CAST(COALESCE(CAST(settings.value_json AS INTEGER), 0) + 1 AS TEXT),
        updated_at=excluded.updated_at`, [key, '1', nowIso()]);
    const row = await first('SELECT value_json FROM settings WHERE key = ?', [key]);
    return Math.max(0, Number(parseJson(row?.value_json, 0)) || 0);
  }

  async function recordVisitorVisit(visitorId, timestamp = Date.now()) {
    await run(`INSERT INTO visitor_activity (visitor_id, first_seen_at, last_seen_at, visit_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(visitor_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
      visit_count=visitor_activity.visit_count + 1`, [visitorId, timestamp, timestamp]);
  }

  async function touchVisitor(visitorId, timestamp = Date.now()) {
    await run(`INSERT INTO visitor_activity (visitor_id, first_seen_at, last_seen_at, visit_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(visitor_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`, [visitorId, timestamp, timestamp]);
  }

  async function getVisitorStats(onlineSince = Date.now() - 90000) {
    const total = await first('SELECT COUNT(*) AS count FROM visitor_activity');
    const online = await first('SELECT COUNT(*) AS count FROM visitor_activity WHERE last_seen_at >= ?', [onlineSince]);
    return {
      totalVisitors: Math.max(0, Number(total?.count) || 0),
      onlineVisitors: Math.max(0, Number(online?.count) || 0)
    };
  }

  async function recordAmapUsage(input = {}) {
    const usageDate = String(input.date || shanghaiDate()).slice(0, 10);
    const endpoint = String(input.endpoint || 'unknown').slice(0, 80);
    const outcome = String(input.outcome || 'success').slice(0, 40);
    await run(`INSERT INTO amap_usage (usage_date, endpoint, outcome, call_count, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(usage_date, endpoint, outcome) DO UPDATE SET call_count=amap_usage.call_count + 1,
      updated_at=excluded.updated_at`, [usageDate, endpoint, outcome, nowIso()]);
  }

  async function getAmapUsage(date = shanghaiDate()) {
    const usageDate = String(date).slice(0, 10);
    const month = usageDate.slice(0, 7);
    const rows = await all(`SELECT usage_date, endpoint, outcome, call_count AS count, updated_at
      FROM amap_usage WHERE usage_date LIKE ? ORDER BY usage_date, endpoint, outcome`, [`${month}-%`]);
    const byEndpoint = {};
    let total = 0, monthTotal = 0, limited = 0, poiMonth = 0, baseMonth = 0, jsMonth = 0;
    for (const row of rows) {
      const count = Math.max(0, Number(row.count) || 0);
      monthTotal += count;
      if (row.endpoint === '/v3/place/text') poiMonth += count;
      else if (String(row.endpoint).startsWith('js:')) jsMonth += count;
      else baseMonth += count;
      if (row.usage_date === usageDate) {
        total += count;
        if (row.outcome === 'rate_limited') limited += count;
      }
      byEndpoint[row.endpoint] = byEndpoint[row.endpoint] || { total: 0, outcomes: {} };
      byEndpoint[row.endpoint].total += count;
      byEndpoint[row.endpoint].outcomes[row.outcome] = (byEndpoint[row.endpoint].outcomes[row.outcome] || 0) + count;
    }
    return { date: usageDate, month, total, monthTotal, poiMonth, baseMonth, jsMonth, limited, byEndpoint };
  }

  async function getPublisherAccess(userId) {
    return mapRow(await first('SELECT * FROM publisher_access WHERE user_id = ?', [userId]));
  }

  async function findApprovedPublisherAccess(displayName, contact) {
    return mapRow(await first(`SELECT * FROM publisher_access
      WHERE display_name = ? AND contact = ? AND status = 'approved'
      ORDER BY reviewed_at DESC LIMIT 1`, [displayName, contact]));
  }

  async function submitPublisherAccess(userId, displayName, contact) {
    const timestamp = nowIso();
    await run(`INSERT INTO publisher_access (user_id, display_name, contact, status, requested_at, reviewed_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, NULL, ?)
      ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, contact=excluded.contact,
      status=CASE WHEN publisher_access.status='approved' THEN 'approved' ELSE 'pending' END,
      requested_at=CASE WHEN publisher_access.status='approved' THEN publisher_access.requested_at ELSE excluded.requested_at END,
      reviewed_at=CASE WHEN publisher_access.status='approved' THEN publisher_access.reviewed_at ELSE NULL END,
      updated_at=excluded.updated_at`, [userId, displayName, contact, timestamp, timestamp]);
    return getPublisherAccess(userId);
  }

  async function listPublisherAccess() {
    return (await all(`SELECT * FROM publisher_access
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, updated_at DESC`)).map(mapRow);
  }

  async function setPublisherAccessStatus(userId, status) {
    const timestamp = nowIso();
    await run(`UPDATE publisher_access SET status = ?, reviewed_at = ?, updated_at = ? WHERE user_id = ?`,
      [status, timestamp, timestamp, userId]);
    return getPublisherAccess(userId);
  }

  async function upsertOrderIssueReport(input) {
    const timestamp = nowIso();
    const report = {
      id: input.id || makeId('oir'),
      targetKey: input.targetKey,
      orderId: input.orderId || null,
      source: input.source,
      reporterKey: input.reporterKey,
      rawText: input.rawText || '',
      parsedSnapshot: input.parsedSnapshot || {},
      parserVersion: input.parserVersion || '',
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp
    };
    await run(`INSERT INTO order_issue_reports (id, target_key, order_id, source, reporter_key, raw_text,
      parsed_snapshot_json, parser_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_key, reporter_key) DO UPDATE SET order_id=excluded.order_id, source=excluded.source,
      raw_text=excluded.raw_text, parsed_snapshot_json=excluded.parsed_snapshot_json,
      parser_version=excluded.parser_version, updated_at=excluded.updated_at`, [
      report.id, report.targetKey, report.orderId, report.source, report.reporterKey, report.rawText,
      JSON.stringify(report.parsedSnapshot), report.parserVersion, report.createdAt, report.updatedAt
    ]);
    return mapRow(await first('SELECT * FROM order_issue_reports WHERE target_key = ? AND reporter_key = ?',
      [report.targetKey, report.reporterKey]));
  }

  async function listOrderIssueReports() {
    return (await all('SELECT * FROM order_issue_reports ORDER BY updated_at DESC')).map(mapRow);
  }

  async function deleteExportedOrderIssueReports(reports) {
    const refs = (Array.isArray(reports) ? reports : []).filter(report => report?.id && report?.updatedAt);
    let deleted = 0;
    for (let index = 0; index < refs.length; index += 100) {
      const statements = refs.slice(index, index + 100)
        .map(report => db.prepare('DELETE FROM order_issue_reports WHERE id = ? AND updated_at = ?').bind(report.id, report.updatedAt));
      const results = typeof db.batch === 'function'
        ? await db.batch(statements)
        : await Promise.all(statements.map(statement => statement.run()));
      deleted += results.reduce((total, result) => total + Number(result?.meta?.changes || result?.changes || 0), 0);
    }
    return deleted;
  }

  async function createClipboardCapture(input) {
    const capture = {
      captureId: input.captureId,
      text: input.text || '',
      capturedAt: input.capturedAt || nowIso(),
      receivedAt: input.receivedAt || nowIso()
    };
    await run(`INSERT INTO clipboard_captures (capture_id, text, captured_at, received_at, status, attempts, next_attempt_at, last_error)
      VALUES (?, ?, ?, ?, 'pending', 0, 0, '') ON CONFLICT(capture_id) DO NOTHING`,
    [capture.captureId, capture.text, capture.capturedAt, capture.receivedAt]);
    const row = mapRow(await first('SELECT * FROM clipboard_captures WHERE capture_id = ?', [capture.captureId]));
    return row ? { ...row, status: row.status || 'pending', attempts: Number(row.attempts || 0), nextAttemptAt: Number(row.nextAttemptAt || 0), lastError: row.lastError || '' } : null;
  }

  async function getClipboardCapture(captureId) {
    const row = mapRow(await first('SELECT * FROM clipboard_captures WHERE capture_id = ?', [captureId]));
    return row ? { ...row, status: row.status || 'pending', attempts: Number(row.attempts || 0), nextAttemptAt: Number(row.nextAttemptAt || 0), lastError: row.lastError || '' } : null;
  }

  async function listClipboardCaptures(limit = 10) {
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    return (await all(`SELECT * FROM clipboard_captures
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY received_at ASC LIMIT ?`, [Date.now(), safeLimit])).map(mapRow);
  }

  async function completeClipboardCapture(captureId, outcome = 'completed') {
    await run(`UPDATE clipboard_captures SET status = ?, completed_at = ?, last_error = '' WHERE capture_id = ?`,
      [outcome === 'ignored' ? 'ignored' : 'completed', nowIso(), captureId]);
    return getClipboardCapture(captureId);
  }

  async function failClipboardCapture(captureId, message = '') {
    const current = await getClipboardCapture(captureId);
    if (!current) return null;
    const attempts = Number(current.attempts || 0) + 1;
    const nextAttemptAt = Date.now() + Math.min(60000, 2000 * (2 ** Math.min(attempts, 5)));
    await run(`UPDATE clipboard_captures SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE capture_id = ?`,
      [attempts, nextAttemptAt, String(message || '').slice(0, 300), captureId]);
    return getClipboardCapture(captureId);
  }

  async function deleteClipboardCapturesOlderThan(cutoff) {
    const result = await run(`DELETE FROM clipboard_captures WHERE received_at <= ? AND status <> 'pending'`, [cutoff]);
    return Number(result?.meta?.changes || result?.changes || 0);
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
      const { importFingerprint: _fingerprint, sourceImages: _sourceImages, applicants: _applicants,
        applicantCount: _applicantCount, ...safe } = order;
      return safe;
    });
    return {
      settings: { homeAddress: settings.homeAddress || '', maxBikeKm: settings.maxBikeKm ?? 12 },
      adminConfigured: Boolean(settings.adminPasswordHash),
      announcement: announcements[0] || null,
      orders: publicOrders
    };
  }

  return {
    getPublicState, getUserById, getUserByPhone, listUsers, createUser, updateUser, deleteUser,
    createSession, getSessionByTokenHash, deleteSessionByTokenHash, createOrder, getOrderById, getOrderContact, listOrders,
    updateOrder, deleteOrder, deleteOrdersOlderThan, getSettings, setSetting, incrementSetting,
    recordVisitorVisit, touchVisitor, getVisitorStats, recordAmapUsage, getAmapUsage,
    getPublisherAccess, findApprovedPublisherAccess, submitPublisherAccess, listPublisherAccess, setPublisherAccessStatus,
    upsertOrderIssueReport, listOrderIssueReports, deleteExportedOrderIssueReports,
    listAnnouncements, createAnnouncement,
    createClipboardCapture, getClipboardCapture, listClipboardCaptures,
    completeClipboardCapture, failClipboardCapture, deleteClipboardCapturesOlderThan };
}

module.exports = { createRepository };
