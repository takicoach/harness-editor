#!/usr/bin/env node
import { runCli } from './cli';

const result = runCli(process.argv.slice(2));
console.log(result.message);
process.exit(result.code);
