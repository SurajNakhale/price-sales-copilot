import { IngestPanel } from "@/app/_components/IngestPanel";
import { isConnected } from "@/lib/google/oauth";
import { readManifest } from "@/lib/storage/new-price-lists";

// Connection state and the manifest are read from disk on every request.
export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: PageProps<"/">) {
  const [connected, manifest, params] = await Promise.all([
    isConnected(),
    readManifest(),
    searchParams,
  ]);

  const connectError = typeof params.connect_error === "string" ? params.connect_error : undefined;

  const saved = [...manifest]
    .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt))
    .map((entry) => ({
      savedAs: entry.savedAs,
      from: entry.from,
      subject: entry.subject,
      emailDate: entry.emailDate,
    }));

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Price &amp; Sales Copilot</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Feature 1 — read price lists from Gmail and save the raw files to{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">mock-data/new-price-lists/</code>.
        </p>
      </header>

      <IngestPanel connected={connected} saved={saved} connectError={connectError} />
    </div>
  );
}
