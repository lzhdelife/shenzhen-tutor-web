import worker from './worker.js';
import parserAdapter from './parser-adapter.js';

export default worker.createWorker({ parseOrders: parserAdapter.parseOrders });
