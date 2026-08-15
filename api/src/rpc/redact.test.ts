import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { redactSecrets, redactError } from "./redact.js";

const FAKE_RPC_URL = "https://eth-mainnet.g.alchemy.com/v2/totally-fake-api-key-12345";
const FAKE_DB_URL = "postgres://user:totally-fake-db-password@db.example.com:5432/liquidation_sim";

describe("redactSecrets / redactError", () => {
  const originalRpcUrl = process.env.RPC_URL_MAINNET;
  const originalDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.RPC_URL_MAINNET = FAKE_RPC_URL;
    process.env.DATABASE_URL = FAKE_DB_URL;
  });

  afterEach(() => {
    if (originalRpcUrl === undefined) delete process.env.RPC_URL_MAINNET;
    else process.env.RPC_URL_MAINNET = originalRpcUrl;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  it("strips a secret env var value out of a plain string", () => {
    const input = `HttpRequestError: fetch failed at ${FAKE_RPC_URL}`;
    const result = redactSecrets(input);
    expect(result).not.toContain(FAKE_RPC_URL);
    expect(result).not.toContain("totally-fake-api-key-12345");
    expect(result).toContain("[REDACTED]");
  });

  it("strips multiple distinct secrets in the same string", () => {
    const input = `rpc=${FAKE_RPC_URL} db=${FAKE_DB_URL}`;
    const result = redactSecrets(input);
    expect(result).not.toContain(FAKE_RPC_URL);
    expect(result).not.toContain(FAKE_DB_URL);
  });

  it("skips unset secret env vars without throwing", () => {
    delete process.env.RPC_URL_MAINNET;
    delete process.env.DATABASE_URL;
    expect(() => redactSecrets("no secrets here")).not.toThrow();
    expect(redactSecrets("no secrets here")).toBe("no secrets here");
  });

  it("leaves non-secret text untouched", () => {
    expect(redactSecrets("chainId=1 is not allowed")).toBe("chainId=1 is not allowed");
  });

  it("redacts a leaked URL from a plain Error's message and stack", () => {
    const err = new Error(`request to ${FAKE_RPC_URL} failed, reason: ECONNRESET`);
    const result = redactError(err);
    expect(result).not.toContain("totally-fake-api-key-12345");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a viem BaseError-shaped object across message/details/shortMessage/metaMessages", () => {
    // Mimics the shape of viem's HttpRequestError without importing viem, since the leak
    // is about the *shape* (several independent string fields), not the specific class.
    class FakeViemError extends Error {
      shortMessage = `HTTP request failed.\n\nURL: ${FAKE_RPC_URL}`;
      details = `fetch failed for ${FAKE_RPC_URL}`;
      metaMessages = [`Request body: {"method":"eth_chainId"}`, `URL: ${FAKE_RPC_URL}`];
      name = "HttpRequestError";
    }
    const err = new FakeViemError(`HTTP request failed for ${FAKE_RPC_URL}`);

    const result = redactError(err);
    expect(result).not.toContain("totally-fake-api-key-12345");
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("walks a .cause chain and redacts secrets found there too", () => {
    const inner = new Error(`connection string ${FAKE_DB_URL} refused`);
    const outer = new Error("query failed", { cause: inner });
    const result = redactError(outer);
    expect(result).not.toContain("totally-fake-db-password");
    expect(result).toContain("[REDACTED]");
  });

  it("handles non-Error values without throwing", () => {
    expect(() => redactError(`plain string with ${FAKE_RPC_URL}`)).not.toThrow();
    expect(redactError(`plain string with ${FAKE_RPC_URL}`)).not.toContain("totally-fake-api-key-12345");
    expect(() => redactError({ some: "object" })).not.toThrow();
    expect(() => redactError(null)).not.toThrow();
    expect(() => redactError(undefined)).not.toThrow();
  });
});
