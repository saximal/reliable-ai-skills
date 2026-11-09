import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const textEvent = text => frame({ type: 'text', text });
const usage = (final, inputTokens = 3, outputTokens = 2) => frame({ type: 'usage', inputTokens, outputTokens, final });
const finish = reason => frame({ type: 'finish', reason });
const done = 'data: [DONE]\r\n\r\n';
const failure = frame({ type: 'error', code: 'overloaded', retryable: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function startFaultServer({ port = 0 } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be 0..65535');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'POST' || url.pathname !== '/stream') { res.writeHead(404).end(); return; }
      let bytes = 0, parts = [];
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 262_144) { res.writeHead(413).end(); return; }
        parts.push(part);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { res.writeHead(400).end(); return; }
      const scenario = url.searchParams.get('scenario') ?? 'success';
      requests.push({ scenario, body });
      if (scenario === 'unavailable') { res.writeHead(503).end('synthetic outage'); return; }
      if (scenario === 'auth') { res.writeHead(401).end('synthetic credentials error'); return; }
      if (scenario === 'redirect') { res.writeHead(302, { location: 'http://example.invalid/' }).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
      res.flushHeaders();
      if (scenario === 'wait-before') {
        res.write(': keepalive\r\n\r\n');
        // No first text; cancellation closes the connection. No long-lived timer is needed.
        return;
      }
      if (scenario === 'hang-after') { res.write(textEvent('A')); return; }
      if (scenario === 'slow-after') {
        res.write(textEvent('A')); await wait(250);
        if (!res.destroyed) res.end(textEvent('B') + usage(true) + finish('stop') + done);
        return;
      }
      if (scenario === 'partial') { res.end(textEvent('partial') + usage(false) + failure); return; }
      if (scenario === 'final-fail') { res.end(usage(true, 7, 1) + failure); return; }
      if (scenario === 'interim-fail') { res.end(usage(false, 7, 1) + failure); return; }
      if (scenario === 'error-before') { res.end(failure); return; }
      if (scenario === 'missing-done') { res.end(textEvent('partial') + usage(false) + finish('stop')); return; }
      if (scenario === 'malformed') { res.end('data: {bad json}\n\n'); return; }
      if (scenario === 'empty') { res.end(usage(true, 1, 0) + finish('stop') + done); return; }
      if (scenario === 'continuation' || scenario === 'continuation-failure') {
        if (!body.continuation) { res.end(textEvent('part one ') + usage(true) + finish('length') + done); return; }
        if (scenario === 'continuation-failure') { res.end(failure); return; }
        res.end(textEvent('part two') + usage(true, 5, 2) + finish('stop') + done); return;
      }
      if (scenario === 'fragmented') {
        const wire = Buffer.from(': comment\r\n\r\n' +
          'event: chunk\r\ndata: {"type":"text",\r\ndata: "text":"café ☕"}\r\n\r\n' +
          usage(true) + finish('stop') + done);
        // Write byte fragments over a real socket; parser tests independently force every split.
        for (let index = 0; index < wire.length; index += 3) {
          if (res.destroyed) return;
          res.write(wire.subarray(index, index + 3));
          await new Promise(resolve => setImmediate(resolve));
        }
        res.end(); return;
      }
      if (scenario !== 'success') { res.end(frame({ type: 'error', code: 'unknown_scenario', retryable: false })); return; }
      res.end(textEvent('hello ') + textEvent('world') + usage(true) + finish('stop') + done);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  // Bind only IPv4 loopback; the CLI does not expose a host override.
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url, requests,
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length && args[0] !== '--port') || (args.length === 1)) {
    console.error('Usage: node scripts/fault-server.mjs [--port 8787]'); process.exitCode = 2;
  } else {
    const lab = await startFaultServer({ port: args.length ? Number(args[1]) : 8787 });
    console.log(`Synthetic SSE server: ${lab.url}/stream?scenario=success (POST)`);
    const stop = async () => { await lab.close(); process.exitCode = 0; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}
