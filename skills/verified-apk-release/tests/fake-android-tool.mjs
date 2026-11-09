// Deliberately fake tools for fault tests. These do not inspect an APK or verify crypto.
import { readFile, writeFile } from 'node:fs/promises';

const [mode, instructionsPath, ...args] = process.argv.slice(2);
const instructions = JSON.parse(await readFile(instructionsPath, 'utf8'));
if (instructions.mutateSource) await writeFile(instructions.mutateSource, 'changed during external tool');
if (instructions.mutateSnapshot) await writeFile(args.at(-1), 'changed private snapshot');
if (instructions.hang) await new Promise(resolve => setTimeout(resolve, 10000));
if (instructions.exitCode) process.exit(instructions.exitCode);
if (mode === 'badging') console.log(instructions.badging);
else if (mode === 'signer') console.log(instructions.signing);
else process.exitCode = 2;
