import { createTrelloClient } from './trello/client.mjs';
import { createTrelloAdapter } from './trello/index.mjs';
import { CliError } from '../lib/errors.mjs';

// One entry per tracker kind: how to build the client from credentials and the adapter on top of it.
// Adding Jira is one entry here and a folder next to `trello/`; no caller changes.
const ADAPTERS = {
  trello: {
    client: (opts) => createTrelloClient(opts),
    adapter: (client) => createTrelloAdapter(client),
  },
};

export const kinds = () => Object.keys(ADAPTERS);

export function createAdapter(kind, clientOptions) {
  const entry = ADAPTERS[kind];
  if (!entry) throw new CliError(`no adapter for tracker kind '${kind}'. Available: ${kinds().join(', ')}.`, { code: 2 });
  const client = entry.client(clientOptions);
  return { client, adapter: entry.adapter(client) };
}
