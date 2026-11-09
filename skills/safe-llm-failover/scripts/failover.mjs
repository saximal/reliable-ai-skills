// Reference orchestration over normalized events, independent of a provider SDK.
export class TransportError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message); this.name = 'TransportError'; this.code = code;
    this.retryable = retryable; this.status = status;
  }
}
export class ConsumerError extends Error {
  constructor(cause) { super('The stream consumer failed', { cause }); this.name = 'ConsumerError'; this.code = 'consumer_error'; }
}
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new TransportError('cancelled', 'Request cancelled');
}
function checkAbort(signal) { if (signal.aborted) throw abortReason(signal); }
function untilAbort(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortReason(signal));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
function positive(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError(`${name} must be a ${allowZero ? 'nonnegative' : 'positive'} integer`);
}
function usageValue(event) {
  if (!Number.isSafeInteger(event.inputTokens) || event.inputTokens < 0 ||
      !Number.isSafeInteger(event.outputTokens) || event.outputTokens < 0 || typeof event.final !== 'boolean') {
    throw new TransportError('protocol_error', 'Invalid normalized usage event');
  }
  return { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
}
export function summarizeUsage(attempts) {
  const known = attempts.filter(attempt => attempt.usage.known);
  return {
    knownInputTokens: known.reduce((sum, attempt) => sum + attempt.usage.final.inputTokens, 0),
    knownOutputTokens: known.reduce((sum, attempt) => sum + attempt.usage.final.outputTokens, 0),
    unknownAttempts: attempts.filter(attempt => !attempt.usage.known).map(attempt => attempt.number),
    fullyKnown: known.length === attempts.length,
  };
}
function hasImages(messages) {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part =>
    part && ['image', 'image_url', 'input_image'].includes(part.type)));
}

/**
 * open({candidate, messages, continuation, signal}) -> AsyncIterable<normalized event>
 * Events: text, usage, finish, done. See references/integration.md for the contract.
 * This reference intentionally owns all retry attempts; adapters must disable SDK retries.
 */
