import { Refusal } from '../lib/errors.mjs';

// An adapter that keeps its cards in memory and knows nothing of Trello. It stands for "a Jira adapter": the same
// module, settings and callers run on it unchanged, which is what the interface is for.

export function memoryAdapter() {
  const places = [{ id: 'p1', name: 'Inbox' }, { id: 'p2', name: 'Drafts' }, { id: 'p3', name: 'Ready' }, { id: 'p4', name: 'Doing' }];
  const cards = [
    { id: 'PROJ-1', shortLink: 'PROJ-1', url: 'tracker://PROJ-1', name: '#10 - First', number: 10, numbers: [10], desc: 'one', labels: [], placeId: 'p1', boardId: 'main', lastActivity: '2026-11-01T00:00:00.000Z', closed: false },
    { id: 'PROJ-2', shortLink: 'PROJ-2', url: 'tracker://PROJ-2', name: 'Secret', numbers: [], number: null, desc: 'draft text', labels: [], placeId: 'p2', boardId: 'main', lastActivity: '2026-11-01T00:00:00.000Z', closed: false },
  ];
  const log = [];
  const get = (ref) => {
    const c = cards.find((x) => x.id === ref);
    if (!c) throw new Refusal('unknown', `no card ${ref}`);
    return c;
  };
  return {
    kind: 'memory',
    log,
    cardRef: (input) => String(input),
    places: async () => places,
    cardsIn: async (placeId) => cards.filter((c) => c.placeId === placeId && !c.closed),
    card: async (ref) => ({ ...get(ref) }),
    allCards: async () => cards.map(({ desc, ...c }) => c),
    cardDetail: async (ref) => ({ card: { ...get(ref) }, comments: [], attachments: [], checklists: [], moves: [], links: [] }),
    comments: async () => [],
    attachments: async () => [],
    labels: async () => [{ id: 'l1', name: 'urgent', color: null }],
    members: async () => [{ id: 'u1', username: 'someone', name: null }],
    actions: async () => [],
    download: async () => ({ bytes: 0 }),
    comment: async (ref, text) => (log.push(['comment', ref, text]), { id: 'c1', time: '2026-11-04T00:00:00.000Z' }),
    moveCard: async (ref, placeId) => (log.push(['move', ref, placeId]), (get(ref).placeId = placeId)),
    addLabel: async (ref, id) => log.push(['addLabel', ref, id]),
    removeLabel: async (ref, id) => log.push(['removeLabel', ref, id]),
    addMember: async (ref, id) => (log.push(['addMember', ref, id]), (get(ref).memberIds = [...(get(ref).memberIds ?? []), id])),
    setDescription: async (ref, text) => (log.push(['setDescription', ref, text]), (get(ref).desc = text)),
    createCard: async ({ placeId, name }) => (log.push(['createCard', placeId, name]), { id: 'PROJ-3', shortLink: 'PROJ-3', url: 'tracker://PROJ-3' }),
  };
}
