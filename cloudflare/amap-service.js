const MODES = new Set(['walking', 'cycling', 'driving', 'transit']);
const DISTRICTS = ['罗湖', '福田', '南山', '盐田', '宝安', '龙岗', '龙华', '坪山', '光明', '大鹏'];

function text(value) { return String(value || '').trim(); }
function districtName(value) { return DISTRICTS.find(name => text(value).includes(name)) || ''; }
function coordinates(value) { return /^\d{2,3}(?:\.\d+)?,\d{1,2}(?:\.\d+)?$/.test(text(value)); }

function serviceError(code, message, status = 502, details = {}) {
  return Object.assign(new Error(message), { code, status, details });
}

function createAmapService({ key, fetchImpl = fetch, timeoutMs = 7000 } = {}) {
  const secret = text(key);
  function configured() {
    if (!secret) throw serviceError('AMAP_NOT_CONFIGURED', '高德服务未配置', 503);
  }
  async function request(path, params) {
    configured();
    const url = new URL(`https://restapi.amap.com${path}`);
    url.search = new URLSearchParams({ ...params, key: secret, output: 'JSON' }).toString();
    let response;
    try {
      response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    } catch (caught) {
      const timeout = caught?.name === 'TimeoutError' || caught?.name === 'AbortError';
      throw serviceError(timeout ? 'AMAP_TIMEOUT' : 'AMAP_UNAVAILABLE', timeout ? '地图服务请求超时' : '地图服务暂时不可用', 503);
    }
    if (response.status === 429) throw serviceError('AMAP_RATE_LIMITED', '地图服务请求过于频繁', 503);
    if (!response.ok) throw serviceError('AMAP_HTTP_ERROR', '地图服务响应异常', 502, { httpStatus: response.status });
    let data;
    try { data = await response.json(); } catch (_) { throw serviceError('AMAP_INVALID_RESPONSE', '地图服务返回了无效响应'); }
    if (data.status !== '1') {
      const limited = /CUQPS_HAS_EXCEEDED|DAILY_QUERY_OVER_LIMIT|USER_DAILY_QUERY_OVER_LIMIT|ACCESS_TOO_FREQUENT/i.test(text(data.infocode) + text(data.info));
      throw serviceError(limited ? 'AMAP_RATE_LIMITED' : 'AMAP_API_ERROR', limited ? '地图服务调用额度已用尽' : '地图服务调用失败', limited ? 503 : 502, { infocode: text(data.infocode) });
    }
    return data;
  }
  async function candidates(query, district = '') {
    const keywords = text(query).slice(0, 80);
    const hint = districtName(district);
    if (keywords.length < 2) throw serviceError('INVALID_LOCATION_QUERY', '地点关键词至少需要两个字', 400);
    const data = await request('/v3/place/text', { keywords, city: '440300', citylimit: 'true', offset: '12', page: '1', extensions: 'base' });
    const values = (Array.isArray(data.pois) ? data.pois : []).filter(poi => poi?.name && coordinates(poi.location)).map(poi => {
      const name = text(poi.name), district = districtName(poi.adname), address = Array.isArray(poi.address) ? '' : text(poi.address);
      return { id: text(poi.id), name, district, address, location: text(poi.location), type: text(poi.type), source: 'amap',
        label: [name, district ? `${district}区` : '', address].filter(Boolean).join(' · '),
        value: `深圳市${district ? `${district}区` : ''}${address || name}` };
    }).filter(candidate => !hint || !candidate.district || candidate.district === hint);
    return { status: values.length ? 'candidates' : 'not_found', candidates: values.slice(0, 8) };
  }
  function confirm(candidate, district = '') {
    const hint = districtName(district);
    const actual = districtName(candidate?.district);
    if (!candidate || !text(candidate.name) || !coordinates(candidate.location)) throw serviceError('INVALID_LOCATION_CANDIDATE', '地点候选缺少名称或经纬度', 400);
    if (hint && actual && hint !== actual) throw serviceError('LOCATION_DISTRICT_CONFLICT', `候选地点不在${hint}区`, 409);
    const resolvedDistrict = actual || hint;
    const detail = text(candidate.address);
    return {
      place: text(candidate.name), address: `深圳市${resolvedDistrict ? `${resolvedDistrict}区` : ''}${detail || text(candidate.name)}`,
      locationVerified: true, locationStatus: 'confirmed', locationPoiId: text(candidate.id), locationCoordinates: text(candidate.location),
      locationAddress: detail, locationConfidence: 100, district: resolvedDistrict
    };
  }
  async function geocode(value) {
    if (coordinates(value)) return text(value);
    const data = await request('/v3/geocode/geo', { address: text(value), city: '深圳' });
    const result = Array.isArray(data.geocodes) ? data.geocodes.find(item => coordinates(item.location)) : null;
    if (!result) throw serviceError('AMAP_GEOCODE_NOT_FOUND', '无法解析路线起点', 422);
    return text(result.location);
  }
  async function route(originValue, destinationValue, requestedMode = 'cycling') {
    const mode = MODES.has(text(requestedMode)) ? text(requestedMode) : 'cycling';
    const [origin, destination] = await Promise.all([geocode(originValue), geocode(destinationValue)]);
    const shared = { origin, destination, show_fields: 'cost' };
    const definitions = {
      walking: ['/v5/direction/walking', '步行', shared], cycling: ['/v5/direction/bicycling', '骑行', shared],
      driving: ['/v5/direction/driving', '开车', { ...shared, strategy: '32' }],
      transit: ['/v3/direction/transit/integrated', '公共交通', { origin, destination, city: '深圳', cityd: '深圳', strategy: '0' }]
    };
    const [path, label, params] = definitions[mode];
    const data = await request(path, params);
    const item = data.route?.paths?.[0] || data.route?.transits?.[0];
    if (!item?.distance) throw serviceError('AMAP_ROUTE_NOT_FOUND', '未找到可用路线', 422);
    const seconds = Number(item.duration || item.cost?.duration || 0);
    return { status: 'verified', source: 'amap', mode, label, km: Math.round(Number(item.distance) / 10) / 100, minutes: seconds ? Math.max(1, Math.round(seconds / 60)) : null };
  }
  return { candidates, confirm, route };
}

module.exports = { createAmapService, serviceError };
