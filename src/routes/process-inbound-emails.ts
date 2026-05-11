import { Router } from "express";
import { processInboundEmails } from "../lib/inbound/process.js";

const router = Router();

router.post("/internal/process-inbound-emails", async (req, res) => {
  const batchSize =
    typeof req.body?.batchSize === "number" ? req.body.batchSize : undefined;
  const result = await processInboundEmails({ batchSize });
  res.json(result);
});

export default router;
