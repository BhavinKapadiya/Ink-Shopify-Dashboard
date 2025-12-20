import {
  Banner,
  BlockStack,
  Text,
  Icon,
  reactExtension,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension(
  "purchase.checkout.block.render",
  () => <InkDisclosure />
);

function InkDisclosure() {
  return (
    <Banner
      status="info"
      title="🛡️ INK Delivery Protection"
    >
      <BlockStack spacing="tight">
        <Text>
          Your purchase is protected with INK verification technology.
        </Text>
        <Text emphasis="bold">
          Tap the INK sticker on delivery to authenticate and create your permanent delivery record.
        </Text>
      </BlockStack>
    </Banner>
  );
}
