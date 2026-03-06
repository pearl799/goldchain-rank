import { createHmac } from "node:crypto";

/**
 * Compute HMAC-SHA256 signature for a Goldchain API request.
 *
 * sign_string = user_id + "\n" + timestamp_ms + "\n" + JSON.stringify(payload)
 */
export function sign(
  secretKey: string,
  userId: string,
  timestampMs: string,
  payloadJson: string,
): string {
  const signString = `${userId}\n${timestampMs}\n${payloadJson}`;
  return createHmac("sha256", secretKey).update(signString).digest("hex");
}
