import { spawnSync } from 'node:child_process';

// A macOS notification (design §7, D-060): the morning run's counts, and an urgent one only for a limit reached or a
// step that failed twice. The text goes to osascript as an argument, never inside the script, so a card name with
// quotes can't change what runs. Elsewhere than macOS nothing is sent.
export function notify({ title, text, urgent = false }, io = {}) {
  const bin = io.osascript ?? (process.platform === 'darwin' ? '/usr/bin/osascript' : null);
  if (!bin) return { sent: false, why: 'not macOS' };
  const script = ['on run argv', `display notification (item 2 of argv) with title (item 1 of argv)${urgent ? ' sound name "Basso"' : ''}`, 'end run'];
  const r = (io.spawnSync ?? spawnSync)(bin, [...script.flatMap((l) => ['-e', l]), String(title), String(text).slice(0, 240)], { encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? { sent: true } : { sent: false, why: String(r.stderr ?? r.error?.message ?? 'osascript failed').trim().slice(0, 200) };
}

// What to tell the owner after a check: one urgent notification per reason a day, and the morning counts once a day.
// `runs` are runner results; `jobs` the host jobs' outcomes. Returns [{ key, title, text, urgent }].
export function notificationsOf({ morning, run, jobs = [], today }) {
  const out = [];
  for (const r of [morning, run].filter(Boolean)) {
    const guard = (r.guard ?? []).find((g) => g.kind === 'guard');
    if (guard) out.push({ key: `limit:${today}`, urgent: true, title: 'Ticket flow: limit reached', text: `Scheduled steps stopped: ${guard.reason}.` });
    for (const s of r.ran ?? []) {
      if (s.note === 'failed twice') out.push({ key: `failed:${today}:${s.group}:${s.stage}`, urgent: true, title: 'Ticket flow: a step failed twice', text: `${s.stage} of ${(s.keys ?? []).join(', ')} failed twice. See /ticket-report.` });
    }
  }
  for (const j of jobs) {
    if (j.note === 'failed twice') out.push({ key: `job:${today}:${j.name}`, urgent: true, title: 'Ticket flow: a host job failed twice', text: `${j.name} failed twice. See /ticket-report.` });
    if (j.held) out.push({ key: `limit:${today}`, urgent: true, title: 'Ticket flow: limit reached', text: `${j.name} waits: ${j.held}.` });
  }
  if (morning && !morning.stopped) {
    const done = (morning.ran ?? []).filter((s) => s.outcome === 'done').length;
    const failed = (morning.ran ?? []).filter((s) => s.outcome === 'failed').length;
    const started = (morning.starts ?? []).filter((s) => !s.skipped).length;
    const a = morning.after?.allowance;
    const wip = morning.after?.wip;
    const parts = [
      `${done} step(s) done, ${failed} failed, ${started} started`,
      wip ? `${wip.inProgress} in progress, ${wip.waiting} waiting` : null,
      a ? `week ${a.used}% of ${a.cap}% allowed` : 'no usage reading',
    ].filter(Boolean);
    out.push({ key: `morning:${today}`, urgent: false, title: `Ticket flow${morning.mode && morning.mode !== 'on' ? ` (${morning.mode})` : ''}: the morning report`, text: `${parts.join('; ')}. /ticket-report` });
  }
  const seen = new Set();
  return out.filter((n) => !seen.has(n.key) && seen.add(n.key));
}
