"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeIndianRupee,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareText,
  Package,
  Receipt,
  Settings,
  Store,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { formatNumber } from "@/lib/format";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown on the right. Waiting-on-a-person counts hide at zero; data counts do not. */
  count?: number;
  hideCountAtZero?: boolean;
}

export interface AppSidebarProps {
  connected: boolean;
  /** Items in the Price Updates flow waiting on a person. Nothing produces these until Feature 2. */
  needsReview: number;
  counts: { products: number; dealers: number; sales: number };
}

export function AppSidebar({ connected, needsReview, counts }: AppSidebarProps) {
  const pathname = usePathname();

  const workflows: NavItem[] = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    {
      href: "/price-updates",
      label: "Price Updates",
      icon: BadgeIndianRupee,
      count: needsReview,
      hideCountAtZero: true,
    },
    { href: "/copilot", label: "Sales Copilot", icon: MessageSquareText },
  ];

  const data: NavItem[] = [
    { href: "/products", label: "Products", icon: Package, count: counts.products },
    { href: "/dealers", label: "Dealers", icon: Store, count: counts.dealers },
    { href: "/sales", label: "Sales", icon: Receipt, count: counts.sales },
  ];

  return (
    <Sidebar>
      <SidebarHeader className="px-3 py-4">
        <Link href="/" className="block">
          <span className="block font-heading text-base leading-tight font-medium">
            Price &amp; Sales Copilot
          </span>
          <span className="block text-xs text-muted-foreground">
            Supplier pricing &amp; sales intelligence
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {workflows.map((item) => (
                <NavRow key={item.href} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Data</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {data.map((item) => (
                <NavRow key={item.href} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === "/settings"}
              render={<Link href="/settings" />}
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center gap-2 px-2 pt-1 pb-1 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{
              backgroundColor: connected
                ? "var(--status-ok)"
                : "var(--status-neutral)",
            }}
          />
          {connected ? "Gmail connected" : "Gmail not connected"}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function NavRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  // Exact match for the dashboard, prefix match elsewhere, so a workflow page
  // keeps its section highlighted.
  const active =
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
  const showCount =
    item.count !== undefined && !(item.hideCountAtZero && item.count === 0);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} render={<Link href={item.href} />}>
        <Icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
      {showCount ? (
        <SidebarMenuBadge>{formatNumber(item.count as number)}</SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}
