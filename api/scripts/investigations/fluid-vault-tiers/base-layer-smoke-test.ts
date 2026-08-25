// Live smoke test of the actual production base-layer files (fluidSmartLeg.ts,
// fluidDexPoolState.ts), not the throwaway investigation scripts - confirms the real,
// committed code works end-to-end against real, active mainnet vaults before #59 builds on it.
import { publicClient, assertAllowedChain } from "../../../src/rpc/client.js";
import { detectSmartLegs } from "../../../src/loaders/fluidSmartLeg.js";
import { loadDexCollateralReserves, loadDexDebtReserves } from "../../../src/loaders/fluidDexPoolState.js";

// Real, confirmed-active vaults from the earlier investigation: one T2 (smart col only), one
// T3 (smart debt only), one T4 (both).
const T2_VAULT = "0x5eb4ba0c320b59f825cc8d2291f672247aa5d06f" as const;
const T3_VAULT = "0xb58634a962a579bd01c392451a718cb5d74dfb53" as const;
const T4_VAULT = "0x57fed7c9b3c763999c519264931790cbca331417" as const;

async function main() {
  await assertAllowedChain();

  for (const [label, vault] of [
    ["T2", T2_VAULT],
    ["T3", T3_VAULT],
    ["T4", T4_VAULT],
  ] as const) {
    const legs = await detectSmartLegs(publicClient, vault);
    console.log(`\n${label} vault ${vault}:`);
    console.log(`  collateralDex: ${legs.collateralDex ?? "(normal)"}`);
    console.log(`  debtDex: ${legs.debtDex ?? "(normal)"}`);

    if (legs.collateralDex) {
      const reserves = await loadDexCollateralReserves(publicClient, legs.collateralDex);
      console.log(`  collateral reserves:`, reserves);
    }
    if (legs.debtDex) {
      const reserves = await loadDexDebtReserves(publicClient, legs.debtDex);
      console.log(`  debt reserves:`, reserves);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
