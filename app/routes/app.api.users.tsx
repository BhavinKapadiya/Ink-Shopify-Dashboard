import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { adminCreateUser, getShopIdByDomain, getMerchantUsers, deleteMerchantUser } from "../services/ink-api.server";
import sgMail from "@sendgrid/mail";
import crypto from "crypto";

const JWT_SECRET =
  process.env.WAREHOUSE_JWT_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "fallback-dev-secret";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: any, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
    ...init,
  });

function verifyToken(token: string): { shop: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── GET: list all users for this shop ───────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let shopDomain = "";

    // 1. Try Shopify session (Admin UI)
    try {
      const { session } = await authenticate.admin(request);
      shopDomain = session.shop;
    } catch (e) {
      // 2. Fallback to Bearer Token (External App)
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        const payload = verifyToken(token);
        shopDomain = payload?.shop || "";
        
        if (!shopDomain) {
          try {
            const decodedBody = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
            shopDomain = decodedBody.merchant_id || decodedBody.shop;
          } catch (e) {}
        }
      }
    }

    if (!shopDomain) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        // Users were created with merchant_id = shopDomain (not shop_id),
        // so we query using the domain string directly.
        const data = await getMerchantUsers(shopDomain);
        
        const users = (data.users || []).map((u: any) => ({
            id: u.user_id,
            name: u.name,
            email: u.email,
            role: "operator",
            createdAt: u.created_at || null
        })).sort((a: any, b: any) => {
            if (!a.createdAt) return 1;
            if (!b.createdAt) return -1;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });

        return json({ users });
    } catch (e: any) {
        console.error("[Users Loader] Proxy error:", e);
        return json({ users: [], error: e.message });
    }
  } catch (err: any) {
    if (err instanceof Response) {
      console.warn("[Users Loader] Auth redirect caught — returning empty user list");
      return json({ users: [] });
    }
    console.error("[Users Loader] Unexpected error:", err);
    return json({ users: [], error: "Failed to load users" });
  }
};


// ─── POST: create / update / delete ──────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let shopDomain = "";

    // 1. Try Shopify session (Admin UI)
    try {
      const { session } = await authenticate.admin(request);
      shopDomain = session.shop;
    } catch (e) {
      // 2. Fallback to Bearer Token (External App)
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        const payload = verifyToken(token);
        shopDomain = payload?.shop || "";
        
        if (!shopDomain) {
          try {
            const decodedBody = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
            shopDomain = decodedBody.merchant_id || decodedBody.shop;
          } catch (e) {}
        }
      }
    }

    if (!shopDomain) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { intent } = body;

  // ── Create ──
  if (intent === "create") {
    const { name, email, password } = body;

    if (!name || !email || !password) {
      return json({ error: "Name, email and password are required" }, { status: 400 });
    }

    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    }

    let inkUserId = "";

    try {
      // ── Resolve Alan's real shop_id (format: shop_<16hex>) ──────────────────
      // We must pass Alan's internal shop_id as merchant_id, NOT the Shopify domain.
      // Passing the domain was the bug causing merchant_id = "taimoor1-2.myshopify.com".
      let alanShopId: string;
      try {
        alanShopId = await getShopIdByDomain(shopDomain);
        console.log(`[UserManagement] Resolved Alan shop_id for ${shopDomain}: ${alanShopId}`);
      } catch (resolveErr: any) {
        console.error("[UserManagement] Could not resolve Alan shop_id:", resolveErr.message);
        return json({ error: "Could not resolve merchant ID. Please contact support." }, { status: 500 });
      }

      // Create User in INK Backend via Admin Proxy using the real shop_id
      const data = await adminCreateUser(alanShopId, name, email, password);
      inkUserId = data.user_id;
      console.log(`[UserManagement] Successfully created user in INK Backend: ${inkUserId} (merchant: ${alanShopId})`);
    } catch (inkError: any) {
      console.error("[UserManagement] Failed to create user in INK:", inkError);
      return json({ error: inkError.message || "Failed to create user in INK System" }, { status: 400 });
    }

    // Send welcome email
    try {
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM_EMAIL || "noreply@in.ink",
        subject: "You've been added to the INK Warehouse App",
        html: `
          <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
            <h2 style="margin-bottom: 8px;">Welcome to INK Warehouse, ${name}!</h2>
            <p style="color: #555;">You've been granted access to the INK Warehouse App. Here are your login credentials:</p>
            <table style="border-collapse: collapse; width: 100%; margin: 24px 0;">
              <tr>
                <td style="padding: 10px; font-weight: bold; background: #f4f4f5; border: 1px solid #e4e4e7;">User ID (Email)</td>
                <td style="padding: 10px; border: 1px solid #e4e4e7;">${email.toLowerCase()}</td>
              </tr>
              <tr>
                <td style="padding: 10px; font-weight: bold; background: #f4f4f5; border: 1px solid #e4e4e7;">Password</td>
                <td style="padding: 10px; border: 1px solid #e4e4e7;">${password}</td>
              </tr>
            </table>
            <a href="https://warehouse-bee05.web.app/login"
               style="display: inline-block; background: #000; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
              Login to Warehouse App →
            </a>
            <p style="margin-top: 24px; font-size: 12px; color: #999;">
              Please change your password after your first login. Do not share your credentials.
            </p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("[UserManagement] Failed to send welcome email:", emailErr);
    }

    return json({ success: true, userId: inkUserId });
  }

  // ── Update ──
  if (intent === "update") {
     // NOTE: The INK API specs provided do not document an update endpoint right now.
     // Returning 501 Not Implemented until the INK backend supports it.
     return json({ error: "Updating users is currently not supported by the INK API." }, { status: 501 });
  }

  // ── Delete ──
  if (intent === "delete") {
    const { userId } = body;

    if (!userId) {
      return json({ error: "userId is required" }, { status: 400 });
    }

    try {
        await deleteMerchantUser(userId);
        return json({ success: true });
    } catch (e: any) {
        console.error("[UserManagement] Failed to delete user:", e);
        return json({ error: e.message || "Failed to delete user" }, { status: 500 });
    }
  }

  } catch (err: any) {
    console.error("[Users Action] Error:", err);
    return json({ error: err.message || "Action failed" }, { status: 500 });
  }
};
