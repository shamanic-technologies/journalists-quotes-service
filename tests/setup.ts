process.env.JOURNALISTS_QUOTES_SERVICE_API_KEY = "test-api-key";
process.env.JOURNALISTS_QUOTES_SERVICE_DATABASE_URL =
  process.env.JOURNALISTS_QUOTES_SERVICE_DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/journalists_quotes_service_test";
process.env.NODE_ENV = "test";
process.env.SCORE_THRESHOLD = "0.5";
process.env.FEATURED_API_BASE_URL = "https://featured.test/api/external-users";
process.env.INBOUND_ALIAS_ROUTING = JSON.stringify([
  { alias: "haro@inbox.test", provider: "haro" },
  { alias: "sos@inbox.test", provider: "sos" },
  { alias: "qwoted@inbox.test", provider: "qwoted" },
]);
process.env.JQS_INBOUND_HMAC_SECRET = "test-hmac-secret";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email-gateway.test";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-email-gateway-key";
