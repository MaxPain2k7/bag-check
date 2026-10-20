// Bag Check
// Shows what a Solana wallet is really worth if you tried to sell it.
//
// Run: node bag-check.js <wallet-address>
//
// Needs a free Jupiter key from developers.jup.ag/portal:
//   set JUP_KEY=your_key_here
//
// ---------------------------------------------------------------------
// WHY THIS VERSION LOOKS DIFFERENT
//
// The old version kept producing the same bug in new costumes: it would
// call a token healthy when it was not sellable. Two causes, both fixed
// here by design rather than by patching.
//
// 1. Two sources of truth. Dexscreener said liquidity, Jupiter said
//    routability, and a hand-ordered if-chain refereed between them.
//    Every new token type found a combination nobody enumerated.
//    Now there is one authority per question: Jupiter's token list for
//    market data, Jupiter quotes for whether it actually sells. Being
//    in the token list proves nothing about sellability, so nothing in
//    the code treats it that way.
//
// 2. The fall-through case was FINE. Any path not anticipated ended in
//    reassurance. Now the default is UNVERIFIED and a calm label needs
//    positive proof. Unanticipated cases fail loud instead of comforting.
//
// The verdict is also split in two stages. Stage one establishes facts
// about sellability. Stage two attaches a label by looking those facts
// up. Facts and opinions no longer share one tangled chain.
// ---------------------------------------------------------------------

const API_KEY = process.env.HELIUS_KEY;
const JUP_KEY = process.env.JUP_KEY || null;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const wallet = process.argv[2];

