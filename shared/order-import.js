'use strict';

const IMPORT_FIELDS = [
  'district', 'place', 'placeOriginal', 'address', 'subject', 'grade', 'gradeDescription',
  'area', 'transitLine', 'price', 'priceText', 'monthly', 'priceMin', 'priceMax', 'priceUnit',
  'hourlyPrice', 'priceApproximate', 'schedule', 'gender', 'student', 'studentGender',
  'requirements', 'teacherRequirement', 'studentLevel', 'studentType', 'optionalSubjects', 'raw',
  'locationQuery', 'locationQueries', 'locationOptions', 'locationRelation', 'locationVerified',
  'locationStatus', 'locationPoiId', 'locationCoordinates', 'locationAddress', 'locationConfidence',
  'locationCandidates', 'structured'
];

function text(value) { return String(value == null ? '' : value).trim(); }

function sanitizeImportedOrder(input = {}) {
  const clean = {};
  for (const key of IMPORT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) clean[key] = input[key];
  }
  clean.raw = text(clean.raw).slice(0, 500000);
  clean.district = text(clean.district).replace(/区$/, '').slice(0, 10);
  for (const key of ['place', 'placeOriginal', 'address', 'locationQuery', 'locationStatus', 'locationPoiId', 'locationCoordinates', 'locationAddress']) {
    if (clean[key] !== undefined) clean[key] = text(clean[key]).slice(0, key === 'address' || key === 'locationAddress' ? 300 : 160);
  }
  clean.locationQueries = Array.isArray(clean.locationQueries) ? clean.locationQueries.map(value => text(value).slice(0, 160)).filter(Boolean).slice(0, 8) : [];
  clean.locationCandidates = Array.isArray(clean.locationCandidates) ? clean.locationCandidates.slice(0, 12).map(candidate => ({
    id: text(candidate?.id).slice(0, 120),
    name: text(candidate?.name).slice(0, 160),
    district: text(candidate?.district).replace(/区$/, '').slice(0, 10),
    address: text(candidate?.address).slice(0, 300),
    location: text(candidate?.location).slice(0, 80),
    type: text(candidate?.type).slice(0, 160),
    searchQuery: text(candidate?.searchQuery).slice(0, 160),
    confidence: Number(candidate?.confidence || 0)
  })) : [];
  clean.locationOptions = Array.isArray(clean.locationOptions) ? clean.locationOptions.slice(0, 4).map(option => ({ ...option })) : [];
  return clean;
}

function isShenzhenCoordinate(value) {
  const match = text(value).match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return false;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  return lng >= 113.6 && lng <= 114.7 && lat >= 22.35 && lat <= 22.9;
}

function normalized(value) { return text(value).replace(/[\s·.．,，:：/\\_-]+/g, '').toLowerCase(); }

function evidenceQueries(ruleOrder, imported) {
  const structuredQueries = imported?.structured?.locations?.value;
  return [...new Set([
    ...(Array.isArray(ruleOrder?.locationQueries) ? ruleOrder.locationQueries : []),
    ruleOrder?.locationQuery,
    ...(Array.isArray(structuredQueries) ? structuredQueries.flatMap(item => [item?.query, ...(item?.locationQueries || [])]) : []),
    imported?.locationQuery
  ].map(text).filter(Boolean))];
}

function candidateMatches(candidate, imported, queries) {
  if (!candidate || !isShenzhenCoordinate(candidate.location)) return false;
  if (text(candidate.location) !== text(imported.locationCoordinates)) return false;
  if (text(imported.locationPoiId) && text(candidate.id) !== text(imported.locationPoiId)) return false;
  if (text(imported.district) && text(candidate.district).replace(/区$/, '') !== text(imported.district).replace(/区$/, '')) return false;
  const place = normalized(imported.place);
  const name = normalized(candidate.name);
  if (place && name && !place.includes(name) && !name.includes(place)) return false;
  const searchQuery = text(candidate.searchQuery || imported.locationQuery);
  return !searchQuery || queries.some(query => normalized(query) === normalized(searchQuery));
}

function canReuseVerifiedLocation(imported, ruleOrder = null) {
  if (!imported?.locationVerified || !text(imported.locationPoiId) || !isShenzhenCoordinate(imported.locationCoordinates)) return false;
  if (ruleOrder?.raw && text(ruleOrder.raw) !== text(imported.raw)) return false;
  if (ruleOrder?.district && imported.district && text(ruleOrder.district).replace(/区$/, '') !== text(imported.district).replace(/区$/, '')) return false;
  const queries = evidenceQueries(ruleOrder, imported);
  if (!queries.length) return false;
  return (imported.locationCandidates || []).some(candidate => candidateMatches(candidate, imported, queries));
}

function markRoutePending(order) {
  order.distanceKm = '';
  order.routeMode = '待计算';
  order.routeStatus = 'pending';
  order.routeOptions = {};
  if (Array.isArray(order.locationOptions)) order.locationOptions = order.locationOptions.map(option => ({ ...option, routeOptions: {} }));
  return order;
}

module.exports = { IMPORT_FIELDS, sanitizeImportedOrder, isShenzhenCoordinate, canReuseVerifiedLocation, markRoutePending };
