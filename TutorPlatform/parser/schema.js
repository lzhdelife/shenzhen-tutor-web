'use strict';

const evidenceField = valueSchema => ({
  type: 'object',
  additionalProperties: false,
  required: ['value', 'rawEvidence', 'confidence', 'source'],
  properties: {
    value: valueSchema,
    rawEvidence: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    source: { type: 'string', enum: ['rule', 'ai', 'amap', 'user'] }
  }
});

const STRING_FIELD = evidenceField({ type: 'string' });
const STRING_ARRAY_FIELD = evidenceField({ type: 'array', items: { type: 'string' } });
const NUMBER_FIELD = evidenceField({ anyOf: [{ type: 'number' }, { type: 'null' }] });
const LOCATION_FIELD = evidenceField({ type: 'array', items: { type: 'object' } });

const PARSER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rawText', 'normalizedText', 'parserVersion', 'locations', 'gradeCurrent', 'gradeNext', 'gradeContext', 'subjectsCurrent', 'subjectsPossible', 'studentGender', 'teacherGender', 'priceUnit', 'schedulePhases', 'requirements', 'notes', 'diagnostics'],
  properties: {
    rawText: { type: 'string' },
    normalizedText: { type: 'string' },
    parserVersion: { type: 'string' },
    locations: {
      ...LOCATION_FIELD,
      required: [...LOCATION_FIELD.required, 'relation'],
      properties: { ...LOCATION_FIELD.properties, relation: { type: 'string', enum: ['AND', 'OR'] } }
    },
    gradeCurrent: STRING_FIELD,
    gradeNext: STRING_FIELD,
    gradeContext: STRING_FIELD,
    subjectsCurrent: STRING_ARRAY_FIELD,
    subjectsPossible: STRING_ARRAY_FIELD,
    subjectContext: STRING_FIELD,
    studentGender: STRING_FIELD,
    studentAge: NUMBER_FIELD,
    studentLevel: STRING_FIELD,
    studentType: STRING_FIELD,
    studentSchool: STRING_FIELD,
    studentSituation: STRING_FIELD,
    teacherGender: STRING_FIELD,
    teacherSchools: STRING_ARRAY_FIELD,
    teacherDegree: STRING_FIELD,
    teacherExperience: STRING_FIELD,
    teacherType: STRING_FIELD,
    teacherTraits: STRING_ARRAY_FIELD,
    priceMin: NUMBER_FIELD,
    priceMax: NUMBER_FIELD,
    priceApproximate: evidenceField({ type: 'boolean' }),
    priceUnit: STRING_FIELD,
    durationPerLesson: NUMBER_FIELD,
    schedulePhases: { type: 'array', items: { type: 'object' } },
    requirements: STRING_ARRAY_FIELD,
    notes: STRING_FIELD,
    contactInfo: { type: 'object' },
    diagnostics: { type: 'object' },
    aiExtraction: { anyOf: [{ type: 'object' }, { type: 'null' }] }
  }
};

function sourced(value, rawEvidence = '', confidence = 0, source = 'rule') {
  return { value, rawEvidence, confidence, source };
}

module.exports = { PARSER_JSON_SCHEMA, sourced };