if (!API_KEY) {
  console.error("Missing HELIUS_KEY.");
  process.exit(1);
}
if (!wallet) {
  console.error("Give me a wallet address: node bag-check.js <address>");
  process.exit(1);
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Real mints for the coins everyone knows. Kept as a map so we can also
// catch tokens wearing these symbols without owning the mint.
const MAJOR = new Map([
  ["So11111111111111111111111111111111111111112", "SOL"],
  [USDC, "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
  ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "JUP"],
  ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "BONK"],
  // Liquid staking tokens. These were missing, so every wallet holding
  // real JitoSOL got accused of holding a fake one. A false accusation on
  // a legitimate $128k position is the worst thing this tool can output.
  ["mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "mSOL"],
  ["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "JitoSOL"],
  ["bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", "bSOL"],
  ["jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", "jupSOL"],
  ["5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", "INF"],
  ["he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhKoc3qcJm", "hSOL"],
  // Other real tokens that wear protected symbols
  ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD"],
  ["7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", "ETH"],
  ["3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", "WBTC"],
  ["EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "WIF"],
  ["4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", "RAY"],
  ["pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "PUMP"],
]);

// Two tiers, because two different things are true.
//
// UNIQUE: exactly one legitimate token wears this symbol. Any other mint
// using it is impersonating, verified or not. There is one USDC.
const UNIQUE_SYMBOLS = new Set([
  "SOL", "WSOL", "USDC", "USDT", "PYUSD", "USDE", "JUP", "BONK", "WIF",
  "PUMP", "RAY", "ETH", "WBTC", "BTC", "POPCAT", "FARTCOIN", "TRUMP",
]);

// FAMILY: many legitimate tokens share this shape. Every liquid staking
// token ends in SOL and new ones launch monthly, so a hardcoded list can
// never be complete. Accusing one of impersonation needs more than the
// name, which is why real JitoSOL got flagged as fake JitoSOL on 8 of 14
// sampled wallets.
const FAMILY_SYMBOLS = new Set([
  "MSOL", "JITOSOL", "BSOL", "JUPSOL", "INF", "HSOL", "LST", "STSOL",
  "CGNTSOL", "DSOL", "PICOSOL", "BNSOL", "VSOL",
]);

// Stablecoins we can value at face without asking anyone
const STABLES = new Set([
  USDC,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
]);

const DUST_USD = 1;
const HISTORY_PAGES = 5;
const JUP_GAP_MS = JUP_KEY ? 1100 : 2600;
const QUOTE_MAX = Number(process.env.QUOTE_MAX || 30); // positions that get a real exit quote
const PROBE_STEPS = [1, 0.1, 0.01];

const jupHeaders = JUP_KEY ? { "x-api-key": JUP_KEY } : {};

// --json prints one machine readable object and nothing else, so other
// scripts can drive this one. It implies quiet.
const AS_JSON = process.argv.includes("--json");
const say = (...a) => { if (!AS_JSON) console.log(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// SOURCE 1: Helius. Authority on what the wallet holds. Nothing else.
//
// This pages. The old version read page 1 only, so a wallet holding
// 1,426 tokens reported on 95 of them and missed its largest position
// entirely. A partial read is worse than no read, because the total
// looks authoritative and is wrong.
// =====================================================================
const HOLDINGS_MAX_PAGES = 20; // 1000 per page, so up to 20,000 tokens

async function getHoldings(address) {
  const all = [];

  for (let page = 1; page <= HOLDINGS_MAX_PAGES; page++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bagcheck",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: address,
          page,
          limit: 1000,
          displayOptions: { showFungible: true },
        },
      }),
    });

    const json = await res.json();
    if (json.error) throw new Error(json.error.message);

    const items = json.result?.items ?? [];
    all.push(...items);

    // a short page means that was the last one
    if (items.length < 1000) {
      return { tokens: parseItems(all), pages: page, truncated: false };
    }
  }

  // hit the page cap, so say so rather than pretending it is complete
  return { tokens: parseItems(all), pages: HOLDINGS_MAX_PAGES, truncated: true };
}

function parseItems(items) {
  return items
    .filter((i) => i.interface === "FungibleToken" || i.interface === "FungibleAsset")
    .map((item) => {
      const info = item.token_info || {};
      const decimals = info.decimals ?? 0;
      const raw = BigInt(info.balance ?? 0);
      return {
        mint: item.id,
        fallbackSymbol: info.symbol || item.content?.metadata?.symbol || "???",
        decimals,
        raw,
        amount: Number(raw) / Math.pow(10, decimals),
      };
    })
    .filter((t) => t.amount > 0);
}

// =====================================================================
// SOURCE 2: Jupiter Tokens V2. Authority on MARKET DATA only, for up to
// 100 mints a call: price, liquidity, activity, audit flags.
//
// It is NOT the authority on whether you can sell. Search returns
// Jupiter's whole token universe, so a mint appearing here only means
// Jupiter knows it exists. RICHGOAT and BALLS both appeared here and
// were then refused at quote time. Only a quote settles sellability.
// =====================================================================
async function getMarketTruth(mints) {
  const found = new Map();

  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    const url = `https://api.jup.ag/tokens/v2/search?query=${batch.join(",")}`;

    const res = await fetch(url, { headers: jupHeaders });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jupiter tokens returned ${res.status}: ${body.slice(0, 120)}`);
    }

    const list = await res.json();
    if (!Array.isArray(list)) {
      throw new Error(`Jupiter tokens returned ${typeof list}, expected an array`);
    }

    // node bag-check.js <wallet> --raw SYMBOL
    // Dumps exactly what Jupiter sent for that token, so we can tell the
    // difference between a field being absent and a field being zero.
    const rawFlag = process.argv.indexOf("--raw");
    if (rawFlag !== -1) {
      const want = (process.argv[rawFlag + 1] || "").toLowerCase();
      const hit = list.find((t) => (t.symbol || "").toLowerCase() === want);
      if (hit) {
        console.error(`\nRaw Jupiter data for ${hit.symbol}:`);
        console.error(JSON.stringify(hit, null, 2));
        console.error("");
      }
    }

    for (const t of list) {
      const mint = t.id ?? t.address ?? t.mint;
      if (!mint) continue;

      // Jupiter omits zero-value fields rather than sending 0. KURO came
      // back with numSells: 1 and no numBuys at all, meaning zero buys.
      // So absent is zero here, NOT unknown. Reading it as unknown was
      // turning a real signal (nobody is buying) into a shrug.
      const s = t.stats24h || {};
      const audit = t.audit || {};

      found.set(mint, {
        symbol: t.symbol || null,
        price: Number(t.usdPrice ?? 0),
        liquidity: Number(t.liquidity ?? 0),
        mcap: Number(t.mcap ?? t.fdv ?? 0),
        holders: Number(t.holderCount ?? 0),
        buys: Number(s.numBuys ?? 0),
        sells: Number(s.numSells ?? 0),
        traders: Number(s.numTraders ?? 0),
        buyVolume: Number(s.buyVolume ?? 0),
        sellVolume: Number(s.sellVolume ?? 0),
        liquidityChange: Number(s.liquidityChange ?? 0),
        organicScore: Number(t.organicScore ?? 0),
        organicLabel: t.organicScoreLabel || null,
        verified: t.isVerified ?? false,
        launchpad: t.launchpad || null,
        createdAt: t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : null,
        // who made this, and how many times have they done it before
        devMints: Number(audit.devMints ?? 0),
        devMigrations: Number(audit.devMigrations ?? 0),
        topHolders: Number(audit.topHoldersPercentage ?? 0),
        mintAuthorityLive: audit.mintAuthorityDisabled === false,
        freezeAuthorityLive: audit.freezeAuthorityDisabled === false,
        tags: t.tags || [],
      });
    }

    await sleep(JUP_GAP_MS);
  }

  return found;
}

// =====================================================================
// SOURCE 2b: the same authority, asked about size. A quote is the only
// thing that knows whether YOUR amount clears, not just the token.
// =====================================================================
async function quoteOnce(mint, rawAmount) {
  const params = `inputMint=${mint}&outputMint=${USDC}&amount=${rawAmount}&slippageBps=1000`;
  const url = `https://api.jup.ag/swap/v1/quote?${params}`;

  try {
    const res = await fetch(url, { headers: jupHeaders });

    if (res.status === 429) return { status: "ratelimited" };

    if (!res.ok) {
      const body = await res.text();
      // Some errors are verdicts, not failures. Jupiter telling us a pool
      // has not updated in a while is information about the token, so it
      // must not be thrown away as noise the way "not tradable" was.
      if (body.includes("not tradable")) return { status: "untradable" };
      if (body.includes("not been updated")) return { status: "stale" };
      if (body.includes("NO_ROUTES")) return { status: "noroute" };
      return { status: "error", detail: `${res.status} ${body.slice(0, 70)}` };
    }

    const json = await res.json();
    const out = json.outAmount ?? null;
    if (out === null) return { status: "error", detail: "no outAmount field" };

    return { status: "ok", usd: Number(out) / 1e6 };
  } catch (e) {
    return { status: "error", detail: e.message };
  }
}

// Full size first. If that will not clear, find what fraction does.
async function probeExit(token) {
  let calls = 0;

  for (const step of PROBE_STEPS) {
    const amount = step === 1 ? token.raw : token.raw / BigInt(Math.round(1 / step));
    if (amount <= 0n) continue;

    const q = await quoteOnce(token.mint, amount.toString());
    calls++;
    await sleep(JUP_GAP_MS);

    if (q.status === "ok") return { share: step, proceeds: q.usd, calls };
    if (q.status === "untradable") return { share: 0, proceeds: 0, calls, reason: "untradable" };
    if (q.status === "stale") return { share: 0, proceeds: 0, calls, reason: "stale" };
    if (q.status === "ratelimited") return { calls, failed: "rate limited" };
    if (q.status === "error") return { calls, failed: q.detail };
    // noroute, shrink and retry
  }

  return { share: 0, proceeds: 0, calls, reason: "noroute" };
}

// =====================================================================
// SOURCE 3: Helius history. Authority on how the token got here.
// =====================================================================
async function getAcquisition(address) {
  const bought = new Set();
  const gifted = new Set();
  let before = null;
  let scanned = 0;
  const RENT_CEILING = 5000000; // 0.005 SOL, above token account rent

  for (let page = 0; page < HISTORY_PAGES; page++) {
    let url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${API_KEY}&limit=100`;
    if (before) url += `&before=${before}`;

    const res = await fetch(url);
    if (!res.ok) break;

    const txns = await res.json();
    if (!Array.isArray(txns) || txns.length === 0) break;

    for (const tx of txns) {
      scanned++;
      const incoming = (tx.tokenTransfers || []).filter((t) => t.toUserAccount === address && t.mint);
      if (incoming.length === 0) continue;

      const outgoing = (tx.tokenTransfers || []).filter((t) => t.fromUserAccount === address && t.mint);
      const solOut = (tx.nativeTransfers || [])
        .filter((n) => n.fromUserAccount === address)
        .reduce((s, n) => s + Number(n.amount || 0), 0);

      const paid = outgoing.length > 0 || solOut > RENT_CEILING;

      for (const t of incoming) {
        if (paid) bought.add(t.mint);
        else gifted.add(t.mint);
      }
    }

    before = txns[txns.length - 1].signature;
  }

  for (const m of bought) gifted.delete(m);
  return { bought, gifted, scanned };
}

// =====================================================================
// STAGE ONE: facts. No opinions, no labels, no ordering tricks.
// Every position lands in exactly one of these states.
// =====================================================================
const SELLS_FULLY = "SELLS_FULLY";
const SELLS_PARTLY = "SELLS_PARTLY";
const WILL_NOT_SELL = "WILL_NOT_SELL";
const NOT_LISTED = "NOT_LISTED"; // Jupiter's token list has never seen it
const NOT_CHECKED = "NOT_CHECKED"; // we ran out of budget

function sellState(row) {
  if (!row.market) return NOT_LISTED;
  if (row.share === null) return NOT_CHECKED;
  if (row.share === 0) return WILL_NOT_SELL;
  if (row.share < 1) return SELLS_PARTLY;
  return SELLS_FULLY;
}

// =====================================================================
// STAGE TWO: collect every flag, then pick the worst as the headline.
//
// The old version returned on the first match, so a token with four
// problems showed one. Now every check runs and every hit is recorded.
// Higher severity means more urgent. The verdict is the worst flag, the
// rest are shown underneath it.
// =====================================================================
function flagsFor(row) {
  const flags = [];
  const add = (code, severity, why) => flags.push({ code, severity, why });

  const state = row.state;
  const m = row.market;

  // -------------------------------------------------------------------
  // PART A: identity. Runs for every position, always, first.
  //
  // Whether a token impersonates USDC has nothing to do with whether we
  // quoted your size. An earlier version returned early on UNVERIFIED
  // and DEAD, which meant unquoted tokens skipped every identity and
  // token check. Three fake USDCs sat unflagged because of it. No check
  // below is allowed to sit behind a sellability return.
  // -------------------------------------------------------------------
  const sym = (row.symbol || "").toUpperCase().replace(/^\$/, "");
  const known = MAJOR.has(row.mint);

  if (!known && UNIQUE_SYMBOLS.has(sym)) {
    // Only one real one exists, so verification does not rescue this
    add("IMPOSTOR", 90, `calls itself ${row.symbol}, but there is only one real ${sym} and this is not it`);
  } else if (!known && (FAMILY_SYMBOLS.has(sym) || /SOL$/.test(sym))) {
    // A crowded family. Jupiter's verified flag is the backstop here.
    if (row.market && row.market.verified) {
      add("LOOKALIKE", 20, `named like ${sym}, but Jupiter has it verified so it is probably a real staking token`);
    } else if (row.market) {
      add("IMPOSTOR", 90, `named like ${sym}, unverified, and not one of the known staking tokens`);
    } else {
      add("IMPOSTOR", 90, `named like ${sym} and not in Jupiter's token list at all`);
    }
  }

  if (MAJOR.has(row.mint)) {
    if (flags.length === 0) add("SAFE", 0, "major coin");
    return flags;
  }

  // -------------------------------------------------------------------
  // PART B: can you get out. Facts about sellability.
  // -------------------------------------------------------------------
  if (state === NOT_LISTED) {
    // A quote is stronger evidence than the token list. If the list never
    // saw the mint but it actually sold, say that, do not call it dead.
    if (row.share === 1 && row.exit > 0) {
      add("MISPRICED", 45, `sells for ${money(row.exit)} but is not in Jupiter's token list`);
    } else if (row.share === 0) {
      add("DEAD", 100, "no route at any size, and not in Jupiter's token list");
    } else {
      add("DEAD", 100, "Jupiter's token list has never seen this mint");
    }
    return flags; // no market data exists, so nothing else can be checked
  }

  if (state === WILL_NOT_SELL) {
    if (row.reason === "stale") {
      add("STALE", 85, "the pool has not updated in a long time, Jupiter will not price it");
    } else {
      add("DEAD", 100, row.reason === "untradable" ? "Jupiter refuses this token" : "no route at any size");
    }
  } else if (state === SELLS_PARTLY) {
    add("TRAPPED", 95, `only ${Math.round(row.share * 100)}% of it clears, for ${money(row.exit)}`);
  } else if (state === NOT_CHECKED) {
    add("UNVERIFIED", 50, "your size was never quoted, so it counts as zero");
  }

  // Cost of exit only means something once we have a real quote
  if (state === SELLS_FULLY) {
    if (row.paper > 0) {
      const loss = 1 - row.exit / row.paper;
      if (loss > 0.5) add("TRAPPED", 95, `it clears, but you lose ${Math.round(loss * 100)}% doing it`);
      else if (loss > 0.15) add("COSTLY", 80, `selling costs you ${Math.round(loss * 100)}% in slippage`);
      else if (row.exit > row.paper * 1.05) {
        // The quote beats the listed price by more than fees explain, which
        // means the price feed and the route disagree. Not a windfall, a
        // warning that one of the two numbers is wrong.
        add("MISPRICED", 45, `quotes ${money(row.exit)} but the price feed says ${money(row.paper)}`);
      }
    } else if (row.exit > 0) {
      // No listed price at all, yet it routes. Real money, but the paper
      // total does not know about it, so say so instead of staying quiet.
      add("MISPRICED", 45, `quotes ${money(row.exit)} with no listed price behind it`);
    }
  }

  // -------------------------------------------------------------------
  // PART C: what the token is. Runs on every listed position, whatever
  // its sell state, because these are properties of the token itself.
  // -------------------------------------------------------------------
  if (m.liquidity < 500) {
    const amount = m.liquidity > 0 ? `only $${Math.round(m.liquidity)} of liquidity` : "no liquidity reported";
    add("THIN", 75, `${amount} behind it`);
  }

  if (m.mintAuthorityLive) add("RISKY", 70, "the creator can still mint more supply");
  if (m.freezeAuthorityLive) add("RISKY", 70, "the creator can freeze your ability to sell");

  // Who made it. Confirmed on Solscan: a wallet with 69 tokens was tagged
  // Token Creator, held zero SOL and had funded 491 other accounts. But a
  // wallet with 19,812 mints is a bundler service used by many people, so
  // it hides the creator rather than identifying one.
  if (m.devMints >= 2000) {
    add("BUNDLED", 30, `deployed via a service with ${m.devMints} mints, so the creator is hidden`);
  } else if (m.devMints >= 20) {
    add("FACTORY", 65, `the dev has launched ${m.devMints} tokens, ${m.devMigrations} graduated`);
  } else if (m.devMints >= 5) {
    add("SERIAL", 40, `the dev has launched ${m.devMints} tokens before this one`);
  }

  if (m.topHolders >= 50) add("CONTROLLED", 60, `top holders own ${Math.round(m.topHolders)}% of supply`);

  if (m.buys === 0 && m.sells === 0) add("NO_BIDS", 55, "not one trade in 24 hours");
  else if (m.buys === 0) add("NO_BIDS", 55, `${m.sells} sells and zero buys today`);
  else if (m.sells > m.buys * 2 && m.sells + m.buys > 20) {
    add("LEAVING", 45, `${m.sells} sells against ${m.buys} buys today`);
  }

  // HOLLOW was firing on two thirds of every bag in a 36 wallet sample,
  // because almost every memecoin scores low on organic activity. A flag
  // that fires on everything says nothing, so it now needs the score to
  // be actually zero AND something else to be wrong. "Low" alone is the
  // normal state of this market, not news.
  if (m.organicScore === 0 && (m.traders < 10 || m.holders < 500)) {
    add("HOLLOW", 35, `zero organic activity, ${m.traders} traders and ${m.holders} holders`);
  }

  if (m.traders > 0 && m.traders < 5) add("EMPTY", 30, `only ${m.traders} traders touched it today`);

  const age = m.createdAt ? (Date.now() - m.createdAt) / 86400000 : null;
  if (age !== null && age < 3) {
    add("NEW", 25, `pool is only ${age < 1 ? "under a day" : Math.round(age) + " days"} old`);
  }

  if (m.holders > 0 && m.holders < 100) add("TINY", 20, `only ${m.holders} holders exist`);

  // Missing data is not good news
  if (age === null) add("PARTIAL", 15, "pool age unknown, so that check never ran");
  if (m.holders === 0) add("PARTIAL", 15, "holder count unknown, so that check never ran");

  if (flags.length === 0) {
    add("FINE", 0, `clears in full, $${Math.round(m.liquidity)} liquidity, ${m.holders} holders`);
  }

  return flags;
}

