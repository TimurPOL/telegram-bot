const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { nowIso } = require("./utils");

class BotDatabase {
  constructor(dbPath, defaults) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.defaults = defaults;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        client_login TEXT,
        client_password TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        chat_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS support_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        telegram_message_id INTEGER NOT NULL,
        message_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.migrate();
    this.seed();
  }

  migrate() {
    this.ensureColumn("users", "client_login", "client_login TEXT");
    this.ensureColumn("users", "client_password", "client_password TEXT");
    this.ensureColumn("users", "chat_enabled", "chat_enabled INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_client_login
      ON users(client_login)
      WHERE client_login IS NOT NULL
    `);
  }

  ensureColumn(tableName, columnName, columnDefinition) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition};`);
  }

  seed() {
    this.setSettingIfMissing("download_url", this.defaults.downloadUrl);
  }

  setSettingIfMissing(key, value) {
    this.db
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO NOTHING
      `)
      .run(key, value || "", nowIso());
  }

  upsertUser(telegramUser, isAdmin) {
    const timestamp = nowIso();
    return this.db
      .prepare(`
        INSERT INTO users (
          telegram_id,
          username,
          first_name,
          last_name,
          client_login,
          client_password,
          is_admin,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          is_admin = excluded.is_admin,
          updated_at = excluded.updated_at
        RETURNING *
      `)
      .get(
        telegramUser.id,
        telegramUser.username || null,
        telegramUser.first_name || null,
        telegramUser.last_name || null,
        isAdmin ? 1 : 0,
        timestamp,
        timestamp,
      );
  }

  getUserByTelegramId(telegramId) {
    return this.db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
  }

  getAllUsers() {
    return this.db.prepare("SELECT * FROM users ORDER BY id ASC").all();
  }

  isChatEnabled(telegramId) {
    const row = this.db
      .prepare("SELECT chat_enabled FROM users WHERE telegram_id = ?")
      .get(telegramId);
    return Boolean(row?.chat_enabled);
  }

  setChatEnabled(telegramId, enabled) {
    return this.db
      .prepare(`
        UPDATE users
        SET chat_enabled = ?, updated_at = ?
        WHERE telegram_id = ?
        RETURNING *
      `)
      .get(enabled ? 1 : 0, nowIso(), telegramId);
  }

  setUserCredentials(telegramId, clientLogin, clientPassword) {
    const user = this.getUserByTelegramId(telegramId);
    if (!user) {
      throw new Error("User not found");
    }

    const conflictingUser = this.db
      .prepare("SELECT telegram_id FROM users WHERE client_login = ? AND telegram_id != ?")
      .get(clientLogin, telegramId);
    if (conflictingUser) {
      const error = new Error("Client login already exists");
      error.code = "CLIENT_LOGIN_TAKEN";
      throw error;
    }

    try {
      return this.db
        .prepare(`
          UPDATE users
          SET client_login = ?, client_password = ?, updated_at = ?
          WHERE telegram_id = ?
          RETURNING *
        `)
        .get(clientLogin, clientPassword, nowIso(), telegramId);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: users.client_login")) {
        const duplicateError = new Error("Client login already exists");
        duplicateError.code = "CLIENT_LOGIN_TAKEN";
        throw duplicateError;
      }

      throw error;
    }
  }

  clearUserCredentials(telegramId) {
    const user = this.getUserByTelegramId(telegramId);
    if (!user) {
      throw new Error("User not found");
    }

    return this.db
      .prepare(`
        UPDATE users
        SET client_login = NULL, client_password = NULL, updated_at = ?
        WHERE telegram_id = ?
        RETURNING *
      `)
      .get(nowIso(), telegramId);
  }

  getAdminTelegramIds() {
    return this.db
      .prepare("SELECT telegram_id FROM users WHERE is_admin = 1 ORDER BY id ASC")
      .all()
      .map((row) => row.telegram_id);
  }

  getStats() {
    const users = this.db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    return { users };
  }

  getSetting(key) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.db
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, value, nowIso());
    return value;
  }

  saveSupportMessage(userId, telegramMessageId, messageText) {
    this.db
      .prepare(`
        INSERT INTO support_messages (
          user_id,
          telegram_message_id,
          message_text,
          created_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .run(userId, telegramMessageId, messageText, nowIso());
  }
}

module.exports = { BotDatabase };
