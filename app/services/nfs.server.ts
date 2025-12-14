import crypto from "crypto";

// Alan's NFS API Base URL
const NFS_API_URL = process.env.NFS_API_URL || "http://193.57.137.90";
const NFS_HMAC_SECRET = process.env.NFS_HMAC_SECRET;

if (!NFS_HMAC_SECRET) {
  console.warn("⚠️ NFS_HMAC_SECRET is not set. Webhook verification will fail.");
}

// =============== TYPE DEFINITIONS ===============

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

interface VerifyPayload {
  nfc_token: string;
  delivery_gps: { lat: number; lng: number };
  device_info?: string;
  phone_last4?: string;
}

interface VerifyResponse {
  proof_id: string;
  verification_status: string;
  gps_verdict: string;
  distance_meters: number;
  signature: string;
  verify_url: string;
}

interface RetrieveResponse {
  proof_id: string;
  order_id: string;
  enrollment: {
    timestamp: string;
    shipping_address_gps: { lat: number; lng: number };
    photo_urls: string[];
  };
  delivery?: {
    timestamp: string;
    delivery_gps: { lat: number; lng: number };
    gps_verdict: string;
    phone_verified: boolean;
  };
  signature: string;
  public_key: string;
  key_id: string;
}

// Export types for use in other files
export type { EnrollPayload, EnrollResponse, VerifyPayload, VerifyResponse, RetrieveResponse };

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
   * Verifies a package delivery with the NFS backend.
   * Called when customer scans NFC tag at delivery.
   */
  async verify(payload: VerifyPayload): Promise<VerifyResponse> {
    console.log("🔍 Verifying with NFS Backend:", JSON.stringify(payload, null, 2));

    const response = await fetch(`${NFS_API_URL}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ NFS Verify Failed [${response.status}]:`, errorText);
      
      // Check for specific error codes
      if (response.status === 403) {
        throw new Error(`Phone verification required: ${errorText}`);
      }
      if (response.status === 404) {
        throw new Error(`Tag not enrolled: ${errorText}`);
      }
      
      throw new Error(`NFS Verification failed: ${errorText}`);
    }

    const data = await response.json();
    console.log("✅ NFS Verification Success:", data);
    return data as VerifyResponse;
  },

  /**
   * Retrieves proof details from the NFS backend.
   * This is the single source of truth for all proof data.
   */
  async retrieveProof(proofId: string): Promise<RetrieveResponse> {
    console.log(`📄 Retrieving proof from NFS Backend: ${proofId}`);

    const response = await fetch(`${NFS_API_URL}/retrieve/${proofId}`, {
      method: "GET",
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ NFS Retrieve Failed [${response.status}]:`, errorText);
      
      if (response.status === 404) {
        throw new Error(`Proof not found: ${proofId}`);
      }
      
      throw new Error(`NFS Retrieve failed: ${errorText}`);
    }

    const data = await response.json();
    console.log("✅ NFS Retrieve Success:", data);
    return data as RetrieveResponse;
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
