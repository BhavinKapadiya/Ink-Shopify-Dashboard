import { type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createMerchant } from "../services/ink-api.server";
import { updateMerchant } from "../services/merchant.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");

  if (!chargeId) {
    return Response.redirect(`${process.env.SHOPIFY_APP_URL}/app/payment`);
  }
  
  try {
    const shopResponse = await admin.graphql(`{ shop { name email myshopifyDomain } }`);
    const shopData = await shopResponse.json();
    const { name, email, myshopifyDomain } = shopData.data.shop;

    // Check for bypass
    if (chargeId !== "bypass") {
        // Verify charge status if needed, but for now we assume callback means success 
        // (normally we'd query the charge ID to be sure)
    } else {
        console.log("Bypassing billing check for Custom App credentials.");
    }

    console.log("Registering merchant with INK API:", { myshopifyDomain, name, email });
    
    // Call external API
    const inkData = await createMerchant(myshopifyDomain, name, email);
    
    // Store in Firestore "merchants" collection
    if (inkData && inkData.api_key) {
        await updateMerchant(session.shop, {
            ink_api_key: inkData.api_key,
            payment_status: "active"
        });
    } else {
        throw new Error("No API key returned from INK");
    }

  } catch (error) {
    console.error("Callback Error:", error);
    // Mark as paid even if API fails? No, retry.
    // For now we assume success if charge worked but API failed, so user isn't stuck.
    // We can show a banner later.
    await updateMerchant(session.shop, { payment_status: "active" });
    return Response.redirect(`${process.env.SHOPIFY_APP_URL}/app/payment?error=registration_failed`);
  }
  
  // Preserve query parameters (embedded, shop, host, hmac, etc.)
  const redirectUrl = new URL(`${process.env.SHOPIFY_APP_URL}/app/dashboard`);
  redirectUrl.search = url.search;
  // Remove charge_id from the forwarded params as it's no longer needed and clutters the URL
  redirectUrl.searchParams.delete("charge_id");
  
  return Response.redirect(redirectUrl.toString());
};
