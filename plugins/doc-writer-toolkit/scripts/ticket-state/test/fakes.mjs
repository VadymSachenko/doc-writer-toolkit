import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateSettings } from '../lib/settings.mjs';

// Offline stand-ins: an in-memory tracker adapter and an in-memory forge adapter, under the real tracker and forge
// modules (the ticket flow composes no request itself, so the modules' rules run as they do for real). The data is
// invented: board, lists, labels, people and repos have generic names, and every id starts 5f00000000.

export const BOARD = '5f00000000000000000d0001';
export const WATCH = '5f00000000000000000d0002';
export const LISTS = {
  intake: { id: '5f00000000000000000a0001', name: 'Incoming' },
  drafts: { id: '5f00000000000000000a0002', name: 'Parked' },
  ready: { id: '5f00000000000000000a0003', name: 'To do' },
  inProgress: { id: '5f00000000000000000a0004', name: 'Doing' },
  blocked: { id: '5f00000000000000000a0005', name: 'Blocked' },
  smeReview: { id: '5f00000000000000000a0006', name: 'Expert check' },
  finalReview: { id: '5f00000000000000000a0007', name: 'Final check' },
  translation: { id: '5f00000000000000000a000c', name: 'Translating' },
  done: { id: '5f00000000000000000a0008', name: 'Finished' },
  oldDone: { id: '5f00000000000000000a0009', name: 'Closed, Oct 2026' },
  outOfScope: { id: '5f00000000000000000a000a', name: 'Not needed' },
  side: { id: '5f00000000000000000a000b', name: 'Side lane' },
};
export const RELEASE = { id: '5f00000000000000000a0101', name: 'Shipping' };
export const NOW = Date.parse('2026-11-10T09:00:00Z');
export const ago = (h) => new Date(NOW - h * 3600000).toISOString();

let ids = 0;
const hex = (n) => n.toString(16).padStart(6, '0');
export const id24 = (kind = 'c') => `5f00000000000000${kind}${hex(++ids).padStart(7, '0')}`.slice(0, 24);

// A card in the module's adapter shape.
export function card({ number = null, name, status = 'ready', list, labels = [], desc = '', lastActivity = ago(48), createdAt = ago(72), closed = false, shortLink, board = BOARD }) {
  const id = id24('c');
  const sl = shortLink ?? `Card${String(ids).padStart(4, '0')}`;
  return {
    id,
    shortLink: sl,
    url: `https://tracker.example/c/${sl}`,
    name: name ?? (number ? `#${number} - Change ${number}` : `A card ${ids}`),
    number,
    numbers: number ? [number] : [],
    desc,
    labels: labels.map((n) => ({ id: `label-${n}`, name: n, color: null })),
    placeId: (list ?? LISTS[status]).id,
    boardId: board,
    lastActivity,
    createdAt,
    closed,
  };
}