export async function runFailover({
  candidates, messages, open, onText = () => {}, signal,
  maxAttempts = 2, maxContinuations = 1,
  firstTextMs = 2_000, selectionMs = 5_000, generationMs = 10_000,
  classify = error => error instanceof TransportError && error.retryable,
}) {
  positive(maxAttempts, 'maxAttempts'); positive(maxContinuations, 'maxContinuations', true);
  for (const [name, value] of Object.entries({ firstTextMs, selectionMs, generationMs })) positive(value, name);
  if (!Array.isArray(candidates) || !candidates.length || typeof open !== 'function' || !Array.isArray(messages)) {
    throw new TypeError('Supply candidates, messages, and an open adapter');
  }
  const original = structuredClone(messages);
  const imageInput = hasImages(original);
  const root = new AbortController();
  const cancel = () => root.abort(signal.reason ?? new TransportError('cancelled', 'Request cancelled'));
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const selectionTimer = setTimeout(() => root.abort(new TransportError('selection_timeout', 'Model selection deadline exceeded')), selectionMs);
  let generationTimer, visible = false, text = '', candidateIndex = 0, continuationIndex = 0;
  const attempts = [];
  const report = () => ({ text, model: visible ? candidates[candidateIndex].id : null, attempts, usage: summarizeUsage(attempts) });
  try {
    while (true) {
      checkAbort(root.signal);
      if (attempts.length >= maxAttempts) throw new TransportError('attempt_budget', 'Total attempt budget exhausted');
      const candidate = candidates[candidateIndex];
      if (!candidate || typeof candidate.id !== 'string') throw new TypeError('Each candidate needs an id');
      if (imageInput && candidate.supportsImages !== true) {
        throw new TransportError('capability_mismatch', 'Image input requires an explicitly image-capable candidate');
      }
      const attempt = {
        number: attempts.length + 1, model: candidate.id, continuation: continuationIndex,
        status: 'running', usage: { known: false, observed: null, final: null },
      };
      attempts.push(attempt);
      const controller = new AbortController();
      const propagate = () => controller.abort(root.signal.reason);
      root.signal.addEventListener('abort', propagate, { once: true });
      const firstTimer = setTimeout(() => controller.abort(new TransportError('first_text_timeout', 'First text deadline exceeded', { retryable: true })), firstTextMs);
      let iterator, finish = null, completed = false;
      try {
        const stream = await untilAbort(Promise.resolve().then(() => open({
          candidate: structuredClone(candidate), messages: structuredClone(original),
          continuation: continuationIndex ? { index: continuationIndex, text } : null,
          signal: controller.signal,
        })), controller.signal);
        iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await untilAbort(iterator.next(), controller.signal);
          if (next.done) break;
          const event = next.value;
          if (event.type === 'text') {
            if (typeof event.text !== 'string' || finish !== null) throw new TransportError('protocol_error', 'Invalid text event');
            if (!event.text) continue;
            clearTimeout(firstTimer);
            if (!visible) {
              visible = true; clearTimeout(selectionTimer);
              generationTimer = setTimeout(() => root.abort(new TransportError('generation_timeout', 'Generation deadline exceeded')), generationMs);
            }
            // Visibility is sticky before entering the consumer: it may perform a partial side effect then throw.
            text += event.text;
            try { await untilAbort(Promise.resolve().then(() => onText(event.text, { signal: controller.signal })), controller.signal); }
            catch (error) { checkAbort(controller.signal); throw new ConsumerError(error); }
          } else if (event.type === 'usage') {
            const value = usageValue(event); attempt.usage.observed = value;
            if (event.final) {
              if (attempt.usage.known) throw new TransportError('protocol_error', 'Duplicate authoritative usage event');
              attempt.usage.known = true; attempt.usage.final = value;
            }
          } else if (event.type === 'finish') {
            if (finish !== null || !['stop', 'length'].includes(event.reason)) throw new TransportError('protocol_error', 'Unsupported finish event');
            finish = event.reason;
          } else if (event.type === 'done') {
            if (finish === null) throw new TransportError('protocol_error', 'Missing finish event');
            completed = true; break;
          } else throw new TransportError('protocol_error', 'Unknown normalized event');
        }
        if (!completed) throw new TransportError('stream_interrupted', 'Stream ended before the completion marker', { retryable: true });
        attempt.status = 'succeeded';
      } catch (caught) {
        const error = controller.signal.aborted ? abortReason(controller.signal) : caught;
        attempt.status = 'failed'; attempt.error = { code: error.code ?? 'adapter_error', name: error.name };
        controller.abort(error);
        checkAbort(root.signal);
        // A continuation cannot replay or switch, even if this particular segment produced no text.
        if (visible || continuationIndex > 0 || error instanceof ConsumerError || !classify(error, { candidate, attempt })) throw error;
        if (attempts.length >= maxAttempts || candidateIndex + 1 >= candidates.length) throw error;
        candidateIndex += 1;
        continue;
      } finally {
        clearTimeout(firstTimer);
        root.signal.removeEventListener('abort', propagate);
        controller.abort(new TransportError('attempt_closed', 'Attempt closed'));
        // Do not wait indefinitely for an adapter that ignores cancellation.
        if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
      }
      if (finish === 'length') {
        if (continuationIndex >= maxContinuations) throw new TransportError('continuation_budget', 'Continuation budget exhausted');
        continuationIndex += 1;
        continue;
      }
      return { ...report(), model: candidates[candidateIndex].id };
    }
  } catch (error) {
    // Even failed calls expose the ledger; an unknown charge is never represented as a known zero.
    error.report = report();
    throw error;
  } finally {
    clearTimeout(selectionTimer); clearTimeout(generationTimer);
    signal?.removeEventListener('abort', cancel);
    if (!root.signal.aborted) root.abort(new TransportError('call_closed', 'Call closed'));
  }
}
