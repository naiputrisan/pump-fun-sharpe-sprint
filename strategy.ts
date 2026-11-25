// strategy.ts — Sharpe-first paper-trading rules for the pump.fun replay.
//
// Idea: most new pump.fun coins bleed out, so the edge (if any) is
// sniping the few that run: buy young coins with strong early buy flow,
// keep every ticket cheap (0.02 SOL), cap every loss hard (-5%), and let
// winners run — bank a double, otherwise trail 8% below the peak. Small,
// frequent, diversified tickets across many mints clear the 20-mint bar
// while no single coin can decide the Sharpe ratio.
//
// Deterministic by construction: every decision is a pure function of the
// replayed events, marks, fills and the batch slot. No wall clock, no
// unseeded randomness, no network calls.

export interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

export interface PositionView {
  mint: string;
  tokenAmount: bigint;
  costLamports: bigint;
}

// ---- Tunable rules (kept deliberately un-tuned: robust, not fitted) ----
export const RULES = {
  // One buy per coin: up to 0.02 SOL, but never more than 0.8% of the
  // coin's real reserves — the harness caps an order at 1% of real
  // reserves, and an oversized order is rejected outright. The floor of
  // 0.012 SOL keeps every round trip above the 0.01 SOL qualifying bar
  // with margin. Small size buys many lottery tickets on young coins.
  buyLamportsMax: 20_000_000n,
  buyLamportsMin: 12_000_000n,
  sizeBpsOfReserve: 80,
  // Entry (sniper): a coin in its first ~8 minutes with strong early buy
  // flow, bought BEFORE it has moved much — the run, if it comes, is
  // still ahead of us. Most new coins die; the edge is catching the few
  // that run, so entries are cheap and frequent and exits let winners run.
  minMomentum: 0.0,
  maxMomentum: 0.10,
  minSinceLaunch: 0.0,
  maxAgeSlots: 1200,
  lookbackSlots: 150,
  minTradesSeen: 8,
  minObserveSlots: 20,
  minBuyShare: 0.65,
  minRealQuoteLamports: 1_250_000_000n, // >= 1.25 SOL of real reserves
  // Exits: bank a double (+100%), stop at -5%, trail 8% below the peak
  // once the peak is +5% or better, or age out after ~24 minutes.
  takeProfit: 1.0,
  stopLoss: -0.03,
  trailingPullback: 0.05,
  trailingArm: 0.05,
  maxHoldSlots: 3600,
  // Do not re-buy a coin we just exited for a while; let it prove itself.
  rebuyCooldownSlots: 240,
  maxSlippageBps: 100,
};

interface CoinState {
  firstSlot: number;
  lastSlot: number;
  lastPrice: number; // lamports of SOL per whole token, from reserves ratio
  samples: Array<{ slot: number; price: number }>;
  peakPrice: number;
  buySol: number; // lamports of buy volume inside the lookback window
  sellSol: number;
  trades: number;
  flow: Array<{ slot: number; signedSol: number; isBuy: boolean }>;
  completed: boolean;
  everTraded: boolean;
}

interface HeldState {
  entrySlot: number;
  entryPrice: number;
  peakPrice: number;
}

function priceFromReserves(virtualQuote: string, virtualToken: string): number {
  const q = Number(BigInt(virtualQuote));
  const t = Number(BigInt(virtualToken));
  if (t <= 0 || q <= 0) return 0;
  return q / t;
}

export class SharpeBot {
  private readonly maxOpen: number;

  constructor(maxOpenPositions = 5) {
    this.maxOpen = maxOpenPositions;
  }

  private coins = new Map<string, CoinState>();
  private held = new Map<string, HeldState>();
  private lastExitSlot = new Map<string, number>();
  private orderCounter = 0;

  private coinFor(mint: string, slot: number): CoinState {
    let c = this.coins.get(mint);
    if (!c) {
      c = {
        firstSlot: slot,
        lastSlot: slot,
        lastPrice: 0,
        samples: [],
        peakPrice: 0,
        buySol: 0,
        sellSol: 0,
        trades: 0,
        flow: [],
        completed: false,
        everTraded: false,
      };
      this.coins.set(mint, c);
    }
    return c;
  }

