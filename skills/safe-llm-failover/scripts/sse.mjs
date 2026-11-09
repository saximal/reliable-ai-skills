// Dependency-free SSE framing. This does not interpret any provider's JSON schema.
export async function* parseSse(chunks, { maxEventChars = 1_048_576 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data = [], event = '', id = '', size = 0, afterCR = false;
  function consumeLine(value) {
    if (value === '') {
      const result = data.length ? { data: data.join('\n'), event: event || 'message', id } : null;
      data = []; event = ''; size = 0;
      return result;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let valueText = colon < 0 ? '' : value.slice(colon + 1);
    if (valueText.startsWith(' ')) valueText = valueText.slice(1);
    if (field === 'data') data.push(valueText);
    else if (field === 'event') event = valueText;
    else if (field === 'id' && !valueText.includes('\0')) id = valueText;
    return null;
  }
  function* consume(text) {
    for (const char of text) {
      if (afterCR && char === '\n') { afterCR = false; continue; }
      afterCR = false;
      if (char === '\r' || char === '\n') {
        const framed = consumeLine(line); line = ''; afterCR = char === '\r';
        if (framed) yield framed;
      } else {
        line += char;
        if (++size > maxEventChars) throw new Error('SSE event exceeds configured character limit');
      }
    }
  }
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('SSE input must contain byte chunks');
    yield* consume(decoder.decode(chunk, { stream: true }));
  }
  yield* consume(decoder.decode());
  // An event without its terminating blank line is incomplete and is not dispatched.
}
