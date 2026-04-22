import fetch from 'node-fetch';

async function testOurBackend() {
    const url = "https://shopify-app-250065525755.us-central1.run.app/api/verify";
    // We use the dummy serial number that corresponds to the shop_a66c merchant
    // or we use the serial number the user provided earlier: proof_165b327f492ac895f82187dc
    const payload = {
        serial_number: "proof_165b327f492ac895f82187dc", 
        delivery_gps: { lat: 0, lng: 0 }
    };
    
    console.log(`Sending POST to OUR Cloud Run Backend: ${url}`);
    
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    console.log("OUR BACKEND RESPONSE:");
    if (data.merchant_media && data.merchant_media.length > 0) {
        console.log(`✅ Success! Video returned: ${data.merchant_media[0].url}`);
    } else {
        console.log(`❌ Failed to return merchant_media. Full payload:`, JSON.stringify(data, null, 2));
    }
}

testOurBackend();
