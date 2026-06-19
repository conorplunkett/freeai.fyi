#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`freeai: ${msg}`);
  process.exitCode = 1;
});
