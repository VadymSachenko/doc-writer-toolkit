// The day's allowance (a share of the week's plan): automated work may use `dailyPercent` of the week per day of the
// week window, counted from the weekly reset that `claude -p /usage` prints; what a day leaves unused carries over
// (10% on the window's first day, up to 70% on its seventh with 10). `maxWeekPercent`, when set, caps it.
// The same reading as the repo's skill harness, kept here so the plugin's scripts carry it.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

// The plan's usage bars from `/usage`. Either is null when the output has none (an API key has no plan limits).
// Only the "all models" week line counts.
export function parseUsage(text) {
  const bar = (re) => {
    const m = re.exec(String(text ?? ''));
    return m ? { percent: Number(m[1]), resets: m[2]?.trim() ?? null } : null;
  };
  return {
    session: bar(/Current session:\s*(\d+)% used(?:\s*·\s*resets ([^\n]+))?/),
    week: bar(/Current week \(all models\):\s*(\d+)% used(?:\s*·\s*resets ([^\n]+))?/),
  };
}

function zoneParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

function zoneOffset(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function wallToInstant({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(guess).getUTCMonth() !== month - 1 || new Date(guess).getUTCDate() !== day) return null;
  const first = zoneOffset(guess, timeZone);
  let ms = guess - first;
  const second = zoneOffset(ms, timeZone);
  if (second !== first) ms = guess - second;
  const back = zoneParts(ms, timeZone);
  return { ms, exists: back.year === year && back.month === month && back.day === day && back.hour === hour && back.minute === minute };
}

// A reset as /usage prints it, "Nov 7 at 6am (Europe/Kiev)", as an instant (ms), or null.
export function parseReset(text, now = new Date()) {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b\s*(?:\(([^)]+)\))?/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  const hour12 = Number(m[3]);
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  if (!month || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const timeZone = m[6]?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const nowMs = now.getTime();
    const thisYear = new Date(nowMs).getUTCFullYear();
    for (let year = thisYear - 1; year <= thisYear + 1; year++) {
      const at = wallToInstant({ year, month, day: Number(m[2]), hour, minute }, timeZone);
      if (at && at.ms >= nowMs - DAY_MS) return at.exists ? at.ms : null;
    }
  } catch {
    /* an unknown time zone */
  }
  return null;
}

// The allowance at `now`: the day of the week window, the share of the week usable by now (`cap`), what is used, and
// what remains today. Null when there is no week bar or its reset can't be read.
export function allowanceOf(usage, limits, now = new Date()) {
  if (!usage?.week) return null;
  const reset = parseReset(usage.week.resets, now);
  if (reset === null) return null;
  const day = Math.min(7, Math.max(1, Math.floor((now.getTime() - (reset - 7 * DAY_MS)) / DAY_MS) + 1));
  const allowance = Math.min(100, limits.dailyPercent * day);
  const cap = limits.maxWeekPercent === null || limits.maxWeekPercent === undefined ? allowance : Math.min(allowance, limits.maxWeekPercent);
  return { day, allowance, cap, used: usage.week.percent, remaining: Math.max(0, cap - usage.week.percent), resets: usage.week.resets, session: usage.session ?? null };
}
