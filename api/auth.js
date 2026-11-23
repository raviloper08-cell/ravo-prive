
import { createHmac, timingSafeEqual } from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!botToken || !supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error: "Server authentication is not configured"
    });
  }

  try {
    const initData = req.body?.initData;

    if (typeof initData !== "string" || !initData) {
      return res.status(400).json({ error: "Missing Telegram data" });
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return res.status(401).json({ error: "Invalid Telegram signature" });
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const calculatedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest();

    const receivedBuffer = Buffer.from(receivedHash, "hex");

    if (
      receivedBuffer.length !== calculatedHash.length ||
      !timingSafeEqual(receivedBuffer, calculatedHash)
    ) {
      return res.status(401).json({ error: "Telegram verification failed" });
    }

    const authDate = Number(params.get("auth_date"));

    if (
      !Number.isFinite(authDate) ||
      authDate > Math.floor(Date.now() / 1000) + 60 ||
      Math.floor(Date.now() / 1000) - authDate > 86400
    ) {
      return res.status(401).json({ error: "Telegram session expired" });
    }

    const userString = params.get("user");

    if (!userString) {
      return res.status(400).json({ error: "Telegram user missing" });
    }

    const user = JSON.parse(userString);

    if (!user.id) {
      return res.status(400).json({ error: "Invalid Telegram user" });
    }

    const profile = {
      telegram_id: String(user.id),
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      username: user.username || null,
      photo_url: user.photo_url || null,
      updated_at: new Date().toISOString()
    };

    const response = await fetch(
      `${supabaseUrl}/rest/v1/profiles?on_conflict=telegram_id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceKey,
          "Authorization": `Bearer ${serviceKey}`,
          "Prefer": "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify(profile)
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Supabase profile error:", result);
      return res.status(500).json({ error: "Could not save profile" });
    }

    return res.status(200).json({
      success: true,
      profile: result[0]
    });

  } catch (error) {
    console.error("Telegram auth error:", error);
    return res.status(500).json({ error: "Authentication failed" });
  }
}
