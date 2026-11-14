import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureFixedCapabilities, MAX_FIXED_CAPABILITY_BYTES } from "../src/hosts/fixed-capabilities.js";

function fixture(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "loopforge-capabilities-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("fixed background preserves selected source text and order, coalesces paths and changes only with its sources", () => fixture((directory) => {
  assert.equal(captureFixedCapabilities([]), undefined);
  const first = path.join(directory, "SKILL.md");
  const second = path.join(directory, "tools.md");
  mkdirSync(path.join(directory, "nested"));
  const original = "---\r\nname: example\r\n---\r\n中文 🧪\r\n  preserve spacing \r\n";
  writeFileSync(first, original);
  writeFileSync(second, "Use the live tool schema.\n");
  const background = captureFixedCapabilities([first, path.join(directory, "nested/../SKILL.md"), second])!;
  assert.ok(background.text.includes(original));
  assert.ok(background.text.includes(JSON.stringify(realpathSync(first))));
  assert.ok(background.text.includes(createHash("sha256").update(original).digest("hex")));
  assert.equal(background.text.split(original).length, 2);
  assert.ok(background.text.indexOf(original) < background.text.indexOf("Use the live tool schema."));
  assert.deepEqual(captureFixedCapabilities([first, second]), background);
  assert.notEqual(captureFixedCapabilities([second, first])!.fingerprint, background.fingerprint);
  writeFileSync(first, original + "Updated original reference.\n");
  assert.notEqual(captureFixedCapabilities([first, second])!.fingerprint, background.fingerprint);
}));

test("fixed background rejects invalid or oversized references instead of silently dropping or truncating them", () => fixture((directory) => {
  const source = path.join(directory, "reference.md");
  assert.throws(() => captureFixedCapabilities([source]), /ENOENT/);
  assert.throws(() => captureFixedCapabilities([directory]), /regular UTF-8 file/);
  for (const invalid of [" \n\t", "contains\0NUL", Buffer.from([0xc3, 0x28])]) {
    writeFileSync(source, invalid);
    assert.throws(() => captureFixedCapabilities([source]), /nonempty text|valid UTF-8/);
  }
  writeFileSync(source, "x".repeat(MAX_FIXED_CAPABILITY_BYTES + 1));
  assert.throws(() => captureFixedCapabilities([source]), /exceeds 64 KiB/);
  const second = path.join(directory, "second.md");
  writeFileSync(source, "中".repeat(11000));
  writeFileSync(second, "中".repeat(11000));
  assert.ok(captureFixedCapabilities([source]));
  assert.throws(() => captureFixedCapabilities([source, second]), /exceeds 64 KiB/);
  writeFileSync(source, "x".repeat(MAX_FIXED_CAPABILITY_BYTES));
  assert.throws(() => captureFixedCapabilities([source]), /exceeds 64 KiB/, "labels count toward the limit too");
}));
