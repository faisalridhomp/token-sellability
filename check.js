// token-sellability — is a BSC token actually sellable?
//
// Pool size alone is NOT proof: two tokens judged "sellable" on liquidity
// were rejected as sell-restricted. This checker judges by simulation:
//   1. token balance of the wallet
//   2. PancakeSwap V2 pair exists + reserves (BNB side)
//   3. a simulated sell (getAmountsOut + a transfer eth_call) succeeds
//   4. transfer restrictions (vesting / lock / paused) via a dry-run transfer
//
// Usage: node check.js <tokenAddress> <walletAddress>
// Requires: ethers (npm i ethers). Uses public BSC RPCs, no key needed.

const { ethers } = require("ethers");

const RPCS = [
    "https://bsc-dataseed1.ninicoin.io",
    "https://bsc-dataseed1.binance.org",
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc.publicnode.com",
];
const FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"; // verified via router.factory() 2026-11-12 — NOT ...0c6b
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
];
const PAIR_ABI = [
    "function getReserves() view returns (uint112,uint112,uint32)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const ROUTER_ABI = ["function getAmountsOut(uint256,address[]) view returns (uint256[])"];

async function getProvider() {
    for (const url of RPCS) {
        try {
            const p = new ethers.JsonRpcProvider(url);
            await p.getBlockNumber();
            return p;
        } catch { /* try next */ }
    }
    throw new Error("no working RPC");
}

async function check(token, wallet) {
    const provider = await getProvider();
    const t = new ethers.Contract(token, ERC20_ABI, provider);
    const [symbol, decimals, balance, supply] = await Promise.all([
        t.symbol().catch(() => "?"),
        t.decimals().catch(() => 18),
        t.balanceOf(wallet),
        t.totalSupply().catch(() => 0n),
    ]);
    const bal = Number(ethers.formatUnits(balance, decimals));
    console.log(`\n${symbol} (${token})`);
    console.log(`  balance: ${bal}  |  totalSupply: ${ethers.formatUnits(supply, decimals)}`);

    // 1. Pair + liquidity
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    const pairAddr = await factory.getPair(token, WBNB);
    if (pairAddr === ethers.ZeroAddress) {
        console.log("  pair: NONE — no PancakeSwap V2 pair. NOT SELLABLE.");
        return { sellable: false, reason: "no pair" };
    }
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [r0, r1] = await pair.getReserves();
    const [t0] = await Promise.all([pair.token0()]);
    const bnbReserve = t0.toLowerCase() === WBNB.toLowerCase() ? r0 : r1;
    const bnbLiq = Number(ethers.formatEther(bnbReserve));
    console.log(`  pair: ${pairAddr}  |  BNB liquidity: ~${bnbLiq.toFixed(6)} BNB`);
    if (bnbLiq < 0.0001) {
        console.log("  liquidity too thin to cover gas. NOT SELLABLE.");
        return { sellable: false, reason: "thin liquidity" };
    }

    // 2. Simulated sell quote (getAmountsOut for the full balance)
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
    let out;
    try {
        out = await router.getAmountsOut(balance, [token, WBNB]);
    } catch (e) {
        console.log("  getAmountsOut reverted — swap route broken. NOT SELLABLE.");
        return { sellable: false, reason: "swap reverts" };
    }
    const outBnb = Number(ethers.formatEther(out[1]));
    console.log(`  sell quote for full balance: ~${outBnb.toFixed(8)} BNB`);
    if (outBnb <= 0) {
        console.log("  quote is 0. NOT SELLABLE.");
        return { sellable: false, reason: "zero quote" };
    }

    // 3. Transfer dry-run (catches vesting / lock / paused / blacklist)
    try {
        const tx = await t.transfer.populateTransaction(wallet, balance);
        await provider.call({ ...tx, from: wallet });
        console.log("  transfer dry-run: OK (no vesting/lock restriction detected)");
    } catch (e) {
        console.log(`  transfer dry-run REVERTED: ${e.shortMessage || e.message}`);
        console.log("  token is transfer-restricted (vesting / lock / paused). NOT SELLABLE now.");
        return { sellable: false, reason: "transfer restricted" };
    }

    console.log(`  VERDICT: SELLABLE — ~${outBnb.toFixed(8)} BNB for ${bal} ${symbol}`);
    return { sellable: true, outBnb };
}

const [token, wallet] = process.argv.slice(2);
if (!token || !wallet) {
    console.log("Usage: node check.js <tokenAddress> <walletAddress>");
    process.exit(1);
}
check(ethers.getAddress(token), ethers.getAddress(wallet)).catch((e) => {
    console.error("error:", e.shortMessage || e.message);
    process.exit(1);
});
