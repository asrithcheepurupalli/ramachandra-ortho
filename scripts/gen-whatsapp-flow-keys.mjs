// One-off: generate an RSA keypair for WhatsApp Flow endpoint encryption and
// upload the public key to Meta. Run once per phone number. Prints the
// private key PEM to paste into .env.local / Vercel as META_FLOW_PRIVATE_KEY
// — this script never writes it to disk.
import { generateKeyPairSync } from "node:crypto";

const TOKEN = process.env.META_WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const GRAPH_VERSION = "v21.0";

if (!TOKEN || !PHONE_NUMBER_ID) {
  console.error("Missing META_WHATSAPP_TOKEN or META_PHONE_NUMBER_ID in env.");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

console.log("\n--- META_FLOW_PRIVATE_KEY (paste into .env.local / Vercel) ---\n");
console.log(privateKey);
console.log("--- end private key ---\n");

const res = await fetch(
  `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/whatsapp_business_encryption`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ business_public_key: publicKey }),
  }
);
const body = await res.json();
console.log(`Meta upload response (${res.status}):`, JSON.stringify(body, null, 2));

if (!res.ok || body.success !== true) {
  console.error("\nPublic key upload FAILED — do not proceed until this succeeds.");
  process.exit(1);
}
console.log("\nPublic key uploaded. Save the private key above, then continue with the plan.");
