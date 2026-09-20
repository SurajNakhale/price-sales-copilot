import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

/**
 * The only place the app reads and writes JSON files. Writes go to a temporary
 * file and are renamed, so a crash can never leave half-written JSON behind.
 */

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return JSON.parse(raw) as T;
}

export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
  options: { mode?: number } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
      mode: options.mode,
    });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function removeFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
