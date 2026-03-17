function toIsoDate(value = new Date()) {
  return value.toISOString();
}

function nowIso() {
  return toIsoDate(new Date());
}

function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatPrice(amount, currency) {
  return `${amount} ${currency}`;
}

function formatDateTime(value) {
  if (!value) {
    return "Навсегда";
  }

  const date = new Date(value);
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandArgs(text) {
  const trimmed = String(text || "").trim();
  const [command, ...rest] = trimmed.split(/\s+/);
  return {
    command: command || "",
    rest,
    rawArgs: trimmed.slice(command.length).trim(),
  };
}

function normalizePlanCode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  const aliases = {
    "30": "30d",
    "30d": "30d",
    "30д": "30d",
    month: "30d",
    "90": "90d",
    "90d": "90d",
    "90д": "90d",
    quarter: "90d",
    lifetime: "lifetime",
    forever: "lifetime",
    eternal: "lifetime",
    foreversub: "lifetime",
    navsegda: "lifetime",
    "навсегда": "lifetime",
  };

  return aliases[normalized] || null;
}

function planTitle(code) {
  switch (code) {
    case "30d":
      return "Подписка на 30 дней";
    case "90d":
      return "Подписка на 90 дней";
    case "lifetime":
      return "Подписка навсегда";
    default:
      return code;
  }
}

function formatUserName(user) {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" ");
  }
  if (user.username) {
    return `@${user.username}`;
  }
  return `ID ${user.telegram_id || user.id}`;
}

module.exports = {
  addDays,
  commandArgs,
  escapeHtml,
  formatDateTime,
  formatPrice,
  formatUserName,
  normalizePlanCode,
  nowIso,
  planTitle,
  sleep,
  toIsoDate,
};
