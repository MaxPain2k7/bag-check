// Pulls holder wallets for a token, so you can test bag-check on real bags.
//
// Run: node get-holders.js <mint-address> [howMany]
//
// Skips the biggest holders on purpose. The top of any holder list is
// pools, exchanges and bots. The middle is actual people.

const API_KEY = process.env.HELIUS_KEY;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const mint = process.argv[2];
const want = Number(process.argv[3] || 15);

if (!API_KEY) {
  console.error("Missing HELIUS_KEY.");
  process.exit(1);
}
if (!mint) {
  console.error("Give me a mint: node get-holders.js <mint> [howMany]");
  console.error("The mint is the long address in the dexscreener URL.");
  process.exit(1);
}

async function getHolders(mintAddress) {
  const owners = new Map(); // owner -> amount
  let cursor = null;

  for (let page = 0; page < 5; page++) {
    const params = { mint: mintAddress, limit: 1000 };
    if (cursor) params.cursor = cursor;

    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenAccounts",
        params,
      }),
    });

    const json = await res.json();
    if (json.error) throw new Error(json.error.message);

    const accounts = json.result?.token_accounts ?? [];
    if (accounts.length === 0) break;

    for (const a of accounts) {
      if (!a.owner) continue;
      const amt = Number(a.amount ?? 0);
      owners.set(a.owner, (owners.get(a.owner) || 0) + amt);
    }

    cursor = json.result?.cursor;
    if (!cursor) break;
  }

  return [...owners.entries()]
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => b.amount - a.amount);
}

async function main() {
  const holders = await getHolders(mint);
  console.log(`\n${holders.length} holders found\n`);

  if (holders.length < 20) {
    console.log("Not many holders, so here they all are:");
    for (const h of holders) console.log(h.owner);
    console.log("");
    return;
  }

  // Drop the top 10% (pools, market makers, the dev) and the tail of
  // dust wallets. What is left is people with a real position.
  const start = Math.floor(holders.length * 0.1);
  const end = Math.floor(holders.length * 0.6);
  const middle = holders.slice(start, end);

  // spread the picks across that range instead of taking neighbours,
  // who are often the same person's wallets
  const step = Math.max(1, Math.floor(middle.length / want));
  const picks = [];
  for (let i = 0; i < middle.length && picks.length < want; i += step) {
    picks.push(middle[i].owner);
  }

  console.log(`${picks.length} wallets from the middle of the list:\n`);
  for (const p of picks) console.log(p);

  console.log(`\nRun them one at a time:`);
  console.log(`  node bag-check.js ${picks[0]}`);
  console.log("");
}

main().catch((err) => {
  console.error("\nFailed:", err.message, "\n");
  process.exitCode = 1;
});
