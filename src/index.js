const { config } = require("./config");
const { BotDatabase } = require("./db");
const { SupabaseSync } = require("./supabase");
const {
  adminChatKeyboard,
  adminPanelKeyboard,
  backToMainKeyboard,
  downloadKeyboard,
  helpKeyboard,
  mainInlineKeyboard,
  mainKeyboard,
  registerKeyboard,
  subscriptionKeyboard,
  supportKeyboard,
} = require("./keyboards");
const { TelegramApi } = require("./telegram");
const {
  commandArgs,
  escapeHtml,
  formatDateTime,
  formatUserName,
  sleep,
} = require("./utils");

const api = new TelegramApi(config.botToken);
const db = new BotDatabase(config.dbPath, config.defaults);
const supabaseSync = new SupabaseSync(config.supabase);
const sessions = new Map();

function isAdmin(telegramId) {
  const numericTelegramId = Number(telegramId);
  return config.adminIds.has(numericTelegramId);
}

function isTextAdmin(telegramId) {
  const numericTelegramId = Number(telegramId);
  return config.textAdminIds.has(numericTelegramId);
}

function canHandleText(telegramId) {
  return isAdmin(telegramId) || isTextAdmin(telegramId);
}

function shouldGrantAdmin(telegramId) {
  const numericTelegramId = Number(telegramId);
  return config.adminIds.has(numericTelegramId);
}

function getSession(telegramId) {
  return sessions.get(telegramId) || null;
}

function setSession(telegramId, session) {
  sessions.set(telegramId, session);
}

function clearSession(telegramId) {
  sessions.delete(telegramId);
}

function clearReplySessionsForTarget(targetTelegramId) {
  for (const [telegramId, session] of sessions.entries()) {
    if (session?.mode === "active_reply_chat" && session.targetTelegramId === targetTelegramId) {
      sessions.delete(telegramId);
    }
  }
}

function getAdminTelegramIds() {
  return [...config.adminIds];
}

function getTextAdminTelegramIds() {
  return [...new Set([...config.adminIds, ...config.textAdminIds])];
}

function getReplyTargetTelegramId(message) {
  const replyText = message.reply_to_message?.text || message.reply_to_message?.caption || "";
  const match = replyText.match(/Telegram ID:\s*(\d+)/i);
  if (!match) {
    return null;
  }

  const targetTelegramId = Number(match[1]);
  return Number.isInteger(targetTelegramId) ? targetTelegramId : null;
}

function getUserChatContext(telegramId) {
  if (!db.isChatEnabled(telegramId)) {
    return null;
  }

  return {
    type: "support",
  };
}

function chatContextLines(chatContext) {
  if (!chatContext) {
    return [];
  }

  if (chatContext.type === "support") {
    return ["Чат: открыт"];
  }

  return [];
}

async function upsertPanelMessage(chatId, messageId, text, options = {}) {
  if (messageId) {
    try {
      await api.editMessageText(chatId, messageId, text, options);
      return;
    } catch (error) {
      if (error.message.includes("message is not modified")) {
        return;
      }
      console.error("Failed to edit panel message:", error.message);
    }
  }

  await api.sendMessage(chatId, text, options);
}

