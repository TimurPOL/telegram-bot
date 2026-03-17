function mainKeyboard(isAdmin = false) {
  const rows = [
    [{ text: "Прайс" }, { text: "Купить" }],
    [{ text: "Моя подписка" }, { text: "Логин" }],
    [{ text: "Скачать" }, { text: "Поддержка" }],
    [{ text: "Помощь" }],
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
      { text: "Прайс", callback_data: "menu:prices" },
      { text: "Купить", callback_data: "menu:buy" },
    ],
    [
      { text: "Моя подписка", callback_data: "menu:mysub" },
      { text: "Логин", callback_data: "menu:login" },
    ],
    [
      { text: "Скачать", callback_data: "menu:download" },
      { text: "Поддержка", callback_data: "menu:support" },
    ],
    [{ text: "Помощь", callback_data: "menu:help" }],
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

function plansKeyboard(plans) {
  const rows = plans.map((plan) => [
    {
      text: `${plan.title} - ${plan.price} ${plan.currency}`,
      callback_data: `buy:${plan.code}`,
    },
  ]);

  rows.push([{ text: "Главное меню", callback_data: "menu:main" }]);

  return {
    inline_keyboard: rows,
  };
}

function orderPaymentKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "Я оплатил", callback_data: `order-paid:${orderId}` },
        { text: "Отмена", callback_data: `order-cancel:${orderId}` },
      ],
      [{ text: "Главное меню", callback_data: "menu:main" }],
    ],
  };
}

function adminOrderKeyboard(orderId, userTelegramId) {
  return {
    inline_keyboard: [
      [
        { text: "Одобрить", callback_data: `admin-approve:${orderId}` },
        { text: "Отклонить", callback_data: `admin-reject:${orderId}` },
      ],
      [{ text: "Ответить пользователю", callback_data: `admin-reply:${userTelegramId}` }],
      [{ text: "Админ-панель", callback_data: "admin:panel" }],
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
        { text: "Ожидающие заказы", callback_data: "admin:list-orders" },
      ],
      [
        { text: "Режим рассылки", callback_data: "admin:broadcast-mode" },
        { text: "Подсказка", callback_data: "admin:help" },
      ],
      [{ text: "Главное меню", callback_data: "menu:main" }],
    ],
  };
}

function subscriptionKeyboard(hasAccess) {
  const rows = [];

  if (hasAccess) {
    rows.push([{ text: "Скачать", callback_data: "menu:download" }]);
  } else {
    rows.push([{ text: "Купить", callback_data: "menu:buy" }]);
  }

  rows.push([{ text: "Логин", callback_data: "menu:login" }]);
  rows.push([{ text: "Прайс", callback_data: "menu:prices" }]);
  rows.push([{ text: "Главное меню", callback_data: "menu:main" }]);

  return {
    inline_keyboard: rows,
  };
}

function helpKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: "Прайс", callback_data: "menu:prices" },
      { text: "Купить", callback_data: "menu:buy" },
    ],
    [{ text: "Главное меню", callback_data: "menu:main" }],
  ];

  if (isAdmin) {
    rows.splice(1, 0, [{ text: "Админ-панель", callback_data: "admin:panel" }]);
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
};