function verdictFrom(flags) {
  const worst = flags.reduce((a, b) => (b.severity > a.severity ? b : a), flags[0]);
  return { bucket: worst.code, why: worst.why, flags };
}

function money(n) {
  if (!Number.isFinite(n)) return "n/a";

  const neg = n < 0;
  const v = Math.abs(n);

  // Under a dollar is noise, say so rather than printing 0
  if (v > 0 && v < 1) return neg ? "-<$1" : "<$1";
  if (v === 0) return "$0";

  // No cents above a thousand, nobody reads them, and separators
  // throughout because $2103205.06 is unreadable
  const s = v >= 1000
    ? Math.round(v).toLocaleString("en-US")
    : v.toFixed(2);

  return (neg ? "-$" : "$") + s;
}

// =====================================================================
// RUN
// =====================================================================
async function main() {
  if (!JUP_KEY) {
    say("No JUP_KEY set. This will be slow. Free key at developers.jup.ag/portal\n");
  }

  const held = await getHoldings(wallet);
  const tokens = held.tokens;
  say(`${tokens.length} ${tokens.length === 1 ? "token" : "tokens"} held, read across ${held.pages} ${held.pages === 1 ? "page" : "pages"}`);
  if (held.truncated) {
    say(`WARNING: hit the page cap, so this is not the whole wallet`);
  }

  const marketCalls = Math.ceil(tokens.length / 100);
  say(`Asking Jupiter about all of them, ${marketCalls} ${marketCalls === 1 ? "call" : "calls"}`);

  const [market, acq] = await Promise.all([
    getMarketTruth(tokens.map((t) => t.mint)),
    getAcquisition(wallet),
  ]);

  const listed = tokens.filter((t) => market.has(t.mint)).length;
  say(`${listed} exist in Jupiter's token list, ${tokens.length - listed} are unknown to it`);
  say(`(being listed is not the same as being sellable, only a quote settles that)\n`);

  let rows = tokens.map((t) => {
    const m = market.get(t.mint) || null;
    const paper = m ? t.amount * m.price : 0;

    let origin = "unknown";
    if (acq.bought.has(t.mint)) origin = "bought";
    else if (acq.gifted.has(t.mint)) origin = "airdrop";

    return {
      ...t,
      symbol: m?.symbol || t.fallbackSymbol,
      market: m,
      paper,
      exit: 0,
      share: null,
      reason: null,
      origin,
    };
  });

  // Majors do not need a quote. Asking Jupiter to swap USDC for USDC
  // returns an error, and a stablecoin is worth its face value anyway.
  for (const r of rows) {
    if (!MAJOR.has(r.mint)) continue;
    r.share = 1;
    r.exit = STABLES.has(r.mint) ? r.amount : r.paper * 0.999;
  }

  // Quotes go to the biggest non-major positions. Anything not reached
  // stays UNVERIFIED rather than being quietly assumed fine.
  //
  // SECOND FIX: a position with no listed price used to be invisible.
  // Everything keyed off paper = amount * price, so a zero price meant
  // zero paper, which meant it failed the dust threshold, never got
  // quoted, and never reached the flag logic. A token with a real pool
  // and no price feed was simply not mentioned. One test wallet held a
  // token showing $0 that quoted for $3.49, and it only surfaced because
  // its price happened to be slightly above zero.
  //
  // So unpriced positions with liquidity behind them now get quoted too,
  // and the quote decides whether they are real.
  const priced = rows.filter((r) => r.market && !MAJOR.has(r.mint) && r.paper >= DUST_USD);

  // "No listed price" means the price is actually missing, not that the
  // paper value is small. My first attempt used paper < $1, which also
  // caught every tiny balance of a normally priced token: 473 of 1436
  // positions on one wallet, almost none of them genuinely unpriced.
  const unpriced = rows.filter(
    (r) => r.market && !MAJOR.has(r.mint) && !(r.market.price > 0) && r.market.liquidity >= 500
  );

  // Reserve a token amount of budget, not a quarter of it.
  //
  // At 25% this spent 7 quotes on unpriced positions, 6 of which came
  // back "will not sell". Meanwhile three priced positions worth $250
  // each, previously confirmed dead, went unchecked because the budget
  // ran out. That is paying to prove worthless things are worthless
  // while giving up real findings.
  //
  // The sample answered the question: a pool with no price is almost
  // always unsellable. So spot-check two, report the rest as a group,
  // and spend the budget where the money is.
  // Keep mints, not object references. The rows array gets replaced by a
  // .map() further down, so anything holding the old objects is left with
  // copies that never receive their state. That made a 2-position spot
  // check report itself as 95.
  const unpricedMints = new Set(unpriced.map((r) => r.mint));

  const RESERVED = Math.min(unpriced.length, 2);
  const mainBudget = Math.max(1, QUOTE_MAX - RESERVED);

  const targets = [
    ...priced.sort((a, b) => b.paper - a.paper).slice(0, mainBudget),
    // pool depth is the only ranking available with no price to sort by
    ...unpriced.sort((a, b) => b.market.liquidity - a.market.liquidity).slice(0, RESERVED),
  ];

  if (unpriced.length > 0) {
    say(`${unpriced.length} ${unpriced.length === 1 ? "position has" : "positions have"} a pool but no price. Spot-checking ${RESERVED}.`);
  }

  if (targets.length > 0) {
    say(targets.length === 1
      ? `Checking the real exit for 1 position\n`
      : `Checking real exits for the top ${targets.length} positions\n`);
    let used = 0;

    for (const r of targets) {
      const p = await probeExit(r);
      used += p.calls;

      if (p.failed) {
        say(`  ${r.symbol.padEnd(14)} could not check: ${p.failed}`);
        continue;
      }

      r.share = p.share;
      r.exit = p.proceeds;
      r.reason = p.reason || null;

      let note;
      if (p.share === 0) note = "will not sell";
      else if (p.share < 1) note = `${money(p.proceeds)} for ${Math.round(p.share * 100)}% of it`;
      else note = money(p.proceeds);
      say(`  ${r.symbol.padEnd(14)} ${note}`);
    }

    say(`\n${used} quote ${used === 1 ? "request" : "requests"} used`);
  }

  // facts, then flags, then the headline verdict
  rows = rows.map((r) => {
    const withState = { ...r, state: sellState(r) };
    return { ...withState, ...verdictFrom(flagsFor(withState)) };
  });

  // Worth is the better of the listed price and the actual quote. Using
  // paper alone hid every position the price feed did not cover.
  for (const r of rows) r.worth = Math.max(r.paper, r.exit || 0);

  const spam = rows.filter((r) => r.origin === "airdrop" && r.worth < DUST_USD);
  const rest = rows.filter((r) => !spam.includes(r));
  const real = rest.filter((r) => r.worth >= DUST_USD);
  const dust = rest.filter((r) => r.worth < DUST_USD);

  const paperTotal = real.reduce((s, r) => s + r.worth, 0);

  // THE FIX THAT MATTERED MOST.
  //
  // The old headline divided proven exit by the paper value of every
  // position, including ones that were never quoted. An unquoted position
  // put its full paper value in the denominator and nothing in the
  // numerator, so it was reported as a total loss.
  //
  // One sampled wallet had 15 positions, 9 quoted, 6 unchecked, and was
  // told "9% of your money is not real". Some of that 9% was not money
  // vanishing on the way out, it was money nobody looked at. Two
  // different facts added together and presented as one.
  //
  // So the loss is now measured only across what was actually checked,
  // and coverage is reported separately.
  const checked = real.filter((r) => r.state === SELLS_FULLY || r.state === SELLS_PARTLY);
  const checkedPaper = checked.reduce((s, r) => s + r.worth, 0);
  const provenTotal = checked.reduce((s, r) => s + r.exit, 0);

  const unchecked = real.filter((r) => r.state !== SELLS_FULLY && r.state !== SELLS_PARTLY);
  const uncheckedPaper = unchecked.reduce((s, r) => s + r.worth, 0);
  const coverage = paperTotal > 0 ? checkedPaper / paperTotal : 1;

  // ===================================================================
  // OUTPUT
  // ===================================================================
  if (AS_JSON) {
    const flagCounts = {};
    for (const r of real) {
      for (const f of r.flags) {
        flagCounts[f.code] = (flagCounts[f.code] || 0) + 1;
      }
    }
    process.stdout.write(JSON.stringify({
      wallet,
      tokensHeld: tokens.length,
      positions: real.length,
      spam: spam.length,
      dust: dust.length,
      paper: Math.round(paperTotal * 100) / 100,
      checkedPaper: Math.round(checkedPaper * 100) / 100,
      proven: Math.round(provenTotal * 100) / 100,
      uncheckedPaper: Math.round(uncheckedPaper * 100) / 100,
      coverage: Math.round(coverage * 1000) / 1000,
      quoted: checked.length,
      unchecked: unchecked.length,
      flagCounts,
      worst: checked
        .map((r) => ({ symbol: r.symbol, paper: r.paper, worth: r.worth, exit: r.exit }))
        .sort((a, b) => (b.paper - b.exit) - (a.paper - a.exit))
        .slice(0, 3),
    }) + "\n");
    return;
  }

  // Default is a short summary. The full per-position dump is 400 lines
  // on a big wallet, which nobody reads, so it lives behind --all.
  // ===================================================================
  const wantAll = process.argv.includes("--all");

  const gone = checkedPaper > 0 ? Math.round((1 - provenTotal / checkedPaper) * 100) : 0;
  const short = wallet.slice(0, 4) + "..." + wallet.slice(-4);

  say(`\nBag Check  ${short}`);
  const bits = [`${real.length} real ${real.length === 1 ? "position" : "positions"}`];
  if (spam.length > 0) bits.push(`${spam.length} spam airdrops`);
  if (dust.length > 0) bits.push(`${dust.length} worthless leftovers`);
  const breakdown = bits.join(", ");

  // Two different headlines, because two different things are true.
  //
  // Slippage only bites when your position is large relative to the pool.
  // Across 12 sampled normal wallets the median shortfall was 1%, so
  // leading with "X is not real" on a $100 bag says nothing. What IS
  // true of every wallet is that most of what it holds is junk: one
  // sample held 46 tokens of which 1 was worth over a dollar.
  //
  // So: big shortfall leads with the money. Otherwise lead with the junk.
  const shortfall = checkedPaper - provenTotal;
  const junkCount = tokens.length - real.length;
  const bigGap = checkedPaper > 0 && shortfall / checkedPaper > 0.1 && shortfall > 50;

  if (bigGap) {
    say(breakdown + "\n");
    say(`Checked positions worth: ${money(checkedPaper)}`);
    say(`You can actually get:    ${money(provenTotal)}`);
    say(`Not real:                ${money(shortfall)}  (${gone}%)\n`);
  } else {
    if (junkCount > 0 && tokens.length > 0) {
      const pct = Math.round((junkCount / tokens.length) * 100);
      say(`You hold ${tokens.length} tokens. ${real.length} of them ${real.length === 1 ? "is" : "are"} worth more than a dollar.`);
      say(`The other ${junkCount} (${pct}%) are spam or dead.\n`);
    }
    say(`Worth:          ${money(paperTotal)}`);
    say(`You can get:    ${money(provenTotal)}`);
    if (provenTotal > checkedPaper) {
      say(`Extra found:    ${money(provenTotal - checkedPaper)}  (quotes beat the price feed)\n`);
    } else if (shortfall > 0.5) {
      say(`Lost to selling: ${money(shortfall)}  (${Math.max(gone, 0)}%)\n`);
    } else {
      say(`It all sells cleanly.\n`);
    }
  }

  // The unpriced group, reported as a group rather than quoted one by one
  if (unpricedMints.size > 0) {
    // read off the current rows, which actually carry state
    const group = rows.filter((r) => unpricedMints.has(r.mint));
    const sampled = group.filter((r) => r.share !== null && r.share !== undefined);
    const unsellable = sampled.filter((r) => r.share === 0).length;

    if (sampled.length > 0) {
      say(`${group.length} positions have a pool but no listed price. Of the ${sampled.length} spot-checked, ${unsellable} could not be sold. The rest are unchecked, so treat them as worth nothing until proven otherwise.\n`);
    } else {
      say(`${group.length} positions have a pool but no listed price, and none were checked this run.\n`);
    }
  }

  // Coverage is its own fact, never folded into the loss figure
  if (coverage < 0.99 && uncheckedPaper > 0.5) {
    say(`Coverage: ${Math.round(coverage * 100)}% of the value was quoted. ${money(uncheckedPaper)} across ${unchecked.length} ${unchecked.length === 1 ? "position" : "positions"} was not checked, so it is not in either number above.\n`);
  }

  // The five positions losing the most money, which is the whole story
  const quoted = real.filter((r) => r.state === SELLS_FULLY || r.state === SELLS_PARTLY);
  const byGap = quoted
    .map((r) => ({ ...r, gap: r.paper - r.exit, pct: r.paper > 0 ? (r.paper - r.exit) / r.paper : 0 }))
    .filter((r) => r.gap > 1 && r.pct > 0.05) // under 5% is ordinary slippage, not a story
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 5);

  if (byGap.length > 1) {
    say("Where the money goes:");
    for (const r of byGap) {
      say(`  ${r.symbol.padEnd(12)} ${money(r.paper).padEnd(12)} becomes ${money(r.exit).padEnd(12)} lose ${Math.round(r.pct * 100)}%`);
    }
    say("");
  }

  // One line per flag that matters, with money attached
  const headline = [
    ["DEAD", "cannot be sold at all"],
    ["IMPOSTOR", "pretending to be a major coin"],
    ["TRAPPED", "only partly sellable"],
    ["STALE", "sitting in a pool nobody has touched in ages"],
    ["FACTORY", "made by a dev who launches hundreds of tokens"],
    ["NO_BIDS", "nobody traded them today"],
    ["THIN", "almost no liquidity left"],
  ];

  const problems = [];
  for (const [code, text] of headline) {
    const hits = real.filter((r) => r.flags.some((f) => f.code === code));
    if (hits.length === 0) continue;
    const worthSum = hits.reduce((s, r) => s + r.worth, 0);
    problems.push(`  ${String(hits.length).padStart(4)} ${text}, ${money(worthSum)} of value`);
  }

  // Not a problem with the bag, a limit of the check. It lives in the
  // coverage line above, not in the list of things wrong with the wallet.

  // An empty header reads like the tool broke, so only print one when
  // there is something under it
  if (problems.length > 0) {
    say("What is wrong with this bag:");
    for (const line of problems) say(line);
  } else {
    say("Nothing flagged. Everything here has a working market.");
  }

  // Only worth a headline when the gap is real and the table did not
  // already say it on a line of its own
  if (byGap.length === 1) {
    const w = byGap[0];
    say(`\n${w.symbol} shows ${money(w.paper)} and exits for ${money(w.exit)}. ${money(w.gap)} of it is not money you have.`);
  } else if (byGap.length > 1) {
    const w = byGap[0];
    say(`\nWorst: ${w.symbol} shows ${money(w.paper)} and exits for ${money(w.exit)}. ${money(w.gap)} that does not exist.`);
  }

  if (!wantAll) {
    say(`\nRun with --all to see every position and every flag.\n`);
    return;
  }

  // ------------------------- full dump -------------------------
  const order = [
    "DEAD", "TRAPPED", "IMPOSTOR", "STALE", "COSTLY", "THIN", "RISKY", "FACTORY", "CONTROLLED",
    "NO_BIDS", "LEAVING", "SERIAL", "HOLLOW", "EMPTY", "BUNDLED", "NEW", "TINY",
    "MISPRICED", "LOOKALIKE", "UNVERIFIED", "PARTIAL", "FINE", "SAFE",
  ];
  real.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || b.paper - a.paper);

  say("\nverdict     token          says      you get    problems");
  for (const r of real) {
    const tag = r.origin === "airdrop" ? " [airdropped]" : "";
    const got = r.state === NOT_CHECKED ? "?" : money(r.exit);
    const clean = r.bucket === "FINE" || r.bucket === "SAFE";
    const codes = clean ? r.why : r.flags.slice().sort((a, b) => b.severity - a.severity).map((f) => f.code).join(" ");
    say(
      `${r.bucket.padEnd(11)} ${r.symbol.padEnd(14)} ${money(r.worth).padEnd(9)} ${got.padEnd(10)} ${codes}${tag}`
    );
  }

  const tally = new Map();
  for (const r of real) {
    for (const f of r.flags) {
      if (f.code === "FINE" || f.code === "SAFE") continue;
      tally.set(f.code, (tally.get(f.code) || 0) + 1);
    }
  }
  if (tally.size > 0) {
    say("\nFlag counts:");
    for (const [code, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      say(`  ${code.padEnd(12)} ${n}`);
    }
  }
  say("");
}

