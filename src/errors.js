/**
 * Every failure mode that should stop a run gets its own class, so index.js can
 * report "session expired" differently from "Amazon added a column" without
 * string-matching on messages.
 */

export class BotError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Redirected to /ap/signin — cookies are dead, a human must run `npm run login`. */
export class SessionExpiredError extends BotError {
  constructor(region) {
    super(`${region} session has expired (redirected to /ap/signin). `
      + `Run: npm run login -- ${region}`);
    this.region = region;
  }
}

/** The downloaded file belongs to a different marketplace than the one requested. */
export class MarketplaceMismatchError extends BotError {
  constructor(requested, evidence) {
    super(`Marketplace contamination: asked for ${requested}, got a file that looks like `
      + `${evidence.looksLike}. ${evidence.detail}`);
    this.requested = requested;
    this.evidence = evidence;
  }
}

/** The header row does not match the stored baseline. Carries the full diff. */
export class SchemaChangedError extends BotError {
  constructor(label, diff) {
    super(`Schema changed for ${label}:\n${diff.report}`);
    this.label = label;
    this.diff = diff;
  }
}

/** Selectors for a click path were never recorded. */
export class NotRecordedError extends BotError {
  constructor(what, how) {
    super(`${what} has not been recorded yet.\n${how}`);
  }
}
