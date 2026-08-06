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

  function planAssistantFlow(contentInput, toolsInput) {
    const content = String(contentInput || '');
    const tools = Array.isArray(toolsInput) ? toolsInput : [];
    const ordered = tools.map((item, index) => {
      const rawOffset = item?.contentOffset;
      const numericOffset = Number(rawOffset);
      const anchored = rawOffset !== undefined && rawOffset !== null && rawOffset !== '' && Number.isFinite(numericOffset) && numericOffset >= 0;
      return {
        item,
        index,
        anchored,
        offset: anchored ? Math.min(content.length, numericOffset) : 0,
        sequence: Number.isFinite(Number(item?.sequence)) ? Number(item.sequence) : index
      };
    }).sort((left, right) => left.offset - right.offset || left.sequence - right.sequence || left.index - right.index);

    const process = [];
    let cursor = 0;
    let index = 0;
    while (index < ordered.length) {
      const offset = ordered[index].offset;
      if (offset > cursor) process.push({ type: 'text', text: content.slice(cursor, offset) });
      const group = [];
      while (index < ordered.length && ordered[index].offset === offset) group.push(ordered[index++].item);
      process.push({ type: 'tools', tools: group });
      cursor = Math.max(cursor, offset);
    }

    return {
      finalText: content.slice(cursor),
      legacy: ordered.some((item) => !item.anchored),
      process
    };
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

  return { RequestGate, SerialQueue, planAssistantFlow, runLatestRequest, streamMatches };
});
