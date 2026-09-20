import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { gmail_v1 } from "googleapis";

import type { ManifestEntry } from "@/lib/types";

// lib/config.ts resolves its paths from process.cwd() when it is first imported,
// so the working directory is moved to a scratch folder before anything is
// loaded. Every write below then lands in the temp folder, never in the repo.
const projectRoot = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "psc-feature1-"));
process.chdir(tempRoot);

const { hasAllowedExtension, buildGmailQuery, NEW_PRICE_LIST_DIR } = await import(
  "@/lib/config"
);
const { extractAttachmentParts, findAttachmentPart } = await import(
  "@/lib/gmail/price-list-emails"
);
const { sanitizeFilename, saveAttachment, readManifest, writeManifest } =
  await import("@/lib/storage/new-price-lists");

afterAll(async () => {
  process.chdir(projectRoot);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/** A price list beside the things we must ignore, nested two levels deep. */
const nestedMessage: gmail_v1.Schema$MessagePart = {
  partId: "",
  mimeType: "multipart/mixed",
  filename: "",
  parts: [
    {
      partId: "0",
      mimeType: "multipart/alternative",
      filename: "",
      parts: [
        { partId: "0.0", mimeType: "text/plain", filename: "", body: { size: 12 } },
        { partId: "0.1", mimeType: "text/html", filename: "", body: { size: 40 } },
      ],
    },
    {
      partId: "1",
      mimeType: "application/octet-stream",
      filename: "Seagate_Price_List.xlsx",
      body: { size: 20480, attachmentId: "att-xlsx" },
    },
    {
      partId: "2",
      mimeType: "application/pdf",
      filename: "terms.pdf",
      body: { size: 9000, attachmentId: "att-pdf" },
    },
    {
      partId: "3",
      mimeType: "image/png",
      filename: "logo.png",
      body: { size: 3000, attachmentId: "att-png" },
    },
    {
      partId: "4",
      mimeType: "multipart/mixed",
      filename: "",
      parts: [
        {
          partId: "4.0",
          mimeType: "text/csv",
          filename: "Samsung_Price_List.csv",
          body: { size: 1024, attachmentId: "att-csv" },
        },
      ],
    },
  ],
};

describe("attachment extraction", () => {
  test("keeps only .xlsx and .csv, including nested parts", () => {
    const parts = extractAttachmentParts(nestedMessage);

    expect(parts.map((part) => part.filename)).toEqual([
      "Seagate_Price_List.xlsx",
      "Samsung_Price_List.csv",
    ]);
    expect(parts.map((part) => part.partId)).toEqual(["1", "4.0"]);
    expect(parts[0].attachmentId).toBe("att-xlsx");
    expect(parts[0].sizeBytes).toBe(20480);
  });

  test("an email with no price list yields nothing", () => {
    const meeting: gmail_v1.Schema$MessagePart = {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", body: { size: 10 } },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "meeting.pdf",
          body: { size: 500, attachmentId: "a" },
        },
      ],
    };

    expect(extractAttachmentParts(meeting)).toEqual([]);
    expect(extractAttachmentParts(undefined)).toEqual([]);
    expect(extractAttachmentParts(null)).toEqual([]);
  });

  test("finds a part by id and ignores one that is not a price list", () => {
    expect(findAttachmentPart(nestedMessage, "4.0")?.filename).toBe(
      "Samsung_Price_List.csv",
    );
    // terms.pdf exists in the message but was never a candidate.
    expect(findAttachmentPart(nestedMessage, "2")).toBeUndefined();
  });

  test("extension check is case-insensitive and anchored at the end", () => {
    expect(hasAllowedExtension("List.XLSX")).toBe(true);
    expect(hasAllowedExtension("list.csv")).toBe(true);
    expect(hasAllowedExtension("xlsx.pdf")).toBe(false);
    expect(hasAllowedExtension("prices.csv.exe")).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  test("strips directories, so path traversal cannot escape the folder", () => {
    expect(sanitizeFilename("../../x.xlsx")).toBe("x.xlsx");
    expect(sanitizeFilename("..\\..\\windows\\y.csv")).toBe("y.csv");
    expect(sanitizeFilename("/etc/passwd.csv")).toBe("passwd.csv");
  });

  test("replaces characters that are unsafe in a filename", () => {
    expect(sanitizeFilename("a:b*.csv")).toBe("a_b_.csv");
    expect(sanitizeFilename('we"ird|name?.xlsx')).toBe("we_ird_name_.xlsx");
  });

  test("falls back to a name when nothing usable is left", () => {
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename("...")).toBe("attachment");
    expect(sanitizeFilename("   ")).toBe("attachment");
  });

  test("keeps the extension when shortening a very long name", () => {
    const long = `${"a".repeat(300)}.xlsx`;
    const result = sanitizeFilename(long);
    expect(result.endsWith(".xlsx")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(120);
  });
});

describe("saveAttachment", () => {
  const base = {
    from: "Seagate Distributor <sales@seagate-dist.test>",
    subject: "September Price List",
    emailDate: "2026-09-03T09:12:00.000Z",
  };

  async function savedFiles(): Promise<string[]> {
    const entries = await fs.readdir(NEW_PRICE_LIST_DIR).catch(() => []);
    return entries.filter((name) => name !== "manifest.json").sort();
  }

  test("writes the file and records it in the manifest", async () => {
    const manifest: ManifestEntry[] = [];
    const result = await saveAttachment({
      manifest,
      messageId: "msg-aaaaaaaa",
      partId: "1",
      originalName: "Seagate_Price_List.xlsx",
      contents: Buffer.from("seagate prices"),
      ...base,
    });

    expect(result.status).toBe("downloaded");
    expect(result.savedAs).toBe("Seagate_Price_List.xlsx");
    expect(manifest).toHaveLength(1);
    expect(manifest[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await fs.readFile(
        path.join(NEW_PRICE_LIST_DIR, "Seagate_Price_List.xlsx"),
        "utf8",
      ),
    ).toBe("seagate prices");
  });

  test("the same message and part is skipped on a re-run", async () => {
    const manifest: ManifestEntry[] = [];
    const first = await saveAttachment({
      manifest,
      messageId: "msg-bbbbbbbb",
      partId: "1",
      originalName: "Repeat.csv",
      contents: Buffer.from("one"),
      ...base,
    });
    const second = await saveAttachment({
      manifest,
      messageId: "msg-bbbbbbbb",
      partId: "1",
      originalName: "Repeat.csv",
      contents: Buffer.from("one"),
      ...base,
    });

    expect(first.status).toBe("downloaded");
    expect(second.status).toBe("skipped-duplicate");
    expect(second.savedAs).toBe("Repeat.csv");
    expect(manifest).toHaveLength(1);
  });

  test("same name and identical content is not stored twice", async () => {
    const manifest: ManifestEntry[] = [];
    await saveAttachment({
      manifest,
      messageId: "msg-cccccccc",
      partId: "1",
      originalName: "Shared.csv",
      contents: Buffer.from("identical"),
      ...base,
    });
    const again = await saveAttachment({
      manifest,
      messageId: "msg-dddddddd",
      partId: "1",
      originalName: "Shared.csv",
      contents: Buffer.from("identical"),
      ...base,
    });

    expect(again.status).toBe("skipped-duplicate");
    expect(again.savedAs).toBe("Shared.csv");
    // Recorded anyway, so the next scan knows this message was handled.
    expect(manifest).toHaveLength(2);
  });

  test("same name with different content is saved beside it, never over it", async () => {
    const manifest: ManifestEntry[] = [];
    await saveAttachment({
      manifest,
      messageId: "msg-eeeeeeee",
      partId: "1",
      originalName: "Price_List.xlsx",
      contents: Buffer.from("brand one"),
      ...base,
    });
    const other = await saveAttachment({
      manifest,
      messageId: "msg-ffffffff",
      partId: "1",
      originalName: "Price_List.xlsx",
      contents: Buffer.from("brand two"),
      ...base,
    });

    expect(other.status).toBe("downloaded");
    expect(other.savedAs).toBe("Price_List__msg-ffff.xlsx");

    const files = await savedFiles();
    expect(files).toContain("Price_List.xlsx");
    expect(files).toContain("Price_List__msg-ffff.xlsx");
    expect(
      await fs.readFile(path.join(NEW_PRICE_LIST_DIR, "Price_List.xlsx"), "utf8"),
    ).toBe("brand one");
  });

  test("a traversing filename lands inside the folder", async () => {
    const manifest: ManifestEntry[] = [];
    const result = await saveAttachment({
      manifest,
      messageId: "msg-99999999",
      partId: "2",
      originalName: "../../escaped.csv",
      contents: Buffer.from("nope"),
      ...base,
    });

    expect(result.savedAs).toBe("escaped.csv");
    expect(await savedFiles()).toContain("escaped.csv");
  });

  test("the manifest round-trips through disk", async () => {
    const manifest = await readManifest();
    expect(manifest).toEqual([]);

    const entry: ManifestEntry = {
      messageId: "msg-11111111",
      partId: "1",
      savedAs: "A.csv",
      originalName: "A.csv",
      from: base.from,
      subject: base.subject,
      emailDate: base.emailDate,
      sha256: "0".repeat(64),
      downloadedAt: "2026-09-20T18:05:00.000Z",
    };
    await writeManifest([entry]);
    expect(await readManifest()).toEqual([entry]);
  });
});

describe("gmail query", () => {
  test("asks Gmail for attachments and price wording", () => {
    const query = buildGmailQuery();
    expect(query).toContain("has:attachment");
    expect(query).toContain("filename:xlsx");
    expect(query).toContain("filename:csv");
    expect(query).toContain("newer_than:90d");
    expect(query).not.toContain("from:");
  });

  test("an allowlist narrows it to those senders", () => {
    process.env.SENDER_ALLOWLIST = "a@brand.test, b@brand.test";
    try {
      expect(buildGmailQuery()).toContain("(from:a@brand.test OR from:b@brand.test)");
    } finally {
      delete process.env.SENDER_ALLOWLIST;
    }
  });
});
