import { createHash } from "node:crypto";
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name, phone, items } = req.body || {};

    if (
      typeof name !== "string" || name.trim().length < 2 ||
      name.length > 80 ||
      typeof phone !== "string" || phone.trim().length < 5 ||
      phone.length > 30 ||
      !Array.isArray(items) || items.length === 0 || items.length > 30
    ) {
      return res.status(400).json({ error: "Проверьте данные заказа" });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!token || !chatId || !supabaseUrl || !supabaseKey) {
      throw new Error("Не настроены переменные сервера");
    }

    const cleanItems = items.map(item => ({
      id: String(item.id || ""),
      quantity: Math.max(1, Math.min(20, Number(item.quantity) || 1))
    }));

    if (cleanItems.some(item => !item.id)) {
      return res.status(400).json({ error: "Некорректный товар" });
    }

    const ids = [...new Set(cleanItems.map(item => item.id))];

    const query = new URLSearchParams({
      select: "id,name,price,is_active",
      id: `in.(${ids.join(",")})`,
      is_active: "eq.true"
    });

    const productResponse = await fetch(
      `${supabaseUrl}/rest/v1/products?${query}`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    if (!productResponse.ok) {
      throw new Error("Ошибка проверки товаров в Supabase");
    }

    const products = await productResponse.json();

    if (products.length !== ids.length) {
      return res.status(400).json({
        error: "Один из товаров больше недоступен"
      });
    }

    const productMap = new Map(products.map(p => [String(p.id), p]));
    let total = 0;

    const lines = cleanItems.map(item => {
      const product = productMap.get(item.id);
      const price = Number(product.price);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error("Некорректная цена товара");
      }

      total += price * item.quantity;

      return `• ${escapeHtml(product.name)} × ${item.quantity} — ${(price * item.quantity).toLocaleString("ru-RU")} ₽`;
    });

    const message = [
      "🛍 <b>НОВЫЙ ЗАКАЗ — RAVO PRIVÉ</b>",
      "",
      `👤 Имя: ${escapeHtml(name.trim())}`,
      `📞 Телефон: ${escapeHtml(phone.trim())}`,
      "",
      "<b>Товары:</b>",
      ...lines,
      "",
      `💰 <b>Итого: ${total.toLocaleString("ru-RU")} ₽</b>`
    ].join("\n");
const secret = createHash("sha256")
  .update(token)
  .digest("hex");

const webhookResponse = await fetch(
  `https://api.telegram.org/bot${token}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://ravo-priv.vercel.app/api/telegram-webhook",
      secret_token: secret,
      allowed_updates: ["callback_query"]
    })
  }
);

const webhookResult = await webhookResponse.json();
console.log("Webhook setup:", webhookResult);
if (!webhookResponse.ok || !webhookResult.ok) {
  throw new Error("Telegram webhook не подключён: " + JSON.stringify(webhookResult));
}
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Подтвердить", callback_data: "order_confirm" },
                { text: "❌ Отменить", callback_data: "order_cancel" }
              ],
              [
                { text: "📦 Выполнен", callback_data: "order_done" }
              ]
            ]
          }
        })
      }
    );

    const result = await telegramResponse.json();

    if (!telegramResponse.ok || !result.ok) {
      throw new Error("Telegram не принял заказ");
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("Order error:", error);

    return res.status(500).json({
      error: "Не удалось отправить заказ. Попробуйте позже."
    });
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