function mainPanelText(adminFlag) {
  return [
    "Главное меню",
    "Используйте кнопки ниже для навигации по боту.",
    adminFlag ? "У вас открыт админ-доступ." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function readyRegisterText(user) {
  if (!user?.client_login || !user.client_password) {
    return null;
  }

  return `Готовый register: register ${user.client_login} ${user.client_password}`;
}

function hasClientCredentials(user) {
  return Boolean(user?.client_login && user?.client_password);
}

function credentialsText(user) {
  return [
    "Данные для входа в клиент:",
    `Логин: ${user.client_login || "-"}`,
    `Пароль: ${user.client_password || "-"}`,
    readyRegisterText(user),
    "",
    `Статус регистрации: ${hasClientCredentials(user) ? "завершена" : "не завершена"}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function registerPromptText() {
  return [
    "Аккаунт клиента еще не создан.",
    "Напишите /register, чтобы самому задать никнейм и пароль.",
  ].join("\n");
}

function registerStartText(user) {
  return [
    hasClientCredentials(user)
      ? "Текущие логин и пароль будут заменены."
      : "Настроим аккаунт клиента вручную.",
    "Отправьте никнейм одним сообщением.",
    "Разрешены латинские буквы, цифры, _, -, .",
    "Длина: от 3 до 24 символов.",
    "/cancel - отмена",
  ].join("\n");
}

function registerPasswordPromptText(clientLogin) {
  return [
    `Никнейм: ${clientLogin}`,
    "Теперь отправьте пароль одним сообщением.",
    "Длина: от 6 до 64 символов, без пробелов.",
    "/cancel - отмена",
  ].join("\n");
}

function normalizeCredentialInput(value) {
  return String(value || "").trim();
}

function validateClientLogin(value) {
  const clientLogin = normalizeCredentialInput(value);
  if (clientLogin.length < 3 || clientLogin.length > 24) {
    return {
      value: null,
      error: "Никнейм должен быть длиной от 3 до 24 символов.",
    };
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(clientLogin)) {
    return {
      value: null,
      error: "Никнейм может содержать только латинские буквы, цифры и символы _, -, .",
    };
  }

  return { value: clientLogin, error: null };
}

function validateClientPassword(value) {
  const clientPassword = normalizeCredentialInput(value);
  if (clientPassword.length < 6 || clientPassword.length > 64) {
    return {
      value: null,
      error: "Пароль должен быть длиной от 6 до 64 символов.",
    };
  }

  if (/\s/.test(clientPassword)) {
    return {
      value: null,
      error: "Пароль не должен содержать пробелы.",
    };
  }

  return { value: clientPassword, error: null };
}

function isClientLoginTakenError(error) {
  return error?.code === "CLIENT_LOGIN_TAKEN";
}

async function syncUserRecord(telegramId) {
  if (!supabaseSync.enabled) {
    return;
  }

  const user = db.getUserByTelegramId(telegramId);
  if (!user) {
    return;
  }

  const payload = {
    telegram_id: user.telegram_id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    is_admin: isAdmin(user.telegram_id),
    client_login: user.client_login,
    client_password: user.client_password,
    has_access: true, // Всегда есть доступ если зареган (упрощаем для синхронизации)
    created_at: user.created_at,
    updated_at: user.updated_at,
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await supabaseSync.upsertUser(payload);
      return;
    } catch (error) {
      if (attempt === 3) {
        console.error("Supabase user sync failed:", error.message);
        return;
      }

      await sleep(500);
    }
  }
}

async function syncAllUsersToSupabase() {
  if (!supabaseSync.enabled) {
    return;
  }

  let synced = 0;
  for (const user of db.getAllUsers()) {
    await syncUserRecord(user.telegram_id);
    synced += 1;
  }

  console.log(`Supabase user backfill completed: ${synced}`);
}

async function syncSettingRecord(key) {
  if (!supabaseSync.enabled) {
    return;
  }

  try {
    await supabaseSync.upsertSetting({
      key,
      value: db.getSetting(key) || "",
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Supabase setting sync failed:", error.message);
  }
}

async function pullSettingFromSupabase(key) {
  if (!supabaseSync.enabled) {
    return;
  }

  try {
    const remoteSetting = await supabaseSync.getSetting(key);
    if (!remoteSetting || !remoteSetting.value) {
      return;
    }

    db.setSetting(key, remoteSetting.value);
  } catch (error) {
    console.error("Supabase setting pull failed:", error.message);
  }
}

function helpText() {
  return [
    "Команды:",
    "/start - главное меню",
    "/register - задать свой логин и пароль",
    "/login - показать логин и пароль клиента",
    "/download - получить ссылку на скачивание",
    "/support - написать администратору",
  ].join("\n");
}

function adminHelpText() {
  return [
    "Админ-команды:",
    "/admin - открыть админ-панель",
    "/setdownload <url> - изменить ссылку на скачивание без перезапуска",
    "/getdownload - показать текущую ссылку на скачивание",
    "/resetlogin <telegram_id> - сбросить логин и пароль пользователя",
    "/say <telegram_id> <текст> - отправить сообщение от имени бота",
    "/broadcast <текст> - рассылка всем пользователям",
    "/users - статистика",
    "/closechat <telegram_id> - закрыть чат с пользователем",
    "/cancel - выйти из режима ответа или рассылки",
  ].join("\n");
}

async function sendMainMenu(chatId, adminFlag) {
  await api.sendMessage(chatId, "Нижнее меню включено. Можно пользоваться кнопками.", {
    reply_markup: mainKeyboard(adminFlag),
  });
}

async function sendContextualMainMenu(chatId, telegramId) {
  await sendMainMenu(chatId, isAdmin(telegramId));
}

async function showMainPanel(chatId, telegramId, messageId = null) {
  await upsertPanelMessage(chatId, messageId, mainPanelText(isAdmin(telegramId)), {
    reply_markup: mainInlineKeyboard(isAdmin(telegramId)),
  });
}

async function showLogin(chatId, telegramId, messageId = null) {
  const user = db.getUserByTelegramId(telegramId);
  if (!hasClientCredentials(user)) {
    await upsertPanelMessage(chatId, messageId, registerPromptText(), {
      reply_markup: registerKeyboard(),
    });
    return;
  }

  await upsertPanelMessage(chatId, messageId, credentialsText(user), {
    reply_markup: subscriptionKeyboard(true),
  });
}

async function showRegister(chatId, telegramId, messageId = null) {
  const user = db.getUserByTelegramId(telegramId);
  if (hasClientCredentials(user)) {
    await upsertPanelMessage(
      chatId,
      messageId,
      "Вы уже зарегистрированы. Повторная регистрация невозможна.\nИспользуйте /login, чтобы увидеть ваши данные.",
      {
        reply_markup: backToMainKeyboard(),
      },
    );
    return;
  }

  setSession(telegramId, { mode: "awaiting_client_login" });
  await upsertPanelMessage(chatId, messageId, registerStartText(user));
}

async function sendCredentialsOrRegisterPrompt(chatId, telegramId) {
  const user = db.getUserByTelegramId(telegramId);

  if (hasClientCredentials(user)) {
    await api.sendMessage(chatId, credentialsText(user));
    return;
  }

  await api.sendMessage(
    chatId,
    [
      "Логин и пароль еще не настроены.",
      "Напишите /register и задайте свой никнейм и пароль вручную.",
    ].join("\n"),
    {
      reply_markup: registerKeyboard(),
    },
  );
}

async function showDownload(chatId, telegramId, messageId = null) {
  const user = db.getUserByTelegramId(telegramId);
  if (!hasClientCredentials(user)) {
    await upsertPanelMessage(
      chatId,
      messageId,
      "Скачивание доступно только после регистрации.",
      {
        reply_markup: registerKeyboard(),
      },
    );
    return;
  }

  await pullSettingFromSupabase("download_url");
  const url = db.getSetting("download_url");
  if (!url) {
    await upsertPanelMessage(chatId, messageId, "Ссылка на скачивание пока не настроена.", {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  await upsertPanelMessage(chatId, messageId, "Актуальная ссылка на скачивание:", {
    reply_markup: downloadKeyboard(url),
  });
}

async function showHelp(chatId, telegramId, messageId = null) {
  await upsertPanelMessage(chatId, messageId, helpText(), {
    reply_markup: helpKeyboard(isAdmin(telegramId)),
  });
}

async function showSupportPrompt(chatId, telegramId, messageId = null) {
  if (getUserChatContext(telegramId)) {
    await upsertPanelMessage(
      chatId,
      messageId,
      "Чат с администратором уже активен. Просто отправьте следующее сообщение, и оно уйдёт админу.",
      {
        reply_markup: supportKeyboard(),
      },
    );
    return;
  }

  db.setChatEnabled(telegramId, true);
  await notifyTextAdminsAboutOpenedChat(telegramId, "Пользователь открыл чат");
  await upsertPanelMessage(
    chatId,
    messageId,
    "Чат с администратором открыт. Просто отправляйте сообщения сюда.",
    {
      reply_markup: supportKeyboard(),
    },
  );
}

function adminPanelText() {
  const stats = db.getStats();
  return [
    "Админ-панель",
    `Пользователей: ${stats.users}`,
    "",
    "Для быстрых действий используйте кнопки ниже.",
  ].join("\n");
}

async function showAdminPanel(chatId, telegramId, messageId = null) {
  if (!isAdmin(telegramId)) {
    await upsertPanelMessage(chatId, messageId, "Нет доступа к админ-панели.", {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  await upsertPanelMessage(chatId, messageId, adminPanelText(), {
    reply_markup: adminPanelKeyboard(),
  });
}

async function showAdminStats(chatId, telegramId, messageId = null) {
  if (!isAdmin(telegramId)) {
    await upsertPanelMessage(chatId, messageId, "Нет доступа к статистике.", {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  const stats = db.getStats();
  await upsertPanelMessage(
    chatId,
    messageId,
    [
      "Статистика",
      `Пользователей: ${stats.users}`,
    ].join("\n"),
    {
      reply_markup: adminPanelKeyboard(),
    },
  );
}

async function sendToRecipients(telegramIds, text, options = {}) {
  for (const telegramId of telegramIds) {
    try {
      await api.sendMessage(telegramId, text, options);
    } catch (error) {
      console.error(`Failed to send message to ${telegramId}:`, error.message);
    }
  }
}

async function sendToAdmins(text, options = {}) {
  await sendToRecipients(getAdminTelegramIds(), text, options);
}

async function sendToTextAdmins(text, options = {}) {
  await sendToRecipients(getTextAdminTelegramIds(), text, options);
}

async function closeUserChat(targetTelegramId) {
  const targetUser = db.getUserByTelegramId(targetTelegramId);
  if (!targetUser) {
    return false;
  }

  if (!db.isChatEnabled(targetTelegramId)) {
    return false;
  }

  db.setChatEnabled(targetTelegramId, false);
  clearReplySessionsForTarget(targetTelegramId);
  await api.sendMessage(targetTelegramId, "Чат с администратором закрыт.");
  return true;
}

async function notifyTextAdminsAboutOpenedChat(telegramId, title) {
  const user = db.getUserByTelegramId(telegramId);
  if (!user) {
    return;
  }

  await sendToTextAdmins(
    [
      `<b>${escapeHtml(title)}</b>`,
      `Пользователь: <b>${escapeHtml(formatUserName(user))}</b>`,
      `Telegram ID: <code>${user.telegram_id}</code>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: adminChatKeyboard(user.telegram_id),
    },
  );
}

async function relayUserChatMessage(currentUser, message) {
  const messageText = message.text || "";
  const chatContext = getUserChatContext(currentUser.telegram_id);
  if (!chatContext || !messageText) {
    return false;
  }

  db.saveSupportMessage(currentUser.id, message.message_id, messageText);
  await sendToTextAdmins(
    [
      "<b>Чат с пользователем</b>",
      `От: <b>${escapeHtml(formatUserName(currentUser))}</b>`,
      `Telegram ID: <code>${currentUser.telegram_id}</code>`,
      ...chatContextLines(chatContext),
      "",
      escapeHtml(messageText),
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: adminChatKeyboard(currentUser.telegram_id),
    },
  );
  return true;
}

async function handleTextAdminCommand(message, currentUser) {
  const { command, rest } = commandArgs(message.text);
  const chatId = message.chat.id;

  if (command === "/cancel") {
    clearSession(currentUser.telegram_id);
    await api.sendMessage(chatId, "Режим сброшен.");
    return true;
  }

  if (command === "/closechat") {
    const targetId = Number(rest[0]);
    if (!Number.isInteger(targetId)) {
      await api.sendMessage(chatId, "Использование: /closechat <telegram_id>");
      return true;
    }

    const closed = await closeUserChat(targetId);
    if (!closed) {
      await api.sendMessage(chatId, `Чат с пользователем ${targetId} уже закрыт.`);
      return true;
    }

    await api.sendMessage(chatId, `Чат с пользователем ${targetId} закрыт.`);
    return true;
  }

  return false;
}

async function handleAdminCommand(message, currentUser) {
  const { command, rest, rawArgs } = commandArgs(message.text);
  const chatId = message.chat.id;

  if (command === "/admin") {
    await showAdminPanel(chatId, currentUser.telegram_id);
    return true;
  }

  if (command === "/setdownload") {
    if (!rawArgs) {
      await api.sendMessage(chatId, "Использование: /setdownload <url>");
      return true;
    }
    db.setSetting("download_url", rawArgs);
    await syncSettingRecord("download_url");
    await api.sendMessage(chatId, "Ссылка на скачивание обновлена.");
    return true;
  }

  if (command === "/getdownload") {
    await pullSettingFromSupabase("download_url");
    const currentUrl = db.getSetting("download_url") || "(пусто)";
    await api.sendMessage(chatId, `Текущая ссылка:\n${currentUrl}`);
    return true;
  }

  if (command === "/resetlogin") {
    const targetId = Number(rest[0]);
    if (!Number.isInteger(targetId)) {
      await api.sendMessage(chatId, "Использование: /resetlogin <telegram_id>");
      return true;
    }

    try {
      db.clearUserCredentials(targetId);
      await syncUserRecord(targetId);
      await api.sendMessage(
        chatId,
        [
          "Логин и пароль сброшены.",
          "Пользователь должен заново пройти /register и сам задать новые данные.",
        ].join("\n"),
      );
      await api.sendMessage(
        targetId,
        [
          "Администратор сбросил ваш логин и пароль.",
          "Напишите /register и задайте новый никнейм и пароль вручную.",
        ].join("\n"),
        {
          reply_markup: registerKeyboard(),
        },
      );
    } catch (error) {
      await api.sendMessage(chatId, `Ошибка: ${error.message}`);
    }
    return true;
  }

  if (command === "/say") {
    const targetId = Number(rest[0]);
    const text = rawArgs.replace(String(rest[0] || ""), "").trim();
    if (!Number.isInteger(targetId) || !text) {
      await api.sendMessage(chatId, "Использование: /say <telegram_id> <текст>");
      return true;
    }

    await api.sendMessage(targetId, text);
    await api.sendMessage(chatId, "Сообщение отправлено.");
    return true;
  }

  if (command === "/broadcast") {
    if (rawArgs) {
      let sent = 0;
      for (const user of db.getAllUsers()) {
        try {
          await api.sendMessage(user.telegram_id, rawArgs);
          sent += 1;
          await sleep(40);
        } catch (error) {
          console.error(`Broadcast failed for ${user.telegram_id}:`, error.message);
        }
      }
      await api.sendMessage(chatId, `Рассылка завершена. Отправлено: ${sent}`);
      return true;
    }

    setSession(currentUser.telegram_id, { mode: "awaiting_broadcast" });
    await api.sendMessage(chatId, "Пришлите текст для рассылки. /cancel чтобы выйти.");
    return true;
  }

  if (command === "/users") {
    await showAdminStats(chatId, currentUser.telegram_id);
    return true;
  }

  if (command === "/cancel") {
    clearSession(currentUser.telegram_id);
    await api.sendMessage(chatId, "Режим сброшен.");
    return true;
  }

  return false;
}

async function handleUserCommand(message, currentUser) {
  const { command } = commandArgs(message.text);
  const chatId = message.chat.id;

  switch (command) {
    case "/start":
      await sendContextualMainMenu(chatId, currentUser.telegram_id);
      await showMainPanel(chatId, currentUser.telegram_id);
      return true;
    case "/register":
      await showRegister(chatId, currentUser.telegram_id);
      return true;
    case "/login":
      await showLogin(chatId, currentUser.telegram_id);
      return true;
    case "/download":
      await showDownload(chatId, currentUser.telegram_id);
      return true;
    case "/support":
      await showSupportPrompt(chatId, currentUser.telegram_id);
      return true;
    case "/help":
      await showHelp(chatId, currentUser.telegram_id);
      return true;
    case "/cancel":
      clearSession(currentUser.telegram_id);
      await api.sendMessage(chatId, "Текущий режим отменен.");
      return true;
    default:
      return false;
  }
}

async function handleTextMessage(message) {
  if (!message.from || !message.chat) {
    return;
  }

  const currentUser = db.upsertUser(message.from, shouldGrantAdmin(message.from.id));
  await syncUserRecord(currentUser.telegram_id);
  const chatId = message.chat.id;
  const session = getSession(currentUser.telegram_id);
  const messageText = message.text || "";
  const replyTargetTelegramId = canHandleText(currentUser.telegram_id)
    ? getReplyTargetTelegramId(message)
    : null;

  if (messageText.startsWith("/")) {
    if (canHandleText(currentUser.telegram_id)) {
      const handledTextAdmin = await handleTextAdminCommand(message, currentUser);
      if (handledTextAdmin) {
        return;
      }
    }

    if (isAdmin(currentUser.telegram_id)) {
      const handledAdmin = await handleAdminCommand(message, currentUser);
      if (handledAdmin) {
        return;
      }
    }

    const handledUser = await handleUserCommand(message, currentUser);
    if (handledUser) {
      return;
    }
  }

  if (session?.mode === "awaiting_client_login") {
    const { value: clientLogin, error } = validateClientLogin(messageText);
    if (error) {
      await api.sendMessage(chatId, `${error}\n\n${registerStartText(currentUser)}`);
      return;
    }

    setSession(currentUser.telegram_id, {
      mode: "awaiting_client_password",
      clientLogin,
    });
    await api.sendMessage(chatId, registerPasswordPromptText(clientLogin));
    return;
  }

  if (session?.mode === "awaiting_client_password") {
    const { value: clientPassword, error } = validateClientPassword(messageText);
    if (error) {
      await api.sendMessage(chatId, `${error}\n\n${registerPasswordPromptText(session.clientLogin)}`);
      return;
    }

    try {
      db.setUserCredentials(currentUser.telegram_id, session.clientLogin, clientPassword);
    } catch (saveError) {
      if (isClientLoginTakenError(saveError)) {
        setSession(currentUser.telegram_id, { mode: "awaiting_client_login" });
        await api.sendMessage(
          chatId,
          ["Этот никнейм уже занят.", "", registerStartText(currentUser)].join("\n"),
        );
        return;
      }

      throw saveError;
    }

    clearSession(currentUser.telegram_id);
    await syncUserRecord(currentUser.telegram_id);
    await api.sendMessage(chatId, "Логин и пароль сохранены.");
    await showLogin(chatId, currentUser.telegram_id);
    return;
  }

  if (isAdmin(currentUser.telegram_id) && session?.mode === "awaiting_broadcast") {
    clearSession(currentUser.telegram_id);
    let sent = 0;
    for (const user of db.getAllUsers()) {
      try {
        await api.sendMessage(user.telegram_id, message.text || "");
        sent += 1;
        await sleep(40);
      } catch (error) {
        console.error(`Broadcast failed for ${user.telegram_id}:`, error.message);
      }
    }
    await api.sendMessage(chatId, `Рассылка завершена. Отправлено: ${sent}`);
    return;
  }

  if (replyTargetTelegramId) {
    if (!db.isChatEnabled(replyTargetTelegramId)) {
      await api.sendMessage(chatId, `Чат с пользователем ${replyTargetTelegramId} уже закрыт.`);
      return;
    }

    await api.sendMessage(replyTargetTelegramId, messageText);
    await api.sendMessage(
      chatId,
      `Сообщение отправлено пользователю ${replyTargetTelegramId}. /cancel чтобы выйти из активного чата.`,
    );
    return;
  }

  if (canHandleText(currentUser.telegram_id) && session?.mode === "active_reply_chat") {
    if (!db.isChatEnabled(session.targetTelegramId)) {
      clearSession(currentUser.telegram_id);
      await api.sendMessage(chatId, `Чат с пользователем ${session.targetTelegramId} уже закрыт.`);
      return;
    }

    await api.sendMessage(session.targetTelegramId, messageText);
    await api.sendMessage(chatId, "Сообщение отправлено пользователю. /cancel чтобы выйти из чата.");
    return;
  }

  if (session?.mode === "awaiting_support_message") {
    clearSession(currentUser.telegram_id);
    db.saveSupportMessage(currentUser.id, message.message_id, messageText);
    const safeText = escapeHtml(messageText);
    await sendToAdmins(
      [
        "<b>Новое сообщение в поддержку</b>",
        `От: <b>${escapeHtml(formatUserName(currentUser))}</b>`,
        `Telegram ID: <code>${currentUser.telegram_id}</code>`,
        "",
        safeText,
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Ответить", callback_data: `admin-reply:${currentUser.telegram_id}` }],
          ],
        },
      },
    );
    await api.sendMessage(chatId, "Сообщение отправлено администраторам.");
    return;
  }

  switch (messageText) {
    case "Логин":
      await showLogin(chatId, currentUser.telegram_id);
      return;
    case "Скачать":
      await showDownload(chatId, currentUser.telegram_id);
      return;
    case "Поддержка":
      await showSupportPrompt(chatId, currentUser.telegram_id);
      return;
    case "Помощь":
      await showHelp(chatId, currentUser.telegram_id);
      return;
    case "Админ":
      if (isAdmin(currentUser.telegram_id)) {
        await showAdminPanel(chatId, currentUser.telegram_id);
      }
      return;
  }

  if (!canHandleText(currentUser.telegram_id) && await relayUserChatMessage(currentUser, message)) {
    await api.sendMessage(chatId, "Сообщение отправлено администратору.");
    return;
  }

  await sendContextualMainMenu(chatId, currentUser.telegram_id);
}

