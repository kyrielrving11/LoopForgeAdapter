import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

/** Bound the complete rendered background, including source labels. Never truncate. */
export const MAX_FIXED_CAPABILITY_BYTES = 64 * 1024;

export interface FixedCapabilityBackground {
  text: string;
  fingerprint: string;
}

/** Explicit source documents only. No transcript discovery, summarization or tool-result cache. */
export function captureFixedCapabilities(files: readonly string[]): FixedCapabilityBackground | undefined {
  if (files.length === 0) return undefined;
  const sections = [
    "# Fixed capability references",
    "These source documents were explicitly selected in host configuration. They are capability reference material, not LoopForge round facts or a task plan. Current LoopForge governance and the current task remain in the round input. The full documents are already present below; reread them only when necessary. Native skill activation, permissions and hooks still follow the host's live interfaces; this reference does not activate a skill. Live tool schemas remain authoritative for tool arguments.",
  ];
  let renderedBytes = Buffer.byteLength(sections.join("\n\n") + "\n", "utf8");
  const seen = new Set<string>();
  for (const file of files) {
    const source = realpathSync(path.resolve(file));
    if (seen.has(source)) continue;
    seen.add(source);
    const info = statSync(source);
    if (!info.isFile()) throw new Error("Fixed capability source must be a regular UTF-8 file: " + source);
    if (info.size > MAX_FIXED_CAPABILITY_BYTES) throw new Error("Fixed capability background exceeds 64 KiB: " + source);
    const bytes = readFileSync(source);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("Fixed capability source must be valid UTF-8: " + source); }
    if (!text.trim() || text.includes("\0")) throw new Error("Fixed capability source must contain nonempty text: " + source);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const section = "## Source: " + JSON.stringify(source) + "\nSHA-256: " + hash + "\n\n" + text;
    renderedBytes += Buffer.byteLength("\n\n" + section, "utf8");
    if (renderedBytes > MAX_FIXED_CAPABILITY_BYTES) {
      throw new Error("Fixed capability background exceeds 64 KiB; select fewer or shorter source documents");
    }
    sections.push(section);
  }
  const text = sections.join("\n\n") + "\n";
  return { text, fingerprint: createHash("sha256").update(text, "utf8").digest("hex") };
}
