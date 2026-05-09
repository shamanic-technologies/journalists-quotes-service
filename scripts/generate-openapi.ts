import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Journalists Quotes Service",
    description:
      "Automates expert-quote outreach via Featured.com Premium API. One run = sync questions, score against brand context, pick top 1, generate pitch, submit answer.",
    version: "1.0.0",
  },
  servers: [
    { url: process.env.SERVICE_URL || "http://localhost:3050" },
  ],
});

const outputFile = join(projectRoot, "openapi.json");
writeFileSync(outputFile, JSON.stringify(document, null, 2));
console.log("openapi.json generated");
