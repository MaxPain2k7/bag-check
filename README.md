# Bag Check

Shows what a Solana wallet is **actually** worth if you tried to sell it.

Every wallet app multiplies your balance by the last traded price. That number is fine for SOL. For a coin sitting in a $400 pool it is fiction. Bag Check asks the exchange for a real quote on your real position size, then reports what came back.

## What it found

Running it on one wallet holding 1,436 tokens:

```
Checked positions worth: $2,707,025
You can actually get:    $1,837,680
Not real:                $869,345  (32%)

Worst: CATE shows $2,051,643 and exits for $1,289,451.
       $762,193 that does not exist.
```

Across 76 sampled wallets, roughly 70 to 94% of tokens people hold had no working market at all. The spread is wide because each sampling method was biased differently — see the honest limits below.

## The three scripts

| Script | What it does |
| --- | --- |
| `bag-check.js` | Reads one wallet, quotes every real position, reports 20 problem types |
| `calibrate.js` | Samples random wallets and reports how often each flag fires |
| `get-holders.js` | Pulls holder addresses for a token, to find wallets to test |

## Setup

Needs Node 18 or newer.

```bash
# free key from helius.dev
set HELIUS_KEY=your_key_here

# free key from developers.jup.ago/portal (optional, but 2x faster)
set JUP_KEY=your_key_here
```

On Mac or Linux use `export` instead of `set`.

## Usage

```bash
# check one wallet
node bag-check.js <wallet-address>

# every position and every flag
node bag-check.js <wallet-address> --all

# machine readable, for scripts
node bag-check.js <wallet-address> --json

# see exactly what Jupiter returned for one token
node bag-check.js <wallet-address> --raw SYMBOL

# sample 30 random wallets and score the flags
node calibrate.js 30

# sample by token holders instead of by block (biased, kept for comparison)
node calibrate.js 30 --by-token

# find wallets holding a token
node get-holders.js <mint-address>
```

## How it decides

Two sources, one question each. Mixing them was the original bug.

- **Helius** — what the wallet holds, and how each token got there. Nothing else.
- **Jupiter tokens API** — market data: price, liquidity, holders, audit flags.
- **Jupiter quote API** — whether your exact size actually sells. This is the only authority on that. Being listed in the token list proves nothing.

Then two stages, kept separate on purpose:

1. **Facts.** Every position lands in exactly one state: sells fully, sells partly, will not sell, not listed, not checked.
2. **Flags.** Every check runs and records a flag with a severity. The headline verdict is the worst one; the rest print underneath.

## The flags

| Flag | Meaning |
| --- | --- |
| `DEAD` | Jupiter will not trade it at any size |
| `TRAPPED` | Only part of it clears, or over half the value evaporates |
| `IMPOSTOR` | Wears a major coin's symbol without being it |
| `STALE` | Pool has not updated in a long time |
| `COSTLY` | Clears, but slippage takes 15% or more |
| `THIN` | Under $500 of liquidity, or none reported |
| `RISKY` | Creator can still mint supply or freeze your selling |
| `FACTORY` | The dev has launched 20 or more tokens |
| `CONTROLLED` | Top holders own half or more of supply |
| `NO_BIDS` | Zero buys today, or no trades at all |
| `LEAVING` | Sells running well ahead of buys |
| `MISPRICED` | The quote and the price feed disagree |
| `SERIAL` | The dev has 5 to 19 previous tokens |
| `BUNDLED` | Deployed through a service with thousands of mints |
| `HOLLOW` | Zero organic activity and thin participation |
| `EMPTY` | Fewer than 5 traders touched it today |
| `NEW` | Pool under 3 days old |
| `TINY` | Fewer than 100 holders |
| `UNVERIFIED` | Tradable, but your size was never quoted. Counts as zero |
| `PARTIAL` | A check could not run because the data was absent |
| `FINE` | Clears in full and not one flag fired |
| `SAFE` | Major coin |

## Two rules the code is built around

**Missing data is not good news.** Checks used to skip themselves when a field was absent, and skipping meant falling through to `FINE`. Several versions of the same bug came from that. Absence now produces its own label.

**Jupiter omits zero-value fields.** A token came back with `numSells: 1` and no `numBuys` at all, meaning zero buys. Reading absent as unknown turned "nobody bought this today" into a shrug.

## Honest limits

1. Holdings page up to 20,000 tokens. If the cap is hit the output says so.
2. Transaction history is 500 deep, so older buys read as unknown rather than bought.
3. Only the top 30 positions by value get real quotes. Everything else stays `UNVERIFIED` and counts as zero.
4. A quote is not a fill. Real execution can be worse.
5. Every threshold in here was chosen by hand, not derived from data. $500 liquidity, 20 dev mints, 15% slippage, 3 days old — all judgement calls that survived review, not measurements.
6. `calibrate.js` has been through two sampling methods and both were biased. Launch feeds returned only holders of brand new tokens. Block fee payers returned mostly bots and protocol accounts. Treat population figures as a range, not a number.

## Not financial advice

This is a tool for inspecting public blockchain data. It does not tell you what to buy or sell. Nothing here is financial advice.

Never share a seed phrase or private key with anyone, including any tool in this repo. Bag Check only ever needs a public wallet address.
