// Automatic calibration run.
//
// Picks random live Solana tokens, picks random holders of each, runs
// bag-check on every wallet, then reports how often each flag fires.
//
// Run: node calibrate.js [howManyWallets]
//
// The point is not to check anyone's bag. It is to find out which flags
// are signals and which are wallpaper. A flag that fires on 95% of
// positions tells you nothing, and one that never fires is dead weight.

const { execFile } = require("child_process");
const fs = require("fs");

const API_KEY = process.env.HELIUS_KEY;
const JUP_KEY = process.env.JUP_KEY || null;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const WANT_WALLETS = Number(process.argv[2] || 10);
const TOKENS_TO_TRY = 8;
// 8 was too low: three whale wallets in a 40 wallet run held 114, 150 and
// 173 positions, so most of their positions went unquoted and UNVERIFIED
// looked like the commonest flag in the market. It was an artifact of this
// number, not a fact about wallets.
const QUOTE_BUDGET = Number(process.env.QUOTE_BUDGET || 20);
// Skip wallets too big to sample honestly rather than half-checking them
const MAX_POSITIONS_TO_TRUST = 60;

if (!API_KEY) {
  console.error("Missing HELIUS_KEY.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------- step 1: find live Solana tokens ----------------
// Dexscreener's public feeds, no key, 60 requests a minute. These are
// tokens people are actively looking at, which is what we want.
async function findTokens() {
  const feeds = [
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
  ];

  const mints = new Set();

  for (const url of feeds) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  ${url.split("/").slice(-2)[0]} returned ${res.status}`);
        continue;
      }
      const list = await res.json();
      const arr = Array.isArray(list) ? list : [list];
      for (const t of arr) {
        if (t.chainId === "solana" && t.tokenAddress) mints.add(t.tokenAddress);
      }
    } catch (e) {
      console.error(`  feed failed: ${e.message}`);
    }
    await sleep(1100);
  }

  return [...mints];
}



// Distinguishing a person's wallet from a protocol crank by looking at
// the address does not work. A "letters in a row" heuristic removed 4 of
// 7 known-good wallets in testing, because random base58 produces long
// letter runs constantly. DRpbCBMxVnDK looks exactly like soLStaCk5TiG.
//
// Behaviour is the real difference. A crank signs thousands of
// transactions an hour. A person signs a few a week. One RPC call per
// candidate, and it measures the thing that actually matters.
async function signsLikeABot(addr) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "sigs",
      method: "getSignaturesForAddress",
      params: [addr, { limit: 100 }],
    }),
  });

  const json = await res.json();
  const sigs = json.result;
  if (!Array.isArray(sigs) || sigs.length < 100) return false; // not busy enough to judge

  const times = sigs.map((x) => x.blockTime).filter(Boolean);
  if (times.length < 2) return false;

  const spanHours = (Math.max(...times) - Math.min(...times)) / 3600;
  if (spanHours <= 0) return true;

  // 100 transactions inside two hours is not a person
  return spanHours < 2;
}

// ---------------- unbiased source: the chain itself ----------------
// Sampling holders of tokens from a "latest launches" feed means every
// wallet you find holds a brand new token, which is why NEW fired on
// half of the median bag. That was the sampler, not the flag.
//
// This instead grabs random recent blocks and takes the fee payers, so
// wallets are chosen with no reference to what they hold.
//
// Known remaining bias: wallets that sign more transactions turn up more
// often, so bots are over-represented. Different bias, and a smaller one.
async function walletsFromBlocks(want) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "slot", method: "getSlot" }),
  });
  const json = await res.json();
  const tip = json.result;
  if (!tip) throw new Error("could not get current slot");

  const found = new Set();
  let attempts = 0;

  while (found.size < want * 3 && attempts < 25) {
    attempts++;
    // anywhere in roughly the last half day
    const slot = tip - Math.floor(Math.random() * 100000) - 100;

    const r = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "blk",
        method: "getBlock",
        params: [slot, {
          transactionDetails: "accounts",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        }],
      }),
    });

    const blk = await r.json();
    const txns = blk.result?.transactions;
    if (!txns) continue; // skipped slot, or too old for this node

    for (const t of txns) {
      const keys = t.transaction?.accountKeys;
      if (!keys || keys.length === 0) continue;
      const payer = keys[0];
      const addr = typeof payer === "string" ? payer : payer.pubkey;
      if (!addr) continue;

      found.add(addr);
    }

    process.stdout.write(`  slot ${slot}: ${found.size} wallets so far\r`);
  }

  console.log("");
  return [...found].sort(() => Math.random() - 0.5);
}

// ---------------- holders of a token (biased, kept for comparison) ----------------
async function holdersOf(mint) {
  const owners = new Map();
  let cursor = null;

  for (let page = 0; page < 2; page++) {
    const params = { mint, limit: 1000 };
    if (cursor) params.cursor = cursor;

    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "h", method: "getTokenAccounts", params }),
    });

    const json = await res.json();
    if (json.error) return [];

    const accounts = json.result?.token_accounts ?? [];
    if (accounts.length === 0) break;

    for (const a of accounts) {
      if (!a.owner) continue;
      owners.set(a.owner, (owners.get(a.owner) || 0) + Number(a.amount ?? 0));
    }

    cursor = json.result?.cursor;
    if (!cursor) break;
  }

  const sorted = [...owners.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);

  // Skip the top 10%: pools, market makers, the dev. Skip the bottom 40%:
  // dust wallets with nothing in them. The middle is real people.
  if (sorted.length < 30) return [];
  return sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.6));
}

// ---------------- step 3: run bag-check on one wallet ----------------
function runBagCheck(wallet) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["bag-check.js", wallet, "--json"],
      {
        env: { ...process.env, QUOTE_MAX: String(QUOTE_BUDGET) },
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err && !stdout) return resolve({ wallet, error: err.message.split("\n")[0] });
        try {
          resolve(JSON.parse(stdout.trim().split("\n").pop()));
        } catch {
          resolve({ wallet, error: "could not parse output" });
        }
      }
    );
  });
}

// ---------------- run ----------------
async function main() {
  if (!fs.existsSync("bag-check.js")) {
    console.error("bag-check.js is not in this folder. Run this from the same folder.");
    process.exit(1);
  }
  if (!JUP_KEY) {
    console.log("No JUP_KEY set, so this will be very slow. Free key at developers.jup.ag/portal\n");
  }

  const useTokens = process.argv.includes("--by-token");

  if (!useTokens) {
    console.log("Sampling random recent blocks for active wallets...");
    const fromChain = await walletsFromBlocks(WANT_WALLETS);
    if (fromChain.length === 0) {
      console.error("No wallets found in sampled blocks.");
      process.exit(1);
    }
    console.log(`  ${fromChain.length} distinct wallets found`);
    console.log(`  Filtering out automated signers...`);

    const keep = [];
    let dropped = 0;
    for (const w of fromChain) {
      if (keep.length >= WANT_WALLETS) break;
      if (await signsLikeABot(w)) { dropped++; continue; }
      keep.push(w);
    }
    console.log(`  dropped ${dropped} automated, kept ${keep.length}\n`);

    await checkAll(keep);
    return;
  }

  console.log("Finding live Solana tokens (biased toward new launches)...");
  const tokens = await findTokens();
  if (tokens.length === 0) {
    console.error("No tokens found. The dexscreener feeds may have moved.");
    process.exit(1);
  }
  console.log(`  ${tokens.length} tokens available\n`);

  // gather candidate wallets from a handful of random tokens
  const candidates = new Set();
  const tried = new Set();

  for (let i = 0; i < TOKENS_TO_TRY && candidates.size < WANT_WALLETS * 3; i++) {
    const mint = pick(tokens.filter((t) => !tried.has(t)));
    if (!mint) break;
    tried.add(mint);

    const mid = await holdersOf(mint);
    if (mid.length === 0) {
      console.log(`  ${mint.slice(0, 6)}... too few holders, skipping`);
      continue;
    }

    // spread picks across the range, neighbours are often the same person
    const step = Math.max(1, Math.floor(mid.length / 5));
    for (let j = 0; j < mid.length && j < step * 5; j += step) candidates.add(mid[j]);

    console.log(`  ${mint.slice(0, 6)}... ${mid.length} mid-tier holders`);
  }

  await checkAll([...candidates].sort(() => Math.random() - 0.5).slice(0, WANT_WALLETS));
}

// ---------------- run every wallet and report ----------------
async function checkAll(wallets) {
  console.log(`\nChecking ${wallets.length} wallets, roughly ${Math.ceil(wallets.length * QUOTE_BUDGET * 1.2 / 60)} minutes\n`);

  const results = [];
  for (const [i, w] of wallets.entries()) {
    process.stdout.write(`  [${i + 1}/${wallets.length}] ${w.slice(0, 6)}... `);
    const r = await runBagCheck(w);
    results.push(r);

    if (r.error) console.log(`failed (${r.error})`);
    else {
      const base = r.checkedPaper ?? r.paper;
      const pctGone = base > 0 ? Math.round((1 - r.proven / base) * 100) : 0;
      const note = r.positions > MAX_POSITIONS_TO_TRUST ? "  <- whale, excluded from flag stats" : "";
      console.log(`${r.positions} positions, $${Math.round(r.paper)} paper, ${pctGone}% not real${note}`);
    }
  }

  // ---------------- the actual point: flag rates ----------------
  // Whales get reported but kept out of the flag statistics. A wallet
  // with 173 positions is not a person and it distorts every rate.
  const usable = results.filter((r) => !r.error && r.positions > 0);
  const whales = usable.filter((r) => r.positions > MAX_POSITIONS_TO_TRUST);
  const good = usable.filter((r) => r.positions <= MAX_POSITIONS_TO_TRUST);
  if (good.length === 0) {
    console.log("\nNothing usable came back.");
    return;
  }

  const median = (arr) => {
    if (!arr || arr.length === 0) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };

  const totalPositions = good.reduce((s, r) => s + r.positions, 0);
  const flagTotals = {};
  const walletsWithFlag = {};

  for (const r of good) {
    for (const [code, n] of Object.entries(r.flagCounts || {})) {
      flagTotals[code] = (flagTotals[code] || 0) + n;
      walletsWithFlag[code] = (walletsWithFlag[code] || 0) + 1;
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(process.argv.includes("--by-token")
    ? "Source: holders of recently launched tokens (biased toward new tokens)"
    : "Source: fee payers from random recent blocks (unbiased by token)");
  console.log(`${good.length} normal wallets, ${totalPositions} positions`);
  if (whales.length > 0) {
    console.log(`${whales.length} whale ${whales.length === 1 ? "wallet" : "wallets"} excluded (over ${MAX_POSITIONS_TO_TRUST} positions each)`);
  }
  console.log("");

  console.log(`Positions per wallet: median ${median(good.map((r) => r.positions))}, range ${Math.min(...good.map((r) => r.positions))} to ${Math.max(...good.map((r) => r.positions))}`);
  const gaps = good
    .filter((r) => (r.checkedPaper ?? r.paper) > 0)
    .map((r) => Math.round((1 - r.proven / (r.checkedPaper ?? r.paper)) * 100));
  if (gaps.length) console.log(`Not real: median ${median(gaps)}%, range ${Math.min(...gaps)}% to ${Math.max(...gaps)}%`);

  // Pooling positions across wallets lets whales dominate. One sample had
  // three wallets holding 114, 150 and 173 positions against a median of
  // 2, so pooled percentages measured those three and nothing else. The
  // honest number is the median of the per-wallet rates.
  const perWalletRate = {};
  for (const r of good) {
    for (const code of Object.keys(flagTotals)) {
      const n = (r.flagCounts || {})[code] || 0;
      (perWalletRate[code] = perWalletRate[code] || []).push((n / r.positions) * 100);
    }
  }

  // The median per-wallet rate was useless: the median wallet holds 2
  // positions, so a flag can only score 0, 50 or 100 there, and the
  // median across wallets collapses to 0 whenever under half the wallets
  // have it. Share of wallets hit is the honest headline number, and a
  // rate is only meaningful on wallets big enough to have one.
  const BIG_ENOUGH = 5;
  const bigWallets = good.filter((r) => r.positions >= BIG_ENOUGH);

  console.log(`\nflag         hits   wallets hit   %of wallets   rate in bags of ${BIG_ENOUGH}+   verdict`);

  const rows = Object.entries(flagTotals).sort(
    (a, b) => walletsWithFlag[b[0]] - walletsWithFlag[a[0]] || b[1] - a[1]
  );

  for (const [code, n] of rows) {
    const hitWallets = walletsWithFlag[code];
    const walletShare = (hitWallets / good.length) * 100;

    // average share of a bag this flag covers, among wallets large
    // enough for the fraction to mean anything
    let rate = null;
    if (bigWallets.length > 0) {
      const rates = bigWallets.map((r) => ((r.flagCounts || {})[code] || 0) / r.positions);
      rate = (rates.reduce((s, x) => s + x, 0) / rates.length) * 100;
    }

    let verdict;
    if (walletShare > 70 && rate !== null && rate > 40) verdict = "fires on most bags and most positions, too loose";
    else if (walletShare > 70) verdict = "in almost every wallet, check it means something";
    else if (hitWallets <= 1) verdict = "one wallet only, not yet tested";
    else if (walletShare < 10) verdict = "rare, but real when it fires";
    else verdict = "looks useful";

    const rateStr = rate === null ? "n/a" : rate.toFixed(0) + "%";
    console.log(
      `${code.padEnd(12)} ${String(n).padStart(4)}   ${String(hitWallets + "/" + good.length).padStart(11)}   ${(walletShare.toFixed(0) + "%").padStart(11)}   ${rateStr.padStart(17)}   ${verdict}`
    );
  }

  if (bigWallets.length === 0) {
    console.log(`\n(no wallet held ${BIG_ENOUGH}+ positions, so the rate column is blank)`);
  } else {
    console.log(`\nRate column covers the ${bigWallets.length} ${bigWallets.length === 1 ? "wallet" : "wallets"} holding ${BIG_ENOUGH}+ positions.`);
  }

  // Whales skew everything, so say how lopsided the sample is
  const sizes = good.map((r) => r.positions).sort((a, b) => b - a);
  const top3 = sizes.slice(0, 3).reduce((s, n) => s + n, 0);
  console.log(`\nSample skew: the 3 biggest wallets hold ${top3} of ${totalPositions} positions (${Math.round((top3 / totalPositions) * 100)}%)`);

  // Flags absent from the table above read as "not a problem in these
  // wallets", but they might just be untested code. Name them.
  const ALL_FLAGS = [
    "DEAD", "TRAPPED", "IMPOSTOR", "STALE", "COSTLY", "THIN", "RISKY",
    "FACTORY", "CONTROLLED", "NO_BIDS", "LEAVING", "MISPRICED", "SERIAL",
    "HOLLOW", "EMPTY", "BUNDLED", "NEW", "TINY", "UNVERIFIED", "PARTIAL",
    "FINE", "SAFE",
  ];
  const never = ALL_FLAGS.filter((f) => !flagTotals[f]);
  if (never.length > 0) {
    console.log(`\nNever fired in this sample (untested, not proven absent):`);
    console.log(`  ${never.join(", ")}`);
  }

  // What actually shows up on every normal wallet
  const junk = usable.map((r) => ({
    held: r.tokensHeld,
    real: r.positions,
    junk: r.tokensHeld - r.positions,
  }));
  const totalHeld = junk.reduce((s, j) => s + j.held, 0);
  const totalReal = junk.reduce((s, j) => s + j.real, 0);
  const covs = usable.map((r) => r.coverage).filter((c) => typeof c === "number");
  if (covs.length) {
    const low = covs.filter((c) => c < 0.95).length;
    console.log(`Quote coverage: median ${Math.round(median(covs) * 100)}%, ${low} of ${covs.length} wallets under 95%`);
  }

  console.log(`\nJunk ratio across the sample:`);
  console.log(`  ${totalHeld} tokens held, ${totalReal} worth more than a dollar`);
  console.log(`  ${Math.round((1 - totalReal / totalHeld) * 100)}% of what people hold is worthless`);
  console.log(`  median wallet: ${median(junk.map((j) => j.held))} held, ${median(junk.map((j) => j.real))} real`);

  const out = `calibration-${Date.now()}.json`;
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to ${out}`);
  console.log("");
}

main().catch((err) => {
  console.error("\nFailed:", err.message, "\n");
  process.exitCode = 1;
});
