import { parseSse } from './sse.mjs';
import { TransportError } from './failover.mjs';

// Local synthetic protocol only. Implement this boundary with the application's existing SDK.
export async function* openLocal({ candidate, messages, continuation, signal }) {
  const url = new URL(candidate.endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new TransportError('local_only', 'The lab adapter accepts loopback HTTP endpoints only');
  }
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, continuation }),
    });
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    throw new TransportError('network_error', 'Local transport failed', { retryable: true });
  }
  if (!response.ok) {
    // The small default is a demonstration policy; providers require semantic classification.
    await response.body?.cancel();
    throw new TransportError('http_error', `HTTP ${response.status}`, {
      status: response.status, retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
    });
  }
  if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
    await response.body?.cancel();
    throw new TransportError('protocol_error', 'Expected text/event-stream');
  }
  try {
    for await (const frame of parseSse(response.body)) {
      if (frame.data === '[DONE]') { yield { type: 'done' }; return; }
      let event;
      try { event = JSON.parse(frame.data); }
      catch { throw new TransportError('protocol_error', 'Invalid JSON in local SSE data'); }
      if (!event || typeof event !== 'object') throw new TransportError('protocol_error', 'Expected normalized event object');
      if (event.type === 'error') throw new TransportError(event.code ?? 'provider_error', 'Synthetic provider error', { retryable: event.retryable === true });
      yield event;
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof TransportError) throw error;
    throw new TransportError('stream_interrupted', 'Local SSE stream was interrupted', { retryable: true });
  }
}
