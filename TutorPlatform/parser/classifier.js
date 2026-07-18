'use strict';

/**
 * Conservative order-likeness gate used after lossless splitting. It only
 * decides whether a block should enter field extraction; ignored raw text is
 * still returned to callers for review.
 */
function classifyOrderBlock(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const evidence = {
    orderCode: /(?:单号|订单|编号|家教编号)\s*[:：]?\s*[A-Z0-9\u4e00-\u9fff-]{4,32}/i.test(text),
    grade: /(?:幼儿园|幼小衔接|小学|(?:新|准)?小[一二三四五六]|[一二三四五六]年级|(?:新)?初[一二三]|[七八九]年级|(?:新)?高[一二三]|中考|高考|成人)/.test(text),
    subject: /(?:语文|数学|英语|物理|化学|生物|政治|历史|地理|数理化|语数英|全科|奥数|科学|编程|陪读|作业辅导)/i.test(text),
    location: /(?:深圳|罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏|线上|\d{1,2}号线|地铁站|街道|社区|花园|小区|公馆|家园|华府|新村|中心|广场|大厦|公寓|附近)/.test(text),
    lesson: /(?:家教|辅导|补习|上课|开班|小班课|一对一|老师|教员|课酬|薪酬|报酬|\d{2,5}\s*(?:元|\/\s*(?:次|小时|h)))/i.test(text)
  };
  const coreCount = ['grade', 'subject', 'location', 'lesson'].filter(key => evidence[key]).length;
  const accepted = evidence.grade && evidence.subject && (evidence.location || evidence.lesson)
    || evidence.orderCode && coreCount >= 2
    || coreCount >= 3;
  return {
    accepted: Boolean(accepted),
    reason: accepted ? 'order-evidence' : 'insufficient-order-evidence',
    evidence
  };
}

function isExplicitOrderStart(value) {
  return /^(?:单号|订单|编号|家教编号)\s*[:：]?\s*[A-Z0-9\u4e00-\u9fff-]{3,32}\s*$/i.test(String(value || '').trim());
}

module.exports = { classifyOrderBlock, isExplicitOrderStart };
