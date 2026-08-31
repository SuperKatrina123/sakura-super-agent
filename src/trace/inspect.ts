import { inspectTrace } from './recorder.js';

const filePath = process.argv[2];

if (!filePath) {
  console.error('用法: pnpm trace:inspect <trace-file>');
  process.exit(1);
}

console.log(await inspectTrace(filePath));
