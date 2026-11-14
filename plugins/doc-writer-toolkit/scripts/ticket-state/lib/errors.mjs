// Exit codes: 0 ok · 1 a record or a lock refused (nothing written), or a call to the tracker or the forge failed ·
// 2 bad usage or configuration. The tracker's and the forge's own errors keep their codes.
export class CliError extends Error {
  constructor(message, { code = 2, data = {} } = {}) {
    super(message);
    this.exitCode = code;
    this.data = data;
  }
}

// A record the world doesn't support, or a lock someone else holds. Nothing is written. `refused` names the rule.
export class Refused extends CliError {
  constructor(refused, message, data = {}) {
    super(`nothing recorded: ${message}`, { code: 1, data: { refused, ...data } });
    this.refused = refused;
  }
}
