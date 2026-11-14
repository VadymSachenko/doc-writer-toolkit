// Preloaded into the runner's site build (`NODE_OPTIONS`, lib/site-build.mjs). Once a process's event loop has drained
// and it emits `exit`, it ends at once instead of running Node's environment teardown: after a full Docusaurus build
// with rspack that teardown frees gigabytes of native objects one by one, mostly back from swap on a machine short of
// memory, for minutes after the build's last line. It exits from `exit`, not `beforeExit`, so work another
// `beforeExit` listener starts still runs, and the code is the one Node chose (13 for a top-level await that never
// settled, a build that stopped partway). Worker threads are left alone.
const { isMainThread } = require('node:worker_threads');

if (isMainThread) process.once('beforeExit', () => process.once('exit', () => process.exit()));
