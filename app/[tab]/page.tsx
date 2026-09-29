import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { TABS, isTab } from "@/lib/tabs";

/**
 * Prerender one static page per tab.
 *
 * Keeping these static matters: a dynamic page would add server round-trip
 * latency to the very first paint that the Lighthouse budgets in
 * `lighthouserc.js` exist to protect.
 */
export function generateStaticParams(): Array<{ tab: string }> {
  return TABS.map((tab) => ({ tab }));
}

/** Unknown tab segments 404 instead of silently rendering the dashboard. */
export const dynamicParams = false;

export default async function TabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;

  if (!isTab(tab)) notFound();

  // The selected tab is derived from the pathname inside <Shell/>, so there is
  // no prop to thread through here.
  return <Shell />;
}
