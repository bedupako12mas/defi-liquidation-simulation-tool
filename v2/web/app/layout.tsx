import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Aave V3 vs Fluid T1 - Liquidation Simulator (v2)",
  description:
    "RPC-tier and (eventually) mainnet-fork-tier comparison of Aave V3 and Fluid T1 liquidation mechanics under named price shocks.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
