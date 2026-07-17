'use strict';

function redactForAI(value) {
  return String(value || '')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号]')
    .replace(/(?:微信|vx|v信|wechat)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_-]{5,}/gi, '[微信号]')
    .replace(/(?:联系人|家长|老师)\s*[:：]\s*[\u4e00-\u9fff]{2,4}/g, match => `${match.split(/[：:]/)[0]}：[姓名]`);
}

module.exports = { redactForAI };
