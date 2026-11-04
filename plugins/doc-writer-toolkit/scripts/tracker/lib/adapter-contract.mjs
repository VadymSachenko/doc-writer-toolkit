// What the module asks of a tracker adapter. The module (`lib/tracker.mjs`) speaks in statuses and transitions and
// owns every decision: which status maps to which places, the transitions guard, the `neverRead` refusal, the
// intake-only creation, the empty-text refusals, the idempotency checks. An adapter only turns these calls into its
// tracker's API and the answers into the shapes below. A new tracker (Jira) is a new folder under `adapters/` with
// these methods, one line in `adapters/index.mjs`, and a client that sends every change through one function.
//
// A *place* is where the tracker keeps a card: a Trello list, a Jira workflow status. `{ id, name }`.
//
// Shapes
//   Card     { id, shortLink, url, name, number, numbers, desc?, labels: [{ id, name, color }], placeId, boardId,
//              lastActivity (ISO), closed }
//   Comment  { id, author: { id, username } | null, time, text, edited }
//   Action   { id, type, time, card: { id, shortLink, name } | null, by, text, placeId, placeBefore, placeAfter,
//              changed: [field names], closed? }
//   Attachment { id, name, url, mimeType, bytes, isUpload, date }
//
// Reads (nothing here changes the tracker)
//   cardRef(input)               -> the reference the other calls take; throws a Refusal('unknown') for a bad input
//   places(board)                -> [Place], the open ones, in board order
//   cardsIn(placeId)             -> [Card], the open cards of a place, with descriptions
//   card(ref)                    -> Card, with its description
//   allCards(board)              -> [Card], archived too, without descriptions, paged
//   cardDetail(ref)              -> { card, comments, attachments, checklists, moves, links }
//   comments(ref)                -> [Comment]
//   attachments(ref)             -> [Attachment]
//   labels(board)                -> [{ id, name, color }]
//   actions(board, { since, types? }) -> [Action], oldest first, paged
//   download(url, dest)          -> { bytes }; sends credentials only to the tracker's own hosts
// Writes (each goes through the client's one `write`, which `--dry-run` stops)
//   comment(ref, text)           -> { id, time }
//   moveCard(ref, placeId)
//   addLabel(ref, labelId), removeLabel(ref, labelId)
//   setDescription(ref, text)
//   createCard({ placeId, name, desc, labelIds }) -> { id, shortLink, url }
//
// An adapter has no operation that archives, deletes or renames a card, and none that a caller could add: that is
// the rule "never archive, delete, rename" held by what the interface does not contain.

export const READS = ['cardRef', 'places', 'cardsIn', 'card', 'allCards', 'cardDetail', 'comments', 'attachments', 'labels', 'actions', 'download'];
export const WRITES = ['comment', 'moveCard', 'addLabel', 'removeLabel', 'setDescription', 'createCard'];

export function assertAdapter(adapter) {
  const missing = [...READS, ...WRITES].filter((m) => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`the ${adapter?.kind ?? 'tracker'} adapter lacks: ${missing.join(', ')}`);
  return adapter;
}
