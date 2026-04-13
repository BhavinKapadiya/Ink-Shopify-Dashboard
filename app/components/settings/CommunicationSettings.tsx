import { useState, useEffect } from "react";
import { useFetcher } from "react-router";
import {
  BlockStack,
  Card,
  Text,
  InlineStack,
  Checkbox,
  Select,
  Divider,
  Layout,
  Banner,
} from "@shopify/polaris";
import { toast } from "../../hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────
interface NotificationSettings {
  channels: { email: boolean; sms: boolean };
  delivery: { outForDelivery: boolean; delivered: boolean; deliveryConfirmed: boolean };
  reminders: { hours4: boolean; hours24: boolean; hours48: boolean };
  returnReminders: { days7: boolean; hours48: boolean };
  returnWindow: string;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  channels: { email: true, sms: false },
  delivery: { outForDelivery: true, delivered: true, deliveryConfirmed: false },
  reminders: { hours4: true, hours24: true, hours48: false },
  returnReminders: { days7: true, hours48: false },
  returnWindow: "30",
};

// ─── Component ────────────────────────────────────────────────────────────────
const CommunicationSettings = () => {
  const loadFetcher = useFetcher<{ settings?: NotificationSettings; error?: string }>();
  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();

  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Load settings from Firestore on mount via Remix loader ─────────────────
  useEffect(() => {
    loadFetcher.load("/app/api/settings/notifications");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Update local state when loader data arrives ────────────────────────────
  useEffect(() => {
    if (loadFetcher.data?.settings) {
      setSettings(loadFetcher.data.settings);
    }
  }, [loadFetcher.data]);

  // ── Show error feedback when save completes ────────────────────────────────
  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data) {
      if (saveFetcher.data.error) {
        setSaveError(saveFetcher.data.error);
        toast({ description: "Failed to save settings", variant: "destructive", duration: 3000 });
      } else if (saveFetcher.data.success) {
        setSaveError(null);
      }
    }
  }, [saveFetcher.state, saveFetcher.data]);

  // ── Save via Remix action — goes through Shopify session auth properly ─────
  const saveSettings = (newSettings: NotificationSettings) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveFetcher.submit(newSettings as any, {
      method: "POST",
      action: "/app/api/settings/notifications",
      encType: "application/json",
    });
  };

  // ── Generic toggle ─────────────────────────────────────────────────────────
  const toggle = (
    section: "channels" | "delivery" | "reminders" | "returnReminders",
    key: string,
    label: string
  ) => {
    const currentSection = settings[section] as Record<string, boolean>;
    const newVal = !currentSection[key];
    const updatedSection = { ...currentSection, [key]: newVal };
    const newSettings = { ...settings, [section]: updatedSection } as NotificationSettings;
    setSettings(newSettings);
    toast({ description: `${label} ${newVal ? "enabled" : "disabled"}`, duration: 1500 });
    saveSettings(newSettings);
  };

  // ── Toggle row sub-component ───────────────────────────────────────────────
  const ToggleRow = ({
    checked,
    onToggle,
    title,
    description,
  }: {
    checked: boolean;
    onToggle: () => void;
    title: string;
    description: string;
  }) => (
    <InlineStack align="space-between" blockAlign="start" wrap={false}>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" fontWeight="medium">{title}</Text>
        <Text as="p" tone="subdued" variant="bodySm">{description}</Text>
      </BlockStack>
      <Checkbox label="" checked={checked} onChange={onToggle} />
    </InlineStack>
  );

  const isSaving = saveFetcher.state !== "idle";

  return (
    <Layout>
      {/* Save error banner */}
      {saveError && (
        <Layout.Section>
          <Banner tone="critical" onDismiss={() => setSaveError(null)}>
            <p>Could not save settings: {saveError}. Please try again.</p>
          </Banner>
        </Layout.Section>
      )}

      {/* ── Notification Channels ── */}
      <Layout.AnnotatedSection
        title="Notification Channel"
        description="How customers receive notifications about their deliveries."
      >
        <Card>
          <BlockStack gap="400">
            <ToggleRow
              checked={settings.channels.email}
              onToggle={() => toggle("channels", "email", "Email notifications")}
              title="Email"
              description="Send notifications via email."
            />
            <Divider />
            <ToggleRow
              checked={settings.channels.sms}
              onToggle={() => toggle("channels", "sms", "SMS notifications")}
              title="SMS"
              description="Send notifications via text message."
            />
            <Text as="p" tone="subdued" variant="bodySm">
              Requires customer phone number from Shopify order.
            </Text>
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      {/* ── Delivery Notifications ── */}
      <Layout.AnnotatedSection
        title="Delivery Notifications"
        description="Messages sent to customers during the delivery process."
      >
        <Card>
          <BlockStack gap="400">
            <ToggleRow
              checked={settings.delivery.outForDelivery}
              onToggle={() => toggle("delivery", "outForDelivery", "Out for delivery")}
              title="Out for delivery"
              description="Notify when carrier scan shows package is out for delivery."
            />
            <Divider />
            <ToggleRow
              checked={settings.delivery.delivered}
              onToggle={() => toggle("delivery", "delivered", "Delivered notification")}
              title="Delivered"
              description="Notify when carrier confirms delivery. Includes tap instructions."
            />
            <Divider />
            <ToggleRow
              checked={settings.delivery.deliveryConfirmed}
              onToggle={() => toggle("delivery", "deliveryConfirmed", "Delivery confirmed")}
              title="Delivery confirmed"
              description="Confirmation sent after customer taps."
            />
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      {/* ── Tap Reminders ── */}
      <Layout.AnnotatedSection
        title="Tap Reminders"
        description="Sent if the customer hasn't tapped. Reminders stop once the customer taps."
      >
        <Card>
          <BlockStack gap="400">
            <ToggleRow
              checked={settings.reminders.hours4}
              onToggle={() => toggle("reminders", "hours4", "4-hour reminder")}
              title="4 hours after delivery"
              description="First reminder."
            />
            <Divider />
            <ToggleRow
              checked={settings.reminders.hours24}
              onToggle={() => toggle("reminders", "hours24", "24-hour reminder")}
              title="24 hours after delivery"
              description="Second reminder."
            />
            <Divider />
            <ToggleRow
              checked={settings.reminders.hours48}
              onToggle={() => toggle("reminders", "hours48", "48-hour reminder")}
              title="48 hours after delivery"
              description="Final tap reminder."
            />
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      {/* ── Return Window Reminders ── */}
      <Layout.AnnotatedSection
        title="Return Window Reminders"
        description="Sent to verified customers as their return window approaches closing."
      >
        <Card>
          <BlockStack gap="400">
            <ToggleRow
              checked={settings.returnReminders.days7}
              onToggle={() => toggle("returnReminders", "days7", "7-day return reminder")}
              title="7 days before return window closes"
              description="Early reminder. Includes return link."
            />
            <Divider />
            <ToggleRow
              checked={settings.returnReminders.hours48}
              onToggle={() => toggle("returnReminders", "hours48", "48-hour return reminder")}
              title="48 hours before return window closes"
              description='"Your return window closes in 2 days."'
            />
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      {/* ── Return Window (M7) ── */}
      <Layout.AnnotatedSection
        title="Return Window"
        description="How long customers have to initiate a return after delivery."
      >
        <Card>
          <Select
            label=""
            labelHidden
            disabled={isSaving}
            value={settings.returnWindow}
            onChange={(v) => {
              const newSettings = { ...settings, returnWindow: v };
              setSettings(newSettings);
              toast({ description: `Return window set to ${v} days`, duration: 1500 });
              saveSettings(newSettings);
            }}
            options={[
              { label: "14 days", value: "14" },
              { label: "30 days", value: "30" },
              { label: "60 days", value: "60" },
              { label: "90 days", value: "90" },
            ]}
          />
        </Card>
      </Layout.AnnotatedSection>
    </Layout>
  );
};

export default CommunicationSettings;
