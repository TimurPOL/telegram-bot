const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { addDays, nowIso } = require("./utils");

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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        code TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        duration_days INTEGER,
        price INTEGER NOT NULL,
        currency TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_code TEXT NOT NULL REFERENCES plans(code),
        starts_at TEXT NOT NULL,
        expires_at TEXT,
        issued_by_telegram_id INTEGER,
        source_order_id INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_code TEXT NOT NULL REFERENCES plans(code),
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
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
    const now = nowIso();
    const upsertPlan = this.db.prepare(`
      INSERT INTO plans (code, title, duration_days, price, currency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title,
        duration_days = excluded.duration_days,
        price = COALESCE(plans.price, excluded.price),
        currency = excluded.currency,
        updated_at = excluded.updated_at
    `);

    upsertPlan.run(
      "7d",
      "Подписка на 7 дней",
      7,
      this.defaults.prices["7d"],
      this.defaults.currency,
      now,
    );
    upsertPlan.run(
      "30d",
      "Подписка на 30 дней",
      30,
      this.defaults.prices["30d"],
      this.defaults.currency,
      now,
    );
    upsertPlan.run(
      "90d",
      "Подписка на 90 дней",
      90,
      this.defaults.prices["90d"],
      this.defaults.currency,
      now,
    );
    upsertPlan.run(
      "lifetime",
      "Подписка навсегда",
      null,
      this.defaults.prices.lifetime,
      this.defaults.currency,
      now,
    );

    this.setSettingIfMissing("download_url", this.defaults.downloadUrl);
    this.setSettingIfMissing("payment_text", this.defaults.paymentText);
  }

  setSettingIfMissing(key, value) {
    this.db
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO NOTHING
      `)
      .run(key, value, nowIso());
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

  hasAnyAdmin() {
    return (
      this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1").get().count > 0
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
    const activeSubscriptions = this.db
      .prepare(`
        SELECT COUNT(DISTINCT user_id) AS count
        FROM subscriptions
        WHERE expires_at IS NULL OR expires_at > ?
      `)
      .get(nowIso()).count;
    const pendingOrders = this.db
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'waiting_approval'")
      .get().count;

    return { users, activeSubscriptions, pendingOrders };
  }

  getPlans() {
    return this.db
      .prepare(`
        SELECT * FROM plans
        WHERE is_active = 1
        ORDER BY CASE code WHEN '7d' THEN 1 WHEN '30d' THEN 2 WHEN '90d' THEN 3 ELSE 4 END
      `)
      .all();
  }

  getPlan(code) {
    return this.db.prepare("SELECT * FROM plans WHERE code = ?").get(code);
  }

  updatePlanPrice(code, amount) {
    return this.db
      .prepare(`
        UPDATE plans
        SET price = ?, updated_at = ?
        WHERE code = ?
        RETURNING *
      `)
      .get(amount, nowIso(), code);
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

  createOrder(userId, plan) {
    const createdAt = nowIso();
    const publicId = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(
      Math.random() * 900 + 100,
    )}`;

    return this.db
      .prepare(`
        INSERT INTO orders (
          public_id,
          user_id,
          plan_code,
          amount,
          currency,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'awaiting_payment', ?, ?)
        RETURNING *
      `)
      .get(publicId, userId, plan.code, plan.price, plan.currency, createdAt, createdAt);
  }

  updateOrderStatus(orderId, status) {
    return this.db
      .prepare(`
        UPDATE orders
        SET status = ?, updated_at = ?
        WHERE id = ?
        RETURNING *
      `)
      .get(status, nowIso(), orderId);
  }

  getOrderById(orderId) {
    return this.db
      .prepare(`
        SELECT
          orders.*,
          users.telegram_id,
          users.username,
          users.first_name,
          users.last_name
        FROM orders
        JOIN users ON users.id = orders.user_id
        WHERE orders.id = ?
      `)
      .get(orderId);
  }

  getWaitingOrders() {
    return this.db
      .prepare(`
        SELECT
          orders.*,
          users.telegram_id,
          users.username,
          users.first_name,
          users.last_name
        FROM orders
        JOIN users ON users.id = orders.user_id
        WHERE orders.status = 'waiting_approval'
        ORDER BY orders.created_at ASC
      `)
      .all();
  }

  getLatestOpenOrderByTelegramId(telegramId) {
    return this.db
      .prepare(`
        SELECT
          orders.*,
          users.telegram_id,
          users.username,
          users.first_name,
          users.last_name
        FROM orders
        JOIN users ON users.id = orders.user_id
        WHERE users.telegram_id = ?
          AND orders.status IN ('awaiting_payment', 'waiting_approval')
        ORDER BY orders.updated_at DESC, orders.id DESC
        LIMIT 1
      `)
      .get(telegramId);
  }

  markOrderPaid(orderId) {
    return this.updateOrderStatus(orderId, "paid");
  }

  rejectOrder(orderId) {
    return this.updateOrderStatus(orderId, "rejected");
  }

  cancelOrder(orderId) {
    return this.updateOrderStatus(orderId, "cancelled");
  }

  flagOrderWaitingApproval(orderId) {
    return this.updateOrderStatus(orderId, "waiting_approval");
  }

  grantSubscription({ telegramId, planCode, issuedByTelegramId = null, sourceOrderId = null }) {
    const user = this.getUserByTelegramId(telegramId);
    const plan = this.getPlan(planCode);

    if (!user) {
      throw new Error("User not found");
    }
    if (!plan) {
      throw new Error("Plan not found");
    }

    const entitlement = this.getUserEntitlementByUserId(user.id);
    const now = new Date();
    const startsAt = entitlement.expires_at
      ? new Date(Math.max(now.getTime(), new Date(entitlement.expires_at).getTime()))
      : now;
    const expiresAt =
      plan.duration_days == null ? null : addDays(startsAt, plan.duration_days).toISOString();

    return this.db
      .prepare(`
        INSERT INTO subscriptions (
          user_id,
          plan_code,
          starts_at,
          expires_at,
          issued_by_telegram_id,
          source_order_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `)
      .get(
        user.id,
        plan.code,
        startsAt.toISOString(),
        expiresAt,
        issuedByTelegramId,
        sourceOrderId,
        nowIso(),
      );
  }

  getUserEntitlementByTelegramId(telegramId) {
    const user = this.getUserByTelegramId(telegramId);
    if (!user) {
      return {
        has_access: false,
        expires_at: null,
        is_lifetime: false,
        plan_code: null,
      };
    }

    return this.getUserEntitlementByUserId(user.id);
  }

  getUserEntitlementByUserId(userId) {
    const lifetime = this.db
      .prepare(`
        SELECT * FROM subscriptions
        WHERE user_id = ? AND expires_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(userId);

    if (lifetime) {
      return {
        has_access: true,
        expires_at: null,
        is_lifetime: true,
        plan_code: lifetime.plan_code,
      };
    }

    const latest = this.db
      .prepare(`
        SELECT * FROM subscriptions
        WHERE user_id = ? AND expires_at > ?
        ORDER BY expires_at DESC
        LIMIT 1
      `)
      .get(userId, nowIso());

    if (!latest) {
      return {
        has_access: false,
        expires_at: null,
        is_lifetime: false,
        plan_code: null,
      };
    }

    return {
      has_access: true,
      expires_at: latest.expires_at,
      is_lifetime: false,
      plan_code: latest.plan_code,
    };
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
