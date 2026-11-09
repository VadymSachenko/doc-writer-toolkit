import { spawnSync } from 'node:child_process';

// A macOS notification (design §7): the morning run's counts, a ticket the watcher started when a slot freed (not
// urgent), and an urgent one only for a limit reached, a
// step that failed twice or hit its daily cap, a host job that failed for an hour, or a part of a check that failed.
// The text goes to osascript as an argument, never inside the script, so a card name with quotes can't change what
// runs. Elsewhere than macOS nothing is sent.
export function notify({ title, text, urgent = false }, io = {}) {
  const bin = io.osascript ?? (process.platform === 'darwin' ? '/usr/bin/osascript' : null);
  if (!bin) return { sent: false, why: 'not macOS' };
  const script = ['on run argv', `display notification (item 2 of argv) with title (item 1 of argv)${urgent ? ' sound name "Basso"' : ''}`, 'end run'];
  const r = (io.spawnSync ?? spawnSync)(bin, [...script.flatMap((l) => ['-e', l]), String(title), String(text).slice(0, 240)], { encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? { sent: true } : { sent: false, why: String(r.stderr ?? r.error?.message ?? 'osascript failed').trim().slice(0, 200) };
}

// A guard stop as a notification: no usage reading is its own reason (a sign-in or `/usage` problem, not a spent
// allowance), so the owner doesn't wait for an allowance that isn't the cause.
const NO_READING = /^no usage reading/;
const guardNote = (reason, what, today) =>
  NO_READING.test(reason)
    ? { key: `noUsage:${today}`, urgent: true, title: 'Ticket flow: no usage reading', text: `${what} stopped: /usage gave no reading. Check the sign-in (schedule.tokenFile) and run claude -p /usage.` }
    : { key: `limit:${today}`, urgent: true, title: 'Ticket flow: limit reached', text: `${what} stopped: ${reason}.` };

// The groups a run started: their start step done. A planned start (a dry run, observe) is not one.
export function startedOf(run) {
  return (run?.starts ?? []).filter((s) => s.steps?.[0]?.stage === 'start' && s.steps[0].outcome === 'done').map((s) => ({ group: s.group, keys: s.steps[0].keys ?? [s.group] }));
}

// A start the watcher's start pass handed to a process of its own, told once its card is in work (lib/watch.mjs): `h` is
// the run's record ({ group, keys, why }).
export const startedNote = (h, today) => ({ key: `started:${today}:${h.group ?? h.keys[0]}`, urgent: false, title: 'Ticket flow: a ticket started', text: `${h.keys.join(', ')} started outside the morning run (${h.why ?? 'a start pass'}). /ticket-report` });

// What to tell the owner after a check: one urgent notification per reason a day, the morning counts once a day, and
// each group the watcher's start pass started. `morning`, `run` and `startPass.run` are runner results; `jobs` the host
// jobs' outcomes. Returns [{ key, title, text, urgent }].
export function notificationsOf({ morning, run, startPass = null, jobs = [], errors = [], capped = [], today }) {
  const out = [];
  for (const s of startedOf(startPass?.run)) {
    out.push({ key: `started:${today}:${s.group}`, urgent: false, title: 'Ticket flow: a ticket started', text: `${s.keys.join(', ')} started outside the morning run (${startPass.why}). /ticket-report` });
  }
  for (const r of [morning, run, startPass?.run].filter(Boolean)) {
    for (const g of (r.guard ?? []).filter((x) => x.kind === 'guard')) out.push(guardNote(g.reason, 'Scheduled steps', today));
    // The morning triage is a step too: its result is in `triage`, not in `ran`.
    for (const s of [...(r.ran ?? []), ...(r.triage?.outcome ? [r.triage] : [])]) {
      if (s.note === 'failed twice') out.push({ key: `failed:${today}:${s.group}:${s.stage}`, urgent: true, title: 'Ticket flow: a step failed twice', text: `${s.stage} of ${(s.keys ?? []).join(', ')} failed twice. See /ticket-report.` });
    }
  }
  for (const j of jobs) {
    // An alert held through the night (`alertHeld`) goes out at the first check after `schedule.morning`, only when
    // the job is still disarmed then (one that re-armed before the morning drops its alert, lib/watch.mjs).
    if (j.disarmed && !j.alertHeld) out.push({ key: `job:${today}:${j.name}`, urgent: true, title: 'Ticket flow: a host job keeps failing', text: `${j.name} failed at each try for an hour (${j.failures} tries, last exit ${j.exit}); disarmed until ${j.downWith?.length ? `${j.downWith.length === 1 ? 'a read that failed with it reads' : `the ${j.downWith.length} reads that failed with it read`} again, ${j.until} at the latest` : j.until}. See /ticket-report.` });
    if (j.since && j.at && !j.disarmed) {
      const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
      const until = Number.isFinite(Date.parse(j.until)) ? `the morning run (${hhmm(j.until)})` : j.until;
      out.push({ key: `job:${today}:${j.name}`, urgent: true, title: 'Ticket flow: a host job kept failing at night', text: `${j.name} failed at each try from ${hhmm(j.since)} (${j.failures} tries, last exit ${j.exit}) and was disarmed at ${hhmm(j.at)}; disarmed until ${until}. See /ticket-report.` });
    }
    if (j.held) out.push(guardNote(j.held, `The host job ${j.name}`, today));
  }
  // A part of a check that failed (a watched list, the status, a run, a job): the rest of the check went on.
  for (const c of capped) out.push({ key: `cap:${today}:${c.key}:${c.stage}${c.pr ? `:${c.pr}` : ''}`, urgent: true, title: 'Ticket flow: a step hit its daily cap', text: `${c.stage} of ${c.key} ran ${c.sessions} sessions today; held until tomorrow. See /ticket-report.`, capped: c });
  for (const e of errors) out.push({ key: `error:${today}:${e.part}`, urgent: true, title: 'Ticket flow: a part of a check failed', text: `${e.part}: ${e.error}`, error: e });
  if (morning && !morning.stopped) {
    const done = (morning.ran ?? []).filter((s) => s.outcome === 'done').length;
    const failed = (morning.ran ?? []).filter((s) => s.outcome === 'failed').length;
    const started = (morning.starts ?? []).filter((s) => !s.skipped).length;
    // A morning run that hands its groups on (lib/dispatch.mjs) has done none of their steps yet: it says what it handed on.
    const handed = (morning.handedOn ?? []).filter((s) => s.handedOn).length;
    const starts = (morning.starts ?? []).filter((s) => s.handedOn).length;
    const a = morning.after?.allowance;
    const wip = morning.after?.wip;
    const parts = [
      morning.handedOn ? `${handed} group(s) handed on, ${starts} start(s) handed on` : `${done} step(s) done, ${failed} failed, ${started} started`,
      wip ? `${wip.inProgress} in progress, ${wip.waiting} waiting` : null,
      a ? `week ${a.used}% of ${a.cap}% allowed` : 'no usage reading',
    ].filter(Boolean);
    out.push({ key: `morning:${today}`, urgent: false, title: `Ticket flow${morning.mode && morning.mode !== 'on' ? ` (${morning.mode})` : ''}: the morning report`, text: `${parts.join('; ')}. /ticket-report` });
  }
  const seen = new Set();
  return out.filter((n) => !seen.has(n.key) && seen.add(n.key));
}
