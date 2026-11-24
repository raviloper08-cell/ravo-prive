
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyTelegram(initData, token) {
  if (typeof initData !== "string" || !initData || initData.length > 10000) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");

  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !userRaw) return null;

  const now = Math.floor(Date.now() / 1000);

  if (!Number.isFinite(authDate) || now - authDate > 86400 || authDate > now + 60) {
    return null;
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(token)
    .digest();

  const calculatedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calculatedHash, "hex");

  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const user = JSON.parse(userRaw);
    return user.id ? user : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!token || !supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: "Server not configured" });
    }

    const user = verifyTelegram(req.body?.initData, token);

    if (!user) {
      return res.status(401).json({ error: "Не удалось подтвердить Telegram" });
    }

    const telegramId = String(user.id);

    const query = new URLSearchParams({
      select: "id,created_at,total_amount,status,items",
      telegram_id: `eq.${telegramId}`,
      order: "created_at.desc",
      limit: "100"
    });

    const response = await fetch(
      `${supabaseUrl}/rest/v1/orders?${query}`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
        }
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("My orders Supabase error:", result);
      return res.status(500).json({ error: "Не удалось загрузить историю заказов" });
    }

    return res.status(200).json({
      success: true,
      orders: result
    });

  } catch (error) {
    console.error("My orders error:", error);
    return res.status(500).json({ error: "Ошибка загрузки заказов" });
  }
}
