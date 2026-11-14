// Preloaded into the runner's site build (`NODE_OPTIONS`, lib/site-build.mjs). When a process's event loop drains, it
// exits at once with the code it would have exited with, instead of running Node's environment teardown: after a full
// Docusaurus build with rspack that teardown frees gigabytes of native objects one by one, mostly back from swap on a
// machine short of memory, for minutes after the build's last line. A failed build exits as before (`process.exit`).
// Worker threads are left alone.
const { isMainThread } = require('node:worker_threads');

if (isMainThread) process.once('beforeExit', (code) => process.exit(code));
