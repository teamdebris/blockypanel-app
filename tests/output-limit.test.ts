import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { OutputTooLargeError, outputCollector, tailCollector } from "../lib/output-limit.ts";

test("collected output stops at its limit, and the command is told once", () => {
  let stops = 0;
  const output = outputCollector(10, () => { stops += 1; });
  output.add("héllo");
  assert.equal(output.text(), "héllo");
  output.add(Buffer.alloc(8));
  output.add("more");
  assert.equal(output.overflowed, true);
  assert.equal(stops, 1);
  assert.equal(output.text(), "");
  assert.match(new OutputTooLargeError("restic").message, /restic printed more than 4 MB/);
});

test("a character split across chunks decodes intact", () => {
  const output = outputCollector(100);
  const bytes = Buffer.from("é");
  output.add(bytes.subarray(0, 1));
  output.add(bytes.subarray(1));
  assert.equal(output.text(), "é");
});

test("error output keeps only its end", () => {
  const errors = tailCollector(8);
  errors.add("lots of noise, then ");
  errors.add("FAILED");
  assert.equal(errors.text(), "n FAILED");
});

test("a command that prints too much is stopped", async () => {
  const child = spawn(process.execPath, ["-e", "const chunk = 'x'.repeat(65536); setInterval(() => process.stdout.write(chunk), 1)"], { stdio: ["ignore", "pipe", "ignore"] });
  const output = outputCollector(256 * 1024, () => child.kill());
  child.stdout.on("data", (chunk: Buffer) => output.add(chunk));
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(output.overflowed, true);
});
