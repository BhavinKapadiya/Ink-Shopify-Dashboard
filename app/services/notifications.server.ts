import sendgrid from "@sendgrid/mail";
import twilio from "twilio";
import { EmailService } from "./email.server";

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = TWILIO_SID && TWILIO_TOKEN ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;

export type NotificationType = 
  | "outForDelivery" 
  | "delivered" 
  | "deliveryConfirmed" 
  | "hours4" 
  | "hours24" 
  | "hours48" 
  | "return7d" 
  | "return48h";

export interface NotificationPayload {
  type: NotificationType;
  toEmail?: string;
  toPhone?: string;
  customerName: string;
  orderName: string;
  merchantName: string;
  verifyUrl?: string; // Tap link / Verification link
  returnWindowDays?: number;
}

export const NotificationService = {
  async dispatch(payload: NotificationPayload, settings: any) {
    const { type, toEmail, toPhone } = payload;
    
    // 1. Check if specific notification type is enabled in settings
    const isEnabled = this.isNotificationEnabled(type, settings);
    if (!isEnabled) {
      console.log(`[NotificationService] Skipped ${type} - disabled by merchant settings.`);
      return false;
    }

    const { channels } = settings;
    
    let emailSent = false;
    let smsSent = false;

    // 2. Dispatch SMS if channel is enabled
    if (channels?.sms && toPhone) {
      smsSent = await this.sendSms(payload);
    } else if (channels?.sms && !toPhone) {
      console.warn(`[NotificationService] SMS channel enabled but no phone number provided for order ${payload.orderName}`);
    }

    // 3. Dispatch Email if channel is enabled
    if (channels?.email && toEmail) {
      emailSent = await this.sendEmail(payload);
    }

    return emailSent || smsSent;
  },

  isNotificationEnabled(type: NotificationType, settings: any): boolean {
    if (!settings) return false;
    const { delivery, reminders, returnReminders } = settings;
    
    switch (type) {
      case "outForDelivery": return !!delivery?.outForDelivery;
      case "delivered": return !!delivery?.delivered;
      case "deliveryConfirmed": return !!delivery?.deliveryConfirmed;
      case "hours4": return !!reminders?.hours4;
      case "hours24": return !!reminders?.hours24;
      case "hours48": return !!reminders?.hours48;
      case "return7d": return !!returnReminders?.days7;
      case "return48h": return !!returnReminders?.hours48;
      default: return false;
    }
  },

  async sendSms(payload: NotificationPayload): Promise<boolean> {
    if (!twilioClient) {
      console.warn("⚠️ Twilio credentials missing. SMS service disabled.");
      return false;
    }

    if (!payload.toPhone) return false;

    // Format message based on type
    let messageBody = "";
    
    switch (payload.type) {
      case "outForDelivery":
        messageBody = `Hi ${payload.customerName}, your order ${payload.orderName} from ${payload.merchantName} is out for delivery today. Get ready to tap your INK sticker!`;
        break;
      case "delivered":
        messageBody = `Your package ${payload.orderName} has arrived! Tap the INK sticker on the box with your phone to verify delivery and unlock your return window.`;
        break;
      case "deliveryConfirmed":
        messageBody = `Verified! Your INK delivery for ${payload.orderName} is confirmed. ${payload.verifyUrl ? `View your passport: ${payload.verifyUrl}` : ""}`;
        break;
      case "hours4":
        messageBody = `Hi ${payload.customerName}, we noticed your package ${payload.orderName} arrived earlier today. Please tap the INK sticker to verify it!`;
        break;
      case "hours24":
        messageBody = `Reminder: Tap the INK sticker on your recent delivery (${payload.orderName}) to verify it and unlock your ${payload.returnWindowDays || 30}-day return window.`;
        break;
      case "hours48":
        messageBody = `Final reminder from ${payload.merchantName}: Please tap the INK sticker on your order ${payload.orderName} to properly register your delivery.`;
        break;
      case "return7d":
        messageBody = `Hi ${payload.customerName}, you have 7 days left to return order ${payload.orderName}. Click here to start a return: ${payload.verifyUrl || "Please contact our support."}`;
        break;
      case "return48h":
        messageBody = `Warning: Your return window for ${payload.merchantName} order ${payload.orderName} closes in 48 hours. Manage it here: ${payload.verifyUrl || "Please contact our support."}`;
        break;
    }

    try {
      await twilioClient.messages.create({
        body: messageBody,
        from: TWILIO_PHONE,
        to: payload.toPhone,
      });
      console.log(`✅ SMS (${payload.type}) sent via Twilio to ${payload.toPhone}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Twilio SMS failed:`, error.message);
      return false;
    }
  },

  async sendEmail(payload: NotificationPayload): Promise<boolean> {
    if (!payload.toEmail) return false;

    // For Delivery Confirmed, we use the existing Return Passport Email template
    if (payload.type === "deliveryConfirmed" && payload.verifyUrl) {
      return EmailService.sendReturnPassportEmail({
        to: payload.toEmail,
        customerName: payload.customerName,
        orderName: payload.orderName,
        merchantName: payload.merchantName,
        proofUrl: payload.verifyUrl,
        returnWindowDays: payload.returnWindowDays,
      });
    }

    // For other types, we'd normally expand email.server.ts to handle them,
    // but for now we will send a basic text notification.
    const subjectPrefix = `[${payload.merchantName}] Order ${payload.orderName}: `;
    let subject = "";
    let body = "";

    switch (payload.type) {
      case "outForDelivery":
        subject = subjectPrefix + "Out for Delivery";
        body = `Hi ${payload.customerName},\n\nYour order is out for delivery today. Get ready to tap your INK sticker!`;
        break;
      case "delivered":
        subject = subjectPrefix + "Delivered - Tap Your Sticker!";
        body = `Your package has arrived!\n\nTap the INK sticker on the box with your phone to verify delivery and unlock your return window.`;
        break;
      case "hours4":
      case "hours24":
      case "hours48":
        subject = subjectPrefix + "Friendly Reminder to Tap Your Sticker";
        body = `Hi ${payload.customerName},\n\nWe noticed your package arrived recently. Please tap the INK sticker to verify it and unlock returns.`;
        break;
      case "return7d":
        subject = subjectPrefix + "7 Days Left to Return";
        body = `Hi ${payload.customerName},\n\nYou have 7 days left to return your order. Need to start a return? Click here: ${payload.verifyUrl}`;
        break;
      case "return48h":
        subject = subjectPrefix + "Return Window Closing Soon";
        body = `Warning: Your return window closes in 48 hours. Manage it here: ${payload.verifyUrl}`;
        break;
    }

    // Simplified send via existing Sendgrid setup (if available)
    if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL) {
        try {
           sendgrid.setApiKey(process.env.SENDGRID_API_KEY);
           await sendgrid.send({
              to: payload.toEmail,
              from: process.env.SENDGRID_FROM_EMAIL,
              subject,
              text: body,
           });
           console.log(`✅ Email (${payload.type}) sent to ${payload.toEmail}`);
           return true;
        } catch (error: any) {
           console.error(`❌ SendGrid failed:`, error.message);
           return false;
        }
    }

    return false;
  }
};
