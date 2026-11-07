import { createGh } from './github/gh.mjs';
import { createGithubAdapter } from './github/index.mjs';
import { CliError } from '../lib/errors.mjs';

// One entry per forge kind: how to build the process client and the adapter on top of it.
// Adding GitLab is one entry here and a folder next to `github/`; no caller changes.
const ADAPTERS = {
  github: {
    client: (opts) => createGh(opts),
    adapter: (client, forge) => createGithubAdapter(client, { owner: forge.owner }),
  },
};

export const kinds = () => Object.keys(ADAPTERS);

export function createAdapter(forge, clientOptions) {
  const entry = ADAPTERS[forge.kind];
  if (!entry) throw new CliError(`no adapter for forge kind '${forge.kind}'. Available: ${kinds().join(', ')}.`, { code: 2 });
  const client = entry.client(clientOptions);
  return { client, adapter: entry.adapter(client, forge) };
}
