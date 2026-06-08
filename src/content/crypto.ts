/**
 * AES-CTR decryption for encraw transport
 */

export async function decryptAesCtr(
  encryptedBuffer: ArrayBuffer,
  hexKey: string
): Promise<ArrayBuffer> {
  const keyBytes = hexToUint8Array(hexKey);
  const counter = new Uint8Array(16); // 16 zero bytes (12-byte nonce + 4-byte counter)

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-CTR" },
    false,
    ["decrypt"]
  );

  return crypto.subtle.decrypt(
    { name: "AES-CTR", counter, length: 32 },
    cryptoKey,
    encryptedBuffer
  );
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