main().catch((err) => {
  console.error("\nFailed:", err.message, "\n");
  process.exitCode = 1;
});

/*
HOW THE VERDICT WORKS
Every check runs on every position and records a flag with a severity.
The headline verdict is the worst flag. The rest print underneath, so a
token with four problems shows four, not one. An earlier version returned
on the first match and hid the rest.

THE FLAGS, worst first
DEAD       - Jupiter will not trade it, at any size. No exit.
TRAPPED    - only part of it clears, or over half the value evaporates.
IMPOSTOR   - wears the symbol of a major coin without being it. One test
             wallet held three different tokens calling themselves USDC.
STALE      - Jupiter refused to price it because the pool has not been
             updated in a long time. Arrived as an HTTP 500, but it is a
             verdict about the token, not a failure of the check.
COSTLY     - clears, but slippage takes 15% or more.
THIN       - under $500 of liquidity, or none reported.
RISKY      - the creator can still mint supply, or freeze your selling.
FACTORY    - the dev has launched 20 or more tokens. This is their job.
CONTROLLED - top holders own half or more of the supply.
NO_BIDS    - zero buys today, or no trades at all.
LEAVING    - sells running well ahead of buys.
MISPRICED  - the quote and the price feed disagree, or it sells with no
             listed price at all. One of the two numbers is wrong, so do
             not trust either without checking.
SERIAL     - the dev has 5 to 19 previous tokens.
BUNDLED    - deployed through a service with thousands of mints, so the
             real creator is hidden. Not a verdict on the token itself.
HOLLOW     - Jupiter rates real activity as zero or low, so the volume
             is probably wash trading.
EMPTY      - fewer than 5 traders touched it today.
NEW        - pool under 3 days old.
TINY       - fewer than 100 holders.
UNVERIFIED - tradable, but your size was never quoted. Counted as zero.
PARTIAL    - a check could not run because the data was absent.
FINE       - clears in full and not one flag fired.
SAFE       - major coin.

THE RULE THAT KILLED THE BUG FAMILY
Missing data is not good news. Checks used to skip themselves when a
field was absent, and skipping meant falling through to FINE. Every
version of the same bug came from that.

The other half of it: Jupiter omits zero-value fields rather than
sending zero. Reading absent as unknown turned "nobody bought this
today" into a shrug. Absent is now read as zero, which is what it is.

WHY THE HEADLINE COUNTS UNVERIFIED AS ZERO
Because the old version's failure mode was always overstating. A number
that only counts proven exits can disappoint on the upside, which is the
safe direction to be wrong in.

HONEST LIMITS
1. Holdings now page properly, up to 20,000 tokens. If the cap is hit
   the output says so instead of quietly reporting a fraction.
2. History is 500 transactions, so older buys read as unknown.
3. Only the top 30 positions by paper value get exit quotes. Everything
   else stays UNVERIFIED and counts as zero.
4. A quote is not a fill. Execution can still be worse.
*/
