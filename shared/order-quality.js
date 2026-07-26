'use strict';

function readableText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && text !== '[object Object]' ? text : '';
}

function recoverOrderRawText(order = {}) {
  const candidates = [
    order.raw,
    order.rawText,
    order.structured?.rawText,
    order.requirements?.rawEvidence,
    order.structured?.requirements?.rawEvidence
  ];
  return candidates.map(readableText).find(value => value.length >= 10) || candidates.map(readableText).find(Boolean) || '';
}

function detectOrderIssues(order = {}) {
  const issues = [];
  const storedRaw = readableText(order.raw);
  const recoveredRaw = recoverOrderRawText(order);
  if (!storedRaw) issues.push({ code: recoveredRaw ? 'raw_recovered' : 'raw_unreadable', label: recoveredRaw ? '原文字段异常' : '原文不可读' });
  const hasLocation = Boolean(String(order.district || '').trim() && String(order.place || order.address || order.locationQuery || '').trim());
  if (!hasLocation) issues.push({ code: 'location_missing', label: '地点缺失' });
  else if (!order.locationCoordinates && ['missing', 'not_found', 'ambiguous', 'unverified'].includes(String(order.locationStatus || ''))) {
    issues.push({ code: 'location_unverified', label: '地点坐标未确认' });
  }
  if (!String(order.subject || '').trim()) issues.push({ code: 'subject_missing', label: '科目缺失' });
  if (!String(order.grade || order.gradeDescription || '').trim()) issues.push({ code: 'grade_missing', label: '年级缺失' });
  return issues;
}

module.exports = { recoverOrderRawText, detectOrderIssues };
