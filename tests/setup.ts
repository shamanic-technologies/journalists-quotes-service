process.env.JOURNALISTS_QUOTES_SERVICE_API_KEY = "test-api-key";
process.env.JOURNALISTS_QUOTES_SERVICE_DATABASE_URL =
  process.env.JOURNALISTS_QUOTES_SERVICE_DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/journalists_quotes_service_test";
process.env.NODE_ENV = "test";
process.env.SCORE_THRESHOLD = "0.5";
process.env.FEATURED_USERNAME = "test-featured-user";
process.env.FEATURED_PASSWORD = "test-featured-pass";
process.env.FEATURED_API_BASE_URL = "https://featured.test/api/external-users";
