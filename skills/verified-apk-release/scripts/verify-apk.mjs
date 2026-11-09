#!/usr/bin/env node
// Node 20+, no npm dependencies. Android SDK and Java are separate dependencies.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_VERSION_CODE = 2100000000;
const SHA256 = /^[a-f0-9]{64}$/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const FIXTURE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isEqual = (a, b) => a.size === b.size && a.sha256 === b.sha256;
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export function assertMetadata(text, expected) {
  const rows = [...text.matchAll(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/gm)];
  ensure(rows.length === 1, 'Android metadata must contain exactly one package record.');
  const [, packageName, code, versionName] = rows[0];
  ensure(packageName === expected.packageName && Number(code) === expected.versionCode && versionName === expected.versionName,
    'Actual APK packageName, versionName or versionCode differs from expectations.');
  ensure(!/^application-debuggable(?:\s|$)/m.test(text), 'Debuggable APK is forbidden.');
  return { packageName, versionName, versionCode: Number(code) };
}

export function assertSignature(text, expected, denied = []) {
  const rows = [...text.matchAll(/^Signer #(\d+) certificate SHA-256 digest:\s*([a-f0-9]{64})\s*$/gmi)];
  ensure(rows.length > 0, 'No current signer certificates found in apksigner output.');
  const ids = rows.map(row => row[1]);
  const actual = rows.map(row => row[2].toLowerCase()).sort();
  ensure(new Set(ids).size === ids.length && new Set(actual).size === actual.length, 'Duplicate signer records are unsupported.');
  const subjects = [...text.matchAll(/^Signer #(\d+) certificate DN:\s*(.+)$/gm)];
  ensure(subjects.length === ids.length && subjects.every(row => ids.includes(row[1])) && new Set(subjects.map(row => row[1])).size === ids.length,
    'Each signer must have a certificate subject.');
  ensure(!subjects.some(row => /(?:^|,)\s*(?:CN|commonName)\s*=\s*"?Android\s+Debug"?\s*(?:,|$)/i.test(row[2])),
    'Android Debug signing certificate is forbidden.');
  ensure(!actual.some(hash => denied.includes(hash)), 'Signing certificate appears in denySignerSha256.');
  ensure(actual.length === expected.length && actual.every((hash, i) => hash === expected[i]),
    'Current APK signer set differs from the exact expectedSignerSha256 set.');
  const schemes = [...text.matchAll(/^Verified using (v(?:2|3(?:\.1)?)) scheme[^\r\n]*:\s*true\s*$/gm)].map(row => row[1]);
  ensure(schemes.length > 0, 'A verified APK signature using v2 or v3 is required.');
  return { currentSignerSha256: actual, schemes: [...new Set(schemes)].sort() };
}

export async function digestFile(filename, maxBytes) {
  const stat = await lstat(filename);
  ensure(stat.isFile() && !stat.isSymbolicLink(), 'Artifact paths must be regular files, not symlinks.');
  ensure(stat.size > 0 && stat.size <= maxBytes, 'Artifact is empty or exceeds maxBytes.');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    ensure(size <= maxBytes, 'Artifact grew beyond maxBytes.');
    hash.update(chunk);
  }
  ensure(size > 0, 'Artifact is empty.');
  return { size, sha256: hash.digest('hex') };
}

export function assertDownloadUrl(value, { fixture, allowedHosts }) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Download URL is invalid.'); }
  ensure(!url.username && !url.password && !url.hash, 'Download URLs cannot include credentials or fragments.');
  ensure(allowedHosts.includes(url.host.toLowerCase()), 'Download URL host is not in allowedHosts.');
  if (fixture) {
    ensure(FIXTURE_HOSTS.has(url.hostname) && ['http:', 'https:'].includes(url.protocol),
      'Fixture downloads are restricted to literal loopback addresses or localhost.');
  } else {
    ensure(url.protocol === 'https:', 'Release downloads require HTTPS; downgrade is forbidden.');
  }
  return url;
}

function request(url, signal, fixture) {
  return new Promise((resolve, reject) => {
    let received;
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      signal, agent: false, headers: { 'Accept-Encoding': 'identity' },
      // Keep normal TLS verification even if the surrounding environment disables it.
      rejectUnauthorized: true,
      // Pin localhost to loopback in fixture mode; do not rely on DNS or proxies.
      ...(fixture && url.hostname === 'localhost' ? { lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4) } : {}),
    }, response => {
      received = response;
      // Preserve errors that arrive between headers and the async iterator setup.
      response.once('error', () => {});
      resolve(response);
    });
    req.once('error', error => {
      // A parser error can occur after response headers (e.g. extra bytes after
      // the declared Content-Length). Do not lose it on an already settled promise.
      received?.destroy(error);
      reject(error);
    });
  });
}

