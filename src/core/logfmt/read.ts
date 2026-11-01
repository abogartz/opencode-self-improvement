// read — split from src/logfmt.ts (#168 domain restructure). Declaration bodies are unchanged.
import { readFile } from "node:fs/promises";

export async function readLines(file: string): Promise<string[]> {
  // BunFile.exists() and .size cache the size; a later text() can crop a larger
  // atomic replacement. Read metadata and bytes through one handle instead.
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((l) => l.trim().length > 0);
}
