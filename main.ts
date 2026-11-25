// main.ts — pump.fun paper-trading bot for the Sharpe sprint.
//
// Protocol: agent-fun/replay/v2, NDJSON over stdin/stdout. The harness
// sends one `hello` line, then a `batch` line per step, then `done`.
// This bot answers every `batch` with exactly one reply line echoing the
// batch's seq and carrying that batch's orders. It never replies to the
// hello line and it exits cleanly on `done`.
//
// Every decision lives in strategy.ts; this file only owns the wire
// protocol: reading lines, parsing JSON, and writing replies. It makes no
// network calls and keeps no wall-clock state, so two runs on the same
// replay agree byte for byte.

import { createInterface } from "node:readline";
import { SharpeBot } from "./strategy.ts";

// The bot is created once the harness hello arrives, so the position cap
// it enforces is the one the harness announced, not a guess.
let bot: SharpeBot | null = null;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  const text = line.trim();
  if (text.length === 0) continue;
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    continue;
  }
  if (msg.type === "hello") {
    // Take the session's caps from the hello message.
    const cap =
      msg.caps && typeof msg.caps.max_open_positions === "number"
        ? msg.caps.max_open_positions
        : 5;
    bot = new SharpeBot(cap);
    continue;
  }
  if (msg.type === "batch") {
    // A batch carries the events since the last one, fresh marks for the
    // live mints, our fills, and the authoritative account snapshot.
    // The bot observes the batch, then answers with one reply line that
    // echoes this batch's seq and holds this batch's orders. A batch
    // before any hello is answered empty, as there is no bot yet.
    if (bot === null) {
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders: [] }) + "\n",
      );
      continue;
    }
    bot.observe(msg);
    const orders = bot.decide(msg);
    const reply = { type: "reply", seq: msg.seq, orders };
    process.stdout.write(JSON.stringify(reply) + "\n");
    continue;
  }
  if (msg.type === "done") {
    break;
  }
  // Any other message type is ignored: the protocol only defines hello,
  // batch and done, and an unknown line must never crash the bot.
}
