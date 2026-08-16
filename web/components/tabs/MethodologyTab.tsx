"use client";

import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { UcFrontierTable } from "@/components/overview/UcFrontierTable";
import { LimitationsPanel } from "@/components/shared/LimitationsPanel";
import { InfoTooltip } from "@/components/shared/InfoTooltip";
import { Glossary } from "@/components/shared/Glossary";

export function MethodologyTab() {
  const { meta, loading, error } = useCapabilities();

  return (
    <div>
      <div className="card">
        <h2>The three position states</h2>
        <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
          At any shocked price, every position is in exactly one of three states - a direct
          algebraic consequence of the protocol&apos;s own liquidation threshold and bonus,
          independently verifiable from those two numbers alone (a framing first written down
          in Warmuz, Chaudhary &amp; Pinna&apos;s unreviewed preprint, <em>Toxic Liquidation
          Spirals</em>, arXiv:2212.07306 - not itself peer-reviewed or cited here as
          validation):
        </p>
        <div className="three-state-grid">
          <div className="three-state-cell">
            <div className="label" style={{ marginBottom: "0.4rem" }}>
              <span className="tag tag-healthy">Healthy</span>
            </div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              Has more collateral value than it needs. No liquidation is possible.
              <InfoTooltip label="What health factor means">
                <strong>Technical:</strong> health factor (collateral value &times; liquidation
                threshold, divided by debt value) &ge; 1.
              </InfoTooltip>
            </div>
          </div>
          <div className="three-state-cell">
            <div className="label" style={{ marginBottom: "0.4rem" }}>
              <span className="tag tag-liquidatable">Liquidatable</span>
              <span className="tag tag-eligible" style={{ marginLeft: "0.35rem" }}>Eligible</span>
            </div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              A liquidator could step in and profit right now - though on Fluid that depends on
              whether a sweep actually reaches this position, not a guarantee.
              <InfoTooltip label="Technical definition of Liquidatable / Eligible">
                Health factor &lt; 1, but current LTV is still under the undercollateralization
                (UC) frontier, 1/(1+i). Aave calls this state <strong>Liquidatable</strong>; Fluid
                T1 positions are labeled <strong>Eligible</strong> instead - deliberately
                different words for a real mechanistic difference, not a display quirk. Aave&apos;s{" "}
                <code>liquidationCall()</code> targets one specific user&apos;s specific reserves
                directly - crossing this line is individually actionable, right now. Fluid&apos;s{" "}
                <code>liquidate()</code> has no per-user targeting at all (verified directly
                against its source) - it sweeps aggregate ticks from worst to a threshold,
                consuming whatever positions sit in that range. &ldquo;Eligible&rdquo; means a
                position&apos;s ratio has entered the zone a sweep <em>could</em> reach - not a
                guarantee it will be, which depends on aggregate sweep depth and what else is
                queued ahead of it in the same vault.
              </InfoTooltip>
            </div>
          </div>
          <div className="three-state-cell">
            <div className="label" style={{ marginBottom: "0.4rem" }}>
              <span className="tag tag-toxic">Toxic</span>
            </div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              Too far gone for liquidation to help - every allowed liquidation now makes the
              position worse, which is how bad debt gets created.
              <InfoTooltip label="Technical definition of Toxic">
                Current LTV has crossed the UC frontier. Any liquidation at the current fixed
                incentive is now guaranteed to make LTV worse, not better - the mechanism that
                produces bad debt, not merely a risk of it. Toxic is always a strict subset of
                Liquidatable/Eligible, not a separate condition reached independently.
              </InfoTooltip>
            </div>
          </div>
        </div>
        <p className="preset-note">
          The Overview tab&apos;s per-position drilldown classifies every real position into
          one of these states, live, at whatever shock magnitude is selected - for both Aave V3
          and Fluid T1.
        </p>
      </div>

      <div className="card">
        <h2>Two confidence levels, not one</h2>
        <p className="preset-note" style={{ marginTop: 0 }}>
          The numbers in this tool are not all equally certain, and shouldn&apos;t be read as
          if they were. In short: treat Level 1 numbers as verified fact, and Level 2 numbers
          as a clearly-labeled, real-but-simplified estimate.
        </p>
        <p className="preset-note">
          <strong>Health factor and LTV are Level 1</strong>: exact, real liquidation-formula
          math, empirically checked against Aave&apos;s own on-chain{" "}
          <code>getUserAccountData()</code> - matched to within 10 bps on real positions. The
          same generic engine (unchanged) is reused for Fluid&apos;s single-collateral-leg
          positions, since a Fluid T1 position&apos;s health factor formula collapses to the
          identical shape with one collateral and one debt leg.
        </p>
        <p className="preset-note">
          <strong>Bad debt is Level 2</strong>: a simplified aggregate approximation
          (<code>max(0, debt - collateral)</code>) at the shocked price - it does not replicate
          the real contract&apos;s close-factor
          <InfoTooltip label="What close factor means">
            <strong>Plain language:</strong> most lending protocols cap how much of a single
            position&apos;s debt can be repaid in one liquidation call (e.g. 50% at a time), so
            a badly underwater position may take several liquidations to fully unwind, not one.
            <br />
            <br />
            <strong>Technical:</strong> the real contract&apos;s close-factor limit, which this
            tool&apos;s Level 2 bad-debt approximation does not replicate.
          </InfoTooltip>{" "}
          limits or per-asset seizure mechanics. The
          Validation tab checks a bounded real sample of positions against the real contract
          directly (<code>eth_call</code> against the real liquidation function with a price
          override, for both protocols, no fork or mined transaction) - it does not replace
          this tab&apos;s approximation everywhere, but it does give a real, checked answer for
          how far off that approximation runs on real, live state.
        </p>
      </div>

      <div className="card">
        <h2>
          The undercollateralization frontier - LTV_UC = 1 / (1 + i)
          <InfoTooltip label="What the UC frontier means, in plain terms">
            <strong>Plain language:</strong> past a certain debt-to-collateral ratio, liquidating
            a position can no longer make it healthier - every liquidation from there only digs
            the hole deeper. That ratio is the UC (undercollateralization) frontier.
          </InfoTooltip>
        </h2>
        <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
          A liquidation above this frontier is mathematically guaranteed to make the position
          worse, not better - a direct algebraic consequence of the protocol&apos;s own
          liquidation threshold and bonus, independently verifiable from those two numbers
          alone (the same framing appears in Warmuz, Chaudhary &amp; Pinna&apos;s unreviewed
          preprint, arXiv:2212.07306, not cited here as validation). Low incentive &rarr; high
          frontier &rarr; real headroom for a high liquidation threshold. This isn&apos;t
          Aave-specific: it falls out of any protocol that pays liquidators a fixed proportional
          bonus per unit of debt repaid, which is exactly what Fluid&apos;s own
          <code>liquidationPenalty</code> is - the same formula applies unchanged, fed each
          protocol&apos;s own real config.
        </p>
        {loading && <p className="loading">Loading...</p>}
        {error && <div className="banner">Error talking to the API: {error}.</div>}
        {meta && <UcFrontierTable rows={meta.ucFrontier} />}
      </div>

      <div className="card">
        <h2>Comparing Aave and Fluid fairly</h2>
        <p className="preset-note" style={{ marginTop: 0 }}>
          Aave and Fluid are discovered very differently, and the real sample sizes reflect
          that - not a difference in how risky either protocol actually is. Aave has no
          on-chain call that lists its borrowers; positions are found by scanning historical{" "}
          <code>Borrow</code> event logs over a bounded block window, then checking each
          candidate&apos;s current real state. Fluid ships resolver contracts
          (<code>FluidVaultPositionsResolver</code>) specifically for external tools to
          enumerate every position directly - one call per vault returns everything, no log
          archaeology required. The practical result: Aave&apos;s real sample is a few hundred
          to low thousands of positions from a recent window; Fluid&apos;s covers essentially
          all 101 real T1 vaults directly.
        </p>
        <p className="preset-note">
          Comparing raw totals (dollars, counts) across two samples of very different size
          mostly measures sample size, not risk. The Overview chart and drilldown use five
          metrics built specifically to stay meaningful across that gap:
        </p>
        <ul className="limitations">
          <li>
            <strong>Count-based %</strong> - liquidatable/eligible and toxic counts as a
            fraction of each protocol&apos;s own sampled book, not an absolute number. The
            primary comparison metric: every discovered position counts equally, so it isn&apos;t
            dominated by whichever single position happens to be largest in the sample.
          </li>
          <li>
            <strong>Dollar-based %</strong> - the same idea applied to collateral value.
            Included alongside the count-based version, but more sensitive to a single large
            position - which is exactly what <strong>concentration</strong> exists to measure
            explicitly, rather than leave hidden inside the total.
          </li>
          <li>
            <strong>Concentration</strong>
            <InfoTooltip label="What concentration means, in plain terms">
              How much of the at-risk collateral total is really just one whale position, rather
              than broadly spread risk. High concentration means a single position could swing
              the numbers on its own.
            </InfoTooltip>{" "}
            - the single largest at-risk position&apos;s share of
            all at-risk collateral, at a given shock. Found empirically necessary this session:
            a real ~$150M Fluid position was found to account for the large majority of one
            shock magnitude&apos;s entire liquidatable-collateral total on its own. High
            concentration means a dollar swing is a single-position artifact, not a broad
            signal - low, stable concentration means it is.
          </li>
          <li>
            <strong>Bad-debt severity</strong> - the median debt/collateral ratio among only the
            positions that are actually underwater, not the summed dollar total. Separates
            &ldquo;many positions barely underwater&rdquo; from &ldquo;one position
            catastrophically underwater,&rdquo; which a single summed total conflates.
          </li>
          <li>
            <strong>Headroom (kill-price)</strong> - per position, the shock magnitude at which
            it first crosses its own threshold, shown as a distribution (median) rather than a
            single swept curve. Answers &ldquo;how fragile is a typical position&rdquo; instead
            of &ldquo;how much is at risk at one specific shock&rdquo; - naturally robust to
            sample size and to any single outlier position, since a median isn&apos;t moved by
            one extreme value the way a sum is.
          </li>
        </ul>
        <p className="preset-note">
          A sixth view, in the per-position drilldown, groups at-risk debt by each
          protocol&apos;s own real isolated-market unit - Aave&apos;s reserve (an asset,
          computed at the individual debt-leg level, since one Aave position can hold debt
          across several reserves at once) and Fluid&apos;s vault (a position always has exactly
          one debt leg). Deliberately different grouping keys per protocol, matching each
          protocol&apos;s own actual market boundary rather than forcing a common shape onto
          both.
        </p>
      </div>

      <div className="card">
        <h2>Known limitations</h2>
        {loading && <p className="loading">Loading...</p>}
        {meta && <LimitationsPanel limitations={meta.limitations} />}
      </div>

      <div className="card">
        <h2>Glossary</h2>
        <p className="preset-note" style={{ marginTop: 0, marginBottom: "1rem" }}>
          Every metric and status shown anywhere in this app, in one place - grouped by
          where it appears. The inline (i) icons throughout explain a term where it&apos;s
          used; this is the central lookup for &ldquo;I saw a word somewhere, what did it
          mean.&rdquo;
        </p>
        <Glossary />
      </div>
    </div>
  );
}
