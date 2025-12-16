
import sendgrid from "@sendgrid/mail";

// SendGrid credentials from environment variables
const apiKey = process.env.SENDGRID_API_KEY;
const fromEmail = process.env.SENDGRID_FROM_EMAIL;

if (apiKey) {
  sendgrid.setApiKey(apiKey);
} else {
  console.warn("⚠️ SendGrid API Key missing. Email service will be disabled.");
}

interface EmailPayload {
  to: string;
  customerName: string;
  orderName: string;
  proofUrl: string;
  merchantName?: string;
}

export const EmailService = {
  /**
   * Sends a verification success email with proof link.
   */
  async sendVerificationEmail(payload: EmailPayload): Promise<boolean> {
    if (!apiKey || !fromEmail) {
      console.error("❌ Cannot send email: SendGrid credentials missing.");
      return false;
    }

    const { to, customerName, orderName, proofUrl, merchantName = "Merchant" } = payload;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <h2 style="color: #2c3e50;">Delivery Verified! ✅</h2>
        <p>Hi ${customerName},</p>
        <p>Great news! Your delivery for order <strong>${orderName}</strong> has been successfully verified.</p>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <p style="margin-bottom: 15px;">Your permanent proof record is now available.</p>
          <a href="${proofUrl}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">View Delivery Proof</a>
        </div>

        <p>You can use this link anytime for:</p>
        <ul>
          <li>Insurance claims</li>
          <li>Warranty verification</li>
          <li>Resale authentication</li>
        </ul>

        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="font-size: 12px; color: #888;">
          Sent by INK verification system for ${merchantName}.
        </p>
      </div>
    `;

    try {
      await sendgrid.send({
        to,
        from: fromEmail,
        subject: `Delivery Verified: Order ${orderName}`,
        html: htmlContent,
      });

      console.log(`✅ Verification email sent to ${to}`);
      return true;
    } catch (error: any) {
      console.error("❌ Failed to send email:", error.response?.body || error.message);
      return false;
    }
  },
};
