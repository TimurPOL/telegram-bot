class TelegramApi {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`${method} failed: ${data.description}`);
    }

    return data.result;
  }

  getUpdates(params) {
    return this.call("getUpdates", params);
  }

  sendMessage(chatId, text, options = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...options,
    });
  }

  editMessageText(chatId, messageId, text, options = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...options,
    });
  }

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }
}

module.exports = { TelegramApi };
