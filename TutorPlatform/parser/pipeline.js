'use strict';

const { sourced } = require('./schema');
const { extractWithAI } = require('./ai-provider');
const { validateStructuredOrder } = require('./validator');
const { redactForAI } = require('./privacy');

const PARSER_VERSION = '2.2.0';
const evidence = (raw, pattern) => String(raw || '').match(pattern)?.[0] || '';
const subjects = value => String(value || '').split(/[\/、，,]+/).map(item => item.trim()).filter(Boolean);
const uniq = values => [...new Set(values.filter(Boolean))];

function locationEvidence(ruleOrder) {
  const options = Array.isArray(ruleOrder.locationOptions) && ruleOrder.locationOptions.length
    ? ruleOrder.locationOptions
    : [{
        raw: ruleOrder.placeOriginal || ruleOrder.place || '',
        district: ruleOrder.district || '',
        area: ruleOrder.area || '',
        place: ruleOrder.place || '',
        transitLine: ruleOrder.transitLine || '',
        nearby: /附近|周边/.test(ruleOrder.placeOriginal || ruleOrder.place || ''),
        query: ruleOrder.locationQuery || '',
        locationQueries: ruleOrder.locationQueries || [],
        poiId: ruleOrder.locationPoiId || '',
        coordinates: ruleOrder.locationCoordinates || '',
        verified: Boolean(ruleOrder.locationVerified),
        ambiguityCandidates: ruleOrder.locationCandidates || []
      }];
  const value = options.map(option => ({
    ...option,
    raw: String(option.raw || option.place || ''),
    district: String(option.district || ''),
    place: String(option.place || ''),
    query: String(option.query || option.locationQuery || ''),
    locationQueries: uniq([
      option.query,
      option.locationQuery,
      ...(Array.isArray(option.locationQueries) ? option.locationQueries : [])
    ]),
    nearby: Boolean(option.nearby || /附近|周边/.test(option.raw || option.place || '')),
    verified: Boolean(option.verified || option.coordinates)
  }));
  const complete = value.every(option => option.district && option.place);
  const verified = value.every(option => option.verified);
  return {
    relation: ruleOrder.locationRelation || (value.length > 1 ? 'OR' : 'AND'),
    value,
    rawEvidence: value.map(item => item.raw).filter(Boolean).join(' 或 '),
    confidence: verified ? 0.98 : complete ? 0.78 : value.some(option => option.place) ? 0.58 : 0,
    source: verified ? 'amap' : 'rule'
  };
}

function schedulePhases(raw) {
  const text = String(raw || '');
  const phases = [];
  const summer = text.match(/暑假([\s\S]*?)(?=开学(?:后|之后)?|$)/);
  const school = text.match(/开学(?:后|之后)?([\s\S]*)/);
  if (summer) phases.push(buildSchedulePhase('暑假', summer[0], summer[1]));
  if (school) phases.push(buildSchedulePhase('开学后', school[0], school[1]));
  if (!phases.length && text) phases.push(buildSchedulePhase('常规', text, text));
  return phases;
}

function numberRange(text) {
  const match = String(text || '').match(/(\d+)\s*[-~～至到]\s*(\d+)\s*次/);
  if (match) return { min: Number(match[1]), max: Number(match[2]) };
  const single = String(text || '').match(/(?:大概|约)?\s*(\d+)\s*次(?:课)?/);
  return single ? { min: Number(single[1]), max: Number(single[1]) } : null;
}

function buildSchedulePhase(phase, rawEvidence, body) {
  const text = String(body || '');
  const duration = text.match(/(\d+(?:\.\d+)?)\s*(?:h|小时)\s*(?:\/\s*次|每次)?/i);
  const start = evidence(text, /(?:暑假|七月|八月|开学|即日起|随时)[^，。；;]{0,18}(?:开始|起)?|\d{1,2}月(?:上旬|中旬|下旬|\d{1,2}[日号])(?:开始|起)?/);
  const frequency = /隔天/.test(text) ? '隔天1次'
    : /周末/.test(text) ? '每周末1次'
      : evidence(text, /每周[^，。；;]{1,24}|一周\s*\d+\s*次|周内上课|连续上课/);
  const weekdays = uniq([...text.matchAll(/周\s*([1-6一二三四五六日天])/g)].map(match => match[1]));
  const timeOfDay = evidence(text, /早\d{1,2}点(?:\d{1,2}分)?|\d{1,2}(?::\d{2})?\s*[-~～至到]\s*\d{1,2}(?::\d{2})?|上午|下午|晚上/);
  const count = numberRange(text);
  const hasDetails = Boolean(start || frequency || weekdays.length || timeOfDay || duration || count);
  return {
    phase,
    rawEvidence,
    start,
    frequency,
    weekdays,
    timeOfDay,
    durationPerLesson: duration ? Number(duration[1]) : null,
    lessonCountMin: count?.min ?? null,
    lessonCountMax: count?.max ?? null,
    confidence: hasDetails ? 0.9 : 0.45,
    source: 'rule'
  };
}

function uncertaintyFields(order) {
  const fields = [];
  const check = (field, item, required = true) => {
    const value = item?.value;
    const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
    if ((required && empty) || Number(item?.confidence || 0) < 0.6) fields.push(field);
  };
  check('locations', order.locations);
  check('gradeCurrent', order.gradeCurrent);
  check('subjectsCurrent', order.subjectsCurrent);
  check('studentGender', order.studentGender, false);
  check('teacherGender', order.teacherGender, false);
  check('priceMin', order.priceMin);
  check('priceUnit', order.priceUnit);
  if (!order.schedulePhases?.length || order.schedulePhases.every(phase => phase.confidence < 0.6)) fields.push('schedulePhases');
  return uniq(fields);
}

