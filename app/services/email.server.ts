
import sendgrid from "@sendgrid/mail";

// SendGrid credentials from environment variables
const apiKey = process.env.SENDGRID_API_KEY;
const fromEmail = process.env.SENDGRID_FROM_EMAIL;

if (apiKey) {
  sendgrid.setApiKey(apiKey);
} else {
  console.warn("⚠️ SendGrid API Key missing. Email service will be disabled.");
}

interface ReturnPassportEmailPayload {
  to: string;
  customerName: string;
  orderName: string;
  proofUrl: string;
  merchantName?: string;
  photoUrls?: string[];  // 4 enrollment photos
  returnWindowDays?: number;  // Return window (e.g., 30 days)
  returnUrl?: string;  // URL to start return
}

// Legacy interface for backward compatibility
interface EmailPayload {
  to: string;
  customerName: string;
  orderName: string;
  proofUrl: string;
  merchantName?: string;
}

export const EmailService = {
  /**
   * Sends the Return Passport email after delivery is unlocked.
   * Includes: 4 enrollment photos, return window info, "Start Return" CTA
   */
  async sendReturnPassportEmail(payload: ReturnPassportEmailPayload): Promise<boolean> {
    if (!apiKey || !fromEmail) {
      console.error("❌ Cannot send email: SendGrid credentials missing.");
      return false;
    }

    const { 
      to, 
      customerName, 
      orderName, 
      proofUrl, 
      merchantName = "Merchant",
      photoUrls = [],
      returnWindowDays = 30,
      returnUrl
    } = payload;

    // Generate photo grid HTML (2x2 layout)
    const photosHtml = photoUrls.length > 0 ? `
      <div style="margin: 20px 0;">
        <h3 style="color: #2c3e50; margin-bottom: 15px;">📸 Enrollment Photos</h3>
        <p style="font-size: 14px; color: #666; margin-bottom: 15px;">
          These photos were taken when your package was sealed and enrolled in INK protection.
        </p>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; max-width: 400px;">
          ${photoUrls.slice(0, 4).map((url, i) => `
            <a href="${url}" target="_blank" style="display: block;">
              <img src="${url}" alt="Enrollment photo ${i + 1}" 
                   style="width: 100%; height: 150px; object-fit: cover; border-radius: 8px; border: 1px solid #ddd;" />
            </a>
          `).join('')}
        </div>
      </div>
    ` : '';

    // Return window section
    const returnWindowHtml = `
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 12px; margin: 25px 0; text-align: center; color: white;">
        <div style="font-size: 48px; margin-bottom: 10px;">🛡️</div>
        <h3 style="margin: 0 0 10px 0; font-size: 18px;">Return Window Active</h3>
        <p style="margin: 0; font-size: 14px; opacity: 0.9;">
          You have <strong>${returnWindowDays} days</strong> from today to initiate a return if needed.
        </p>
      </div>
    `;

    // Determine return button URL
    const returnButtonUrl = returnUrl || proofUrl;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5;">
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; margin-top: 20px;">
          
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="font-size: 64px; margin-bottom: 15px;">🔓</div>
            <h1 style="color: #1a1a2e; margin: 0; font-size: 28px;">Delivery Unlocked!</h1>
            <p style="color: #666; margin-top: 10px; font-size: 16px;">
              Your INK Protected Delivery is complete
            </p>
          </div>

          <!-- Greeting -->
          <p style="font-size: 16px; color: #333;">Hi ${customerName},</p>
          <p style="font-size: 16px; color: #333; line-height: 1.6;">
            Great news! Your delivery for order <strong>${orderName}</strong> has been successfully unlocked. 
            Your package has been verified at your delivery location.
          </p>

          <!-- Return Window -->
          ${returnWindowHtml}

          <!-- Enrollment Photos -->
          ${photosHtml}

          <!-- Start Return CTA -->
          <div style="background-color: #f8f9fa; padding: 25px; border-radius: 12px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 15px 0; font-size: 16px; color: #333;">
              Need to start a return? Use your Return Passport below.
            </p>
            <a href="${returnButtonUrl}" 
               style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); 
                      color: white; 
                      padding: 16px 40px; 
                      text-decoration: none; 
                      border-radius: 30px; 
                      display: inline-block; 
                      font-weight: bold;
                      font-size: 16px;
                      box-shadow: 0 4px 15px rgba(17, 153, 142, 0.3);">
              🚀 Start Return
            </a>
            
            <p style="margin-top: 20px; font-size: 13px; color: #888;">
              Or copy this link: <br/>
              <a href="${proofUrl}" style="color: #11998e; word-break: break-all;">${proofUrl}</a>
            </p>
          </div>

          <!-- Benefits -->
          <div style="margin: 25px 0;">
            <p style="font-size: 14px; color: #333; margin-bottom: 10px;">
              <strong>Your Return Passport can be used for:</strong>
            </p>
            <ul style="padding-left: 20px; color: #555; line-height: 1.8;">
              <li>✅ Quick & easy returns</li>
              <li>🛡️ Insurance claims</li>
              <li>📋 Warranty verification</li>
              <li>🏷️ Resale authentication</li>
            </ul>
          </div>

          <!-- Footer -->
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          <p style="font-size: 12px; color: #888; text-align: center;">
            Sent by INK Premium Delivery for ${merchantName}.<br/>
            This email confirms your delivery was unlocked successfully.
          </p>
        </div>
      </body>
      </html>
    `;

    try {
      await sendgrid.send({
        to,
        from: fromEmail,
        subject: `🔓 Delivery Unlocked: Order ${orderName} - Your Return Passport`,
        html: htmlContent,
      });

      console.log(`✅ Return Passport email sent to ${to}`);
      return true;
    } catch (error: any) {
      console.error("❌ Failed to send email:", error.response?.body || error.message);
      return false;
    }
  },

  /**
   * Legacy method - redirects to Return Passport email
   * Kept for backward compatibility
   */
  async sendVerificationEmail(payload: EmailPayload): Promise<boolean> {
    return this.sendReturnPassportEmail({
      ...payload,
      photoUrls: [],
      returnWindowDays: 30,
    });
  },
};
