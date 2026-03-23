function mainKeyboard(isAdmin = false) {
  const rows = [
    [{ text: "Логин" }, { text: "Скачать" }],
    [{ text: "Поддержка" }, { text: "Помощь" }],
  ];

  if (isAdmin) {
    rows.push([{ text: "Админ" }]);
  }

  return {
    keyboard: rows,
    is_persistent: true,
    resize_keyboard: true,
  };
}

function mainInlineKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: "Логин", callback_data: "menu:login" },
      { text: "Скачать", callback_data: "menu:download" },
    ],
    [
      { text: "Поддержка", callback_data: "menu:support" },
      { text: "Помощь", callback_data: "menu:help" },
    ],
  ];

  if (isAdmin) {
    rows.push([{ text: "Админ-панель", callback_data: "admin:panel" }]);
  }

  return {
    inline_keyboard: rows,
  };
}

function backToMainKeyboard() {
  return {
    inline_keyboard: [[{ text: "Главное меню", callback_data: "menu:main" }]],
  };
}

function registerKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Зарегистрироваться", callback_data: "menu:register" }],
      [{ text: "Главное меню", callback_data: "menu:main" }],
    ],
  };
}

function adminChatKeyboard(userTelegramId) {
  return {
    inline_keyboard: [
      [{ text: "Открыть чат", callback_data: `admin-reply:${userTelegramId}` }],
      [{ text: "Закрыть чат", callback_data: `admin-close-chat:${userTelegramId}` }],
    ],
  };
}

function downloadKeyboard(url) {
  return {
    inline_keyboard: [
      [{ text: "Скачать", url }],
      [{ text: "Главное меню", callback_data: "menu:main" }],
    ],
  };
}

function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Статистика", callback_data: "admin:stats" },
        { text: "Режим рассылки", callback_data: "admin:broadcast-mode" },
      ],
      [{ text: "Подсказка", callback_data: "admin:help" }],
      [{ text: "Главное меню", callback_data: "menu:main" }],
    ],
  };
}

function subscriptionKeyboard(isRegistered) {
  const rows = [];

  if (isRegistered) {
    rows.push([{ text: "Скачать", callback_data: "menu:download" }]);
  } else {
    rows.push([{ text: "Зарегистрироваться", callback_data: "menu:register" }]);
  }

  rows.push([{ text: "Логин", callback_data: "menu:login" }]);
  rows.push([{ text: "Главное меню", callback_data: "menu:main" }]);

  return {
    inline_keyboard: rows,
  };
}

function helpKeyboard(isAdmin = false) {
  const rows = [
    [{ text: "Главное меню", callback_data: "menu:main" }],
  ];

  if (isAdmin) {
    rows.splice(0, 0, [{ text: "Админ-панель", callback_data: "admin:panel" }]);
  }

  return {
    inline_keyboard: rows,
  };
}

function supportKeyboard() {
  return {
    inline_keyboard: [[{ text: "Главное меню", callback_data: "menu:main" }]],
  };
}

module.exports = {
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
};
