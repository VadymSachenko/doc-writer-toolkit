import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists, readJson, sha256 } from './util.mjs';
import { latestCommit, listBranches } from './gh.mjs';
import { matchesTicket, requireSource } from './config.mjs';
import { PENDING_DIFF } from './store.mjs';

const run = promisify(execFile);

// Did the app's locale files change since the last import? Scripts only, no AI. Needs `gh` for the github adapter.
export async function runCheck(settings) {
  const src = requireSource(settings);
  const meta = await readJson(path.join(settings.labelsDir, 'meta.json'));
  const pendingSync = await exists(path.join(settings.labelsDir, PENDING_DIFF));
  const reasons = [];
  const result = { changed: false, pendingSync, reasons, recorded: null, latest: null, tickets: settings.tickets };

  if (!meta) {
    reasons.push('no snapshot yet: run import');
    result.changed = true;
    return result;
  }
  result.recorded = { commit: meta.commit, overlay: meta.overlay?.branches ?? {} };

  if (src.type === 'github-json') {
    const latest = { commit: await latestCommit(src.repo, src.branch, src.dir), overlay: {} };
    if (latest.commit !== meta.commit) reasons.push(`${src.repo}@${src.branch}: locale files changed (${meta.commit.slice(0, 7)} -> ${latest.commit?.slice(0, 7)})`);

    if (settings.tickets.length) {
      const branches = (await listBranches(src.repo)).filter((b) => b !== src.branch && matchesTicket(b, settings.tickets));
      const shas = await Promise.all(branches.map((b) => latestCommit(src.repo, b, src.dir)));
      branches.forEach((b, i) => (latest.overlay[b] = shas[i]));
    }
    const recorded = meta.overlay?.branches ?? {};
    for (const [branch, sha] of Object.entries(latest.overlay)) {
      if (!(branch in recorded)) reasons.push(`ticket branch ${branch}: new, not imported yet`);
      else if (recorded[branch] !== sha) reasons.push(`ticket branch ${branch}: locale files changed`);
    }
    for (const branch of Object.keys(recorded)) {
      if (!(branch in latest.overlay)) reasons.push(`ticket branch ${branch}: no longer matches (merged, deleted or another ticket)`);
    }
    result.latest = latest;
  } else {
    const texts = [];
    for (const locale of meta.locales) {
      const { stdout } = await run('sh', ['-c', src.command.replaceAll('{locale}', locale)], { cwd: settings.root, maxBuffer: 64 * 1024 * 1024 });
      texts.push(`${locale}\0${stdout}`);
    }
    const commit = `content:${sha256(texts.join('\0'))}`;
    if (commit !== meta.commit) reasons.push('command output changed');
    result.latest = { commit };
  }

  if (pendingSync) reasons.push('the last import has a label diff that was not synced: run sync');
  result.changed = reasons.length > 0;
  return result;
}
