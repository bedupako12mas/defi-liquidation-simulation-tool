// Real, verified addresses (checked live against mainnet before use, not copied unchecked -
// same discipline as aaveAddresses.ts) - sourced from Aave's own real address-book repo
// (github.com/aave-dao/aave-address-book, src/AaveV4Ethereum.sol), cross-checked against
// Aave's real ISpoke.sol interface (github.com/aave/aave-v4) rather than trusted from docs
// prose alone. Aave V4 launched on Ethereum mainnet 2026-03-30 with a Hub-and-Spoke
// architecture - see docs/decisions.md's 2026-09-07 entry for the full investigation.
//
// 4 real Hubs (Core, Plus, Prime, and a Global Dollar Hub not mentioned in Aave's own public
// docs at the time of this investigation - found only by reading the real address book).
export const AAVE_V4_HUBS = {
  core: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
  plus: "0x06002e9c4412CB7814a791eA3666D905871E536A",
  prime: "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931",
  globalDollar: "0x62d63197660c080236193CA60b70E49A08E90368",
} as const;

// 13 real Spokes (a bounded, DAO-authorized set today - Aave V4 is not yet permissionless
// for third-party Spoke deployment, confirmed live via Aave's own team commentary - so this
// list is a real, complete census, not a sample, as of this investigation). Excludes
// TREASURY_SPOKE (protocol-owned treasury accounting, not a real user-facing borrow/supply
// market).
export const AAVE_V4_SPOKES = {
  main: "0x94e7A5dCbE816e498b89aB752661904E2F56c485",
  bluechip: "0x973a023A77420ba610f06b3858aD991Df6d85A08",
  forex: "0xD8B93635b8C6d0fF98CbE90b5988E3F2d1Cd9da1",
  gold: "0x65407b940966954b23dfA3caA5C0702bB42984DC",
  lombardBtc: "0x7EC68b5695e803e98a21a9A05d744F28b0a7753D",
  ethenaCorrelated: "0x58131E79531caB1d52301228d1f7b842F26B9649",
  ethenaEcosystem: "0xba1B3D55D249692b669A164024A838309B7508AF",
  usdgPendle: "0x956d8e0A89cfa3744428C4641b5a53B56167a7f9",
  usdgMaple: "0x774b9655413c34809c1f1b16b654465A89EBE989",
  etherfi: "0xbF10BDfE177dE0336aFD7fcCF80A904E15386219",
  kelp: "0x3131FE68C4722e726fe6B2819ED68e514395B9a4",
  lido: "0xe1900480ac69f0B296841Cd01cC37546d92F35Cd",
} as const;

export type AaveV4SpokeName = keyof typeof AAVE_V4_SPOKES;

export const AAVE_V4_SPOKE_ADDRESSES: `0x${string}`[] = Object.values(AAVE_V4_SPOKES) as `0x${string}`[];
