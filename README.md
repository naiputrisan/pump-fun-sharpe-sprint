# pump-fun-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/naiputrisan/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/naiputrisan/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for pump.fun that chases the Sharpe ratio, not the biggest win. It snipes young coins: buy a coin in its first ~8 minutes when recent flow is buyer-dominated (≥65% buy share) and the price has barely moved yet (0–10% over the last ~150 slots), with a small ticket of at most 0.02 SOL — sized down to 0.8% of the coin's real reserves so orders are never rejected for exceeding the harness cap, and never below 0.012 SOL so every round trip clears the 0.01 SOL qualifying bar. Exits bank a double (+100%), stop at -3%, trail 5% below the peak once the peak is +5% or better, or age out after ~24 minutes. Never more than 5 open positions, never a re-buy within 240 slots of an exit, and every decision is a deterministic function of the replayed events, so two runs agree exactly.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: it reads the harness `hello`, answers each `batch` with one reply line echoing its `seq` and carrying that batch's `orders`, and exits on `done`. Paper trading only — no real funds, no network calls.

---

<sub>Entered on [make.fun](https://make.fun/?ref=naiputrisan&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
