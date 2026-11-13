# token-sellability

Checks whether a BSC token is actually sellable — by simulation, not by
pool size alone.

Two tokens judged "sellable" on liquidity were rejected as
sell-restricted. A pool can exist while transfers are locked (vesting,
pause, blacklist), so this checker simulates the whole path before
calling anything sellable.

## Checks

1. Wallet balance of the token.
2. PancakeSwap V2 pair exists, and its BNB-side reserves.
3. A simulated sell quote (`getAmountsOut`) for the full balance.
4. A transfer dry-run (`eth_call`) — catches vesting, locks, pauses.

## Usage

```bash
npm i ethers
node check.js <tokenAddress> <walletAddress>
```

Example:

```bash
node check.js 0x4257AC3e0E2B6A4AF35A5D49bB61910305001825 0x3Bc96b2528f686F27b04897bD819bC10D8981B1b
```

Prints a verdict: `SELLABLE` with the estimated BNB out, or `NOT SELLABLE`
with the reason (no pair / thin liquidity / swap reverts / transfer
restricted / zero quote).
