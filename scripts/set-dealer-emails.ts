/**
 * Points the mock dealers' email addresses at your own Gmail, so a Feature 3
 * draft's Bcc is aliases of your own inbox.
 *
 *   bun run mock:dealer-emails you@gmail.com
 *
 * Gmail delivers you+dealer1@gmail.com, you+dealer2@gmail.com and so on to
 * you@gmail.com, so every dealer keeps a distinct address and every copy lands
 * in your inbox. Only each dealer's `email` changes: names, states and order
 * stay, and it is safe to run again with another address.
 *
 * Use this instead of editing EMAIL_BASE in generate-mock-data.ts and running
 * `mock:generate --force`, which would reset the price changes you approved.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Dealer {
  dealer: string;
  state: string;
  email: string;
}

const DEALERS_FILE = join(import.meta.dir, "..", "mock-data", "dealers", "dealers.json");

/**
 * The part of a Gmail address before any "+". Throws for anything else, since
 * "+" aliases are a Gmail feature and the mock data promises @gmail.com.
 */
export function parseGmailBase(address: string): string {
  const [local = "", domain = ""] = address.trim().toLowerCase().split("@");
  if (domain !== "gmail.com" && domain !== "googlemail.com") {
    throw new Error(`"${address}" is not a Gmail address. Plus-aliases only work on @gmail.com, so use one.`);
  }
  const base = local.split("+")[0];
  if (!/^[a-z0-9][a-z0-9.]*$/.test(base)) {
    throw new Error(`"${address}" does not look like a Gmail address.`);
  }
  return base;
}

/** The dealers with `you+dealerN@gmail.com`, N being their position in the list. Nothing else changes. */
export function rewriteDealerEmails(dealers: Dealer[], address: string): Dealer[] {
  const base = parseGmailBase(address);
  return dealers.map((dealer, index) => ({ ...dealer, email: `${base}+dealer${index + 1}@gmail.com` }));
}

/** Rewrites the file in place, in the format the generator writes. Returns what it wrote. */
export function rewriteDealerFile(file: string, address: string): Dealer[] {
  const dealers = JSON.parse(readFileSync(file, "utf8")) as Dealer[];
  if (!Array.isArray(dealers) || dealers.length === 0) throw new Error(`${file} holds no dealers.`);
  const rewritten = rewriteDealerEmails(dealers, address);
  writeFileSync(file, `${JSON.stringify(rewritten, null, 2)}\n`);
  return rewritten;
}

if (import.meta.main) {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: bun run mock:dealer-emails you@gmail.com");
    process.exit(1);
  }
  try {
    const dealers = rewriteDealerFile(DEALERS_FILE, address);
    console.log(
      `Updated ${dealers.length} dealer addresses: ${dealers[0].email} … ${dealers[dealers.length - 1].email}`,
    );
    console.log("Every one of them is delivered to your own inbox. Nothing else in the file changed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
