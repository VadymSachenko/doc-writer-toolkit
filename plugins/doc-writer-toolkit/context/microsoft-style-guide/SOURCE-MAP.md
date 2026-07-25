# Source map

The complete machine-readable map is [`source-map.json`](source-map.json). It records:

- every inventoried English source page and its local consolidated rule file;
- the live-only URI entry added after the archived discovery baseline;
- source URLs and baseline hashes;
- the official Ukrainian guide edition, hash, page count, and local corpus root.

Human-readable coverage totals are in [`COVERAGE.md`](COVERAGE.md). Source and
edition decisions are in [`maintenance/source-inventory.md`](maintenance/source-inventory.md).

`active` means the source is represented by a local rule. `pending` would mean that a
source was discovered but not assigned; a validated release must have zero pending
records.
