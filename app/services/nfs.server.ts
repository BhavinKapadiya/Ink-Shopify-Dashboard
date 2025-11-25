import crypto from "crypto";

const NFS_API_URL = process.env.NFS_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
const NFS_HMAC_SECRET = process.env.NFS_HMAC_SECRET;

if (!NFS_HMAC_SECRET) {
  console.warn("⚠️ NFS_HMAC_SECRET is not set. Webhook verification will fail.");
}

interface EnrollPayload {
  order_id: string;
  nfc_uid: string;
  nfc_token: string;
  photo_urls: string[];
  photo_hashes: string[];
  shipping_address_gps: { lat: number; lng: number };
  customer_phone_last4?: string;
  warehouse_gps?: { lat: number; lng: number };
}

interface EnrollResponse {
  proof_id: string;
  enrollment_status: string;
  key_id: string;
}

export const NFSService = {
  /**
   * Enrolls a package with the NFS backend.
   */
  async enroll(payload: EnrollPayload): Promise<EnrollResponse> {
    console.log("🚀 Enrolling with NFS Backend:", JSON.stringify(payload, null, 2));

    const response = await fetch(`${NFS_API_URL}/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      
      // Log detailed error information
      console.error(`❌ NFS Enroll Failed [${response.status}]:`, errorText);
      console.error(`Response Headers:`, JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));
      console.error(`Request URL:`, `${NFS_API_URL}/enroll`);
      console.error(`Request Payload:`, JSON.stringify(payload, null, 2));
      
      // Try to parse error as JSON for more details
      let errorDetails = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        errorDetails = JSON.stringify(errorJson, null, 2);
        console.error(`Parsed Error:`, errorDetails);
      } catch {
        // Not JSON, use raw text
      }
      
      throw new Error(`NFS Enrollment failed: ${errorText}`);
    }

    const data = await response.json();
    console.log("✅ NFS Enrollment Success:", data);
    return data as EnrollResponse;
  },

  /**
   * Verifies the HMAC signature of an incoming webhook.
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!NFS_HMAC_SECRET) return false;

    const computedSignature = crypto
      .createHmac("sha256", NFS_HMAC_SECRET)
      .update(payload)
      .digest("hex");

    // Use timingSafeEqual to prevent timing attacks
    const signatureBuffer = Buffer.from(signature);
    const computedBuffer = Buffer.from(computedSignature);

    if (signatureBuffer.length !== computedBuffer.length) return false;

    return crypto.timingSafeEqual(signatureBuffer, computedBuffer);
  },
};
