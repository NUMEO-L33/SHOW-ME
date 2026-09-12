import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type AssetTicketPayload = {
  guideId: string;
  expiresAt: number;
  nonce: string;
};

function signature(secret: Buffer, encodedPayload: string) {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

export function createAssetTicket(
  secret: Buffer,
  guideId: string,
  now = Date.now(),
  ttlMs = 60 * 60 * 1000,
) {
  if (secret.length < 32) throw new Error("Asset ticket secret must contain at least 32 bytes");
  if (!guideId || ttlMs <= 0) throw new Error("Asset ticket input is invalid");
  const payload: AssetTicketPayload = {
    guideId,
    expiresAt: now + ttlMs,
    nonce: randomBytes(8).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    token: `${encodedPayload}.${signature(secret, encodedPayload)}`,
    expiresAt: payload.expiresAt,
  };
}

export function verifyAssetTicket(
  secret: Buffer,
  token: string,
  guideId: string,
  now = Date.now(),
) {
  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return false;
  const expectedSignature = signature(secret, encodedPayload);
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<AssetTicketPayload>;
    return payload.guideId === guideId && Number.isSafeInteger(payload.expiresAt) && Number(payload.expiresAt) > now;
  } catch {
    return false;
  }
}
