import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config();

const shop = 'taimoor1-2.myshopify.com';

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!projectId || !clientEmail || !privateKey) {
  console.error('❌ Missing Firebase env vars in .env');
  process.exit(1);
}

const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');

const app = getApps().length === 0
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApps()[0];

const db = getFirestore(app);

const doc = await db.collection('shopify_sessions').doc('offline_' + shop).get();
const token = doc.data()?.accessToken;

if (!token) {
  console.error('❌ No access token found in Firestore for', shop);
  process.exit(1);
}

console.log('✅ Got access token. Querying Shopify for Order #1089...\n');

const query = `{
  orders(first: 1, query: "name:#1089") {
    edges {
      node {
        id
        name
        statusPageUrl
        email
        phone
        shippingAddress { phone }
      }
    }
  }
}`;

const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
  },
  body: JSON.stringify({ query }),
});

const json = await res.json();
const order = json.data?.orders?.edges?.[0]?.node;

if (!order) {
  console.error('❌ Order #1089 not found.');
  console.log(JSON.stringify(json, null, 2));
} else {
  console.log('📦 Order Details:');
  console.log(JSON.stringify(order, null, 2));
}
