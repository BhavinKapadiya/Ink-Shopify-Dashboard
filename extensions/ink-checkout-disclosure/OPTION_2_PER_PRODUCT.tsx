// OPTION 2: $5 PER PRODUCT (Use this if you want to charge $5 for each product)
// Replace the content of Checkout.tsx with this code

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
const INK_PROTECTION_VARIANT_ID = "gid://shopify/ProductVariant/YOUR_VARIANT_ID_HERE";

export default reactExtension(
  "purchase.checkout.block.render",
  () => <InkDisclosure />
);

function InkDisclosure() {
  const applyCartLinesChange = useApplyCartLinesChange();
  const cartLines = useCartLines();

  // Automatically add INK protection based on number of products
  useEffect(() => {
    // Count real products (excluding INK protection itself)
    const realProducts = cartLines.filter(
      (line) => line.merchandise.id !== INK_PROTECTION_VARIANT_ID
    );
    
    const totalProductQuantity = realProducts.reduce(
      (sum, line) => sum + line.quantity, 
      0
    );

    // Find existing INK protection line
    const protectionLine = cartLines.find(
      (line) => line.merchandise.id === INK_PROTECTION_VARIANT_ID
    );

    const currentProtectionQty = protectionLine?.quantity || 0;

    // Adjust protection quantity to match product count
    if (totalProductQuantity > 0) {
      if (currentProtectionQty === 0) {
        // Add protection for all products
        applyCartLinesChange({
          type: "addCartLine",
          merchandiseId: INK_PROTECTION_VARIANT_ID,
          quantity: totalProductQuantity,
        }).catch((error) => {
          console.error("Failed to add INK protection:", error);
        });
      } else if (currentProtectionQty !== totalProductQuantity) {
        // Update protection quantity to match products
        applyCartLinesChange({
          type: "updateCartLine",
          id: protectionLine!.id,
          quantity: totalProductQuantity,
          merchandiseId: INK_PROTECTION_VARIANT_ID,
        }).catch((error) => {
          console.error("Failed to update INK protection:", error);
        });
      }
    }
  }, [cartLines, applyCartLinesChange]);

  // Calculate total protection fee
  const realProducts = cartLines.filter(
    (line) => line.merchandise.id !== INK_PROTECTION_VARIANT_ID
  );
  const productCount = realProducts.reduce((sum, line) => sum + line.quantity, 0);
  const totalProtectionFee = productCount * 5;

  return (
    <Banner status="info" title="🛡️ INK Delivery Protection Included">
      <BlockStack spacing="tight">
        <Text emphasis="bold">
          ✅ All {productCount} item{productCount !== 1 ? 's' : ''} protected (+${totalProtectionFee}.00)
        </Text>
        <Text size="small">
          Each item includes NFC-verified proof of delivery with photo documentation and GPS tracking.
        </Text>
        <Text size="small">
          Tap the INK sticker on delivery to authenticate your package.
        </Text>
      </BlockStack>
    </Banner>
  );
}