  private notePrice(c: CoinState, slot: number, price: number): void {
    if (price <= 0) return;
    c.lastPrice = price;
    c.lastSlot = slot;
    if (price > c.peakPrice) c.peakPrice = price;
    const last = c.samples[c.samples.length - 1];
    if (!last || slot - last.slot >= 2) {
      c.samples.push({ slot, price });
      if (c.samples.length > 400) c.samples.splice(0, c.samples.length - 400);
    } else {
      last.price = price;
      last.slot = slot;
    }
  }

  private priceAt(c: CoinState, slot: number): number {
    // Oldest retained sample at or before the target slot.
    let best = 0;
    for (const s of c.samples) {
      if (s.slot <= slot) best = s.price;
      else break;
    }
    return best;
  }

  private pruneFlow(c: CoinState, slot: number): void {
    const cut = slot - RULES.lookbackSlots;
    while (c.flow.length > 0 && c.flow[0].slot < cut) {
      const f = c.flow.shift()!;
      if (f.isBuy) c.buySol -= f.signedSol;
      else c.sellSol -= f.signedSol;
    }
  }

  /** Feed one batch of harness events into the coin book. */
  observe(batch: any): void {
    const slot: number = batch.slot;
    for (const ev of batch.events ?? []) {
      if (ev.event === "CompleteEvent") {
        const c = this.coinFor(ev.mint, slot);
        c.completed = true;
        continue;
      }
      if (ev.event === "CreateEvent") {
        const c = this.coinFor(ev.mint, slot);
        const p = priceFromReserves(ev.virtual_quote_reserves, ev.virtual_token_reserves);
        this.notePrice(c, slot, p);
        continue;
      }
      if (ev.event !== "TradeEvent") continue;
      const c = this.coinFor(ev.mint, slot);
      c.trades += 1;
      const sol = Number(BigInt(ev.sol_amount));
      c.flow.push({ slot, signedSol: sol, isBuy: ev.is_buy });
      if (ev.is_buy) c.buySol += sol;
      else c.sellSol += sol;
      const p = priceFromReserves(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      this.notePrice(c, slot, p);
      this.pruneFlow(c, slot);
      // The harness sends no marks, so the trade itself is the only fresh
      // read of a coin's real reserves: use it for the liquidity filter.
      (c as any).realQuote = BigInt(ev.real_sol_reserves);
    }
    // Marks are the freshest reserve snapshot for every live mint.
    for (const m of batch.marks ?? []) {
      const c = this.coinFor(m.mint, slot);
      const p = priceFromReserves(m.virtual_quote_reserves, m.virtual_token_reserves);
      this.notePrice(c, slot, p);
      // Keep a rough reserve read for the liquidity filter.
      (c as any).realQuote = BigInt(m.real_quote_reserves);
    }
  }

  /** Decide this batch's orders. Positions come from the harness account. */
  decide(batch: any): Order[] {
    const slot: number = batch.slot;
    const orders: Order[] = [];
    const positions: PositionView[] = (batch.account?.positions ?? []).map((p: any) => ({
      mint: p.mint,
      tokenAmount: BigInt(p.token_amount),
      costLamports: BigInt(p.cost_lamports),
    }));
    const heldMints = new Set(positions.map((p) => p.mint));

    // Reconcile held-state bookkeeping with the harness account.
    for (const mint of [...this.held.keys()]) {
      if (!heldMints.has(mint)) {
        this.held.delete(mint);
        this.lastExitSlot.set(mint, slot);
      }
    }
    for (const p of positions) {
      let h = this.held.get(p.mint);
      if (!h) {
        const entryPrice =
          p.tokenAmount > 0n ? Number(p.costLamports) / Number(p.tokenAmount) : 0;
        h = { entrySlot: slot, entryPrice, peakPrice: entryPrice };
        this.held.set(p.mint, h);
      }
      const c = this.coins.get(p.mint);
      if (c && c.lastPrice > h.peakPrice) h.peakPrice = c.lastPrice;
    }

    // --- Exits first: protect capital before opening anything new. ---
    for (const p of positions) {
      const c = this.coins.get(p.mint);
      const h = this.held.get(p.mint)!;
      const price = c?.lastPrice ?? 0;
      if (price <= 0) continue;
      const ret = h.entryPrice > 0 ? price / h.entryPrice - 1 : 0;
      const peakRet = h.entryPrice > 0 ? h.peakPrice / h.entryPrice - 1 : 0;
      const pullback = h.peakPrice > 0 ? price / h.peakPrice - 1 : 0;
      const agedOut = slot - h.entrySlot >= RULES.maxHoldSlots;
      const shouldSell =
        ret >= RULES.takeProfit ||
        ret <= RULES.stopLoss ||
        (peakRet >= RULES.trailingArm && pullback <= -RULES.trailingPullback) ||
        agedOut ||
        (c?.completed ?? false);
      if (shouldSell && p.tokenAmount > 0n) {
        orders.push({
          side: "sell",
          client_id: this.nextId("s", slot),
          mint: p.mint,
          token_amount: p.tokenAmount.toString(),
          max_slippage_bps: RULES.maxSlippageBps,
        });
      }
    }

    // --- Entries: only while a slot is free, smallest and steadiest first. ---
    const openAfterExits = positions.length - orders.filter((o) => o.side === "sell").length;
    const freeSlots = this.maxOpen - openAfterExits;
    if (freeSlots > 0) {
      const candidates: Array<{ mint: string; momentum: number; fresh: boolean; size: bigint }> = [];
      for (const [mint, c] of this.coins) {
        if (c.completed) continue;
        // A coin that has not traded in ~5000 slots is dead for our
        // purposes; skipping it keeps the per-batch scan cheap and stops
        // stale coins from ever being reconsidered.
        if (slot - c.lastSlot > 5000) continue;
        if (heldMints.has(mint)) continue;
        if (c.trades < RULES.minTradesSeen) continue;
        if (slot - c.firstSlot < RULES.minObserveSlots) continue;
        const lastExit = this.lastExitSlot.get(mint);
        if (lastExit !== undefined && slot - lastExit < RULES.rebuyCooldownSlots) continue;
        const realQuote = (c as any).realQuote as bigint | undefined;
        if (realQuote === undefined || realQuote < RULES.minRealQuoteLamports) continue;
        const old = this.priceAt(c, slot - RULES.lookbackSlots);
        if (old <= 0 || c.lastPrice <= 0) continue;
        const momentum = c.lastPrice / old - 1;
        if (momentum < RULES.minMomentum || momentum > RULES.maxMomentum) continue;
        // Since launch: up from its first-seen price, so this is a coin
        // with early buyers behind it, not one drifting sideways.
        const first = c.samples[0];
        if (!first || first.price <= 0 || c.lastPrice / first.price - 1 < RULES.minSinceLaunch) continue;
        // Fresh coins only: a pop on an old coin is usually a dead bounce.
        if (slot - c.firstSlot > RULES.maxAgeSlots) continue;
        const buy = c.buySol;
        const sell = c.sellSol;
        if (buy + sell <= 0) continue;
        if (buy / (buy + sell) < RULES.minBuyShare) continue;
        // Size to the coin's real reserves so the order is never rejected
        // for exceeding 1% of reserves, and never below the qualifying bar.
        const capped =
          (realQuote * BigInt(RULES.sizeBpsOfReserve)) / 10_000n;
        const size =
          capped > RULES.buyLamportsMax ? RULES.buyLamportsMax : capped;
        if (size < RULES.buyLamportsMin) continue;
        candidates.push({ mint, momentum, fresh: !c.everTraded, size });
      }
      // Spread across new coins first (clears the 20-mint bar safely), then
      // strongest modest momentum. Deterministic tie-break on mint string.
      candidates.sort((a, b) => {
        if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
        if (b.momentum !== a.momentum) return b.momentum - a.momentum;
        return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
      });
      for (const cand of candidates.slice(0, freeSlots)) {
        orders.push({
          side: "buy",
          client_id: this.nextId("b", slot),
          mint: cand.mint,
          quote_lamports: cand.size.toString(),
          max_slippage_bps: RULES.maxSlippageBps,
        });
        const c = this.coins.get(cand.mint)!;
        c.everTraded = true;
      }
    }

    return orders.slice(0, 16);
  }

  private nextId(kind: string, slot: number): string {
    this.orderCounter += 1;
    return `${kind}${slot}-${this.orderCounter}`;
  }
}
