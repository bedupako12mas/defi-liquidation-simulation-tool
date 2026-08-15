/**
 * Redaction safety net for secret-bearing env vars (RPC URLs, DB connection strings) that
 * can end up embedded verbatim inside third-party error objects. viem in particular puts
 * the full request URL - API key and all - into a thrown error's `.message`, `.details`,
 * `.shortMessage`, and `.metaMessages`; pg's connection errors can do the same with
 * `DATABASE_URL`. This has already leaked a live key twice this session via ad-hoc
 * scripts whose errors reached console.error unsanitized.
 *
 * Deliberately general-purpose: it reads whatever secret-shaped env vars are currently
 * loaded from `process.env` at call time, rather than special-casing one script or one
 * error shape, so every current and future logging call that might surface a caught
 * error - present or not-yet-written - is covered without anyone needing to remember to
 * sanitize by hand each time.
 */

// Every env var this project treats as secret-shaped (its value embeds a credential).
// Keep this in sync with api/.env.example - anything added there that carries a
// credential (a token, password, or key baked into a URL) belongs here too.
const SECRET_ENV_VAR_NAMES = ["RPC_URL_MAINNET", "DATABASE_URL"] as const;

const REDACTED = "[REDACTED]";

function currentSecretValues(): string[] {
  const values: string[] = [];
  for (const name of SECRET_ENV_VAR_NAMES) {
    const value = process.env[name];
    // Skip unset/empty rather than throwing - sanitizing must never itself become the
    // reason a diagnostic script crashes before it can report the *original* error.
    if (typeof value === "string" && value.length > 0) {
      values.push(value);
    }
  }
  // Longest first so a secret value that happens to be a prefix of another currently-set
  // secret doesn't leave a partial (still-sensitive) remainder behind.
  return values.sort((a, b) => b.length - a.length);
}

/**
 * Strips every currently-loaded secret env var value out of `input`, replacing each
 * occurrence with `[REDACTED]`. Secret values are read fresh from `process.env` on every
 * call (never cached, never hardcoded), so it automatically tracks whatever is actually
 * loaded in the current process.
 */
export function redactSecrets(input: string): string {
  let result = input;
  for (const secret of currentSecretValues()) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

/** The subset of viem's BaseError shape (and a plain Error's) worth pulling apart
 *  individually - each field can independently carry a leaked URL, so each is redacted
 *  and included rather than relying on a single top-level `.message`. */
interface MaybeRichError {
  name?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  metaMessages?: unknown;
  stack?: unknown;
  cause?: unknown;
}

function isErrorLike(value: unknown): value is MaybeRichError {
  return typeof value === "object" && value !== null && ("message" in value || value instanceof Error);
}

/**
 * Safely stringifies an arbitrary caught value - a plain Error, a viem `BaseError`
 * (HttpRequestError, RpcRequestError, etc.), a pg error, or anything else - into one
 * redacted string safe to hand to console.error/log.error. Unlike `String(err)` or a bare
 * `.message` read, this also walks `.details`/`.shortMessage`/`.metaMessages` (viem's
 * BaseError fields) and a `.cause` chain, since the URL can show up in any of them
 * independently of `.message`.
 */
export function redactError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  function visit(value: unknown, depth: number): void {
    if (value === null || value === undefined) return;
    if (depth > 10) return; // guards against a pathological/circular `.cause` chain

    if (typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
    }

    if (isErrorLike(value)) {
      const e = value;
      if (typeof e.name === "string") parts.push(`name: ${e.name}`);
      if (typeof e.message === "string") parts.push(`message: ${e.message}`);
      if (typeof e.shortMessage === "string") parts.push(`shortMessage: ${e.shortMessage}`);
      if (typeof e.details === "string") parts.push(`details: ${e.details}`);
      if (Array.isArray(e.metaMessages)) parts.push(`metaMessages: ${e.metaMessages.join(" ")}`);
      if (typeof e.stack === "string") parts.push(`stack: ${e.stack}`);
      if (e.cause !== undefined) visit(e.cause, depth + 1);
      return;
    }

    if (typeof value === "string") {
      parts.push(value);
      return;
    }

    try {
      parts.push(JSON.stringify(value));
    } catch {
      parts.push(String(value));
    }
  }

  visit(err, 0);
  const combined = parts.length > 0 ? parts.join("\n") : String(err);
  return redactSecrets(combined);
}
