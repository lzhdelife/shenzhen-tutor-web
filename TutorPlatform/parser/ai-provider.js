'use strict';

const crypto = require('crypto');
const { PARSER_JSON_SCHEMA } = require('./schema');
const { redactForAI } = require('./privacy');

const cache = new Map();

function config() {
  return {
    provider: String(process.env.PARSER_AI_PROVIDER || 'disabled').toLowerCase(),
    apiKey: String(process.env.PARSER_AI_API_KEY || ''),
    baseUrl: String(process.env.PARSER_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: String(process.env.PARSER_AI_MODEL || ''),
    timeoutMs: Math.max(1000, Math.min(30000, Number(process.env.PARSER_AI_TIMEOUT_MS || 10000)))
  };
}

function normalizedHash(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/\s+/g, ' ').trim()).digest('hex');
}

async function extractWithAI(normalizedText) {
  const settings = config();
  if (settings.provider === 'disabled' || !settings.apiKey || !settings.model) return null;
  const key = normalizedHash(normalizedText);
  if (cache.has(key)) return cache.get(key);
  const safeText = redactForAI(normalizedText);
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: '只依据原文抽取家教订单。每个字段必须引用原文 evidence；没有证据就返回空值，禁止猜测。可能增加的科目不得放进当前科目。学生性别不得当成教师性别。' },
      { role: 'user', content: safeText }
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'tutor_order', strict: true, schema: PARSER_JSON_SCHEMA } }
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.timeoutMs)
      });
      if (!response.ok) throw new Error(`AI provider HTTP ${response.status}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const result = typeof content === 'string' ? JSON.parse(content) : content;
      cache.set(key, result);
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  // Do not log raw text, provider keys or request bodies.
  return { _providerError: String(lastError?.message || 'AI unavailable') };
}

module.exports = { extractWithAI, normalizedHash };
