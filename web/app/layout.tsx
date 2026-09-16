import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Aave V3, Aave V4 & Fluid - Liquidation Simulator",
  description:
    "Compares Aave V3, Aave V4, and Fluid T1 liquidation mechanics under named price shocks, with gas-cost-of-liquidation metrics and disclosed modeling limitations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
