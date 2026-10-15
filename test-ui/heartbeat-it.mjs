// IT — the connection heartbeat: a silent connection is closed with a reason the engine logs, but a tab whose
// timers were slowed in the background gets a fresh ping before it is judged.
import { mock } from "node:test";
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();
let socket; const FakeWS = globalThis.WebSocket;
globalThis.WebSocket = class extends FakeWS { constructor(...args) { super(...args); socket = this; this.closes = []; } close(code, reason) { this.closes.push([code, reason]); super.close(); } };
globalThis.WebSocket.OPEN = 1;
// The clock and the timers move separately, as in a throttled tab: time passes without the interval firing.
let now = 1_000_000;
Date.now = () => now;
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
const advance = (ms) => { now += ms; mock.timers.tick(ms); };
const { connectWs } = await import("../public/js/ws.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const pings = () => ws.sent.filter((m) => m && m.type === "ping").length;

connectWs(); advance(1);
const first = socket;
advance(5000);
ok("a ping goes out every 5s", pings() === 1);
first.onmessage({ data: JSON.stringify({ type: "pong" }) });

// Throttled in the background: a minute passes before the interval fires once.
now += 60_000;
advance(5000);
ok("a late tick pings instead of closing", first.closes.length === 0 && pings() === 2);

// A real silence: no reply across several on-time ticks.
advance(5000); advance(5000); advance(5000);
ok("a connection silent for over 10s is closed with code 4000 and a reason", JSON.stringify(first.closes[0]) === JSON.stringify([4000, "no reply for 10s"]));

mock.timers.reset();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
