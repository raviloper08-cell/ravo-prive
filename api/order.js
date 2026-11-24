
import { createHmac, timingSafeEqual } from "node:crypto";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function verifyTelegram(initData, token) {
  if (typeof initData !== "string" || !initData || initData.length > 10000) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");

  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !userRaw) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(authDate) ||
    now - authDate > 86400 ||
    authDate > now + 60
  ) {
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

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const user = JSON.parse(userRaw);
    return user.id ? user : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { name, phone, items, initData } = req.body || {};

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!token || !chatId || !supabaseUrl || !serviceKey) {
      throw new Error("Не настроены переменные сервера");
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
      return res.status(400).json({
        error: "Проверьте товары в заказе"
      });
    }

    const telegramUser = verifyTelegram(initData, token);

    if (!telegramUser) {
      return res.status(401).json({
        error: "Не удалось подтвердить Telegram. Откройте магазин через Telegram."
      });
    }

    const telegramId = String(telegramUser.id);

    const cleanItems = items.map(item => ({
      id: String(item.id || ""),
      quantity: Math.max(
        1,
        Math.min(20, Math.floor(Number(item.quantity) || 1))
      )
    }));

    if (cleanItems.some(item => !item.id)) {
      return res.status(400).json({
        error: "Некорректный товар"
      });
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
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
        }
      }
    );

    if (!productResponse.ok) {
      const errorText = await productResponse.text();
      console.error("Product lookup error:", errorText);
      throw new Error("Ошибка проверки товаров");
    }

    const products = await productResponse.json();

    if (products.length !== ids.length) {
      return res.status(400).json({
        error: "Один из товаров больше недоступен"
      });
    }

    const productMap = new Map(
      products.map(product => [String(product.id), product])
    );

    let total = 0;

    const orderItems = cleanItems.map(item => {
      const product = productMap.get(item.id);
      const price = Number(product.price);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error("Некорректная цена товара");
      }

      const lineTotal = price * item.quantity;
      total += lineTotal;

      return {
        product_id: String(product.id),
        name: product.name,
        price,
        quantity: item.quantity,
        total: lineTotal
      };
    });

    // Ищем профиль по Telegram ID.
    // В таблице profiles имя хранится в поле name.
    const profileQuery = new URLSearchParams({
      select: "id,auth_user_id,bonus_balance,subscription_plan,name,phone",
      telegram_id: `eq.${telegramId}`
    });

    const profileResponse = await fetch(
      `${supabaseUrl}/rest/v1/profiles?${profileQuery}`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
        }
      }
    );

    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      console.error("Profile lookup error:", errorText);
      throw new Error("Не удалось найти профиль покупателя");
    }

    const profiles = await profileResponse.json();

    if (!profiles.length) {
      return res.status(400).json({
        error: "Профиль не найден. Перезапустите магазин в Telegram."
      });
    }

    const profile = profiles[0];

    if (!profile.auth_user_id) {
      return res.status(409).json({
        error: "Профиль не связан с авторизацией. Перезапустите приложение."
      });
    }

    // Используем имя и телефон из формы или сохранённого профиля.
    const customerName =
      typeof name === "string" && name.trim()
        ? name.trim()
        : String(profile.name || "").trim();

    const customerPhone =
      typeof phone === "string" && phone.trim()
        ? phone.trim()
        : String(profile.phone || "").trim();

    if (
      customerName.length < 2 ||
      customerName.length > 80 ||
      customerPhone.length < 5 ||
      customerPhone.length > 30
    ) {
      return res.status(400).json({
        error: "Укажите корректное имя и номер телефона"
      });
    }

    // Сохраняем контакты в существующие поля name и phone.
    const profileUpdateResponse = await fetch(
      `${supabaseUrl}/rest/v1/profiles?telegram_id=eq.${encodeURIComponent(telegramId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          name: customerName,
          phone: customerPhone,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!profileUpdateResponse.ok) {
      const errorText = await profileUpdateResponse.text();
      console.error("Profile update error:", errorText);
      throw new Error("Не удалось сохранить контакты покупателя");
    }

    // Создаём заказ.
    // В таблице orders поле customer_name существует.
    const orderPayload = {
      user_id: profile.auth_user_id,
      telegram_id: telegramId,
      customer_name: customerName,
      phone: customerPhone,
      items: orderItems,
      total_amount: total,
      status: "pending",
      payment_status: "pending"
    };

    const saveResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?select=id`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(orderPayload)
      }
    );

    const savedOrders = await saveResponse.json();

    if (!saveResponse.ok || !Array.isArray(savedOrders) || !savedOrders.length) {
      console.error("Supabase order save error:", savedOrders);
      throw new Error("Не удалось сохранить заказ");
    }

    const order = savedOrders[0];

    const lines = orderItems.map(item =>
      `• ${escapeHtml(item.name)} × ${item.quantity} — ${item.total.toLocaleString("ru-RU")} ₽`
    );

    const message = [
      `🛍 <b>НОВЫЙ ЗАКАЗ RAVO PRIVÉ №${order.id}</b>`,
      "",
      `👤 Имя: ${escapeHtml(customerName)}`,
      `📞 Телефон: ${escapeHtml(customerPhone)}`,
      `🆔 Telegram ID: ${telegramId}`,
      "",
      "<b>Товары:</b>",
      ...lines,
      "",
      `💰 <b>Итого: ${total.toLocaleString("ru-RU")} ₽</b>`,
      "",
      "🕒 Статус: Новый"
    ].join("\n");

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Подтвердить",
                  callback_data: `order_confirm:${order.id}`
                },
                {
                  text: "❌ Отменить",
                  callback_data: `order_cancel:${order.id}`
                }
              ],
              [
                {
                  text: "📦 Выполнен",
                  callback_data: `order_done:${order.id}`
                }
              ]
            ]
          }
        })
      }
    );

    const telegramResult = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramResult.ok) {
      console.error("Telegram send error:", telegramResult);
      throw new Error("Заказ сохранён, но уведомление не отправлено");
    }

    return res.status(200).json({
      success: true,
      order_id: order.id,
      total
    });

  } catch (error) {
    console.error("Order error:", error);

    return res.status(500).json({
      error: "Не удалось оформить заказ. Попробуйте позже."
    });
  }
}
