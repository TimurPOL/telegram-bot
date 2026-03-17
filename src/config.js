const fs = require("node:fs");
const path = require("node:path");

function normalizeEnvValue(value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

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
  const value = normalizeEnvValue(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseAdminIds(value) {
  const normalized = normalizeEnvValue(value || "");
  if (!normalized) {
    return new Set();
  }

  return new Set(
    normalized
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
  dbPath: path.resolve(process.cwd(), normalizeEnvValue(process.env.DB_PATH) || "./data/bot.sqlite"),
  supabase: {
    url: normalizeEnvValue(process.env.SUPABASE_URL) || "",
    serviceRoleKey: normalizeEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY) || "",
    schema: normalizeEnvValue(process.env.SUPABASE_SCHEMA) || "public",
  },
  defaults: {
    downloadUrl: normalizeEnvValue(process.env.DEFAULT_DOWNLOAD_URL) || "",
    paymentText:
      normalizeEnvValue(process.env.DEFAULT_PAYMENT_TEXT) ||
      'РћРїР»Р°С‚РёС‚Рµ РїРѕРґРїРёСЃРєСѓ РїРѕ РёРЅСЃС‚СЂСѓРєС†РёРё Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР° Рё РЅР°Р¶РјРёС‚Рµ "РЇ РѕРїР»Р°С‚РёР»".',
    currency: normalizeEnvValue(process.env.CURRENCY) || "RUB",
    prices: {
      "7d": Number(normalizeEnvValue(process.env.DEFAULT_PRICE_7D) || "125"),
      "30d": Number(normalizeEnvValue(process.env.DEFAULT_PRICE_30D) || "500"),
      "90d": Number(normalizeEnvValue(process.env.DEFAULT_PRICE_90D) || "1200"),
      lifetime: Number(normalizeEnvValue(process.env.DEFAULT_PRICE_LIFETIME) || "2500"),
    },
  },
};

module.exports = { config };
