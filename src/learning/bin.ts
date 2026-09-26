#!/usr/bin/env node
import { runCli } from './cli';
import { runPreferenceCli } from './preferenceCli';

const args = process.argv.slice(2);
const result = args[0]?.startsWith('preferences-') ? await runPreferenceCli(args) : runCli(args);
console.log(result.message);
process.exit(result.code);
