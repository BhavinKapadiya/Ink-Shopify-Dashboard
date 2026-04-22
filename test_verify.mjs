import fetch from 'node-fetch';

async function testVerify() {
  const serial = 'proof_165b327f492ac895f82187dc';
  const url = 'https://shopify-app-250065525755.us-central1.run.app/api/verify';
  
  console.log(`Sending POST ${url}`);
  console.log(`Payload: { serial_number: "${serial}", delivery_gps: { lat: 23, lng: 72 } }`);
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial_number: serial, delivery_gps: { lat: 23, lng: 72 } })
  });
  
  const json = await res.json();
  console.log(`\nStatus: ${res.status}`);
  console.log(`\nResponse Data:`);
  console.log(JSON.stringify(json, null, 2));
}

testVerify();
