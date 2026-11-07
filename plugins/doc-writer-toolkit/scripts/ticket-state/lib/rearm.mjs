// Re-arming a host job the watcher disarmed (lib/watch.mjs): a job that failed at each try for an hour is disarmed, an
// `every` job until the next morning run, a watch job until its next new card. Two things re-arm it sooner:
//   - the reads that were failing when it was disarmed (the boards, the PRs: `downWith`) read again in a check, so a
//     job that failed only because the network was down runs at the first check after the network is back;
//   - `ticket-state set retry job <name>` (its time in `<state>/rearmed.json`, `jobs`), later than the disarm.
// A job disarmed while every read worked (the job's own failure) stays disarmed until one of these.

const isDisarmed = (job, s) => Boolean(s.disarmed) || Boolean(s.lastFailure && (s.heldUntil || (job.watch && !s.armed)) && !s.rearmed);
const disarmedAt = (s) => Date.parse(s.disarmed?.at ?? s.lastFailure ?? '') || 0;

export function rearmJob(job, state, { sources = [], rearmedAt = null, now }) {
  if (!isDisarmed(job, state)) return { state };
  const down = state.disarmed?.downWith ?? [];
  const back = down.length > 0 && down.every((name) => sources.find((x) => x.name === name)?.outcome === 'read');
  const byOwner = Boolean(rearmedAt) && Date.parse(rearmedAt) > disarmedAt(state);
  if (!back && !byOwner) return { state };
  const rearmed = { at: new Date(now).toISOString(), why: byOwner ? '`ticket-state set retry job`' : `${down.join(', ')} read again` };
  return {
    rearmed,
    state: { ...state, heldUntil: null, failures: 0, failingSince: null, disarmed: null, rearmed, ...(job.watch ? { armed: true } : {}) },
  };
}
