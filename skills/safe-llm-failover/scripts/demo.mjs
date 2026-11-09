import { startFaultServer } from './fault-server.mjs';
import { openLocal } from './local-adapter.mjs';
import { runFailover } from './failover.mjs';

const scenario = process.argv[2] ?? 'fallback';
const cases = {
  fallback: ['unavailable', 'success'],
  partial: ['partial', 'success'],
  continuation: ['continuation', 'success'],
  'continuation-failure': ['continuation-failure', 'success'],
  usage: ['final-fail', 'success'],
  fragmented: ['fragmented', 'success'],
  cancel: ['hang-after', 'success'],
  consumer: ['success', 'success'],
};
if (!Object.hasOwn(cases, scenario)) {
  console.error(`Choose: ${Object.keys(cases).join(', ')}`); process.exitCode = 2;
} else {
  const lab = await startFaultServer();
  const cancellation = new AbortController();
  try {
    const result = await runFailover({
      candidates: cases[scenario].map((name, index) => ({ id: `candidate-${index + 1}`, endpoint: `${lab.url}/stream?scenario=${name}`, supportsImages: true })),
      messages: [{ role: 'user', content: 'Synthetic local greeting' }],
      open: openLocal, signal: cancellation.signal, maxAttempts: 3,
      onText: fragment => {
        process.stdout.write(fragment);
        if (scenario === 'cancel') cancellation.abort(new Error('User cancellation'));
        if (scenario === 'consumer') throw new Error('Synthetic UI failure');
      },
    });
    console.log('\n' + JSON.stringify(result, null, 2));
  } catch (error) {
    console.log('\n' + JSON.stringify({ error: error.code ?? error.message, ...error.report }, null, 2));
    // Fault cases are expected demonstrations, not CLI failures.
  } finally { await lab.close(); }
}
