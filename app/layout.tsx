import type { Metadata } from "next";
import { Geist_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import "./globals.css";

import { AppSidebar } from "@/app/_components/AppSidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readDealers, readProducts, readSales } from "@/lib/data/mock-data";
import { isConnected } from "@/lib/google/oauth";

// Newsreader for the wordmark and page titles, IBM Plex Sans for everything
// else. See context/ui-design.md section 5.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Price & Sales Copilot",
  description: "Supplier pricing and sales intelligence",
};

// The sidebar shows the Gmail connection and the dataset counts, all read
// from disk, so the shell is rendered per request like the pages inside it.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [connected, products, dealers, sales] = await Promise.all([
    isConnected(),
    readProducts(),
    readDealers(),
    readSales(),
  ]);

  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${newsreader.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              connected={connected}
              // Nothing produces review items until Feature 2 exists.
              needsReview={0}
              counts={{
                products: products.length,
                dealers: dealers.length,
                sales: sales.length,
              }}
            />
            <SidebarInset className="min-w-0">{children}</SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
