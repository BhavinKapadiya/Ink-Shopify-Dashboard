import { type ActionFunctionArgs } from "react-router";
import { NFSService } from "../services/nfs.server";
import { INK_NAMESPACE } from "../utils/metafields.server";
import { serialNumberToToken } from "../utils/nfc-conversion.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With, Origin",
};

// Handle OPTIONS preflight
export const loader = async () => {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    // Get offline session
    const session = await prisma.session.findFirst({
      where: { isOnline: false },
    });

    if (!session) {
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "No session available" }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // Parse JSON payload
    const payload = await request.json();
    const { order_id, serial_number, photo_urls, photo_hashes, shipping_address_gps } = payload;

    console.log(`📦 Enrollment request for order ${order_id}, serial: ${serial_number}`);

    if (!order_id || !serial_number || !photo_urls || !photo_hashes) {
      console.error("❌ Missing required fields");
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Missing required fields: order_id, serial_number, photo_urls, photo_hashes" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // Convert serial number to UID and Token (deterministic)
    const { uid, token } = serialNumberToToken(serial_number);
    console.log(`✅ Converted serial to UID: ${uid}, Token: ${token}`);

    // Now validate with converted values
    if (!order_id || !uid || !token || !photo_urls || !photo_hashes) {
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // Create admin client helper
    const admin = {
      graphql: async (query: string, options?: any) => {
        const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables || {},
          }),
        });

        return {
          json: async () => await response.json(),
        };
      },
    };

    // 1. Fetch customer phone from Shopify order
    console.log(`📞 Fetching customer phone for order ${order_id}...`);
    let customer_phone_last4: string | undefined;

    try {
      const numericOrderId = order_id.replace(/\D/g, '');
      const orderGid = `gid://shopify/Order/${numericOrderId}`;

      const orderQuery = `
        query getOrder($id: ID!) {
          order(id: $id) {
            customer {
              phone
            }
          }
        }
      `;

      const orderResponse = await admin.graphql(orderQuery, { variables: { id: orderGid } });
      const orderData = await orderResponse.json();
      const customerPhone = orderData.data?.order?.customer?.phone;

      if (customerPhone) {
        // Extract last 4 digits (remove non-numeric characters)
        const phoneDigits = customerPhone.replace(/\D/g, '');
        customer_phone_last4 = phoneDigits.slice(-4);
        console.log(`✅ Customer phone last 4: ${customer_phone_last4}`);
      } else {
        console.warn("⚠️ No customer phone found for order");
      }
    } catch (phoneError) {
      console.error("Error fetching customer phone:", phoneError);
      // Continue enrollment even if phone fetch fails
    }

    // 2. Save to local Proof table (backup)
    console.log("💾 Saving enrollment to database...");
    let localProofId: string;

    try {
      const proofRecord = await prisma.proof.create({
        data: {
          order_id,
          nfc_uid: uid,
          nfc_token: token,
          photo_urls: JSON.stringify(photo_urls),
          photo_hashes: JSON.stringify(photo_hashes),
          shipping_address_gps: JSON.stringify(shipping_address_gps),
          customer_phone_last4,
          enrollment_timestamp: new Date(),
        },
      });
      localProofId = proofRecord.proof_id;
      console.log(`✅ Saved to database with proof_id: ${localProofId}`);
    } catch (dbError: any) {
      console.error("❌ Database save failed:", dbError);
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Failed to save enrollment to database", details: dbError.message }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // 3. Call NFS Backend to Enroll
    // NOTE: Alan's API expects the ACTUAL tag UID (serial_number), not our generated hash
    const enrollPayload = {
      order_id,
      nfc_uid: serial_number,  // Send original serial number to Alan (e.g., "ef:8b:c4:c3")
      nfc_token: token,  // Send our generated token
      photo_urls,
      photo_hashes,
      shipping_address_gps,
      customer_phone_last4: customer_phone_last4 || "",  // Always include, Alan's API requires it
      warehouse_gps: {
        lat: 40.7580, // Default warehouse location (from client specs)
        lng: -73.9855
      }
    };

    let nfsResponse: { proof_id: string; enrollment_status: string; key_id: string } | null = null;
    let nfsError: string | null = null;

    try {
      nfsResponse = await NFSService.enroll(enrollPayload);
      console.log(`✅ NFS enrollment successful: ${nfsResponse.proof_id}`);

      // Update local Proof record with NFS response
      await prisma.proof.update({
        where: { proof_id: localProofId },
        data: {
          nfs_proof_id: nfsResponse.proof_id,
          enrollment_status: nfsResponse.enrollment_status,
          key_id: nfsResponse.key_id,
        },
      });
      console.log("✅ Local database updated with NFS response");

    } catch (error: any) {
      nfsError = error.message || "NFS enrollment failed";
      console.error("⚠️ NFS enrollment failed, but data saved locally:", nfsError);
      // Don't return error - we have local backup
    }

    // 4. Update Shopify Metafields
    console.log("📝 Updating order metafields...");
    try {
      const numericOrderId = order_id.replace(/\D/g, '');
      const orderGid = `gid://shopify/Order/${numericOrderId}`;

      const metafields = [
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "proof_reference",
          type: "single_line_text_field",
          value: nfsResponse?.proof_id || localProofId,
        },
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "verification_status",
          type: "single_line_text_field",
          value: nfsResponse ? "enrolled" : "enrolled_local_only",
        },
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "nfc_uid",
          type: "single_line_text_field",
          value: uid,
        },
      ];

      const mutation = `
        mutation SetEnrollmentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `;

      await admin.graphql(mutation, { variables: { metafields } });
      console.log("✅ Metafields updated successfully");
    } catch (metaError) {
      console.error("⚠️ Metafield update failed:", metaError);
      // Don't fail the request - enrollment is already saved
    }

    await prisma.$disconnect();

    // Return success with proof_id
    return new Response(
      JSON.stringify({
        success: true,
        proof_id: nfsResponse?.proof_id || localProofId,
        nfs_status: nfsResponse ? "success" : "failed_local_backup",
        ...(nfsError && { nfs_error: nfsError }),
      }),
      {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }
    );

  } catch (error: any) {
    console.error("❌ Enrollment Error:", error);
    await prisma.$disconnect();
    return new Response(
      JSON.stringify({ error: error.message || "Enrollment failed" }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }
    );
  }
};