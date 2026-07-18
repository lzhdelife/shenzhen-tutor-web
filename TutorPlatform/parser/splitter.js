'use strict';

const { isExplicitOrderStart } = require('./classifier');

/**
 * Numbered compact orders copied from chat commonly start with keycap emoji
 * ("1️⃣") or circled digits. Require grade and subject identity on the same
 * line so numbered requirement lists inside one order are not split.
 */
function isNumberedOrderStart(value) {
  const line = String(value || '').trim();
  if (!/^(?:[1-9]\ufe0f?\u20e3|[①②③④⑤⑥⑦⑧⑨⑩])/.test(line)) return false;
  const hasGrade = /(?:幼儿园|小学|(?:新|准)?小[一二三四五六]|[一二三四五六]年级|(?:新)?初[一二三]|[七八九]年级|(?:新)?高[一二三]|中考|高考)/.test(line);
  const hasSubject = /(?:语文|数学|英语|物理|化学|生物|数理化|语数英|全科|奥数|科学|编程)/.test(line);
  return hasGrade && hasSubject;
}

/**
 * Split raw import text without knowing anything about HTTP, users, storage,
 * maps or field extraction. Blank lines are lossless, high-confidence order
 * boundaries. A caller-supplied soft splitter handles legacy text that has no
 * blank lines.
 */
function splitOrdersDetailed(input, options = {}) {
  const original = String(input || '').replace(/\r/g, '');
  if (!original.trim()) return { blocks: [], diagnostics: [] };

  const hardBoundary = /\n[ \t]*\n(?:[ \t]*\n)*/g;
  const spans = [];
  let cursor = 0;
  let boundary;
  while ((boundary = hardBoundary.exec(original))) {
    spans.push([cursor, boundary.index]);
    cursor = hardBoundary.lastIndex;
  }
  spans.push([cursor, original.length]);

  const hardBlocks = spans
    .map(([start, end]) => {
      const slice = original.slice(start, end);
      const leading = slice.match(/^\s*/)?.[0].length || 0;
      const trailing = slice.match(/\s*$/)?.[0].length || 0;
      const rawStart = start + leading;
      const rawEnd = Math.max(rawStart, end - trailing);
      return { raw: original.slice(rawStart, rawEnd), rawStart, rawEnd };
    })
    .filter(item => item.raw.length > 0);

  if (hardBlocks.length > 1) {
    return {
      blocks: hardBlocks.map(item => item.raw),
      diagnostics: hardBlocks.map((item, blockIndex) => ({
        blockIndex,
        rawStart: item.rawStart,
        rawEnd: item.rawEnd,
        boundaryReason: 'blank-line',
        confidence: 1
      }))
    };
  }

  // A copied source/group label may sit directly above an explicit order id
  // without a blank line. Preserve both spans so the classifier can report
  // the preamble as ignored instead of merging it into the order.
  const explicitStarts = [...original.matchAll(/^.*$/gm)]
    .filter(match => match.index > 0 && isExplicitOrderStart(match[0]))
    .map(match => match.index);
  if (explicitStarts.length) {
    const boundaries = [0, ...explicitStarts, original.length];
    const items = [];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const slice = original.slice(start, end);
      const leading = slice.match(/^\s*/)?.[0].length || 0;
      const trailing = slice.match(/\s*$/)?.[0].length || 0;
      const rawStart = start + leading;
      const rawEnd = Math.max(rawStart, end - trailing);
      if (rawEnd > rawStart) items.push({ raw: original.slice(rawStart, rawEnd), rawStart, rawEnd });
    }
    return {
      blocks: items.map(item => item.raw),
      diagnostics: items.map((item, blockIndex) => ({
        blockIndex, rawStart: item.rawStart, rawEnd: item.rawEnd,
        boundaryReason: blockIndex ? 'explicit-order-title' : 'preamble', confidence: 0.95
      }))
    };
  }

  const softSplit = typeof options.softSplit === 'function'
    ? options.softSplit
    : value => [String(value || '').trim()].filter(Boolean);
  const blocks = softSplit(original);
  let searchFrom = 0;
  const diagnostics = blocks.map((block, blockIndex) => {
    const foundAt = original.indexOf(block, searchFrom);
    const rawStart = foundAt >= 0 ? foundAt : searchFrom;
    const rawEnd = rawStart + block.length;
    searchFrom = rawEnd;
    return {
      blockIndex,
      rawStart,
      rawEnd,
      boundaryReason: isNumberedOrderStart(block) ? 'numbered-order' : /^\s*(?:【|\[|[A-Z]{1,5}\d{4,})/.test(block) ? 'title' : 'heuristic',
      confidence: isNumberedOrderStart(block) ? 0.95 : 0.75
    };
  });
  return { blocks, diagnostics };
}

module.exports = { isNumberedOrderStart, splitOrdersDetailed };
