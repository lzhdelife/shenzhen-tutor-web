'use strict';

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
      boundaryReason: /^\s*(?:【|\[|[A-Z]{1,5}\d{4,})/.test(block) ? 'title' : 'heuristic',
      confidence: 0.75
    };
  });
  return { blocks, diagnostics };
}

module.exports = { splitOrdersDetailed };
