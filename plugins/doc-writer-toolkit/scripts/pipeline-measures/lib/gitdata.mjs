import { MARKER } from './config.mjs';
import { PULL_FETCH } from './runners.mjs';

const CHUNK = 100;
const START = '\u0001';

// Brings the pull requests' commits into the clone (squash-merged and deleted branches are still there).
export const fetchPulls = (git) => git(PULL_FETCH);

// Which of the commits the clone has.
export async function presentOids(git, oids) {
  if (!oids.length) return new Set();
  const out = await git(['cat-file', '--batch-check'], { input: oids.join('\n') + '\n' });
  const present = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40,64}) commit /);
    if (m) present.add(m[1]);
  }
  return present;
}

// One commit's diff, read from `git show --unified=0` output: its parents, the text lines it adds and removes, the
// marker lines among them, the files it touches. A merge commit has no lines of its own.
export function parseCommit(block) {
  const lines = block.split('\n');
  const [oid, ...parents] = lines[0].trim().split(/\s+/);
  const stats = { oid, parents, added: 0, removed: 0, markersAdded: 0, markersRemoved: 0, files: [] };
  if (parents.length > 1) return stats;
  let inHunk = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      const m = line.match(/ b\/(.*)$/);
      stats.files.push(m ? m[1] : line.slice(11));
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      stats.added++;
      if (MARKER.test(line)) stats.markersAdded++;
    } else if (inHunk && line.startsWith('-')) {
      stats.removed++;
      if (MARKER.test(line)) stats.markersRemoved++;
    }
  }
  return stats;
}

// Map of oid -> stats for the commits the clone has; a commit it lacks is not in the map.
export async function commitStats(git, oids) {
  const have = [...await presentOids(git, oids)];
  const map = new Map();
  for (let i = 0; i < have.length; i += CHUNK) {
    const out = await git(['show', '--no-color', '--unified=0', '--format=%x01%H %P', ...have.slice(i, i + CHUNK)]);
    for (const block of out.split(START).slice(1)) {
      const stats = parseCommit(block);
      map.set(stats.oid, stats);
    }
  }
  return map;
}
