# API seeding notes — project-specific

Time-sensitive and ordering caveats for seeding test-environment state via the API test collection. `app-explorer` reads this file so its generic "seed immediately before capture" rule can be applied against the concrete timing quirks of this project's test environment. Add a new bullet here whenever a scenario turns out to expire, mutate, or reorder itself between seeding and capture.

## Timing caveats

- **Queued payouts auto-expire after ~2 minutes** in this test environment. Seed payout scenarios immediately before capturing their UI state — do not seed them all upfront and capture later. This also constrains parallel seeding: a batch of payouts seeded together will start expiring before the later screens are captured.

## Ordering caveats

- Seed each time-sensitive scenario as late as possible in the run, directly before the screen that shows it. Stable, non-expiring state (balances, closed availability, static records) can be seeded upfront.

<!-- Add further time-sensitive or ordering seeding caveats above as they are discovered. -->
