import { numberToHex, type Hex } from "viem";

/**
 * Builds minimal EVM runtime bytecode that ignores whatever it's called with and always
 * returns a single fixed uint256. Used to override a price oracle's (or a yield-bearing
 * wrapper's raw rate source's) deployed code for the duration of one eth_call, so a
 * validator can test "what would this real contract do at this hypothetical price" without
 * needing to know or fake that contract's actual internal storage layout - viem's
 * stateOverride only lets you override balance/nonce/code/storage, not "make this function
 * return X" directly, and code-override is the general-purpose one that works identically
 * for any single-uint256-return view function (getAssetPrice, stEthPerToken,
 * getExchangeRateLiquidate, ...) regardless of what real logic normally computes it.
 *
 * Bytecode, six opcodes:
 *   PUSH32 <value>   0x7f <32 bytes>
 *   PUSH1 0x00       0x60 0x00   (memory offset to write the value at)
 *   MSTORE           0x52
 *   PUSH1 0x20       0x60 0x20   (return size: 32 bytes)
 *   PUSH1 0x00       0x60 0x00   (return offset)
 *   RETURN           0xf3
 */
export function buildFixedReturnBytecode(value: bigint): Hex {
  return buildFixedTupleReturnBytecode([value]);
}

/**
 * Same idea as buildFixedReturnBytecode, generalized to a fixed-size tuple of static
 * values - needed for any real function whose ABI return isn't a single uint256. Real case
 * this covers: Chainlink's latestRoundData() returns (uint80, int256 answer, uint256,
 * uint256, uint80) - a 5-word tuple. Solidity's ABI decoder expects exactly that many
 * words; returning only one would leave the decode short, and since Fluid's own
 * _readChainlinkSource wraps this in a try/catch, an under-sized return silently resolves
 * to a swallowed 0, not a loud failure - worth getting the tuple shape right rather than
 * relying on that catch to mask the bug (verified against the real source before writing
 * this, not assumed). Every slot except the one actually read by the caller can be zero.
 *
 * Bytecode, per word i (0-indexed): PUSH32 <word> PUSH1 <offset=32*i> MSTORE. Once for
 * every word, then PUSH1 <size> PUSH1 0x00 RETURN. Limited to <=7 words so offset/size
 * fit in a single PUSH1 byte (256), comfortably covers every real case here.
 */
export function buildFixedTupleReturnBytecode(values: bigint[]): Hex {
  if (values.length === 0 || values.length > 7) {
    throw new Error(`buildFixedTupleReturnBytecode: expected 1-7 values, got ${values.length}`);
  }
  let code = "0x";
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (value < 0n || value > (1n << 256n) - 1n) {
      throw new Error(`buildFixedTupleReturnBytecode: value at index ${i} out of uint256 range: ${value}`);
    }
    const valueHex = numberToHex(value, { size: 32 }).slice(2);
    const offsetHex = numberToHex(i * 32, { size: 1 }).slice(2);
    code += `7f${valueHex}60${offsetHex}52`; // PUSH32 <value> PUSH1 <offset> MSTORE
  }
  const sizeHex = numberToHex(values.length * 32, { size: 1 }).slice(2);
  code += `60${sizeHex}6000f3`; // PUSH1 <size> PUSH1 0x00 RETURN
  return code as Hex;
}
