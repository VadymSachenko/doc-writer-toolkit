import { CliError } from '../../ui-labels/lib/util.mjs';

export { CliError };

// A call the module refuses to make, on a rule. `refused` names the rule: notAllowed (a repo or login the settings
// don't name), notNamed (a label the settings don't name, or one the module never removes), empty, unknown,
// outsideDiff, stale, ambiguous. Exit code 2, like any input the caller must fix.
export class Refusal extends CliError {
  constructor(refused, message, data = {}) {
    super(message, { code: 2, data: { refused, ...data } });
    this.refused = refused;
  }
}

// A call to the forge that failed (gh did not run, a network error, an HTTP status the adapter doesn't handle).
// Exit code 1.
export class ForgeError extends CliError {
  constructor(message, data = {}) {
    super(message, { code: 1, data });
  }
}
