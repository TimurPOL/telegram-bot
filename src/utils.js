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

function formatDateTime(value) {
  if (!value) {
    return "Неизвестно";
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
  formatUserName,
  nowIso,
  sleep,
  toIsoDate,
};
