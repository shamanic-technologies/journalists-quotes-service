import type { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SECONDS = 300;

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseSignatureHeader(
  header: string
): { timestamp: number; v1: string } | null {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      v1 = value;
    }
  }
  if (timestamp === null || v1 === null) return null;
  return { timestamp, v1 };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export interface HmacVerifyOptions {
  headerName?: string;
  secretEnvVar: string;
}

/**
 * Verify x-eg-signature header on incoming requests from email-gateway-service.
 * Header format: `t=<unix_seconds>,v1=<hex sha256(t + "." + body, secret)>`
 *
 * Requires `req.rawBody` to be populated — wire express.json with the
 * `verify` option in index.ts so it captures raw bytes alongside parsing.
 */
export function hmacVerify(opts: HmacVerifyOptions) {
  const headerName = opts.headerName ?? "x-eg-signature";

  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = process.env[opts.secretEnvVar];
    if (!secret) {
      console.error(
        `[journalists-quotes-service] HMAC secret env var ${opts.secretEnvVar} is not set`
      );
      res.status(500).json({ error: "Server misconfigured" });
      return;
    }

    const sigHeader = req.headers[headerName] as string | undefined;
    if (!sigHeader) {
      res.status(401).json({ error: "Missing signature header" });
      return;
    }

    const parsed = parseSignatureHeader(sigHeader);
    if (!parsed) {
      res.status(401).json({ error: "Malformed signature header" });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - parsed.timestamp) > REPLAY_WINDOW_SECONDS) {
      res.status(401).json({ error: "Signature timestamp outside replay window" });
      return;
    }

    if (!req.rawBody) {
      console.error(
        "[journalists-quotes-service] HMAC verify requires req.rawBody; ensure express.json is wired with verify option that sets req.rawBody"
      );
      res.status(500).json({ error: "Server misconfigured" });
      return;
    }
    const rawBody = req.rawBody.toString("utf8");

    const expected = createHmac("sha256", secret)
      .update(`${parsed.timestamp}.${rawBody}`)
      .digest("hex");

    if (!constantTimeEqual(expected, parsed.v1)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    next();
  };
}
