import { CliError } from '../../ui-labels/lib/util.mjs';

export { CliError };

// A call the module refuses to make, on a rule. `refused` names the rule: neverRead, transition, intake, empty,
// outsideFlow, archived, notAllowed, ambiguous, unknown. Exit code 2, like any input the caller must fix.
export class Refusal extends CliError {
  constructor(refused, message, data = {}) {
    super(message, { code: 2, data: { refused, ...data } });
    this.refused = refused;
  }
}

// A call to the tracker that failed (a network error, an HTTP status the adapter doesn't handle). Exit code 1.
export class TrackerError extends CliError {
  constructor(message, data = {}) {
    super(message, { code: 1, data });
  }
}