async function handleCallbackQuery(callbackQuery) {
  const from = callbackQuery.from;
  const data = callbackQuery.data || "";
  const currentUser = db.upsertUser(from, shouldGrantAdmin(from.id));
  await syncUserRecord(currentUser.telegram_id);
  const message = callbackQuery.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;

  const [action, value] = data.split(":");

  try {
    if (action === "menu") {
      if (value === "main") {
        await showMainPanel(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Главное меню" });
        return;
      }

      if (value === "login") {
        await showLogin(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Логин клиента" });
        return;
      }

      if (value === "register") {
        await showRegister(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Регистрация" });
        return;
      }

      if (value === "download") {
        await showDownload(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Скачивание" });
        return;
      }

      if (value === "support") {
        await showSupportPrompt(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Поддержка" });
        return;
      }

      if (value === "help") {
        await showHelp(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Помощь" });
        return;
      }
    }

    if (action === "admin-reply") {
      if (!canHandleText(currentUser.telegram_id)) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Нет доступа", show_alert: true });
        return;
      }
      const targetTelegramId = Number(value);
      if (!db.isChatEnabled(targetTelegramId)) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Чат уже закрыт", show_alert: true });
        return;
      }

      setSession(currentUser.telegram_id, {
        mode: "active_reply_chat",
        targetTelegramId,
      });
      await api.answerCallbackQuery(callbackQuery.id, { text: "Чат открыт" });
      await api.sendMessage(
        currentUser.telegram_id,
        `Чат с пользователем ${targetTelegramId} открыт. Все следующие сообщения уйдут ему от имени бота. /cancel чтобы выйти.`,
      );
      return;
    }

    if (action === "admin-close-chat") {
      if (!canHandleText(currentUser.telegram_id)) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Нет доступа", show_alert: true });
        return;
      }

      const targetTelegramId = Number(value);
      const closed = await closeUserChat(targetTelegramId);
      if (!closed) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Чат уже закрыт", show_alert: true });
        return;
      }

      clearSession(currentUser.telegram_id);
      await api.answerCallbackQuery(callbackQuery.id, { text: "Чат закрыт" });
      await api.sendMessage(currentUser.telegram_id, `Чат с пользователем ${targetTelegramId} закрыт.`);
      return;
    }

    if (action === "admin") {
      if (!isAdmin(currentUser.telegram_id)) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Нет доступа", show_alert: true });
        return;
      }

      if (value === "panel") {
        await showAdminPanel(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Админ-панель" });
        return;
      }

      if (value === "stats") {
        await showAdminStats(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Статистика" });
        return;
      }

      if (value === "broadcast-mode") {
        setSession(currentUser.telegram_id, { mode: "awaiting_broadcast" });
        await api.sendMessage(
          currentUser.telegram_id,
          "Пришлите текст. Следующее сообщение будет отправлено всем пользователям. /cancel чтобы выйти.",
        );
        await api.answerCallbackQuery(callbackQuery.id, { text: "Режим рассылки включен" });
        return;
      }

      if (value === "help") {
        await upsertPanelMessage(chatId, messageId, adminHelpText(), {
          reply_markup: adminPanelKeyboard(),
        });
        await api.answerCallbackQuery(callbackQuery.id, { text: "Подсказка отправлена" });
        return;
      }
    }
  } catch (error) {
    console.error("Callback error:", error);
    try {
      await api.answerCallbackQuery(callbackQuery.id, {
        text: error.message.slice(0, 180),
        show_alert: true,
      });
    } catch (nestedError) {
      console.error("Failed to answer callback query:", nestedError);
    }
  }
}

async function handleUpdate(update) {
  try {
    if (update.message) {
      await handleTextMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (error) {
    console.error("Update handling error:", error);
  }
}

function publicBotCommands() {
  return [
    { command: "start", description: "Открыть меню" },
    { command: "register", description: "Создать логин" },
    { command: "login", description: "Логин клиента" },
    { command: "download", description: "Скачать" },
    { command: "support", description: "Написать админу" },
  ];
}

function adminBotCommands() {
  return [
    ...publicBotCommands(),
    { command: "admin", description: "Админ-панель" },
    { command: "setdownload", description: "Сменить ссылку" },
    { command: "getdownload", description: "Показать ссылку" },
    { command: "closechat", description: "Закрыть чат" },
    { command: "cancel", description: "Выйти из режима" },
  ];
}

function textAdminBotCommands() {
  return [
    { command: "closechat", description: "Закрыть чат" },
    { command: "cancel", description: "Выйти из чата" },
  ];
}

async function setupBotCommands() {
  try {
    await api.setMyCommands(publicBotCommands());

    const scopedTelegramIds = new Set([
      ...db.getAllUsers().map((user) => user.telegram_id),
      ...getAdminTelegramIds(),
      ...getTextAdminTelegramIds(),
    ]);

    for (const telegramId of scopedTelegramIds) {
      let commands = publicBotCommands();
      if (isAdmin(telegramId)) {
        commands = adminBotCommands();
      } else if (isTextAdmin(telegramId)) {
        commands = textAdminBotCommands();
      }

      try {
        await api.setMyCommands(commands, {
          scope: {
            type: "chat",
            chat_id: telegramId,
          },
        });
      } catch (error) {
        console.error(`Failed to set scoped commands for ${telegramId}:`, error.message);
      }
    }
  } catch (error) {
    console.error("Failed to set bot commands:", error.message);
  }
}

async function startPolling() {
  let offset = 0;

  while (true) {
    try {
      const updates = await api.getUpdates({
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(3000);
    }
  }
}

async function main() {
  await setupBotCommands();

  console.log("--- Supabase Diagnostic ---");
  console.log(`SUPABASE_URL found: ${Boolean(config.supabase.url)}`);
  console.log(`SUPABASE_KEY/SERVICE_ROLE found: ${Boolean(config.supabase.serviceRoleKey)}`);
  
  if (config.supabase.serviceRoleKey) {
     const key = config.supabase.serviceRoleKey;
     console.log(`Key starts with: ${key.substring(0, 10)}...`);
  }
  
  console.log(`Supabase Sync: ${supabaseSync.enabled ? "ENABLED" : "DISABLED"}`);
  console.log("---------------------------");

  if (supabaseSync.enabled) {
    console.log(`Supabase URL: ${config.supabase.url}`);
  }

  await syncAllUsersToSupabase();
  await pullSettingFromSupabase("download_url");
  await syncSettingRecord("download_url");
  console.log("Bot started.");
  await startPolling();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
