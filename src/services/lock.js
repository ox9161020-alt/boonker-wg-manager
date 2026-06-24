'use strict';

// Serialises async sections so concurrent peer create/revoke requests cannot
// interleave the read-modify-write on the shared awg0.conf. Without this, two
// simultaneous /peer/create calls can read the same peer list and allocate the
// same IP, or clobber each other's writes to the config file.
let tail = Promise.resolve();

function withLock(fn) {
  const run = tail.then(() => fn());
  // Keep the chain alive even if fn rejects, so one failure doesn't wedge the queue.
  tail = run.then(() => {}, () => {});
  return run;
}

module.exports = { withLock };