function buildRuleStructuredOrder(ruleOrder, rawText) {
  const raw = String(rawText || ruleOrder.raw || '');
  const structured = {
    rawText: raw,
    normalizedText: String(ruleOrder.raw || raw),
    parserVersion: PARSER_VERSION,
    locations: locationEvidence(ruleOrder),
    gradeCurrent: sourced(ruleOrder.grade || '', evidence(raw, /幼儿园|(?:准)?小[一二三四五六]|[一二三四五六]年级|初[一二三]|高[一二三]|大学|成人/), ruleOrder.grade && ruleOrder.grade !== '其他' ? 0.95 : 0.2),
    gradeNext: sourced(/预习高一|熟悉高一/.test(raw) ? '高一' : '', evidence(raw, /预习高一|熟悉高一/), /预习高一|熟悉高一/.test(raw) ? 0.95 : 0),
    gradeContext: sourced(ruleOrder.gradeDescription || ruleOrder.grade || '', evidence(raw, /初三(?:刚)?毕业[^，。；;]*/), 0.9),
    subjectsCurrent: sourced(ruleOrder.subject === '其他' ? [] : subjects(ruleOrder.subject), evidence(raw, /语数英|数理化|语文|数学|英语|物理|化学|生物/), ruleOrder.subject && ruleOrder.subject !== '其他' ? 0.95 : 0),
    subjectsPossible: sourced(subjects(ruleOrder.optionalSubjects), evidence(raw, /后续可能[^，。；;]*/), ruleOrder.optionalSubjects ? 0.95 : 0),
    subjectContext: sourced(ruleOrder.optionalSubjects ? '后续可能增加' : '', evidence(raw, /后续可能[^，。；;]*/), ruleOrder.optionalSubjects ? 0.9 : 0),
    studentGender: sourced(ruleOrder.studentGender || '', evidence(raw, /女生|女孩|男生|男孩|(?:高|初)[一二三]\s*[男女]/), ruleOrder.studentGender ? 0.95 : 0),
    studentAge: sourced(null, '', 0), studentLevel: sourced(ruleOrder.studentLevel || '', ruleOrder.studentLevel || '', ruleOrder.studentLevel ? 0.9 : 0), studentType: sourced(ruleOrder.studentType || '', ruleOrder.studentType || '', ruleOrder.studentType ? 0.9 : 0), studentSchool: sourced('', '', 0), studentSituation: sourced(ruleOrder.student || '', ruleOrder.student || '', ruleOrder.student ? 0.75 : 0),
    teacherGender: sourced(ruleOrder.gender || '', evidence(raw, /(?:年轻)?女(?:在职)?老师|男(?:在职)?老师|男女不限/), ruleOrder.gender ? 0.95 : 0), teacherSchools: sourced(subjects(evidence(raw, /深大(?:或者|或)哈工大|深圳大学|哈尔滨工业大学/).replace(/或者|或/g, '/')), evidence(raw, /深大(?:或者|或)哈工大|深圳大学|哈尔滨工业大学/), 0.9), teacherDegree: sourced('', '', 0), teacherExperience: sourced(evidence(raw, /有经验|经验丰富/), evidence(raw, /有经验|经验丰富/), 0.8), teacherType: sourced(evidence(raw, /在职老师|大学生|专业家教老师/), evidence(raw, /在职老师|大学生|专业家教老师/), 0.8), teacherTraits: sourced(subjects(evidence(raw, /认真负责|负责|有责任心/)), evidence(raw, /认真负责|负责|有责任心/), 0.85),
    priceMin: sourced(ruleOrder.priceMin || null, ruleOrder.priceText || evidence(raw, /\d{2,5}[^，。；;]{0,12}(?:小时|次|节|月)/), ruleOrder.price ? 0.98 : 0), priceMax: sourced(ruleOrder.priceMax || null, ruleOrder.priceText || '', ruleOrder.price ? 0.98 : 0), priceApproximate: sourced(Boolean(ruleOrder.priceApproximate), ruleOrder.priceText || '', ruleOrder.price ? 0.98 : 0), priceUnit: sourced(ruleOrder.priceUnit || '', ruleOrder.priceText || '', ruleOrder.priceUnit ? 0.99 : 0), durationPerLesson: sourced((() => { const match = String(ruleOrder.priceUnit || '').match(/^(\d+(?:\.\d+)?)小时$/); return match ? Number(match[1]) : null; })(), ruleOrder.priceText || '', ruleOrder.priceUnit?.includes('小时') ? 0.8 : 0),
    schedulePhases: schedulePhases(ruleOrder.schedule || raw), requirements: sourced(subjects(ruleOrder.requirements), ruleOrder.requirements || '', ruleOrder.requirements ? 0.75 : 0), notes: sourced('', '', 0), contactInfo: { redacted: redactForAI(raw) !== raw },
    diagnostics: { aiStatus: 'disabled', issues: [], uncertainFields: [] }
  };
  structured.diagnostics.uncertainFields = uncertaintyFields(structured);
  return structured;
}

async function runParserPipeline({ rawText, ruleOrder }) {
  const structured = buildRuleStructuredOrder(ruleOrder, rawText);
  const ai = await extractWithAI(structured.normalizedText);
  structured.diagnostics.aiStatus = ai?._providerError ? 'error' : ai ? 'used' : 'disabled';
  structured.aiExtraction = ai && !ai._providerError ? ai : null;
  const validated = validateStructuredOrder(structured);
  validated.order.diagnostics.issues = validated.issues;
  return validated.order;
}

module.exports = { PARSER_VERSION, buildRuleStructuredOrder, runParserPipeline };
