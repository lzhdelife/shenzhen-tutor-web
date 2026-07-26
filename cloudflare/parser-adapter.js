'use strict';

// This adapter only wires the parser package's stable orchestration boundary to
// infrastructure dependencies already exported by the legacy Node application.
// Parsing rules remain owned by TutorPlatform/parser and are not duplicated here.
const platform = require('../TutorPlatform/server.js');
const { recognizeOrders } = require('../TutorPlatform/parser/recognizer.js');
const { runParserPipeline } = require('../TutorPlatform/parser/pipeline.js');

async function parseOrders(data, context) {
  const agency = context.agency;
  return recognizeOrders({
    text: data?.text || '',
    source: agency.name,
    agencyId: agency.id
  }, {
    splitDetailed: platform.splitImportBlocksDetailed,
    parseRuleOrder: platform.parseOrder,
    buildStructured: ({ rawText, ruleOrder }) => runParserPipeline({ rawText, ruleOrder })
  });
}

module.exports = { parseOrders };
