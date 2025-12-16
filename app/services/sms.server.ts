
import twilio from "twilio";

// Twilio credentials from environment variables
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

// Initialize Twilio client
let client: any;

if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
} else {
  console.warn("⚠️ Twilio credentials missing. SMS service will be disabled.");
}

export const SMSService = {
  /**
   * Sends an SMS to a recipient.
   * @param to The recipient's phone number (E.164 format)
   * @param body The message body
   */
  async sendSMS(to: string, body: string): Promise<boolean> {
    if (!client) {
      console.error("❌ Cannot send SMS: Twilio client not initialized.");
      return false;
    }

    if (!to) {
      console.error("❌ Cannot send SMS: No recipient phone number.");
      return false;
    }

    try {
      console.log(`📨 Sending SMS to ${to}...`);
      const message = await client.messages.create({
        body,
        from: fromPhoneNumber,
        to,
      });

      console.log(`✅ SMS sent! SID: ${message.sid}`);
      return true;
    } catch (error: any) {
      console.error("❌ Failed to send SMS:", error.message);
      return false;
    }
  },
};
