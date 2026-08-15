import { describe, it, expect } from "vitest";
import { buildFixedReturnBytecode, buildFixedTupleReturnBytecode } from "./stateOverride.js";

describe("buildFixedReturnBytecode", () => {
  it("produces the expected 6-opcode bytecode for a simple value", () => {
    // PUSH32 <32-byte value> PUSH1 0x00 MSTORE PUSH1 0x20 PUSH1 0x00 RETURN
    const code = buildFixedReturnBytecode(123n);
    expect(code).toBe(
      "0x7f000000000000000000000000000000000000000000000000000000000000007b60005260206000f3",
    );
  });

  it("rejects values outside uint256 range", () => {
    expect(() => buildFixedReturnBytecode(-1n)).toThrow();
    expect(() => buildFixedReturnBytecode(1n << 256n)).toThrow();
  });

  it("is equivalent to a single-element tuple", () => {
    expect(buildFixedReturnBytecode(42n)).toBe(buildFixedTupleReturnBytecode([42n]));
  });
});

describe("buildFixedTupleReturnBytecode", () => {
  it("produces bytecode that returns the right total byte length for N words", () => {
    // Per word: PUSH32(1) + value(32) + PUSH1(1) + offset(1) + MSTORE(1) = 36 bytes.
    // Trailer: PUSH1(1) + size(1) + PUSH1(1) + 0x00(1) + RETURN(1) = 5 bytes.
    // Real Chainlink case: 5 words (latestRoundData()'s tuple shape).
    const code = buildFixedTupleReturnBytecode([0n, 100n, 0n, 0n, 0n]);
    const bytes = (code.length - 2) / 2; // strip "0x", 2 hex chars per byte
    const expectedBytes = 5 * 36 + 5;
    expect(bytes).toBe(expectedBytes);
  });

  it("places each value's PUSH1 offset correctly for a multi-word tuple", () => {
    const code = buildFixedTupleReturnBytecode([1n, 2n, 3n]);
    expect(code).toContain("6000"); // offset 0
    expect(code).toContain("6020"); // offset 32
    expect(code).toContain("6040"); // offset 64
  });

  it("rejects an empty or too-large tuple", () => {
    expect(() => buildFixedTupleReturnBytecode([])).toThrow();
    expect(() => buildFixedTupleReturnBytecode(new Array(8).fill(0n))).toThrow();
  });

  it("rejects an out-of-range value at any position", () => {
    expect(() => buildFixedTupleReturnBytecode([1n, -1n, 2n])).toThrow();
    expect(() => buildFixedTupleReturnBytecode([1n, 1n << 256n])).toThrow();
  });
});
