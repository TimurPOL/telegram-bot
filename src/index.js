const { config } = require("./config");
const { BotDatabase } = require("./db");
const { SupabaseSync } = require("./supabase");
const {
  adminChatKeyboard,
  adminOrderKeyboard,
  adminPanelKeyboard,
  backToMainKeyboard,
  downloadKeyboard,
  helpKeyboard,
  mainInlineKeyboard,
  mainKeyboard,
  orderPaymentKeyboard,
  plansKeyboard,
  registerKeyboard,
  subscriptionKeyboard,
  supportKeyboard,
} = require("./keyboards");
const { TelegramApi } = require("./telegram");
const {
  commandArgs,
  escapeHtml,
  formatDateTime,
  formatPrice,
  formatUserName,
  normalizePlanCode,
  planTitle,
  sleep,
} = require("./utils");

const api = new TelegramApi(config.botToken);
const db = new BotDatabase(config.dbPath, config.defaults);
const supabaseSync = new SupabaseSync(config.supabase);
const sessions = new Map();

function isAdmin(telegramId) {
  const numericTelegramId = Number(telegramId);
  if (config.adminIds.has(numericTelegramId)) {
    return true;
  }

  const existingUser = db.getUserByTelegramId(numericTelegramId);
  return Boolean(existingUser?.is_admin);
}

