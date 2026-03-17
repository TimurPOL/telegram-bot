class SupabaseSync {
  constructor(config) {
    this.url = config.url || "";
    this.serviceRoleKey = config.serviceRoleKey || "";
    this.schema = config.schema || "public";
    this.enabled = Boolean(this.url && this.serviceRoleKey);
    this.baseUrl = this.enabled ? `${this.url.replace(/\/$/, "")}/rest/v1` : "";
  }

  headers(extra = {}) {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      "Content-Type": "application/json",
      "Accept-Profile": this.schema,
      "Content-Profile": this.schema,
      ...extra,
    };
  }

  async request(path, { method = "GET", body = null, headers = {} } = {}) {
    if (!this.enabled) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(headers),
      body: body == null ? null : JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase ${method} ${path} failed: ${errorText}`);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async upsertUser(userRecord) {
    if (!this.enabled) {
      return;
    }

    await this.request("/telegram_users?on_conflict=telegram_id", {
      method: "POST",
      body: [userRecord],
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
    });
  }

  async upsertSetting(settingRecord) {
    if (!this.enabled) {
      return;
    }

    await this.request("/bot_settings?on_conflict=key", {
      method: "POST",
      body: [settingRecord],
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
    });
  }

  async upsertHwid(hwidRecord) {
    if (!this.enabled) {
      return;
    }

    await this.request("/hwids?on_conflict=telegram_id,hwid", {
      method: "POST",
      body: [hwidRecord],
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
    });
  }

  async listHwidsByTelegramId(telegramId) {
    if (!this.enabled) {
      return [];
    }

    const rows = await this.request(
      `/hwids?telegram_id=eq.${Number(telegramId)}&select=id,telegram_id,hwid,launch_count,created_at&order=created_at.asc`,
    );

    return rows || [];
  }

  async getSetting(key) {
    if (!this.enabled) {
      return null;
    }

    const rows = await this.request(
      `/bot_settings?key=eq.${encodeURIComponent(key)}&select=key,value,updated_at&limit=1`,
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    return rows[0];
  }
}

module.exports = { SupabaseSync };
