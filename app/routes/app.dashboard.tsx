import { useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  InlineStack,
  EmptyState,
  Banner,
  Layout,
} from "@shopify/polaris";
import PolarisAppLayout from "~/components/PolarisAppLayout";
import RecentActivity from "~/components/RecentActivity";
import EngagementFunnel from "~/components/EngagementFunnel";
import NFCTagInventory from "~/components/NFCTagInventory";
import RevenueThisPeriod from "~/components/RevenueThisPeriod";
import TimeToEngagement from "~/components/TimeToEngagement";
import CurrentPlanCard from "~/components/CurrentPlanCard";
import BillingWidget from "~/components/billing/BillingWidget";
import CommunicationsUsage from "~/components/CommunicationsUsage";
import { toast } from "sonner"; // Replaced with Sonner to match previous setup

const Dashboard = () => {
  const [hasOrders, setHasOrders] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handleViewDemo = () => {
    setIsTransitioning(true);
    toast("Loading demo data", { description: "Showing sample orders and verification data." });
    setTimeout(() => {
      setHasOrders(true);
      setIsTransitioning(false);
    }, 1000);
  };

  const handleDownloadGuide = () => {
    toast("Downloading guide", { description: "Your warehouse setup guide is being prepared." });
  };

  if (!hasOrders) {
    return (
      <PolarisAppLayout>
        <Page title="Dashboard">
          <Card>
            <EmptyState
              heading="Your setup is complete! 🎉"
              action={{ content: "View Demo", onAction: handleViewDemo, loading: isTransitioning }}
              secondaryAction={{ content: "Download Setup Guide", onAction: handleDownloadGuide }}
              image=""
            >
              <p>Your NFC tags will arrive in 3-5 business days. In the meantime, explore the app or read our warehouse setup guide.</p>
            </EmptyState>
          </Card>
        </Page>
      </PolarisAppLayout>
    );
  }

  return (
    <PolarisAppLayout>
      <Page>
        <BlockStack gap="400">
          {/* Operational Analytics (Metabase) */}
          <Card padding="0">
            <div style={{ padding: "0" }}>
              <iframe
                src="https://metabase-production-afb0.up.railway.app/public/dashboard/2987f9a3-e933-48d4-bb41-ad571c22c565#theme=transparent"
                frameBorder="0"
                width="100%"
                allowTransparency
                title="Operational Analytics Dashboard"
                className="w-full h-[800px] md:h-[650px] block"
              ></iframe>
            </div>
          </Card>

          {/* Row 1: Time to Engagement + Engagement Funnel */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TimeToEngagement />
            <EngagementFunnel />
          </div>

          {/* Row 2: NFC Tag Inventory + Total Value Protected */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NFCTagInventory />
            <RevenueThisPeriod />
          </div>

          {/* Row 3: Recent Activity + Billing Widget */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <RecentActivity />
            <div className="flex flex-col gap-4">
              <BillingWidget />
              <CurrentPlanCard />
            </div>
          </div>

          {/* Row 4: Communications — full width */}
          <CommunicationsUsage />
        </BlockStack>
      </Page>
    </PolarisAppLayout>
  );
};

export default Dashboard;
