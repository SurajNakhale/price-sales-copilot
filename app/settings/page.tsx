import { GmailSettings } from "@/app/_components/GmailSettings";
import { PageHeader } from "@/app/_components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TOKEN_FILE, senderAllowlist } from "@/lib/config";
import { grantedScopes, isConnected } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const [connected, granted] = await Promise.all([isConnected(), grantedScopes()]);

  return (
    <>
      <PageHeader title="Settings" description="Gmail connection and data locations" />

      <div className="flex flex-col gap-3.5 p-7">
        <GmailSettings
          connected={connected}
          tokenPath={TOKEN_FILE}
          scopes={granted}
          senderAllowlist={senderAllowlist()}
        />

        <Card>
          <CardHeader>
            <CardTitle>Data</CardTitle>
            <CardDescription>
              There is no database. Everything is a local file.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-[14rem_1fr]">
              <dt className="text-muted-foreground">Current price list</dt>
              <dd className="font-mono text-xs">
                mock-data/current-price-lists/current-price-list.json
              </dd>

              <dt className="text-muted-foreground">Dealers</dt>
              <dd className="font-mono text-xs">mock-data/dealers/dealers.json</dd>

              <dt className="text-muted-foreground">Sales</dt>
              <dd className="font-mono text-xs">mock-data/sales/sales-data.json</dd>

              <dt className="text-muted-foreground">Downloaded price lists</dt>
              <dd className="font-mono text-xs">mock-data/new-price-lists/</dd>

              <dt className="text-muted-foreground">Reset the mock data</dt>
              <dd className="font-mono text-xs">bun run mock:generate --force</dd>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