export async function digestDownload(value, expected, policy) {
  const signal = AbortSignal.timeout(policy.timeoutMs);
  let url = assertDownloadUrl(value, policy);
  for (let redirects = 0; ; redirects++) {
    const response = await request(url, signal, policy.fixture);
    if (REDIRECTS.has(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      ensure(redirects < policy.maxRedirects, 'Download exceeded maxRedirects.');
      ensure(typeof location === 'string' && location.length > 0, 'Redirect has no Location.');
      const next = assertDownloadUrl(new URL(location, url).href, policy);
      ensure(!(url.protocol === 'https:' && next.protocol !== 'https:'), 'HTTPS downgrade is forbidden.');
      url = next;
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error('Full download must return HTTP 200.');
    }
    const encoding = response.headers['content-encoding'];
    const length = response.headers['content-length'];
    if ((encoding && encoding.toLowerCase() !== 'identity') ||
        (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== expected.size))) {
      response.destroy();
      throw new Error('Download Content-Length or Content-Encoding differs from the artifact.');
    }
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of response) {
        size += chunk.length;
        ensure(size <= expected.size, 'Download contains extra bytes.');
        hash.update(chunk);
      }
    } finally { response.destroy(); }
    const result = { size, sha256: hash.digest('hex') };
    ensure(isEqual(result, expected), 'Full download digest or size differs from the artifact.');
    return { requestedUrl: value, finalUrl: url.href, ...result };
  }
}

function runTool(command, args, { timeoutMs, baseDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: baseDir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    let bytes = 0;
    let problem;
    const stop = message => {
      problem ??= new Error(message);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop('Android tool exceeded toolTimeoutMs.'), timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) stop('Android tool output exceeded 4 MiB.');
      else parts.push(data);
    });
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Android tool could not start: ${error.code ?? 'unknown error'}.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (problem) reject(problem);
      else if (code !== 0) reject(new Error(`Android tool exited unsuccessfully (${code}).`));
      else resolve(Buffer.concat(parts).toString('utf8').replace(/\r\n/g, '\n'));
    });
  });
}

function fingerprints(value, name, required) {
  ensure(Array.isArray(value) && (!required || value.length > 0) && value.length <= 16 && value.every(v => typeof v === 'string' && SHA256.test(v)),
    `${name} must be an array of ${required ? 'one or more ' : ''}SHA-256 hex fingerprints.`);
  const result = value.map(v => v.toLowerCase()).sort();
  ensure(new Set(result).size === result.length, `${name} contains duplicates.`);
  return result;
}

function bounded(value, fallback, min, max, name) {
  const result = value ?? fallback;
  ensure(Number.isSafeInteger(result) && result >= min && result <= max, `${name} is outside its supported integer range.`);
  return result;
}

