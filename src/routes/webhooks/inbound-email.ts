import { Router } from "express";
import { db } from "../../db/index.js";
import { inboundEmails } from "../../db/schema.js";
import { PostmarkInboundWebhookSchema } from "../../schemas.js";
import { resolveProvider } from "../../lib/inbound/alias-routing.js";

const router = Router();

router.post("/webhooks/inbound-email", async (req, res) => {
  const parsed = PostmarkInboundWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const payload = parsed.data;
  const messageId = payload.MessageID;
  const fromEmail = payload.FromFull?.Email ?? payload.From;
  const toEmail = (payload.ToFull?.[0]?.Email ?? payload.To).toLowerCase();
  const subject = payload.Subject ?? null;

  const provider = resolveProvider(toEmail);

  const [row] = await db
    .insert(inboundEmails)
    .values({
      messageId,
      fromEmail,
      toEmail,
      subject,
      rawPayload: payload,
      provider,
      ingestionChannel: "email",
      sourceAlias: toEmail,
      processingStatus: "pending",
    })
    .onConflictDoNothing({ target: inboundEmails.messageId })
    .returning({ id: inboundEmails.id });

  if (!row) {
    res.status(200).json({ accepted: true, deduplicated: true });
    return;
  }

  console.log(
    `[journalists-quotes-service] inbound email accepted id=${row.id} provider=${provider ?? "unknown"} alias=${toEmail} messageId=${messageId}`
  );
  res.status(200).json({ accepted: true, inboundEmailId: row.id });
});

export default router;
