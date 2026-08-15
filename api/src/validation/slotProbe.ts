import type { Address, PublicClient } from "viem";
import { encodeAbiParameters, keccak256, numberToHex, parseAbi } from "viem";

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const ERC20_ALLOWANCE_ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

// ERC20 storage layout isn't standardized - which slot holds `balanceOf`/`allowance` varies
// per token implementation. Generous enough to cover common patterns (OpenZeppelin-style,
// most proxy implementations) without an unbounded search; a token whose real slot falls
// outside this range surfaces as an explicit "unable to validate", not a silent wrong
// answer - see aaveValidator.ts.
const MAX_SLOT_INDEX = 20;

const TEST_VALUE = (1n << 200n) + 12345n; // large, distinctive - won't collide with a real balance

/** Solidity's mapping(address => uint256) slot derivation: keccak256(abi.encode(key, slot)). */
function balanceSlotFor(account: Address, slotIndex: number): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, BigInt(slotIndex)]));
}

/** Nested mapping(address => mapping(address => uint256)) slot derivation:
 *  keccak256(abi.encode(spender, keccak256(abi.encode(owner, slot)))). */
function allowanceSlotFor(owner: Address, spender: Address, slotIndex: number): `0x${string}` {
  const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(slotIndex)]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, ownerSlot]));
}

export interface TokenSlots {
  balanceSlotIndex: number;
  allowanceSlotIndex: number;
}

// Per-token, not per-call - storage layout is a property of the token contract, permanent
// for as long as that contract's code doesn't change (see docs/decisions.md's #30 entry).
const slotCache = new Map<string, TokenSlots | null>();

/**
 * Finds which storage slot index holds `balanceOf`/`allowance` for a given ERC20, by
 * overriding each candidate slot with a distinctive test value and checking via a real
 * eth_call whether the token's own balanceOf()/allowance() reflects it. Returns null (not a
 * throw) if no candidate slot in range works - an explicit "could not determine" signal the
 * caller must handle, not a guess.
 */
export async function probeTokenSlots(
  client: PublicClient,
  token: Address,
  testAccount: Address,
  testSpender: Address,
): Promise<TokenSlots | null> {
  const cacheKey = token.toLowerCase();
  if (slotCache.has(cacheKey)) return slotCache.get(cacheKey)!;

  const balanceSlotIndex = await probeBalanceSlot(client, token, testAccount);
  const allowanceSlotIndex =
    balanceSlotIndex === null ? null : await probeAllowanceSlot(client, token, testAccount, testSpender);

  const result: TokenSlots | null =
    balanceSlotIndex !== null && allowanceSlotIndex !== null ? { balanceSlotIndex, allowanceSlotIndex } : null;

  slotCache.set(cacheKey, result);
  return result;
}

async function probeBalanceSlot(client: PublicClient, token: Address, account: Address): Promise<number | null> {
  for (let slotIndex = 0; slotIndex < MAX_SLOT_INDEX; slotIndex++) {
    const slot = balanceSlotFor(account, slotIndex);
    try {
      const result = await client.readContract({
        address: token,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [account],
        stateOverride: [{ address: token, stateDiff: [{ slot, value: numberToHex(TEST_VALUE, { size: 32 }) }] }],
      });
      if (result === TEST_VALUE) return slotIndex;
    } catch {
      // A candidate slot that happens to corrupt something else the token reads during
      // balanceOf (rare, but possible for non-trivial implementations) reverts instead of
      // returning a wrong number - treated the same as "not this slot", keep probing.
      continue;
    }
  }
  return null;
}

async function probeAllowanceSlot(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<number | null> {
  for (let slotIndex = 0; slotIndex < MAX_SLOT_INDEX; slotIndex++) {
    const slot = allowanceSlotFor(owner, spender, slotIndex);
    try {
      const result = await client.readContract({
        address: token,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [owner, spender],
        stateOverride: [{ address: token, stateDiff: [{ slot, value: numberToHex(TEST_VALUE, { size: 32 }) }] }],
      });
      if (result === TEST_VALUE) return slotIndex;
    } catch {
      continue;
    }
  }
  return null;
}