function normalize(config, baseDir, fixture) {
  ensure(config && typeof config === 'object' && !Array.isArray(config), 'Config must be an object.');
  const resolve = name => { ensure(typeof name === 'string' && name.length > 0, 'A required path is missing.'); return path.resolve(baseDir, name); };
  ensure(typeof config.packageName === 'string' && /^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(config.packageName), 'packageName must be a concrete Android application ID.');
  ensure(typeof config.versionName === 'string' && config.versionName.length > 0 && config.versionName.length <= 128 && !/[\x00-\x1f\x7f]/.test(config.versionName), 'versionName must be a concrete, printable string.');
  ensure(Number.isSafeInteger(config.versionCode) && config.versionCode >= 1 && config.versionCode <= MAX_VERSION_CODE, 'versionCode must be an integer from 1 to 2100000000.');
  ensure(Array.isArray(config.copies) && config.copies.length >= 1 && config.copies.length <= 32, 'copies must name at least one independently delivered local file (maximum 32).');
  ensure(Array.isArray(config.urls) && config.urls.length >= 1 && config.urls.length <= 32 && config.urls.every(v => typeof v === 'string'), 'urls must contain one or more download URLs (maximum 32).');
  ensure(Array.isArray(config.allowedHosts) && config.allowedHosts.length >= 1 && config.allowedHosts.length <= 32 && config.allowedHosts.every(v => typeof v === 'string' && v.length > 0 && v === v.toLowerCase()), 'allowedHosts must contain lowercase exact hosts, including ports where used.');
  ensure(config.tools && ['aapt', 'java', 'apksignerJar'].every(k => typeof config.tools[k] === 'string' && config.tools[k].length > 0), 'tools.aapt, tools.java and tools.apksignerJar are required (real Android SDK and Java for release).');
  ensure(fixture || config.fixtureToolPrefixes === undefined, 'fixtureToolPrefixes cannot be used for release verification.');
  const prefixes = config.fixtureToolPrefixes ?? {};
  ensure(['aapt', 'java'].every(k => prefixes[k] === undefined || (Array.isArray(prefixes[k]) && prefixes[k].every(v => typeof v === 'string'))), 'Fixture tool prefixes must be argument arrays.');
  const toolCommand = value => value.includes('/') || value.includes('\\') ? resolve(value) : value;
  const result = {
    ...config, fixture, baseDir,
    apk: resolve(config.apk), copies: config.copies.map(resolve), output: resolve(config.output),
    expectedSignerSha256: fingerprints(config.expectedSignerSha256, 'expectedSignerSha256', true),
    denySignerSha256: fingerprints(config.denySignerSha256 ?? [], 'denySignerSha256', false),
    maxBytes: bounded(config.maxBytes, 512 * 1024 * 1024, 1, 4 * 1024 * 1024 * 1024, 'maxBytes'),
    timeoutMs: bounded(config.timeoutMs, 120000, 1, 600000, 'timeoutMs'),
    toolTimeoutMs: bounded(config.toolTimeoutMs, 60000, 1, 600000, 'toolTimeoutMs'),
    maxRedirects: bounded(config.maxRedirects, 0, 0, 5, 'maxRedirects'),
    tools: { aapt: toolCommand(config.tools.aapt), java: toolCommand(config.tools.java), apksignerJar: resolve(config.tools.apksignerJar) },
    prefixes,
  };
  ensure(result.output.endsWith(fixture ? '.fixture.json' : '.candidate.json'), fixture ? 'Fixture output must end in .fixture.json.' : 'Release output must end in .candidate.json.');
  ensure(!result.expectedSignerSha256.some(hash => result.denySignerSha256.includes(hash)), 'Expected signer also appears in denySignerSha256.');
  result.urls.forEach(url => assertDownloadUrl(url, result));
  return result;
}

