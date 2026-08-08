#!/usr/bin/env node
import { runAggregateCli } from './aggregateCutLearning';

const result = runAggregateCli(process.argv.slice(2));
console.log(result.message);
process.exit(result.code);