// `actions`: { <board id>: [actions in the adapter's shape] }, given back from `since` on, as the real board does.
export function trackerAdapter({ cards = [], comments = {}, release = [], actions = {} } = {}) {
  const log = [];
  const reads = [];
  const all = () => [...cards, ...release];
  const get = (ref) => {
    const c = all().find((x) => x.id === ref || x.shortLink === ref);
    if (!c) {
      const e = new Error(`no card ${ref}`);
      e.data = { status: 404 };
      throw e;
    }
    return c;
  };
  const labels = [...new Set(cards.flatMap((c) => c.labels.map((l) => l.name)).concat(['high', 'low', 'needs info', 'Guide', 'Api', 'Docs', 'Portal UI', 'Portal API']))].map((n) => ({ id: `label-${n}`, name: n, color: null }));
  return {
    kind: 'memory',
    log,
    reads,
    cards,
    comments,
    cardRef: (input) => String(input).replace(/^https:\/\/tracker\.example\/c\//, ''),
    places: async (board) => (reads.push(['places', board]), board === BOARD ? Object.values(LISTS) : [RELEASE]),
    cardsIn: async (placeId) => {
      reads.push(['cardsIn', placeId]);
      if (placeId === LISTS.drafts.id) throw new Error('the drafts list was read');
      return all().filter((c) => c.placeId === placeId && !c.closed).map((c) => ({ ...c }));
    },
    card: async (ref) => ({ ...get(ref) }),
    allCards: async (board) => all().filter((c) => c.boardId === board).map(({ desc, ...c }) => c),
    cardDetail: async (ref) => {
      const c = get(ref);
      reads.push(['cardDetail', c.id]);
      return { card: { ...c }, comments: comments[c.id] ?? [], attachments: [], checklists: [], moves: c.moves ?? [], links: [] };
    },
    comments: async (ref) => comments[get(ref).id] ?? [],
    attachments: async () => [],
    labels: async () => labels,
    actions: async (board, { since } = {}) => {
      reads.push(['actions', board, since]);
      if (actions.fail?.[board]) throw new Error(actions.fail[board]);
      return (actions[board] ?? []).filter((a) => !since || a.time >= since).map((a) => ({ ...a }));
    },
    download: async () => ({ bytes: 0 }),
    comment: async (ref, text) => {
      log.push(['comment', ref, text]);
      const c = get(ref);
      (comments[c.id] ??= []).push({ id: `cm-${log.length}`, author: null, time: new Date(NOW).toISOString(), text, edited: null });
      return { id: `cm-${log.length}`, time: new Date(NOW).toISOString() };
    },
    moveCard: async (ref, placeId) => {
      log.push(['move', ref, placeId]);
      get(ref).placeId = placeId;
    },
    addLabel: async (ref, labelId) => log.push(['addLabel', ref, labelId]),
    removeLabel: async (ref, labelId) => log.push(['removeLabel', ref, labelId]),
    setDescription: async (ref, text) => log.push(['setDescription', ref, text]),
    createCard: async () => {
      throw new Error('not in these tests');
    },
  };
}

// A PR in the forge adapter's shape.
export function pr({ repo = 'guide-docs', number, head, base = 'main', state = 'open', headCommit = 'a'.repeat(40), labels = [], reviewRequests = [], reviewDecision = null }) {
  return {
    repo,
    number,
    nodeId: `PR_${number}`,
    url: `https://forge.example/acme/${repo}/pull/${number}`,
    title: `Change ${number}`,
    body: '',
    state,
    draft: false,
    head: head ?? `ticket-${number}`,
    base,
    headCommit,
    mergeCommit: state === 'merged' ? 'f'.repeat(40) : null,
    mergedAt: state === 'merged' ? ago(1) : null,
    closedAt: null,
    createdAt: ago(30),
    updatedAt: ago(2),
    author: 'writer-bot',
    reviewDecision,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    reviewRequests: reviewRequests.map((login) => ({ login })),
    labels,
    assignees: [],
  };
}

// `changed`: { <repo>: [PRs] } and `events`: { <repo>: [events] }, given back from `since` on. `fail`: { <repo>: message }.
export function forgeAdapter({ prs = [], activity = {}, changed = {}, events = {}, fail = {} } = {}) {
  const log = [];
  const reads = [];
  const get = ({ repo, number }) => {
    const p = prs.find((x) => x.repo === repo && x.number === Number(number));
    if (!p) {
      const e = new Error(`no PR ${repo}#${number}`);
      e.data = { status: 404 };
      throw e;
    }
    return p;
  };
  const act = (a) => activity[`${a.repo}#${a.number}`] ?? {};
  return {
    kind: 'memory',
    log,
    reads,
    prs,
    activity,
    pr: async (a) => ({ ...get(a) }),
    prByHead: async ({ repo, head }) => prs.find((p) => p.repo === repo && p.head === head) ?? null,
    openPrByHead: async ({ repo, head }) => prs.find((p) => p.repo === repo && p.head === head && p.state === 'open') ?? null,
    changedPrs: async ({ repo, since }) => {
      reads.push(['changedPrs', repo, since]);
      if (fail[repo]) throw new Error(fail[repo]);
      return (changed[repo] ?? []).filter((p) => p.updatedAt >= since).map((p) => ({ ...p }));
    },
    reviews: async (a) => act(a).reviews ?? [],
    threads: async (a) => act(a).threads ?? [],
    issueComments: async (a) => act(a).comments ?? [],
    reviewComments: async () => [],
    reviewComment: async () => {
      throw new Error('not in these tests');
    },
    events: async ({ repo, since }) => {
      reads.push(['events', repo, since]);
      if (fail[repo]) throw new Error(fail[repo]);
      return { events: (events[repo] ?? []).filter((e) => e.createdAt >= since), truncated: false };
    },
    diffLines: async () => [],
    createPr: async () => {
      throw new Error('not in these tests');
    },
    updatePr: async (a) => void log.push(['updatePr', a]),
    addAssignees: async (a) => void log.push(['addAssignees', a]),
    requestReviewers: async (a) => void log.push(['requestReviewers', a]),
    createReview: async () => {
      throw new Error('not in these tests');
    },
    reply: async () => {
      throw new Error('not in these tests');
    },
    comment: async (a) => (log.push(['comment', a]), { id: 900 + log.length }),
    changeLabels: async (a) => {
      log.push(['changeLabels', a.repo, a.number, a.add, a.remove]);
      const p = get(a);
      p.labels = [...p.labels.filter((l) => !a.remove.includes(l)), ...a.add];
    },
  };
}

// The shared settings of an invented host, plus the owner's local values.
export function rawSettings(extra = {}) {
  return {
    schemaVersion: 1,
    state: '.flow/',
    tracker: {
      kind: 'trello',
      credentials: { envFile: '.env', key: 'TEST_KEY', token: 'TEST_TOKEN' },
      board: BOARD,
      watchBoards: [WATCH],
      statuses: {
        intake: ['Incoming'], drafts: ['Parked'], ready: ['To do'], inProgress: ['Doing'], blocked: ['Blocked'], smeReview: ['Expert check'],
        finalReview: ['Final check'], translation: ['Translating'], done: ['Finished', 'Closed*'], outOfScope: ['Not needed'],
      },
      neverRead: ['drafts'],
      transitions: [
        ['intake', 'ready'], ['intake', 'outOfScope'], ['intake', 'done'], ['ready', 'inProgress'], ['inProgress', 'blocked'], ['blocked', 'inProgress'],
        ['inProgress', 'smeReview'], ['inProgress', 'finalReview'], ['smeReview', 'blocked'], ['smeReview', 'finalReview'], ['finalReview', 'smeReview'], ['finalReview', 'translation'], ['finalReview', 'done'], ['translation', 'finalReview'], ['translation', 'inProgress'], ['translation', 'smeReview'], ['translation', 'done'], ['translation', 'outOfScope'], ['smeReview', 'translation'], ['inProgress', 'translation'], ['blocked', 'translation'],
      ],
      labels: { needsInfo: 'needs info' },
      docLabels: ['Guide', 'Api', 'Docs', 'Portal UI', 'Portal API'],
      quietHours: 2,
      triageMarker: 'Triage:',
    },
    forge: { kind: 'github', owner: 'acme', self: 'owner-login', assignee: 'owner-login', checkLabel: 'Look at me' },
    targets: [
      { id: 'guide', appLabel: 'Guide', repo: 'guide-docs', path: 'repos/guide-docs', uaRoot: 'docs/', review: 'sme', reviewers: ['expert-one'], labels: { inProgress: 'in progress', review: 'in expert review', finalReview: 'In final review' } },
      { id: 'api', appLabel: 'Api', repo: 'api-docs', path: 'repos/api-docs', uaRoot: 'docs/', review: 'places', reviewers: ['expert-two'], labels: { inProgress: 'In progress', review: 'In tech review', finalReview: 'In final review' } },
      { id: 'portal-ui', appLabel: 'Portal UI', repo: 'portal-docs', path: 'repos/portal-docs', uaRoot: 'portal/', review: 'sme', reviewers: ['expert-one'], labels: { inProgress: 'In progress', review: 'In expert review', finalReview: 'In final review' } },
      { id: 'portal-api', appLabel: 'Portal API', repo: 'portal-docs', path: 'repos/portal-docs', uaRoot: 'docs/', review: 'places', reviewers: ['expert-two'], labels: { inProgress: 'In progress', review: 'In tech review', finalReview: 'In final review' } },
    ],
    hostRules: { triage: '.claude/rules/triage.md', templates: '.claude/rules/templates.md' },
    hostJobs: [{ name: 'notes', watch: { board: WATCH, list: 'Shipping' }, quietHours: 3, run: { skill: 'notes-writer' } }],
    mode: 'on',
    ...extra,
  };
}

export const tmp = (prefix = 'ticket-state-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A host folder with the settings file (and, optionally, the local file), returning loaded settings.
export function host({ shared = {}, local = null } = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'ticket-flow.json'), JSON.stringify(rawSettings(shared)));
  if (local) fs.writeFileSync(path.join(root, '.claude', 'ticket-flow.local.json'), JSON.stringify(local));
  return root;
}

export function settingsFor(root, extra = {}) {
  const raw = rawSettings(extra);
  return { ...validateSettings(raw, { root, stateRootDefault: '.doc-toolkit/ticket-flow/' }), file: path.join(root, '.claude/ticket-flow.json'), localFile: null };
}

// A git stand-in for tests that don't need history: no hand edits, nothing changed, no pages, no image changed.
export const quietGit = { branchCommits: () => [], changedUnder: () => [], pagesOf: () => [], imagesChanged: () => [] };

// A worktree stand-in for a world with no clones on disk (the runner's `io.ensureWorktree`).
export const noTree = (settings, p) => ({ repo: p.repo, branch: p.branch, path: path.join(settings.root, '.worktrees', p.repo, p.branch), push: `git push origin HEAD:refs/heads/${p.branch}`, linked: [], missing: [], notes: [] });

// A throwaway git repository.
export function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  const commit = (files, message = 'change') => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    g('add', '-A');
    g('commit', '-q', '-m', message);
    return g('rev-parse', 'HEAD');
  };
  return { dir, g, commit };
}
