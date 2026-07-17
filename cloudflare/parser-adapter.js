'use strict';

// This adapter only wires the parser package's stable orchestration boundary to
// infrastructure dependencies already exported by the legacy Node application.
// Parsing rules remain owned by TutorPlatform/parser and are not duplicated here.
const platform = require('../TutorPlatform/server.js');
const { recognizeOrders } = require('../TutorPlatform/parser/recognizer.js');
const { runParserPipeline } = require('../TutorPlatform/parser/pipeline.js');

async function parseOrders(data, context) {
  const agency = context.agency;
  const env = context.env || {};
  const settings = {
    amapWebServiceKey: env.AMAP_WEB_SERVICE_KEY || '',
    homeAddress: '',
    maxBikeKm: 12
  };
  const resolveWithoutDistrictRegression = async (order, scopedSettings) => {
    const original = {
      district: order.district,
      place: order.place,
      placeOriginal: order.placeOriginal,
      address: order.address,
      locationQuery: order.locationQuery,
      locationQueries: order.locationQueries
    };
    await platform.resolveOrderLocation(order, scopedSettings);
    if (original.district && order.district && order.district !== original.district) {
      Object.assign(order, original, {
        locationVerified: false,
        locationStatus: 'ambiguous',
        locationConfidence: 0,
        locationPoiId: '',
        locationCoordinates: '',
        locationAddress: ''
      });
    }
  };
  return recognizeOrders({
    text: data?.text || '',
    source: agency.name,
    agencyId: agency.id,
    settings
  }, {
    splitDetailed: platform.splitImportBlocksDetailed,
    parseRuleOrder: platform.parseOrder,
    resolveLocation: resolveWithoutDistrictRegression,
    buildStructured: ({ rawText, ruleOrder }) => runParserPipeline({ rawText, ruleOrder })
  });
}

module.exports = { parseOrders };
