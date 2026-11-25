// Mirror console output into bot.log (with timestamps) so errors survive after the terminal closes.
import fs from "node:fs";
import { format } from "node:util";

const stream = fs.createWriteStream(new URL("./bot.log", import.meta.url), { flags: "a" });

for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    stream.write(`${new Date().toISOString()} [${level}] ${format(...args)}\n`);
  };
}

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  stream.end(() => process.exit(1));
});
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
