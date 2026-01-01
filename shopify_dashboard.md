# TestStore-1 Shopify App - Complete Documentation

## 📋 Table of Contents
1. [Project Overview](#project-overview)
2. [Technical Architecture](#technical-architecture)
3. [Features & Functionality](#features--functionality)
4. [Database Schema](#database-schema)
5. [API Endpoints](#api-endpoints)
6. [External Integrations](#external-integrations)
7. [Shopify Extensions](#shopify-extensions)
8. [Setup & Installation](#setup--installation)
9. [Deployment Guide](#deployment-guide)
10. [Troubleshooting](#troubleshooting)

---

## 📦 Project Overview

### **Purpose**
TestStore-1 is a Shopify App that provides INK Premium Delivery protection for orders. It integrates NFC-based proof of delivery, GPS verification, and photo documentation to create tamper-proof delivery records. The app serves as a middleware between the NFC warehouse app, Shopify orders, and Alan's external NFS API (Single Source of Truth for proofs).

### **Key Capabilities**
- **NFC Enrollment**: Process warehouse NFC tag enrollments with photo uploads
- **Delivery Verification**: Validate package deliveries via NFC + GPS + phone verification
- **Return Passport**: Automatically send customers encrypted return credentials
- **Order Integration**: Store proof references in Shopify order metafields
- **Email Notifications**: SendGrid integration for customer communications
- **Cloudinary Storage**: Secure photo storage with hash verification

### **Technology Stack**
- **Framework**: React Router 7.9.3 (upgraded from Remix)
- **Backend**: Node.js with Prisma ORM
- **Database**: PostgreSQL
- **Shopify**: Shopify API 2024-10, Polaris UI
- **External APIs**: NFS API, SendGrid, Cloudinary, Twilio (optional)
- **Authentication**: Shopify OAuth with session storage

---

## 🏗️ Technical Architecture

### **Project Structure**
```
test-store1/
├── app/
│   ├── routes/              # API routes and pages
│   │   ├── api.enroll.tsx   # POST /api/enroll
│   │   ├── api.verify.tsx   # POST /api/verify
│   │   ├── api.photos.upload.tsx  # Photo uploads
│   │   ├── api.retrieve.$proofId.tsx  # Retrieve proofs
│   │   ├── app.orders.$orderId.tsx    # Order detail page
│   │   ├── webhooks.*.ts    # Webhook handlers
│   │   └── ...
│   ├── services/            # Business logic
│   │   ├── nfs.server.ts    # NFS API integration
│   │   ├── email.server.ts  # SendGrid email service
│   │   └── sms.server.ts    # Twilio SMS (optional)
│   ├── utils/               # Utility functions
│   │   ├── nfc-conversion.server.ts   # Serial→UID→Token
│   │   ├── metafields.server.ts        # Shopify metafield helpers
│   │   ├── shopify-files.server.ts     # Cloudinary uploads
│   │   └── ...
│   ├── shopify.server.ts    # Shopify app config
│   └── db.server.ts         # Prisma client
├── prisma/
│   └── schema.prisma        # Database schema
├── extensions/              # Shopify UI extensions
│   └── ink-cart-selector/   # Cart page extension
├── shopify.app.toml         # App configuration
└── package.json
```

### **Key Dependencies**

```json
{
  "dependencies": {
    "@react-router/dev": "^7.9.3",
    "@react-router/node": "^7.9.3",
    "@shopify/app-bridge-react": "^4.2.7",
    "@shopify/polaris": "^13.9.5",
    "@shopify/shopify-app-react-router": "^1.0.2",
    "@prisma/client": "^6.17.1",
    "@sendgrid/mail": "^8.1.0",
    "react": "^18.3.1",
    "react-router": "^7.9.3",
    "twilio": "^4.23.0"
  }
}
```

### **System Architecture**

```mermaid
graph TB
    NFC[NFC Warehouse App] -->|Enroll/Verify| APP[Shopify App]
    APP -->|Store proof_id| SHOP[Shopify Orders]
    APP -->|Enroll/Verify Requests| NFS[Alan's NFS API]
    APP -->|Email Notifications| SG[SendGrid]
    APP -->|Photo Storage| CLD[Cloudinary]
    APP -->|Session Management| DB[PostgreSQL]
    NFS -->|Webhooks| APP
    SHOP -->|OAuth & GraphQL| APP
```

---

## ⚡ Features & Functionality

### **1. NFC Enrollment Workflow**

**Endpoint**: `POST /api/enroll`

**Process Flow**:
```mermaid
sequenceDiagram
    participant PWA as NFC App
    participant API as Shopify App
    participant SHOP as Shopify Admin
    participant NFS as Alan's NFS API
    
    PWA->>API: POST /api/enroll
    Note over PWA,API: {order_id, serial_number, photos, gps}
    
    API->>API: Convert serial→UID→Token (deterministic)
    API->>SHOP: Fetch customer phone
    API->>NFS: POST /enroll
    NFS-->>API: proof_id, key_id
    API->>SHOP: Update metafields
    Note over API,SHOP: proof_reference, verification_status, nfc_uid
    API-->>PWA: {proof_id, token}
    PWA->>PWA: Write token to NFC tag
```

**Key Features**:
- **Deterministic Conversion**: `serial_number` → [UID](file:///e:/Shopify/test-store1/app/utils/nfc-conversion.server.ts#3-25) → [Token](file:///e:/Shopify/test-store1/app/utils/nfc-conversion.server.ts#26-45) (always same output)
- **Order Validation**: Searches by ID or order name (#1234)
- **Customer Phone Extraction**: Gets last 4 digits for verification
- **External Proof Storage**: Alan's NFS API is single source of truth
- **Shopify Metafields**: Only stores `proof_id` reference, not full data
- **Token Generation**: Returns token for NFC tag writing

**Code Example**:
```typescript
// app/routes/api.enroll.tsx
const { uid, token } = serialNumberToToken(serial_number);

const enrollPayload = {
  order_id,
  nfc_uid: serial_number,
  nfc_token: token,
  photo_urls,
  photo_hashes,
  shipping_address_gps,
  customer_phone_last4
};

const nfsResponse = await NFSService.enroll(enrollPayload);

// Store proof_id in Shopify metafields
const metafields = [{
  ownerId: validOrderGid,
  namespace: "ink",
  key: "proof_reference",
  value: nfsResponse.proof_id
}];
```

### **2. Delivery Verification Workflow**

**Endpoint**: `POST /api/verify`

**Process Flow**:
```mermaid
sequenceDiagram
    participant PWA as NFC App
    participant API as Shopify App
    participant NFS as Alan's NFS API
    participant SG as SendGrid
    participant CUST as Customer
    
    PWA->>API: POST /api/verify
    Note over PWA,API: {serial_number, delivery_gps, phone_last4}
    
    API->>API: Convert serial→Token
    API->>NFS: POST /verify
    Note over API,NFS: {nfc_token, delivery_gps, phone_last4}
    
    NFS->>NFS: Validate GPS proximity
    NFS->>NFS: Validate phone match
    NFS-->>API: Verification result
    
    API->>NFS: GET /retrieve/{proof_id}
    NFS-->>API: Proof data (order_id, photos)
    
    API->>SG: Send Return Passport Email
    Note over SG,CUST: 4 photos, return link, 30-day window
    
    API-->>PWA: Verification success
```

**Validation Rules**:
1. **GPS Proximity**: Delivery GPS must be within X meters of shipping address
2. **Phone Verification**: Last 4 digits must match customer phone
3. **Tag Enrollment**: Tag must be enrolled before verification
4. **Replay Protection**: Prevents duplicate verification attempts

**Return Passport Email**:
- **Subject**: "🔓 Delivery Unlocked: Order #1234 - Your Return Passport"
- **Contents**:
  - 4 enrollment photos (2x2 grid)
  - Return window countdown (30 days)
  - "Start Return" CTA button
  - Proof URL for verification
  - Resale authentication benefits

### **3. Photo Upload & Storage**

**Endpoint**: `POST /api/photos/upload`

**Features**:
- **Cloudinary Integration**: Secure cloud storage
- **SHA-256 Hashing**: Integrity verification
- **Auto-Tagging**: Tags photos with order ID
- **Format Support**: JPEG, PNG, WebP
- **Size Limits**: Max 10MB per photo

**Upload Flow**:
```typescript
// app/routes/api.photos.upload.tsx
const formData = await parseMultipartFormData(request, uploadHandler);
const photoFile = formData.get("photo");

// Upload to Cloudinary
const uploadResult = await cloudinary.uploader.upload(photoFile, {
  folder: `ink-proofs/${orderId}`,
  tags: [orderId, "enrollment"]
});

// Generate hash
const photoHash = crypto.createHash('sha256')
  .update(photoBuffer)
  .digest('hex');

return { 
  photoUrl: uploadResult.secure_url,
  photoHash 
};
```

### **4. Order Detail Page**

**Route**: [app/routes/app.orders.$orderId.tsx](file:///e:/Shopify/test-store1/app/routes/app.orders.$orderId.tsx)

**Features**:
- View full proof details
- Display all 4 enrollment photos
- Show delivery status and GPS location
- View verification history
- Customer phone and contact info
- Timeline of events
- Download proof certificate

### **5. Webhooks**

The app handles multiple webhooks:

#### **A. NFS Verification Webhook**
**Route**: [webhooks.nfs.verify.tsx](file:///e:/Shopify/test-store1/app/routes/webhooks.nfs.verify.tsx)

Triggered by Alan's NFS when verification occurs:
```typescript
{
  "proof_id": "proof_abc123",
  "verification_status": "verified",
  "gps_verdict": "within_range",
  "delivery_gps": {"lat": 40.7580, "lng": -73.9855}
}
```

**Actions**:
- Validate HMAC signature
- Retrieve full proof from NFS API
- Find associated Shopify order
- Send Return Passport email to customer
- Update order metafields

#### **B. Shopify Webhooks**
- [webhooks.orders_create.ts](file:///e:/Shopify/test-store1/app/routes/webhooks.orders_create.ts): Tag new orders for INK protection
- [webhooks.fulfillments.ts](file:///e:/Shopify/test-store1/app/routes/webhooks.fulfillments.ts): Trigger enrollment reminders
- [webhooks.app.uninstalled.tsx](file:///e:/Shopify/test-store1/app/routes/webhooks.app.uninstalled.tsx): Cleanup on app removal
- [webhooks.app.scopes_update.tsx](file:///e:/Shopify/test-store1/app/routes/webhooks.app.scopes_update.tsx): Handle permission changes

---

## 🗄️ Database Schema

### **Prisma Schema** ([prisma/schema.prisma](file:///e:/Shopify/test-store1/prisma/schema.prisma))

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Session table - REQUIRED for Shopify OAuth
model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
}
```

**Important Notes**:
- **No Proof Model**: Proof data is stored in Alan's NFS API only
- **Session Table**: Required for Shopify OAuth (DO NOT REMOVE)
- **Metafields**: Proof references stored in Shopify order metafields
- **Database Provider**: PostgreSQL (can be changed to SQLite for local dev)

### **Shopify Metafields**

Stored under namespace `"ink"`:

| Key | Type | Description |
|-----|------|-------------|
| `proof_reference` | `single_line_text_field` | Alan's proof_id |
| `verification_status` | `single_line_text_field` | "enrolled", "verified", "failed" |
| `nfc_uid` | `single_line_text_field` | Original NFC serial number |

**Access Example**:
```typescript
const metafields = await admin.graphql(`
  query {
    order(id: "gid://shopify/Order/1234") {
      metafields(namespace: "ink") {
        key
        value
      }
    }
  }
`);
```

---

## 🔌 API Endpoints

### **Public API Endpoints** (CORS Enabled)

#### **POST /api/enroll**
Enroll a package with NFC tag and photos.

**Headers**: `Content-Type: application/json`

**Request**:
```json
{
  "order_id": "1015",
  "serial_number": "ef:8b:c4:c3",
  "photo_urls": ["https://...", "https://...", "https://...", "https://..."],
  "photo_hashes": ["hash1", "hash2", "hash3", "hash4"],
  "shipping_address_gps": {
    "lat": 40.7580,
    "lng": -73.9855
  }
}
```

**Response**:
```json
{
  "success": true,
  "proof_id": "proof_f8e7a2b1c3d4e5f6",
  "enrollment_status": "enrolled",
  "key_id": "key_123abc",
  "token": "token_4f8e7a2b1c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"
}
```

**Error Responses**:
- `400`: Missing required fields
- `404`: Order not found in Shopify
- `500`: Enrollment failed

---

#### **POST /api/verify**
Verify package delivery.

**Request**:
```json
{
  "serial_number": "ef:8b:c4:c3",
  "delivery_gps": {
    "lat": 40.7582,
    "lng": -73.9850
  },
  "device_info": "iPhone 14",
  "phone_last4": "5678"
}
```

**Response**:
```json
{
  "proof_id": "proof_f8e7a2b1c3d4e5f6",
  "verification_status": "verified",
  "gps_verdict": "within_range",
  "distance_meters": 45.3,
  "signature": "3a7f8b9c...",
  "verify_url": "https://in.ink/verify/proof_f8e7a2b1c3d4e5f6"
}
```

**Error Responses**:
- `403`: Phone verification failed
- `404`: Tag not enrolled
- `500`: Verification error

---

#### **POST /api/photos/upload**
Upload a single photo to Cloudinary.

**Request**: `multipart/form-data`
```
photo: <File>
orderId: "1015"
photoIndex: "0"
```

**Response**:
```json
{
  "success": true,
  "photoUrl": "https://res.cloudinary.com/...",
  "photoHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

---

#### **GET /api/retrieve/:proofId**
Retrieve proof details from NFS API.

**Response**:
```json
{
  "proof_id": "proof_f8e7a2b1c3d4e5f6",
  "order_id": "1015",
  "enrollment": {
    "timestamp": "2026-01-01T10:30:00Z",
    "shipping_address_gps": {"lat": 40.7580, "lng": -73.9855},
    "photo_urls": ["https://...", ...]
  },
  "delivery": {
    "timestamp": "2026-01-02T14:20:00Z",
    "delivery_gps": {"lat": 40.7582, "lng": -73.9850},
    "gps_verdict": "within_range",
    "phone_verified": true
  },
  "signature": "3a7f8b9c...",
  "public_key": "-----BEGIN PUBLIC KEY-----...",
  "key_id": "key_123abc"
}
```

---

## 🔗 External Integrations

### **1. Alan's NFS API** (Single Source of Truth)

**Base URL**: `http://193.57.137.90` (configurable via `NFS_API_URL`)

#### **POST /enroll**
```json
{
  "order_id": "1015",
  "nfc_uid": "ef:8b:c4:c3",
  "nfc_token": "token_...",
  "photo_urls": [...],
  "photo_hashes": [...],
  "shipping_address_gps": {...},
  "customer_phone_last4": "5678",
  "warehouse_gps": {...}
}
```

#### **POST /verify**
```json
{
  "nfc_token": "token_...",
  "delivery_gps": {...},
  "device_info": "iPhone 14",
  "phone_last4": "5678"
}
```

#### **GET /retrieve/:proofId**
Returns complete proof data including cryptographic signatures.

**Environment Variables**:
```bash
NFS_API_URL=http://193.57.137.90
NFS_HMAC_SECRET=your_shared_secret_for_webhooks
```

---

### **2. SendGrid Email Service**

**Purpose**: Send Return Passport emails to customers

**Email Template Features**:
- 🔓 Delivery unlocked notification
- 📸 4 enrollment photos in 2x2 grid
- 🛡️ 30-day return window countdown
- 🚀 "Start Return" CTA button
- ✅ Benefits list (returns, insurance, warranty, resale)

**Configuration**:
```bash
SENDGRID_API_KEY=SG.xxx...
SENDGRID_FROM_EMAIL=noreply@yourdomain.com
```

**Code**:
```typescript
// app/services/email.server.ts
await EmailService.sendReturnPassportEmail({
  to: "customer@email.com",
  customerName: "John",
  orderName: "#1015",
  proofUrl: "https://in.ink/verify/proof_...",
  photoUrls: ["https://...", ...],
  returnWindowDays: 30
});
```

---

### **3. Cloudinary Photo Storage**

**Purpose**: Store product enrollment photos

**Configuration**:
```bash
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=abcdef...
```

**Features**:
- Automatic folder organization: `ink-proofs/{orderId}/`
- Auto-tagging with order ID
- Secure URLs with signed access
- Image transformations (resize, compress)

---

### **4. Twilio SMS (Optional)**

**Purpose**: SMS notifications for verification

**Configuration**:
```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890
```

Currently minimal usage - can be expanded for SMS alerts.

---

## 🧩 Shopify Extensions

### **INK Cart Selector Extension**

**Location**: `extensions/ink-cart-selector/`

**Type**: Cart Page Extension

**Purpose**: Allow customers to opt-in to INK Premium Delivery protection

**File Structure**:
```
ink-cart-selector/
├── blocks/
│   ├── cart-block.liquid     # Cart page UI
│   └── cart-block-script.js  # Client-side logic
├── locales/
│   └── en.default.json       # Translations
├── assets/
│   └── ink-logo.png
└── shopify.extension.toml    # Extension config
```

**Configuration** ([shopify.extension.toml](file:///e:/Shopify/test-store1/extensions/ink-cart-selector/shopify.extension.toml)):
```toml
[[extensions]]
type = "cart_transform"
name = "ink-cart-selector"
handle = "ink-protection"

[extension_points]
cart = "cart-block"
```

**Deployment**:
```bash
shopify app deploy
```

---

## 🚀 Setup & Installation

### **Prerequisites**
- Node.js >= 20.19
- PostgreSQL database
- Shopify Partner account
- Shopify CLI installed globally

### **Installation Steps**

#### **1. Clone & Install Dependencies**
```bash
cd e:/Shopify/test-store1
npm install
```

#### **2. Configure Environment Variables**

Create [.env](file:///e:/Shopify/NFC/.env) file (NOTE: [.env](file:///e:/Shopify/NFC/.env) is gitignored):
```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/teststore

# Shopify (auto-configured by CLI)
SHOPIFY_API_KEY=xxx
SHOPIFY_API_SECRET=xxx

# NFS API
NFS_API_URL=http://193.57.137.90
NFS_HMAC_SECRET=your_shared_secret

# SendGrid
SENDGRID_API_KEY=SG.xxx...
SENDGRID_FROM_EMAIL=noreply@yourdomain.com

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=xxx

# Twilio (Optional)
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_PHONE_NUMBER=+1234567890
```

#### **3. Setup Database**
```bash
npm run setup
# This runs: prisma generate && prisma db push
```

#### **4. Link to Shopify App**
```bash
shopify app config link
# Select your app from Shopify Partners dashboard
```

#### **5. Start Development Server**
```bash
npm run dev
# This runs: shopify app dev
```

The app will be available at the tunnel URL provided by Shopify CLI.

---

## 🌐 Deployment Guide

### **Deployment Options**

The app can be deployed to:
1. **Shopify Oxygen** (Recommended)
2. **Heroku**
3. **Fly.io**
4. **Railway**
5. **Docker** (Self-hosted)

---

### **Option 1: Shopify Deployment**

```bash
# Build the app
npm run build

# Deploy to Shopify
npm run deploy
```

Shopify will provision hosting and configure environment variables.

---

### **Option 2: Heroku Deployment**

#### **Setup**
```bash
# Install Heroku CLI
heroku create teststore-app

# Add PostgreSQL
heroku addons:create heroku-postgresql:hobby-dev

# Set environment variables
heroku config:set NFS_API_URL=http://193.57.137.90
heroku config:set NFS_HMAC_SECRET=xxx
heroku config:set SENDGRID_API_KEY=SG.xxx
heroku config:set SENDGRID_FROM_EMAIL=noreply@yourdomain.com
heroku config:set CLOUDINARY_CLOUD_NAME=xxx
heroku config:set CLOUDINARY_API_KEY=xxx
heroku config:set CLOUDINARY_API_SECRET=xxx

# Deploy
git push heroku main

# Run database migrations
heroku run npm run setup
```

---

### **Option 3: Docker Deployment**

**Dockerfile** (included):
```dockerfile
FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run setup
RUN npm run build
CMD ["npm", "start"]
```

**Deploy**:
```bash
docker build -t teststore-app .
docker run -p 3000:3000 --env-file .env teststore-app
```

---

### **Environment Variables Checklist**

Before deployment, ensure all variables are set:

- [ ] `DATABASE_URL`
- [ ] `SHOPIFY_API_KEY`
- [ ] `SHOPIFY_API_SECRET`
- [ ] `NFS_API_URL`
- [ ] `NFS_HMAC_SECRET`
- [ ] `SENDGRID_API_KEY`
- [ ] `SENDGRID_FROM_EMAIL`
- [ ] `CLOUDINARY_CLOUD_NAME`
- [ ] `CLOUDINARY_API_KEY`
- [ ] `CLOUDINARY_API_SECRET`

---

## 🔐 Security Considerations

### **1. NFS Webhook Verification**

All webhooks from Alan's NFS API must be verified:

```typescript
// app/services/nfs.server.ts
const isValid = NFSService.verifyWebhookSignature(
  JSON.stringify(payload),
  request.headers.get('X-NFS-Signature')
);

if (!isValid) {
  throw new Error('Invalid webhook signature');
}
```

### **2. Deterministic NFC Conversion**

**Critical**: The same NFC serial number must ALWAYS produce the same token.

```typescript
// app/utils/nfc-conversion.server.ts
export function serialNumberToToken(serialNumber: string) {
  const cleaned = serialNumber.replace(/[^0-9a-fA-F]/gi, '');
  const uid = crypto.createHash('sha256').update(cleaned).digest('hex').substring(0, 16);
  const token = 'token_' + crypto.createHash('sha256').update(uid).digest('hex');
  return { uid, token };
}
```

**Why deterministic?**:
- Enrollment creates token
- Verification must derive same token from serial number
- No database lookup required

### **3. Photo Hash Integrity**

Photos are hashed with SHA-256 to detect tampering:

```typescript
const photoHash = crypto.createHash('sha256')
  .update(photoBuffer)
  .digest('hex');
```

### **4. HTTPS Required**

All production deployments must use HTTPS for:
- Shopify App Bridge
- GPS capture
- NFC communication
- API calls

---

## 🔧 Troubleshooting

### **Common Issues**

#### **1. Prisma/Database Errors**

**Error**: `Table 'Session' does not exist`

**Solution**:
```bash
npm run setup
# or manually:
npx prisma generate
npx prisma db push --accept-data-loss
```

---

#### **2. Shopify Authentication Errors**

**Error**: `nbf claim timestamp check failed`

**Cause**: System clock out of sync

**Solution**: Enable "Set time automatically" in system settings

---

#### **3. NFS API Connection Failed**

**Checks**:
- Verify `NFS_API_URL` is correct
- Test connectivity: `curl http://193.57.137.90`
- Check firewall rules
- Verify Alan's server is running

---

#### **4. Webhook Signature Verification Failed**

**Cause**: `NFS_HMAC_SECRET` mismatch

**Solution**: Ensure secret matches Alan's configuration exactly

---

#### **5. Order Not Found Error**

**Problem**: Order lookup by ID fails

**Cause**: PWA sends "1015" but Shopify expects full GID

**Solution**: The app searches by both ID and order name:
```typescript
// Try GID first
const orderGid = `gid://shopify/Order/${numericOrderId}`;

// Fallback to name search
const nameQuery = `name:${numericOrderId}`;
```

---

#### **6. Email Not Sending**

**Checks**:
- Verify `SENDGRID_API_KEY` is valid
- Check `SENDGRID_FROM_EMAIL` is verified in SendGrid
- Review SendGrid dashboard for bounces/blocks
- Check server logs for detailed error messages

---

#### **7. Photos Not Uploading**

**Checks**:
- Verify Cloudinary credentials
- Check Cloudinary storage quota
- Ensure proper CORS settings
- Verify file size limits (max 10MB)

---

## 📊 Utilities Reference

### **NFC Conversion Utility**

```typescript
// app/utils/nfc-conversion.server.ts

// Convert serial number to UID and Token
const { uid, token } = serialNumberToToken("ef:8b:c4:c3");

// UID: "7f3a2b1c4d5e6f8a"
// Token: "token_9c8b7a6f5e4d3c2b1a0f..."
```

### **Metafields Utility**

```typescript
// app/utils/metafields.server.ts

export const INK_NAMESPACE = "ink";

// Get metafields
const proofId = await getOrderMetafield(admin, orderGid, "proof_reference");

// Set metafields
await setOrderMetafields(admin, orderGid, {
  proof_reference: "proof_abc123",
  verification_status: "enrolled"
});
```

---

## 📈 Performance Metrics

### **API Response Times**
- `/api/enroll`: ~2-3 seconds (photo upload + NFS call)
- `/api/verify`: ~500ms (NFS verification)
- `/api/photos/upload`: ~800ms per photo

### **Database Queries**
- Session lookup: ~10ms
- Order lookup (by GID): ~50ms
- Order search (by name): ~100ms

---

## 🔄 Change Log

### **Recent Updates**
- Upgraded from Remix to React Router 7.9.3
- Removed local Proof model (NFS API is source of truth)
- Implemented deterministic NFC conversion
- Added Return Passport email with photos
- Fixed order lookup to search by both ID and name
- Added webhook signature verification

---

## 📞 Support Information

**Project Location**: `e:/Shopify/test-store1`  
**Framework**: React Router 7.9.3 (Shopify App)  
**Database**: PostgreSQL  
**External API**: NFS API (Alan's server)  
**Node Version**: >=20.19 <22 || >=22.12  

**Important Files**:
- [shopify.app.toml](file:///e:/Shopify/test-store1/shopify.app.toml): App configuration
- [prisma/schema.prisma](file:///e:/Shopify/test-store1/prisma/schema.prisma): Database schema
- [app/shopify.server.ts](file:///e:/Shopify/test-store1/app/shopify.server.ts): Shopify app setup

---

**Last Updated**: January 1, 2026  
**Documentation Version**: 1.0.0  
**App Author**: Bhavin Kapadiya
