const { EventEmitter } = require("node:events");

function createPipeline() {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  return bus;
}

module.exports = { createPipeline };