function shouldGrantAdmin(telegramId) {
  const numericTelegramId = Number(telegramId);
  if (config.adminIds.has(numericTelegramId)) {
    return true;
  }

  const existingUser = db.getUserByTelegramId(numericTelegramId);
  if (existingUser?.is_admin) {
    return true;
  }

  return config.adminIds.size === 0 && !db.hasAnyAdmin();
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

function getAdminTelegramIds() {
  return [...new Set([...config.adminIds, ...db.getAdminTelegramIds()])];
}

function getUserChatContext(telegramId) {
  const openOrder = db.getLatestOpenOrderByTelegramId(telegramId);
  if (openOrder) {
    return {
      type: "order",
      order: openOrder,
    };
  }

  const entitlement = db.getUserEntitlementByTelegramId(telegramId);
  if (!entitlement.has_access) {
    return null;
  }

  return {
    type: "subscription",
    entitlement,
  };
}

function chatContextLines(chatContext) {
  if (!chatContext) {
    return [];
  }

  if (chatContext.type === "order") {
    return [
      `Заказ: <code>${escapeHtml(chatContext.order.public_id)}</code>`,
      `Тариф: ${escapeHtml(planTitle(chatContext.order.plan_code))}`,
      `Статус заказа: ${escapeHtml(chatContext.order.status)}`,
    ];
  }

  if (chatContext.entitlement.is_lifetime) {
    return ["Подписка: активна навсегда"];
  }

  if (chatContext.entitlement.expires_at) {
    return [`Подписка активна до: ${escapeHtml(formatDateTime(chatContext.entitlement.expires_at))} UTC`];
  }

  return ["Подписка: активна"];
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

function planText(plan) {
  return `${plan.title} - ${formatPrice(plan.price, plan.currency)}`;
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

function credentialsText(user, entitlement) {
  return [
    "Данные для входа в клиент:",
    `Логин: ${user.client_login || "-"}`,
    `Пароль: ${user.client_password || "-"}`,
    readyRegisterText(user),
    "",
    `Статус доступа: ${entitlement.has_access ? "активен" : "не активен"}`,
    entitlement.is_lifetime
      ? "Подписка: навсегда"
      : entitlement.expires_at
        ? `Подписка до: ${formatDateTime(entitlement.expires_at)} UTC`
        : "Подписка пока не активна",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function registerPromptText() {
  return [
    "Аккаунт клиента еще не создан.",
    "Напишите /register, чтобы создать логин и пароль.",
  ].join("\n");
}

function ensureClientCredentials(telegramId) {
  const user = db.getUserByTelegramId(telegramId);
  if (!user) {
    return null;
  }

  if (user.client_login && user.client_password) {
    return user;
  }

  return db.ensureUserCredentials(telegramId);
}

async function syncUserRecord(telegramId) {
  if (!supabaseSync.enabled) {
    return;
  }

  const user = db.getUserByTelegramId(telegramId);
  if (!user) {
    return;
  }

  const entitlement = db.getUserEntitlementByTelegramId(telegramId);
  const payload = {
    telegram_id: user.telegram_id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    is_admin: Boolean(user.is_admin),
    client_login: user.client_login,
    client_password: user.client_password,
    has_access: entitlement.has_access,
    plan_code: entitlement.plan_code,
    expires_at: entitlement.expires_at,
    is_lifetime: entitlement.is_lifetime,
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
    ensureClientCredentials(user.telegram_id);
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

function pricesText() {
  const lines = ["Доступные тарифы:"];
  for (const plan of db.getPlans()) {
    lines.push(`- ${planText(plan)}`);
  }
  return lines.join("\n");
}

function subscriptionText(entitlement) {
  if (!entitlement.has_access) {
    return "Подписка не активна.";
  }

  if (entitlement.is_lifetime) {
    return "Подписка активна: навсегда.";
  }

  return `Подписка активна до ${formatDateTime(entitlement.expires_at)} UTC.`;
}

function helpText() {
  return [
    "Команды:",
    "/start - главное меню",
    "/prices - показать прайс",
    "/buy - выбрать тариф",
    "/mysub - статус подписки",
    "/register - создать логин и пароль клиента",
    "/login - показать логин клиента",
    "/download - получить ссылку на скачивание",
    "/support - написать администратору",
  ].join("\n");
}

function adminHelpText() {
  return [
    "Админ-команды:",
    "/admin - открыть админ-панель",
    "/setprice <30d|90d|lifetime> <цена> - изменить цену",
    "/setdownload <url> - изменить ссылку на скачивание без перезапуска",
    "/getdownload - показать текущую ссылку на скачивание",
    "/setpayment <текст> - изменить инструкцию по оплате",
    "/grant <telegram_id> <30d|90d|lifetime> - выдать подписку вручную",
    "/resetlogin <telegram_id> - пересоздать логин и пароль пользователя",
    "/say <telegram_id> <текст> - отправить сообщение от имени бота",
    "/broadcast <текст> - рассылка всем пользователям",
    "/orders - список заказов, ожидающих одобрения",
    "/users - статистика",
    "/cancel - выйти из режима ответа или рассылки",
  ].join("\n");
}

function formatOrderForAdmin(order) {
  return [
    "<b>Новый запрос на оплату</b>",
    `Заказ: <code>${escapeHtml(order.public_id)}</code>`,
    `Пользователь: <b>${escapeHtml(
      formatUserName({
        telegram_id: order.telegram_id,
        username: order.username,
        first_name: order.first_name,
        last_name: order.last_name,
      }),
    )}</b>`,
    `Telegram ID: <code>${order.telegram_id}</code>`,
    `Тариф: ${escapeHtml(planTitle(order.plan_code))}`,
    `Сумма: ${escapeHtml(formatPrice(order.amount, order.currency))}`,
    `Статус: ${escapeHtml(order.status)}`,
  ].join("\n");
}

function formatOrderForUser(order) {
  const paymentText = db.getSetting("payment_text") || "Инструкция по оплате пока не заполнена.";
  return [
    `Заказ создан: <code>${escapeHtml(order.public_id)}</code>`,
    `Тариф: ${escapeHtml(planTitle(order.plan_code))}`,
    `Сумма: ${escapeHtml(formatPrice(order.amount, order.currency))}`,
    "",
    "Инструкция по оплате:",
    escapeHtml(paymentText),
    "",
    'После оплаты нажмите "Я оплатил".',
  ].join("\n");
}

async function sendMainMenu(chatId, adminFlag) {
  await api.sendMessage(chatId, "Нижнее меню включено. Можно пользоваться кнопками.", {
    reply_markup: mainKeyboard(adminFlag),
  });
}

async function showMainPanel(chatId, telegramId, messageId = null) {
  await upsertPanelMessage(chatId, messageId, mainPanelText(isAdmin(telegramId)), {
    reply_markup: mainInlineKeyboard(isAdmin(telegramId)),
  });
}

async function showPrices(chatId, telegramId, messageId = null) {
  await upsertPanelMessage(chatId, messageId, pricesText(), {
    reply_markup: plansKeyboard(db.getPlans()),
  });
}

async function showBuy(chatId, telegramId, messageId = null) {
  await upsertPanelMessage(chatId, messageId, "Выберите тариф:", {
    reply_markup: plansKeyboard(db.getPlans()),
  });
}

async function showSubscription(chatId, telegramId, messageId = null) {
  const entitlement = db.getUserEntitlementByTelegramId(telegramId);
  await upsertPanelMessage(chatId, messageId, subscriptionText(entitlement), {
    reply_markup: subscriptionKeyboard(entitlement.has_access),
  });
}

async function showLogin(chatId, telegramId, messageId = null) {
  let user = ensureClientCredentials(telegramId);
  if (!user) {
    await upsertPanelMessage(chatId, messageId, registerPromptText(), {
      reply_markup: registerKeyboard(),
    });
    return;
  }

  const entitlement = db.getUserEntitlementByTelegramId(telegramId);
  await syncUserRecord(telegramId);
  await upsertPanelMessage(chatId, messageId, credentialsText(user, entitlement), {
    reply_markup: subscriptionKeyboard(entitlement.has_access),
  });
}

async function showRegister(chatId, telegramId, messageId = null) {
  const user = db.ensureUserCredentials(telegramId);
  const entitlement = db.getUserEntitlementByTelegramId(telegramId);
  await syncUserRecord(telegramId);
  await upsertPanelMessage(
    chatId,
    messageId,
    [`Аккаунт клиента готов.`, "", credentialsText(user, entitlement)].join("\n"),
    {
      reply_markup: subscriptionKeyboard(entitlement.has_access),
    },
  );
}

async function showDownload(chatId, telegramId, messageId = null) {
  const entitlement = db.getUserEntitlementByTelegramId(telegramId);
  if (!entitlement.has_access) {
    await upsertPanelMessage(
      chatId,
      messageId,
      "Скачивание доступно только при активной подписке.",
      {
        reply_markup: subscriptionKeyboard(false),
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

  setSession(telegramId, { mode: "awaiting_support_message" });
  await upsertPanelMessage(
    chatId,
    messageId,
    "Пришлите одно сообщение, я отправлю его администраторам.",
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
    `Активных подписок: ${stats.activeSubscriptions}`,
    `Ожидающих заказов: ${stats.pendingOrders}`,
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
      `Активных подписок: ${stats.activeSubscriptions}`,
      `Ожидающих заказов: ${stats.pendingOrders}`,
    ].join("\n"),
    {
      reply_markup: adminPanelKeyboard(),
    },
  );
}

async function sendToAdmins(text, options = {}) {
  for (const adminId of getAdminTelegramIds()) {
    try {
      await api.sendMessage(adminId, text, options);
    } catch (error) {
      console.error(`Failed to send admin message to ${adminId}:`, error.message);
    }
  }
}

async function notifyAdminsAboutNewOrder(orderId) {
  const order = db.getOrderById(orderId);
  if (!order) {
    return;
  }

  await sendToAdmins(
    [
      "<b>Пользователь выбрал тариф</b>",
      `Заказ: <code>${escapeHtml(order.public_id)}</code>`,
      `Пользователь: <b>${escapeHtml(
        formatUserName({
          telegram_id: order.telegram_id,
          username: order.username,
          first_name: order.first_name,
          last_name: order.last_name,
        }),
      )}</b>`,
      `Telegram ID: <code>${order.telegram_id}</code>`,
      `Тариф: ${escapeHtml(planTitle(order.plan_code))}`,
      `Сумма: ${escapeHtml(formatPrice(order.amount, order.currency))}`,
      "Чат с пользователем уже открыт.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: adminChatKeyboard(order.telegram_id),
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
  await sendToAdmins(
    [
      chatContext.type === "order" ? "<b>Чат по покупке</b>" : "<b>Чат с пользователем</b>",
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

async function createOrderAndPrompt(chatId, telegramUser, planCode) {
  const user = db.getUserByTelegramId(telegramUser.id);
  const plan = db.getPlan(planCode);
  if (!user || !plan) {
    await api.sendMessage(chatId, "Не удалось создать заказ.");
    return;
  }

  await pullSettingFromSupabase("payment_text");
  const order = db.createOrder(user.id, plan);
  await api.sendMessage(chatId, formatOrderForUser(order), {
    parse_mode: "HTML",
    reply_markup: orderPaymentKeyboard(order.id),
  });
  await api.sendMessage(
    chatId,
    "Чат с администратором открыт. Можете сразу написать сюда сообщение по оплате или по заказу.",
    {
      reply_markup: supportKeyboard(),
    },
  );
  await notifyAdminsAboutNewOrder(order.id);
}

async function notifyAdminsAboutPayment(orderId) {
  const order = db.getOrderById(orderId);
  if (!order) {
    return;
  }

  await sendToAdmins(formatOrderForAdmin(order), {
    parse_mode: "HTML",
    reply_markup: adminOrderKeyboard(order.id, order.telegram_id),
  });
}

async function approveOrder(orderId, adminTelegramId) {
  const order = db.getOrderById(orderId);
  if (!order) {
    throw new Error("Заказ не найден");
  }

  if (order.status !== "waiting_approval") {
    throw new Error("Этот заказ уже обработан");
  }

  db.markOrderPaid(orderId);
  db.grantSubscription({
    telegramId: order.telegram_id,
    planCode: order.plan_code,
    issuedByTelegramId: adminTelegramId,
    sourceOrderId: orderId,
  });
  const targetUser = db.ensureUserCredentials(order.telegram_id);
  await syncUserRecord(order.telegram_id);

  await api.sendMessage(
    order.telegram_id,
    `Оплата подтверждена. ${subscriptionText(db.getUserEntitlementByTelegramId(order.telegram_id))}`,
    {
      reply_markup: mainKeyboard(isAdmin(order.telegram_id)),
    },
  );
  await api.sendMessage(
    order.telegram_id,
    "Чат с администратором активен. Просто пишите сюда, и сообщение уйдёт админу через бота.",
    {
      reply_markup: supportKeyboard(),
    },
  );

  const url = db.getSetting("download_url");
  if (url) {
    await api.sendMessage(order.telegram_id, "Ссылка на скачивание:", {
      reply_markup: downloadKeyboard(url),
    });
  }

  await api.sendMessage(
    order.telegram_id,
    credentialsText(targetUser, db.getUserEntitlementByTelegramId(order.telegram_id)),
  );
}

async function rejectOrder(orderId) {
  const order = db.getOrderById(orderId);
  if (!order) {
    throw new Error("Заказ не найден");
  }

  if (order.status !== "waiting_approval") {
    throw new Error("Этот заказ уже обработан");
  }

  db.rejectOrder(orderId);
  await api.sendMessage(order.telegram_id, "Оплата отклонена. Свяжитесь с администратором.");
}

async function handleAdminCommand(message, currentUser) {
  const { command, rest, rawArgs } = commandArgs(message.text);
  const chatId = message.chat.id;

  if (command === "/admin") {
    await showAdminPanel(chatId, currentUser.telegram_id);
    return true;
  }

  if (command === "/setprice") {
    const planCode = normalizePlanCode(rest[0]);
    const amount = Number(rest[1]);
    if (!planCode || !Number.isFinite(amount) || amount <= 0) {
      await api.sendMessage(chatId, "Использование: /setprice <30d|90d|lifetime> <цена>");
      return true;
    }

    const plan = db.updatePlanPrice(planCode, Math.round(amount));
    if (!plan) {
      await api.sendMessage(chatId, "Тариф не найден.");
      return true;
    }

    await api.sendMessage(chatId, `Цена обновлена: ${planText(plan)}`);
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

  if (command === "/setpayment") {
    if (!rawArgs) {
      await api.sendMessage(chatId, "Использование: /setpayment <текст>");
      return true;
    }
    db.setSetting("payment_text", rawArgs);
    await syncSettingRecord("payment_text");
    await api.sendMessage(chatId, "Инструкция по оплате обновлена.");
    return true;
  }

  if (command === "/grant") {
    const targetId = Number(rest[0]);
    const planCode = normalizePlanCode(rest[1]);
    if (!Number.isInteger(targetId) || !planCode) {
      await api.sendMessage(chatId, "Использование: /grant <telegram_id> <30d|90d|lifetime>");
      return true;
    }

    try {
      db.grantSubscription({
        telegramId: targetId,
        planCode,
        issuedByTelegramId: currentUser.telegram_id,
      });
      const targetUser = db.ensureUserCredentials(targetId);
      await syncUserRecord(targetId);
      await api.sendMessage(chatId, "Подписка выдана.");
      await api.sendMessage(
        targetId,
        `Вам выдана ${planTitle(planCode).toLowerCase()}. ${subscriptionText(
          db.getUserEntitlementByTelegramId(targetId),
        )}`,
      );
      await api.sendMessage(
        targetId,
        "Чат с администратором активен. Просто пишите сюда, и сообщение уйдёт админу через бота.",
        {
          reply_markup: supportKeyboard(),
        },
      );
      await api.sendMessage(
        targetId,
        credentialsText(targetUser, db.getUserEntitlementByTelegramId(targetId)),
      );
    } catch (error) {
      await api.sendMessage(chatId, `Ошибка: ${error.message}`);
    }
    return true;
  }

  if (command === "/resetlogin") {
    const targetId = Number(rest[0]);
    if (!Number.isInteger(targetId)) {
      await api.sendMessage(chatId, "Использование: /resetlogin <telegram_id>");
      return true;
    }

    try {
      const targetUser = db.resetUserCredentials(targetId);
      await syncUserRecord(targetId);
      await api.sendMessage(
        chatId,
        [
          "Логин обновлен.",
          `Логин: ${targetUser.client_login}`,
          `Пароль: ${targetUser.client_password}`,
          readyRegisterText(targetUser),
        ].join("\n"),
      );
      await api.sendMessage(
        targetId,
        credentialsText(targetUser, db.getUserEntitlementByTelegramId(targetId)),
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

  if (command === "/orders") {
    const orders = db.getWaitingOrders();
    if (orders.length === 0) {
      await api.sendMessage(chatId, "Нет заказов, ожидающих одобрения.");
      return true;
    }

    for (const order of orders) {
      await api.sendMessage(chatId, formatOrderForAdmin(order), {
        parse_mode: "HTML",
        reply_markup: adminOrderKeyboard(order.id, order.telegram_id),
      });
    }
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
      await sendMainMenu(chatId, isAdmin(currentUser.telegram_id));
      await showMainPanel(chatId, currentUser.telegram_id);
      return true;
    case "/prices":
      await showPrices(chatId, currentUser.telegram_id);
      return true;
    case "/buy":
      await showBuy(chatId, currentUser.telegram_id);
      return true;
    case "/mysub":
      await showSubscription(chatId, currentUser.telegram_id);
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
    default:
      return false;
  }
}

async function handleTextMessage(message) {
  if (!message.from || !message.chat) {
    return;
  }

  let currentUser = db.upsertUser(message.from, shouldGrantAdmin(message.from.id));
  currentUser = ensureClientCredentials(currentUser.telegram_id) || currentUser;
  await syncUserRecord(currentUser.telegram_id);
  const chatId = message.chat.id;
  const session = getSession(currentUser.telegram_id);
  const messageText = message.text || "";

  if (messageText.startsWith("/")) {
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

  if (isAdmin(currentUser.telegram_id) && session?.mode === "active_reply_chat") {
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
    case "Прайс":
      await showPrices(chatId, currentUser.telegram_id);
      return;
    case "Купить":
      await showBuy(chatId, currentUser.telegram_id);
      return;
    case "Моя подписка":
      await showSubscription(chatId, currentUser.telegram_id);
      return;
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

  if (!isAdmin(currentUser.telegram_id) && await relayUserChatMessage(currentUser, message)) {
    await api.sendMessage(chatId, "Сообщение отправлено администратору.");
    return;
  }

  await sendMainMenu(chatId, isAdmin(currentUser.telegram_id));
}

async function handleCallbackQuery(callbackQuery) {
  const from = callbackQuery.from;
  const data = callbackQuery.data || "";
  let currentUser = db.upsertUser(from, shouldGrantAdmin(from.id));
  currentUser = ensureClientCredentials(currentUser.telegram_id) || currentUser;
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

      if (value === "prices") {
        await showPrices(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Прайс" });
        return;
      }

      if (value === "buy") {
        await showBuy(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Выбор тарифа" });
        return;
      }

      if (value === "mysub") {
        await showSubscription(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Статус подписки" });
        return;
      }

      if (value === "login") {
        await showLogin(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Логин клиента" });
        return;
      }

      if (value === "register") {
        await showRegister(chatId, currentUser.telegram_id, messageId);
        await api.answerCallbackQuery(callbackQuery.id, { text: "Р›РѕРіРёРЅ СЃРѕР·РґР°РЅ" });
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

    if (action === "buy") {
      await createOrderAndPrompt(chatId, from, value);
      await api.answerCallbackQuery(callbackQuery.id, { text: "Заказ создан" });
      return;
    }

    if (action === "order-paid") {
      const orderId = Number(value);
      const order = db.getOrderById(orderId);
      if (!order || order.telegram_id !== currentUser.telegram_id) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Заказ не найден", show_alert: true });
        return;
      }
      if (order.status !== "awaiting_payment") {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Этот заказ уже обработан", show_alert: true });
        return;
      }

      db.flagOrderWaitingApproval(orderId);
      await notifyAdminsAboutPayment(orderId);
      await api.editMessageText(
        chatId,
        messageId,
        `${formatOrderForUser(db.getOrderById(orderId))}\n\nСтатус: ожидает подтверждения администратора.`,
        {
          parse_mode: "HTML",
        },
      );
      await api.answerCallbackQuery(callbackQuery.id, { text: "Администратор получил запрос" });
      return;
    }

    if (action === "order-cancel") {
      const orderId = Number(value);
      const order = db.getOrderById(orderId);
      if (!order || order.telegram_id !== currentUser.telegram_id) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Заказ не найден", show_alert: true });
        return;
      }
      if (order.status !== "awaiting_payment") {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Заказ уже нельзя отменить", show_alert: true });
        return;
      }

      db.cancelOrder(orderId);
      await api.editMessageText(chatId, messageId, "Заказ отменен.", {
        reply_markup: backToMainKeyboard(),
      });
      await api.answerCallbackQuery(callbackQuery.id, { text: "Заказ отменен" });
      return;
    }

    if (action === "admin-approve") {
      if (!isAdmin(currentUser.telegram_id)) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Нет доступа", show_alert: true });
        return;
      }
      await approveOrder(Number(value), currentUser.telegram_id);
      await api.editMessageText(
        chatId,
        messageId,
        `${formatOrderForAdmin(db.getOrderById(Number(value)))}\n\nСтатус: paid`,
        {
          parse_mode: "HTML",
          reply_markup: adminPanelKeyboard(),
        },
      );
      await api.answerCallbackQuery(callbackQuery.id, { text: "Подписка выдана" });
      return;
    }

    if (action === "admin-reject") {
      if (!isAdmin(currentUser.telegram_id)) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Нет доступа", show_alert: true });
        return;
      }
      await rejectOrder(Number(value));
      await api.editMessageText(
        chatId,
        messageId,
        `${formatOrderForAdmin(db.getOrderById(Number(value)))}\n\nСтатус: rejected`,
        {
          parse_mode: "HTML",
          reply_markup: adminPanelKeyboard(),
        },
      );
      await api.answerCallbackQuery(callbackQuery.id, { text: "Заказ отклонен" });
      return;
    }

    if (action === "admin-reply") {
      if (!isAdmin(currentUser.telegram_id)) {
        await api.answerCallbackQuery(callbackQuery.id, { text: "Нет доступа", show_alert: true });
        return;
      }
      const targetTelegramId = Number(value);
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

      if (value === "list-orders") {
        const orders = db.getWaitingOrders();
        if (orders.length === 0) {
          await api.sendMessage(currentUser.telegram_id, "Нет заказов, ожидающих одобрения.");
        } else {
          for (const order of orders) {
            await api.sendMessage(currentUser.telegram_id, formatOrderForAdmin(order), {
              parse_mode: "HTML",
              reply_markup: adminOrderKeyboard(order.id, order.telegram_id),
            });
          }
        }
        await api.answerCallbackQuery(callbackQuery.id, { text: "Готово" });
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

async function setupBotCommands() {
  try {
    await api.setMyCommands([
      { command: "start", description: "Открыть меню" },
      { command: "prices", description: "Прайс" },
      { command: "buy", description: "Купить подписку" },
      { command: "mysub", description: "Статус подписки" },
      { command: "register", description: "Создать логин" },
      { command: "login", description: "Логин клиента" },
      { command: "download", description: "Скачать" },
      { command: "support", description: "Написать админу" },
      { command: "admin", description: "Админ-панель" },
    ]);
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
  await syncAllUsersToSupabase();
  await pullSettingFromSupabase("download_url");
  await pullSettingFromSupabase("payment_text");
  await syncSettingRecord("download_url");
  await syncSettingRecord("payment_text");
  console.log("Bot started.");
  await startPolling();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
