#!/usr/bin/env node
"use strict";
const { main } = require("../lib/cli");

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; }); // e.g. piped into `head`
}

process.on("SIGINT", () => {
  process.stdout.write("\nStopped. Anything already installed stays installed; no credentials were changed by stopping.\n");
  process.exit(130);
});

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
  // Errors never include request bodies, headers or typed input.
  process.stderr.write(`brewboard-skill: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
