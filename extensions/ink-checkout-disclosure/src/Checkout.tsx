import {
  Banner,
  BlockStack,
  Text,
  reactExtension,
  useApplyCartLinesChange,
  useCartLines,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect } from "react";

// IMPORTANT: Replace this with your actual INK Protection product variant ID
// Go to Shopify Admin → Products → INK Protected Delivery → Copy Variant ID
const INK_PROTECTION_VARIANT_ID = "gid://shopify/ProductVariant/46259612164330";

export default reactExtension(
  "purchase.checkout.block.render",
  () => <InkDisclosure />
);

function InkDisclosure() {
  const applyCartLinesChange = useApplyCartLinesChange();
  const cartLines = useCartLines();

  // Automatically add INK protection when products are in cart
  useEffect(() => {
    const hasRealProducts = cartLines.some(
      (line) => line.merchandise.id !== INK_PROTECTION_VARIANT_ID
    );

    const hasProtection = cartLines.some(
      (line) => line.merchandise.id === INK_PROTECTION_VARIANT_ID
    );

    // If there are products but no protection, add it automatically
    if (hasRealProducts && !hasProtection) {
      applyCartLinesChange({
        type: "addCartLine",
        merchandiseId: INK_PROTECTION_VARIANT_ID,
        quantity: 1,
      }).catch((error) => {
        console.error("Failed to add INK protection:", error);
      });
    }
  }, [cartLines, applyCartLinesChange]);

  return (
    <Banner status="info" title="🛡️ INK Delivery Protection Included">
      <BlockStack spacing="tight">
        <Text emphasis="bold">
          ✅ All items in this order are protected with INK verification (+$5.00)
        </Text>
        <Text size="small">
          Your delivery includes NFC-verified proof of delivery with photo documentation and GPS tracking.
        </Text>
        <Text size="small">
          Tap the INK sticker on delivery to authenticate your package.
        </Text>
      </BlockStack>
    </Banner>
  );
}
