const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env"));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseAdminIds(value) {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item)),
  );
}

const config = {
  botToken: requireEnv("BOT_TOKEN"),
  adminIds: parseAdminIds(process.env.ADMIN_IDS || ""),
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH || "./data/bot.sqlite"),
  supabase: {
    url: process.env.SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    schema: process.env.SUPABASE_SCHEMA || "public",
  },
  defaults: {
    downloadUrl: process.env.DEFAULT_DOWNLOAD_URL || "",
    paymentText:
      process.env.DEFAULT_PAYMENT_TEXT ||
      'Оплатите подписку по инструкции администратора и нажмите "Я оплатил".',
    currency: process.env.CURRENCY || "RUB",
    prices: {
      "30d": Number(process.env.DEFAULT_PRICE_30D || "500"),
      "90d": Number(process.env.DEFAULT_PRICE_90D || "1200"),
      lifetime: Number(process.env.DEFAULT_PRICE_LIFETIME || "2500"),
    },
  },
};

module.exports = { config };
