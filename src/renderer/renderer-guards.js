(function exposeRendererGuards(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StarOwnerRendererGuards = api;
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  class SerialQueue {
    constructor() {
      this.tail = Promise.resolve();
    }

    run(task) {
      const result = this.tail.catch(() => {}).then(task);
      this.tail = result.catch(() => {});
      return result;
    }
  }

  class RequestGate {
    constructor() {
      this.sequence = 0;
    }

    next() {
      this.sequence += 1;
      return this.sequence;
    }

    isCurrent(sequence) {
      return Number(sequence) === this.sequence;
    }
  }

  function streamMatches(stream, messageId) {
    return Boolean(stream) && (!messageId || stream.id === messageId);
  }

  return { RequestGate, SerialQueue, streamMatches };
});
