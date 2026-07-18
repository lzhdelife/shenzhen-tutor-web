'use strict';

const { PARSER_VERSION } = require('./pipeline');
const { classifyOrderBlock } = require('./classifier');

async function mapWithConcurrency(items, concurrency, mapper) {
  const result = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}

function requireDependency(dependencies, name) {
  if (typeof dependencies?.[name] !== 'function') {
    throw new TypeError(`order recognizer requires dependency: ${name}`);
  }
  return dependencies[name];
}

/**
 * Stable application-facing boundary for order recognition.
 *
 * The parser package owns splitting and extraction orchestration. Infrastructure
 * details (legacy rule parser, Amap verification and persistence settings) are
 * injected so this module remains independently testable.
 */
async function recognizeOrders(request, dependencies) {
  const splitDetailed = requireDependency(dependencies, 'splitDetailed');
  const parseRuleOrder = requireDependency(dependencies, 'parseRuleOrder');
  const buildStructured = requireDependency(dependencies, 'buildStructured');
  const resolveLocation = dependencies?.resolveLocation;
  const split = splitDetailed(request?.text || '');
  const acceptedBlocks = [];
  const ignoredBlocks = [];
  split.blocks.forEach((rawText, sourceBlockIndex) => {
    const diagnostic = split.diagnostics[sourceBlockIndex];
    const classification = classifyOrderBlock(rawText);
    if (classification.accepted) {
      acceptedBlocks.push({ rawText, diagnostic, sourceBlockIndex, classification });
    } else {
      ignoredBlocks.push({
        rawText,
        reason: classification.reason,
        evidence: classification.evidence,
        diagnostic: { ...diagnostic, sourceBlockIndex, classification: 'ignored' }
      });
    }
  });

  // Preview intentionally does not deduplicate. Dropping or merging a raw block
  // before the user confirms it is more harmful than showing a possible duplicate.
  const parsed = await mapWithConcurrency(acceptedBlocks, 3, async ({ rawText }) => {
    const order = parseRuleOrder(rawText, request?.source || '', request?.agencyId || '');
    if (typeof resolveLocation === 'function') {
      await resolveLocation(order, request?.settings || {});
    }
    order.structured = await buildStructured({ rawText, ruleOrder: order });
    return order;
  });

  return {
    parserVersion: PARSER_VERSION,
    parsed,
    splitDiagnostics: acceptedBlocks.map((item, blockIndex) => ({
      ...item.diagnostic,
      blockIndex,
      sourceBlockIndex: item.sourceBlockIndex,
      classification: 'order'
    })),
    ignoredBlocks
  };
}

module.exports = { recognizeOrders };