async function ensureAbsent(filename) {
  try { await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output already exists; use a fresh candidate/report path.');
}

// A same-directory hard link exposes a complete file atomically and refuses overwrite.
// Filesystems without hard-link support fail closed rather than copy a partial report.
async function writeAtomicNew(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await link(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

export async function verifyApk(config, { baseDir = process.cwd(), fixture = false } = {}) {
  const cfg = normalize(config, path.resolve(baseDir), fixture);
  await ensureAbsent(cfg.output);
  const paths = [cfg.apk, ...cfg.copies];
  const info = await Promise.all(paths.map(async file => {
    await digestFile(file, cfg.maxBytes);
    const stat = await lstat(file);
    return { canonical: await realpath(file), identity: `${stat.dev}:${stat.ino}` };
  }));
  const canonical = info.map(item => item.canonical);
  ensure(new Set(canonical.map(v => process.platform === 'win32' ? v.toLowerCase() : v)).size === paths.length, 'APK and local copies must be distinct files.');
  ensure(new Set(info.map(item => item.identity)).size === paths.length, 'APK and local copies cannot share the same file identity (hard links).');
  // Freeze the source BEFORE invoking any tool; tools inspect only a private snapshot.
  const expected = await digestFile(cfg.apk, cfg.maxBytes);
  const directory = await mkdtemp(path.join(tmpdir(), 'verified-apk-'));
  const snapshot = path.join(directory, 'artifact.apk');
  const tracked = [cfg.apk];
  const freeze = async () => {
    for (const filename of [...tracked, snapshot]) ensure(isEqual(await digestFile(filename, cfg.maxBytes), expected), 'Artifact changed during verification.');
  };
  try {
    await copyFile(cfg.apk, snapshot, constants.COPYFILE_EXCL);
    await freeze();
    const toolOptions = { timeoutMs: cfg.toolTimeoutMs, baseDir: cfg.baseDir };
    const badging = await runTool(cfg.tools.aapt, [...(cfg.prefixes.aapt ?? []), 'dump', 'badging', snapshot], toolOptions);
    await freeze();
    const metadata = assertMetadata(badging, cfg);
    const signerText = await runTool(cfg.tools.java, [...(cfg.prefixes.java ?? []), '-jar', cfg.tools.apksignerJar, 'verify', '--verbose', '--print-certs', snapshot], toolOptions);
    await freeze();
    const signature = assertSignature(signerText, cfg.expectedSignerSha256, cfg.denySignerSha256);
    for (const filename of cfg.copies) {
      ensure(isEqual(await digestFile(filename, cfg.maxBytes), expected), 'Local delivered copy differs from the original APK.');
      tracked.push(filename);
    }
    const downloads = [];
    for (const url of cfg.urls) {
      await freeze();
      downloads.push(await digestDownload(url, expected, cfg));
      await freeze();
    }
    const report = {
      schemaVersion: 1,
      kind: fixture ? 'unverified-apk-fixture-report' : 'apk-release-candidate',
      verification: {
        status: fixture ? 'unverified-fixture' : 'verified',
        releaseEligible: !fixture,
        checkedAt: new Date().toISOString(),
        ...signature,
        checks: { actualMetadata: !fixture, cryptographicSignature: !fixture, nonDebuggable: !fixture, byteIdentity: true, localCopies: cfg.copies.length, fullDownloads: downloads.length },
        ...(fixture ? { limitation: 'Synthetic tools/bytes may be used. This report cannot establish a genuine signed APK or authorize a release.' } : {}),
      },
      artifact: { ...metadata, ...expected, downloads },
    };
    await freeze();
    await writeAtomicNew(cfg.output, report);
    return { output: cfg.output, report };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node verify-apk.mjs <verify|fixture> --config CONFIG.json\nverify: real Android tools + HTTPS -> new .candidate.json\nfixture: loopback only -> non-promotable .fixture.json\nNo publishing command is provided. See references/workflow.md.');
    return;
  }
  ensure(args.length === 3 && ['verify', 'fixture'].includes(args[0]) && args[1] === '--config', 'Usage: node verify-apk.mjs <verify|fixture> --config CONFIG.json');
  const configPath = path.resolve(args[2]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const result = await verifyApk(config, { baseDir: path.dirname(configPath), fixture: args[0] === 'fixture' });
  console.log(JSON.stringify({ output: result.output, kind: result.report.kind, status: result.report.verification.status }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
