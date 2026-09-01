// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Flow endpoint encryption (data_api_version 3.0). Meta encrypts every
// request with a per-request AES-128 key, itself RSA-OAEP-encrypted against
// our public key (uploaded via scripts/gen-whatsapp-flow-keys.mjs); we decrypt
// with the matching private key, then encrypt the response with the same AES
// key under a flipped IV, per Meta's spec. Pure crypto only — no Next.js or
// booking logic here, so the protocol can be reasoned about in isolation.
// ─────────────────────────────────────────────────────────────────────────────
import { constants, createCipheriv, createDecipheriv, privateDecrypt } from "node:crypto";

const AUTH_TAG_LENGTH = 16;

export type FlowRequestBody = {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
};

export function decryptFlowRequest(body: FlowRequestBody): {
  payload: any;
  aesKey: Buffer;
  iv: Buffer;
} {
  const privateKey = process.env.META_FLOW_PRIVATE_KEY;
  if (!privateKey) throw new Error("META_FLOW_PRIVATE_KEY not set");

  const aesKey = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(body.encrypted_aes_key, "base64")
  );

  const iv = Buffer.from(body.initial_vector, "base64");
  const flowDataBuf = Buffer.from(body.encrypted_flow_data, "base64");
  const ciphertext = flowDataBuf.subarray(0, flowDataBuf.length - AUTH_TAG_LENGTH);
  const authTag = flowDataBuf.subarray(flowDataBuf.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return { payload: JSON.parse(decrypted.toString("utf-8")), aesKey, iv };
}

export function encryptFlowResponse(payload: object, aesKey: Buffer, iv: Buffer): string {
  const flippedIv = Buffer.from(iv.map((b) => b ^ 0xff));

  const cipher = createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([encrypted, authTag]).toString("base64");
}
