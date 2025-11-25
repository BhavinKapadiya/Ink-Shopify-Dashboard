import crypto from "crypto";

export async function generateSHA256Hash(input: Buffer | Blob): Promise<string> {
  let buffer: Buffer;
  
  if (Buffer.isBuffer(input)) {
    buffer = input;
  } else {
    // Blob/File object - convert to buffer
    const arrayBuffer = await input.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  }
  
  // Generate SHA-256 hash
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return hash;
}