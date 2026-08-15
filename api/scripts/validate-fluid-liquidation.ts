import { publicClient, assertAllowedChain } from "../src/rpc/client.js";
import { loadFluidVaultConfigs } from "../src/loaders/fluidVaultConfig.js";
import { loadFluidPositions } from "../src/loaders/fluidPositions.js";
import { resolveFluidPrices } from "../src/loaders/fluidPriceResolution.js";
import { loadReserveConfigs } from "../src/loaders/aaveReserveConfig.js";
import { healthFactor } from "../src/engine/healthFactor.js";
import { validateFluidLiquidation, resolveFluidOverrideTarget } from "../src/validation/fluidValidator.js";
import { redactError } from "../src/rpc/redact.js";
import type { PriceVector } from "../src/engine/types.js";

// Env-configurable, matching validate-aave-liquidation.ts's convention. Negative fraction
// magnitudes to try, in order, stopping at the first real "swept" result per position -
// this project's own diagnosis found real positions can need anywhere from a mild ~3% move
// to (for very conservatively-collateralized vaults) an unrealistic move before crossing
// their real threshold - trying a small range rather than one fixed guess.
const SAMPLE_SIZE = Number(process.env.VALIDATION_SAMPLE_SIZE ?? "20");
const SHOCK_MAGNITUDES_PCT = [1, 3, 5, 10, 20, 30];

// KNOWN, DISCLOSED SCOPE LIMIT (see fluidValidator.ts): only vaults whose oracle is a
// single-hop FluidGenericOracle are covered - confirmed live this session to be 44 of 95
// unique real oracles. Positions in other vaults report "unable-to-validate" explicitly,
// not silently skipped.
//
// Loading ALL vaults' positions in one batch exceeds the free-tier eth_call gas cap (a
// real, confirmed finding this session, same class of issue as #51) - chunked here.
const VAULT_CHUNK_SIZE = 10;

async function main() {
  await assertAllowedChain();

  const vaults = await loadFluidVaultConfigs(publicClient);
  const aaveReserves = await loadReserveConfigs(publicClient);
  const priceResolution = resolveFluidPrices(vaults, aaveReserves);

  const allPositions: Awaited<ReturnType<typeof loadFluidPositions>>["positions"] = [];
  for (let i = 0; i < vaults.length; i += VAULT_CHUNK_SIZE) {
    const chunk = vaults.slice(i, i + VAULT_CHUNK_SIZE);
    const { positions } = await loadFluidPositions(publicClient, chunk, priceResolution);
    allPositions.push(...positions);
  }

  const prices: PriceVector = Object.fromEntries(priceResolution.pricesUsd8);
  const vaultByAddress = new Map(vaults.map((v) => [v.vault.toLowerCase(), v]));

  const withHf = allPositions
    .map((p) => ({ ...p, hf: healthFactor(p.position, prices) }))
    .filter((x) => x.hf !== null)
    .sort((a, b) => Number(a.hf! - b.hf!))
    .slice(0, SAMPLE_SIZE);

  console.log(`Testing the ${withHf.length} real positions closest to their real threshold (of ${allPositions.length} total).`);

  let swept = 0;
  let notApplicable = 0;
  let unableToValidate = 0;
  let noSweepInRange = 0;

  for (const { position, vaultAddress, hf } of withHf) {
    const vault = vaultByAddress.get(vaultAddress.toLowerCase());
    if (!vault) continue;

    const resolution = await resolveFluidOverrideTarget(publicClient, vault.oracle, "internal-exchange-rate");
    if (resolution.status === "not-applicable") {
      notApplicable++;
      continue;
    }
    if (resolution.status === "unable-to-validate") {
      unableToValidate++;
      console.log(`  UNABLE   ${position.id} (HF=${(Number(hf) / 1e18).toFixed(4)}): ${resolution.reason}`);
      continue;
    }

    let foundSweep = false;
    for (const pct of SHOCK_MAGNITUDES_PCT) {
      const realRate = await publicClient.readContract({
        address: resolution.overrideAddress,
        abi: [{ type: "function", name: "getExchangeRateLiquidate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "getExchangeRateLiquidate",
      });
      const shockedRate = (realRate * BigInt(100 - pct)) / 100n;

      const result = await validateFluidLiquidation(publicClient, {
        vault: vault.vault,
        oracle: vault.oracle,
        overrideValue: shockedRate,
        priceComponent: "internal-exchange-rate",
        debtAmt: vault.totalBorrowVault,
      });

      if (result.status === "swept") {
        swept++;
        foundSweep = true;
        console.log(
          `  SWEPT    ${position.id} (HF=${(Number(hf) / 1e18).toFixed(4)}) at -${pct}%: actualColAmt=${result.actualColAmt} actualDebtAmt=${result.actualDebtAmt}`,
        );
        break;
      }
    }
    if (!foundSweep) {
      noSweepInRange++;
      console.log(`  (no sweep within -${SHOCK_MAGNITUDES_PCT[SHOCK_MAGNITUDES_PCT.length - 1]}%) ${position.id} (HF=${(Number(hf) / 1e18).toFixed(4)})`);
    }
  }

  console.log(
    `\nResults: ${swept} swept, ${noSweepInRange} no-sweep-in-tested-range, ${notApplicable} not-applicable, ${unableToValidate} unable-to-validate.`,
  );
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(redactError(err));
  process.exitCode = 1;
});
