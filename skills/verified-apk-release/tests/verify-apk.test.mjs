import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assertDownloadUrl, assertMetadata, assertSignature, digestDownload, verifyApk } from '../scripts/verify-apk.mjs';

const helper = fileURLToPath(new URL('../scripts/verify-apk.mjs', import.meta.url));
const fakeTool = fileURLToPath(new URL('./fake-android-tool.mjs', import.meta.url));
const CERT_A = 'a'.repeat(64); // Fictional fingerprint, not a real signing identity.
const CERT_B = 'b'.repeat(64);
const metadata = { packageName: 'org.example.demo', versionName: '2.4.0-test+7', versionCode: 247 };
const badging = `package: name='${metadata.packageName}' versionCode='${metadata.versionCode}' versionName='${metadata.versionName}' platformBuildVersionName='test'\napplication: label='Synthetic fixture'\n`;
const signer = (hash = CERT_A, subject = 'CN=Fictional Fixture') => `Verified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate DN: ${subject}\nSigner #1 certificate SHA-256 digest: ${hash}\n`;
const bytes = Buffer.from('Synthetic non-APK bytes used only to test orchestration and delivery.');
const fingerprint = data => ({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') });

async function harness(t, handler) {
  const directory = await mkdtemp(path.join(tmpdir(), 'apk-fixture-tests-'));
  const server = http.createServer(handler ?? ((_req, response) => response.end(bytes)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const host = `127.0.0.1:${server.address().port}`;
  const instructionsPath = path.join(directory, 'fake-tools.json');
  const instructions = { badging, signing: signer() };
  await writeFile(instructionsPath, JSON.stringify(instructions));
  await writeFile(path.join(directory, 'source.apk'), bytes);
  await copyFile(path.join(directory, 'source.apk'), path.join(directory, 'delivered.apk'));
  await writeFile(path.join(directory, 'fake-apksigner.jar'), 'not a jar; fake tools ignore this');
  const config = {
    ...metadata, apk: 'source.apk', copies: ['delivered.apk'], urls: [`http://${host}/app.apk`], allowedHosts: [host],
    expectedSignerSha256: [CERT_A], output: 'result.fixture.json', maxBytes: 1024, timeoutMs: 1000, toolTimeoutMs: 3000,
    tools: { aapt: process.execPath, java: process.execPath, apksignerJar: 'fake-apksigner.jar' },
    fixtureToolPrefixes: { aapt: [fakeTool, 'badging', instructionsPath], java: [fakeTool, 'signer', instructionsPath] },
  };
  return {
    directory, config, instructions, host, server,
    updateTools: () => writeFile(instructionsPath, JSON.stringify(instructions)),
    run: () => verifyApk(config, { baseDir: directory, fixture: true }),
    noOutput: async () => assert.rejects(readFile(path.join(directory, config.output)), { code: 'ENOENT' }),
  };
}

test('metadata requires actual exact package, versionName and numeric versionCode and rejects debuggable', () => {
  assert.deepEqual(assertMetadata(badging, metadata), metadata);
  for (const change of [{ packageName: 'org.other.demo' }, { versionName: '2.4.0' }, { versionCode: 248 }]) {
    assert.throws(() => assertMetadata(badging, { ...metadata, ...change }), /differs/);
  }
  assert.throws(() => assertMetadata(`${badging}application-debuggable\n`, metadata), /Debuggable/);
  assert.throws(() => assertMetadata(`${badging}${badging}`, metadata), /exactly one/);
});

test('signature gates exact signer set, cryptographic scheme, debug subject and denylist', () => {
  assert.deepEqual(assertSignature(signer(), [CERT_A]), { currentSignerSha256: [CERT_A], schemes: ['v2'] });
  const multiple = `${signer()}Signer #2 certificate DN: CN=Other Fictional Fixture\nSigner #2 certificate SHA-256 digest: ${CERT_B}\n`;
  assert.deepEqual(assertSignature(multiple, [CERT_A, CERT_B]).currentSignerSha256, [CERT_A, CERT_B]);
  assert.throws(() => assertSignature(multiple, [CERT_A]), /exact expected/);
  assert.throws(() => assertSignature(signer(CERT_B), [CERT_A]), /exact expected/);
  assert.throws(() => assertSignature(signer(CERT_A, 'O=Android, CN = "Android Debug", C=US'), [CERT_A]), /Debug signing/);
  assert.throws(() => assertSignature(signer(), [CERT_A], [CERT_A]), /denySigner/);
  assert.throws(() => assertSignature(signer().replace('): true', '): false'), [CERT_A]), /verified APK signature/);
  assert.throws(() => assertSignature(`${signer()}${signer()}`, [CERT_A]), /Duplicate/);
  assert.throws(() => assertSignature(signer().replace(/Signer #1 certificate DN:.+\n/, ''), [CERT_A]), /subject/);
});

test('full synthetic fixture runs fake tools and writes only an explicitly unverified report', async t => {
  const h = await harness(t);
  const result = await h.run();
  assert.equal(result.report.kind, 'unverified-apk-fixture-report');
  assert.equal(result.report.verification.status, 'unverified-fixture');
  assert.equal(result.report.verification.releaseEligible, false);
  assert.equal(result.report.verification.checks.cryptographicSignature, false);
  assert.equal(result.report.verification.checks.actualMetadata, false);
  assert.equal(result.report.artifact.sha256, fingerprint(bytes).sha256);
  assert.equal(result.report.artifact.downloads.length, 1);
  assert.equal(result.report.artifact.versionName, metadata.versionName);
  assert.deepEqual(JSON.parse(await readFile(result.output, 'utf8')), result.report);
  assert.deepEqual((await readdir(h.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('fixture mode cannot emit release candidate; release mode rejects fixture prefixes and plain HTTP before tools', async t => {
  const h = await harness(t);
  h.config.output = 'result.candidate.json';
  await assert.rejects(h.run(), /Fixture output/);
  await h.noOutput();
  await assert.rejects(verifyApk(h.config, { baseDir: h.directory }), /fixtureToolPrefixes/);
  delete h.config.fixtureToolPrefixes;
  await assert.rejects(verifyApk(h.config, { baseDir: h.directory }), /require HTTPS/);
  await h.noOutput();
});

test('wrong metadata and fake cryptographic failures prevent output', async t => {
  const h = await harness(t);
  h.config.versionCode++;
  await assert.rejects(h.run(), /differs from expectations/);
  await h.noOutput();
  h.config.versionCode--;
  h.instructions.exitCode = 1;
  await h.updateTools();
  await assert.rejects(h.run(), /unsuccessfully/);
  await h.noOutput();
});

test('local copy with same size and different bytes prevents output', async t => {
  const h = await harness(t);
  await writeFile(path.join(h.directory, 'delivered.apk'), Buffer.alloc(bytes.length, 88));
  await assert.rejects(h.run(), /Local delivered copy differs/);
  await h.noOutput();
});

test('source mutation during an external Android step is caught before output', async t => {
  const h = await harness(t);
  h.instructions.mutateSource = path.join(h.directory, 'source.apk');
  await h.updateTools();
  await assert.rejects(h.run(), /changed during verification/);
  await h.noOutput();
});

test('private snapshot mutation by a tool is caught', async t => {
  const h = await harness(t);
  h.instructions.mutateSnapshot = true;
  await h.updateTools();
  await assert.rejects(h.run(), /changed during verification/);
  await h.noOutput();
});

test('source and delivered files are rechecked after full download', async t => {
  let mutate;
  const h = await harness(t, (_req, response) => { mutate().then(() => response.end(bytes)); });
  mutate = () => writeFile(path.join(h.directory, 'delivered.apk'), Buffer.alloc(bytes.length, 89));
  await assert.rejects(h.run(), /changed during verification/);
  await h.noOutput();
});

test('new-output rule preserves a previous report', async t => {
  const h = await harness(t);
  const filename = path.join(h.directory, h.config.output);
  await writeFile(filename, 'previous immutable report');
  await assert.rejects(h.run(), /already exists/);
  assert.equal(await readFile(filename, 'utf8'), 'previous immutable report');
});

test('atomic no-clobber protects output created during verification', async t => {
  let inject;
  const h = await harness(t, (_req, response) => { inject().then(() => response.end(bytes)); });
  const filename = path.join(h.directory, h.config.output);
  inject = () => writeFile(filename, 'concurrent writer');
  await assert.rejects(h.run(), { code: 'EEXIST' });
  assert.equal(await readFile(filename, 'utf8'), 'concurrent writer');
  assert.equal((await readdir(h.directory)).some(name => name.endsWith('.tmp')), false);
});

test('copy path must represent an independent file', async t => {
  const h = await harness(t);
  h.config.copies = ['source.apk'];
  await assert.rejects(h.run(), /distinct files/);
  await h.noOutput();
});

test('hardlink aliases are not independent delivered copies', async t => {
  const h = await harness(t);
  await rm(path.join(h.directory, 'delivered.apk'));
  await link(path.join(h.directory, 'source.apk'), path.join(h.directory, 'delivered.apk'));
  await assert.rejects(h.run(), /same file identity/);
  await h.noOutput();
});

test('bounded tools fail without writing a fixture report', async t => {
  const h = await harness(t);
  h.instructions.hang = true;
  await h.updateTools();
  h.config.toolTimeoutMs = 150;
  await assert.rejects(h.run(), /toolTimeoutMs/);
  await h.noOutput();
});

test('fixture downloads cannot address external hosts even when allowlisted', () => {
  assert.throws(() => assertDownloadUrl('http://example.invalid/app.apk', { fixture: true, allowedHosts: ['example.invalid'] }), /loopback/);
  assert.throws(() => assertDownloadUrl('https://a.example.invalid/app.apk', { fixture: false, allowedHosts: ['b.example.invalid'] }), /allowedHosts/);
  assert.throws(() => assertDownloadUrl('http://a.example.invalid/app.apk', { fixture: false, allowedHosts: ['a.example.invalid'] }), /HTTPS/);
  assert.throws(() => assertDownloadUrl('https://u:p@a.example.invalid/app.apk', { fixture: false, allowedHosts: ['a.example.invalid'] }), /credentials/);
});

test('bounded loopback download rejects wrong hash, truncation, extra bytes, compressed body and non-200', async t => {
  const h = await harness(t, (req, response) => {
    response.setHeader('Transfer-Encoding', 'chunked');
    if (req.url === '/wrong') response.end(Buffer.alloc(bytes.length, 90));
    else if (req.url === '/short') response.end(bytes.subarray(0, 5));
    else if (req.url === '/extra') response.end(Buffer.concat([bytes, Buffer.from('extra')]));
    else if (req.url === '/compressed') { response.setHeader('Content-Encoding', 'gzip'); response.end(bytes); }
    else if (req.url === '/partial') { response.statusCode = 206; response.end(bytes); }
    else if (req.url === '/length') { response.removeHeader('Transfer-Encoding'); response.setHeader('Content-Length', bytes.length + 2); response.end(bytes); }
    else if (req.url === '/trailing') { response.removeHeader('Transfer-Encoding'); response.setHeader('Content-Length', bytes.length); response.end(Buffer.concat([bytes, Buffer.from('invalid trailing HTTP bytes')])); }
  });
  const policy = { fixture: true, allowedHosts: [h.host], timeoutMs: 1000, maxRedirects: 0 };
  for (const route of ['wrong', 'short', 'extra', 'compressed', 'partial', 'length', 'trailing']) {
    await assert.rejects(digestDownload(`http://${h.host}/${route}`, fingerprint(bytes), policy));
  }
});

test('redirect limits, allowlist and loopback restriction apply on every hop', async t => {
  const h = await harness(t, (req, response) => {
    if (req.url === '/ok') response.end(bytes);
    else { response.statusCode = 302; response.setHeader('Location', req.url === '/once' ? '/ok' : req.url === '/external' ? 'http://example.invalid/app.apk' : '/loop'); response.end(); }
  });
  const policy = { fixture: true, allowedHosts: [h.host, 'example.invalid'], timeoutMs: 1000, maxRedirects: 1 };
  const success = await digestDownload(`http://${h.host}/once`, fingerprint(bytes), policy);
  assert.equal(success.finalUrl, `http://${h.host}/ok`);
  await assert.rejects(digestDownload(`http://${h.host}/once`, fingerprint(bytes), { ...policy, maxRedirects: 0 }), /maxRedirects/);
  await assert.rejects(digestDownload(`http://${h.host}/loop`, fingerprint(bytes), policy), /maxRedirects/);
  await assert.rejects(digestDownload(`http://${h.host}/external`, fingerprint(bytes), policy), /loopback/);
});

test('download deadline covers a stalled body', async t => {
  const h = await harness(t, (_req, response) => { response.writeHead(200); response.write(bytes.subarray(0, 2)); });
  await assert.rejects(digestDownload(`http://${h.host}/stall`, fingerprint(bytes), { fixture: true, allowedHosts: [h.host], timeoutMs: 100, maxRedirects: 0 }));
});

test('CLI resolves config-relative paths and preserves non-promotable fixture markers', async t => {
  const h = await harness(t);
  const nested = path.join(h.directory, 'another-cwd');
  await mkdir(nested);
  const configPath = path.join(h.directory, 'config.json');
  await writeFile(configPath, JSON.stringify(h.config));
  const execution = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, 'fixture', '--config', configPath], { cwd: nested, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).status, 'unverified-fixture');
  assert.equal(JSON.parse(await readFile(path.join(h.directory, h.config.output), 'utf8')).verification.releaseEligible, false);
});
