const namespaceOf = (key) => key.slice(0, Math.max(key.lastIndexOf('.'), 0));

function valuesOf(labels, locales, key) {
  const out = {};
  for (const l of locales) if (labels[l]?.[key] !== undefined) out[l] = labels[l][key];
  return out;
}

// Compares two snapshots ({ locale: { key: string } }). A key is "present" when any locale has it.
export function diffSnapshots(oldLabels, newLabels) {
  const locales = [...new Set([...Object.keys(oldLabels), ...Object.keys(newLabels)])];
  const keysOf = (labels) => new Set(Object.values(labels).flatMap((m) => Object.keys(m)));
  const oldKeys = keysOf(oldLabels);
  const newKeys = keysOf(newLabels);

  let added = [...newKeys].filter((k) => !oldKeys.has(k)).sort();
  let removed = [...oldKeys].filter((k) => !newKeys.has(k)).sort();

  const changed = [];
  for (const key of [...newKeys].filter((k) => oldKeys.has(k)).sort()) {
    const perLocale = {};
    for (const l of locales) {
      const before = oldLabels[l]?.[key] ?? null;
      const after = newLabels[l]?.[key] ?? null;
      if (before !== after) perLocale[l] = { old: before, new: after };
    }
    if (Object.keys(perLocale).length) changed.push({ key, locales: perLocale });
  }

  // rekeyed: one removed + one added key with the identical UA string in the same namespace (1:1 only).
  const bucket = (keys, labels) => {
    const map = new Map();
    for (const key of keys) {
      const uk = labels.uk?.[key];
      if (uk === undefined) continue;
      const id = `${namespaceOf(key)}\0${uk}`;
      map.set(id, [...(map.get(id) ?? []), key]);
    }
    return map;
  };
  const removedBy = bucket(removed, oldLabels);
  const addedBy = bucket(added, newLabels);
  const rekeyed = [];
  for (const [id, from] of removedBy) {
    const to = addedBy.get(id);
    if (from.length !== 1 || !to || to.length !== 1) continue;
    const perLocale = {};
    for (const l of locales) {
      const before = oldLabels[l]?.[from[0]] ?? null;
      const after = newLabels[l]?.[to[0]] ?? null;
      if (before !== after) perLocale[l] = { old: before, new: after };
    }
    rekeyed.push({ from: from[0], to: to[0], locales: perLocale });
  }
  const moved = new Set(rekeyed.flatMap((r) => [r.from, r.to]));
  added = added.filter((k) => !moved.has(k));
  removed = removed.filter((k) => !moved.has(k));

  return {
    added: added.map((key) => ({ key, values: valuesOf(newLabels, locales, key) })),
    removed: removed.map((key) => ({ key, values: valuesOf(oldLabels, locales, key) })),
    changed,
    rekeyed: rekeyed.sort((a, b) => (a.from < b.from ? -1 : 1)),
  };
}

export const diffIsEmpty = (d) => !d.added.length && !d.removed.length && !d.changed.length && !d.rekeyed.length;

export function diffSummary(d) {
  return { added: d.added.length, removed: d.removed.length, changed: d.changed.length, rekeyed: d.rekeyed.length };
}
