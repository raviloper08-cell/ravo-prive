
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!botToken || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server authentication is not configured" });
  }

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

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
    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(authDate) ||
      authDate > now + 60 ||
      now - authDate > 86400
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

    const telegramId = String(user.id);

    // Ищем существующий Telegram-профиль.
    const profileResponse = await fetch(
      `${supabaseUrl}/rest/v1/profiles?telegram_id=eq.${encodeURIComponent(telegramId)}&select=*`,
      { headers }
    );

    const profiles = await profileResponse.json();

    if (!profileResponse.ok) {
      console.error("Profile lookup error:", profiles);
      return res.status(500).json({ error: "Could not load profile" });
    }

    let profile = profiles[0];

    // Если профиль уже связан с Auth, используем эту связь.
    let authUserId = profile?.auth_user_id || null;

    // Иначе создаём отдельного Auth-пользователя.
    if (!authUserId) {
      const newAuthId = randomUUID();

      const createAuthResponse = await fetch(
        `${supabaseUrl}/auth/v1/admin/users`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: newAuthId,
            email: `telegram_${telegramId}@users.ravo.invalid`,
            email_confirm: true,
            password: randomUUID() + randomUUID(),
            user_metadata: {
              telegram_id: telegramId
            }
          })
        }
      );

      const authResult = await createAuthResponse.json();

      if (!createAuthResponse.ok) {
        console.error("Auth user creation error:", authResult);
        return res.status(500).json({ error: "Could not create auth user" });
      }

      authUserId = authResult.id;
    }

    const updatedProfile = {
      telegram_id: telegramId,
      auth_user_id: authUserId,
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      username: user.username || null,
      photo_url: user.photo_url || null,
      updated_at: new Date().toISOString()
    };

    const saveResponse = await fetch(
      `${supabaseUrl}/rest/v1/profiles?on_conflict=telegram_id`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify(updatedProfile)
      }
    );

    const savedProfiles = await saveResponse.json();

    if (!saveResponse.ok) {
      console.error("Profile save error:", savedProfiles);
      return res.status(500).json({ error: "Could not save profile" });
    }

    return res.status(200).json({
      success: true,
      profile: savedProfiles[0]
    });

  } catch (error) {
    console.error("Telegram auth error:", error);
    return res.status(500).json({ error: "Authentication failed" });
  }
}
