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

  async function runLatestRequest({ requestGate, resultGate = requestGate, onStart, request, onAccept, onReject, onFinish }) {
    const requestGeneration = requestGate.next();
    const resultGeneration = resultGate === requestGate ? requestGeneration : resultGate.next();
    onStart?.();
    try {
      const value = await request();
      if (!requestGate.isCurrent(requestGeneration) || !resultGate.isCurrent(resultGeneration)) return { accepted: false, value };
      await onAccept?.(value);
      return { accepted: true, value };
    } catch (error) {
      const accepted = requestGate.isCurrent(requestGeneration) && resultGate.isCurrent(resultGeneration);
      if (accepted) await onReject?.(error);
      return { accepted, error };
    } finally {
      if (requestGate.isCurrent(requestGeneration)) await onFinish?.();
    }
  }

  return { RequestGate, SerialQueue, runLatestRequest, streamMatches };
});
