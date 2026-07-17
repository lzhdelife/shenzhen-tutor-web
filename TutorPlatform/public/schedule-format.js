'use strict';

(function attachScheduleFormatter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TutorScheduleFormat = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const compact = value => String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/((?:每次|一次|时长\s*[:：]?))\s+(?=\d)/g, '$1')
    .replace(/(?<=\d)\s+(?=(?:h|小时))/gi, '')
    .replace(/\s+([，。；、：！？])/g, '$1')
    .replace(/([，。；、：！？])\s+/g, '$1')
    .trim();

  function firstMatch(text, patterns, fallback = '') {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return compact(match[1] || match[0]);
    }
    return fallback;
  }

  function normalizeCount(value) {
    return compact(value)
      .replace(/(?<=\d)\s*[、，,~～至到]\s*(?=\d)/g, '-')
      .replace(/\s*-\s*/g, '-')
      .replace(/^大概\s*/, '约')
      .replace(/^至少安排?\s*/, '至少');
  }

  function collectWeeklyCounts(text) {
    const pattern = /(?:[0-9]{1,2}月|暑假|寒假|假期|开学后?)?\s*(?:一周|每周)\s*[0-9一二三四五六七八九十两]+(?:\s*[-~～、，,至到]\s*[0-9一二三四五六七八九十两]+)?\s*(?:次|天)(?:左右)?/g;
    const matches = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = normalizeCount(match[0]);
      if (value && !matches.includes(value)) matches.push(value);
    }
    if (matches.length === 1) {
      return matches[0].replace(/^(?:[0-9]{1,2}月|暑假|寒假|假期|开学后?)\s*/, '');
    }
    if (matches.length > 1) return matches.join('；');
    return normalizeCount(firstMatch(text, [
      /((?:每隔一天|隔天|几乎每天|每天))/,
      /(周\s*[0-9一二三四五六七两]+\s*天)/
    ], ''));
  }

  function phasedSchedule(text) {
    const summerMatch = text.match(/暑假(?:开始)?([\s\S]*?)(?=开学(?:后)?|$)/);
    const schoolMatch = text.match(/开学(?:后)?([\s\S]*)/);
    if (!summerMatch || !schoolMatch) return null;
    const summer = summerMatch[1];
    const school = schoolMatch[1];
    const weekdays = [...summer.matchAll(/周([一二三四五六日天])/g)].map(match => match[1].replace('天', '日'));
    const uniqueDays = [...new Set(weekdays)];
    const time = firstMatch(summer, [
      /((?:早上?|上午|下午|晚上|晚间)?\s*\d{1,2}\s*点(?:\s*\d{1,2}\s*分)?)/
    ], '');
    const summerDuration = firstMatch(summer, [/((?:一次|每次)\s*[一二三四两0-9]+\s*个?小时|[0-9]+(?:\.\d+)?h\/次)/i], '');
    const schoolDuration = firstMatch(school, [/((?:一次|每次)\s*[一二三四两0-9]+\s*个?小时|[0-9]+(?:\.\d+)?h\/次)/i], '');
    let summerSummary = /连续上课/.test(summer) ? '暑假连续上课' : '暑假';
    if (/(?:每)?隔天(?:上)?(?:一|1)次|隔一天(?:上)?(?:一|1)次/.test(summer)) summerSummary = '暑假隔天1次';
    if (uniqueDays.length) summerSummary = `暑假每周${uniqueDays.join('、')}`;
    let schoolSummary = '开学后';
    if (/周末[^，。；;]{0,8}(?:一|1)次|(?:每周)?周末/.test(school)) schoolSummary = '开学后每周末1次';
    const schoolDay = school.match(/周\s*([1-6一二三四五六])[^，。；;]{0,10}(?:上)?(?:一|1)次/);
    if (schoolDay) {
      const day = ({ '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' })[schoolDay[1]] || schoolDay[1];
      schoolSummary = `开学后每周${day}1次`;
    }
    if (summerDuration) summerSummary += `，${summerDuration.replace(/^一次/, '每次')}`;
    if (schoolDuration) schoolSummary += `，${schoolDuration.replace(/^一次/, '每次')}`;
    return {
      start: '暑假开始',
      count: `${summerSummary}；${schoolSummary}`,
      slot: time || (/周末/.test(school) ? '周末' : (summerDuration || schoolDuration ? '分阶段时长' : '时间段待定'))
    };
  }

  function summarizeScheduleText(value) {
    let text = compact(value);
    text = text.replace(
      /每次\s*([0-9一二三四五六七两]+\s*[-~～、，,至到]\s*[0-9一二三四五六七两]+)\s*次(?=[\s\S]*(?:每次|一次)\s*(?:时长\s*[:：]?\s*)?[0-9一二三四两.]+\s*(?:h|小时))/,
      '每周$1次'
    );
    const phased = phasedSchedule(text);
    if (phased) return phased;

    const start = firstMatch(text, [
      /(暑假|寒假|寒暑假|开学后|现在开始|马上开始|本周开始|下周开始|最近开始|近期开始|这几天就开始|最近试课|[0-9]{1,2}月[0-9]{1,2}[号日]?(?:后|起|开始|上课|试课)?|[0-9]{1,2}\.[0-9]{1,2}\s*[-到至]\s*[0-9]{1,2}\.[0-9]{1,2}|[0-9]{1,2}月[中下旬底初]?(?:开始|上课|试课)?)/
    ], '开始时间待定');

    const weeklyCount = collectWeeklyCounts(text);

    const totalCount = normalizeCount(firstMatch(text, [
      /((?:一共|共|大概|约|至少安排?|持续)\s*[0-9]{1,3}\s*(?:[-~～、，,至到]\s*[0-9]{1,3}\s*)?(?:次课?|节课?)(?:左右)?)/,
      /((?:暑假|寒假|假期)\s*[0-9]{1,3}\s*(?:次课?|节课?)(?:左右)?)/,
      /([0-9]{1,3}\s*[-~～、，,至到]\s*[0-9]{1,3}\s*(?:次课?|节课?)(?:左右)?)/
    ], ''));

    const fallbackCount = normalizeCount(firstMatch(text, [
      /([0-9]{1,3}\s*(?:次课?|节课?)(?:左右)?)/
    ], '次数待定'));
    const weeklyCores = weeklyCount.split('；').map(item => item
      .replace(/^(?:[0-9]{1,2}月|暑假|寒假|假期|开学后?)\s*/, '')
      .replace(/^(?:一周|每周)/, ''));
    const effectiveTotal = totalCount && !weeklyCores.includes(totalCount) ? totalCount : '';
    const counts = [weeklyCount, effectiveTotal].filter(Boolean);
    const count = [...new Set(counts)].join('；') || fallbackCount;

    const period = firstMatch(text, [
      /(时段面议|时间面议)/,
      /(((?<![一每])周[一二三四五六日天]\s*(?:[-到至、和及]\s*(?:周)?[一二三四五六日天])|(?<![一每])周[一二三四五六日天]\s*周[一二三四五六日天])(?:上午|下午|晚上|晚间|白天|中午|傍晚)?(?:\s*或\s*周末)?)/,
      /((?:周末|(?<![一每])周[一二三四五六日天])(?:上午|下午|晚上|晚间|白天|中午|傍晚)?(?:\s*或\s*(?:周末|上午|下午|晚上|晚间|白天|中午|傍晚))?)/,
      /((?:上午|下午|晚上|晚间|白天|中午|傍晚)(?:\s*(?:和|及|、)\s*(?:上午|下午|晚上|晚间|白天|中午|傍晚))?)/,
      /([0-9]{1,2}\s*[:：点]\s*[0-9]{0,2}\s*[-到至]\s*[0-9]{1,2}\s*[:：点]?\s*[0-9]{0,2})/
    ], '');

    const duration = firstMatch(text, [
      /((?:一次|每次|一节课)\s*(?:时长\s*[:：]?\s*)?(?:[0-9]+(?:\.[0-9]+)?|[一二三四两])\s*个?\s*[-~～至到]?\s*(?:[0-9]+(?:\.[0-9]+)?|[一二三四两])?\s*个?\s*(?:h|小时)|[0-9]+(?:\.[0-9]+)?\s*(?:h|小时)\s*\/\s*次)/
    ], '');
    const slot = [...new Set([period, duration].filter(Boolean))].join('，') || '时间段待定';

    return { start, count, slot };
  }

  return { summarizeScheduleText };
}));
