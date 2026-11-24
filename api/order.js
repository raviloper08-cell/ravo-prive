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
  if (!initData || !token) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(token)
    .digest();

  const calculatedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  try {
    if (
      !timingSafeEqual(
        Buffer.from(calculatedHash, "hex"),
        Buffer.from(hash, "hex")
      )
    ) return null;
  } catch {
    return null;
  }

  const authDate = Number(params.get("auth_date"));

  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_ADMIN_CHAT_ID,
    SBER_CARD_NUMBER,
    SBER_CARDHOLDER
  } = process.env;

  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_ADMIN_CHAT_ID ||
    !SBER_CARD_NUMBER
  ) {
    return res.status(500).json({
      error: "Server environment variables are missing"
    });
  }

  const cardNumber = SBER_CARD_NUMBER.replace(/\D/g, "");

  if (!/^\d{16,19}$/.test(cardNumber)) {
    return res.status(500).json({
      error: "Invalid Sberbank card number configuration"
    });
  }

  const { name, phone, items, initData } = req.body || {};

  const telegramUser = verifyTelegram(
    initData,
    TELEGRAM_BOT_TOKEN
  );

  if (!telegramUser) {
    return res.status(401).json({
      error: "Telegram authorization failed"
    });
  }

  if (
    !name ||
    !phone ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return res.status(400).json({
      error: "Invalid order data"
    });
  }

  const supabaseHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };

  async function supabase(path, options = {}) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        ...supabaseHeaders,
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(text || "Supabase request failed");
    }

    return text ? JSON.parse(text) : null;
  }

  async function telegram(method, body) {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    const result = await response.json();

    if (!result.ok) {
      throw new Error(result.description || "Telegram request failed");
    }

    return result;
  }

  try {
    const telegramId = String(telegramUser.id);

    const profileRows = await supabase(
      `profiles?telegram_id=eq.${encodeURIComponent(telegramId)}&select=id,auth_user_id,bonus_balance,subscription_plan,name,phone&limit=1`
    );

    const profile = profileRows?.[0];

    if (!profile) {
      return res.status(400).json({
        error: "Profile not found. Open your profile in the app first."
      });
    }

    const productIds = [...new Set(
      items.map(item => String(item.product_id || ""))
    )];

    if (productIds.some(id => !id)) {
      return res.status(400).json({
        error: "Invalid product"
      });
    }

    const idFilter = productIds
      .map(id => `"${id.replace(/"/g, '\\"')}"`)
      .join(",");

    const products = await supabase(
      `products?id=in.(${encodeURIComponent(idFilter)})&is_active=eq.true&select=id,name,price`
    );

    if (!products || products.length !== productIds.length) {
      return res.status(400).json({
        error: "Some products are unavailable"
      });
    }

    const normalizedItems = [];

    for (const item of items) {
      const product = products.find(
        p => String(p.id) === String(item.product_id)
      );

      if (!product) {
        return res.status(400).json({
          error: "Product not found"
        });
      }

      const quantity = Number(item.quantity);

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        return res.status(400).json({
          error: "Invalid quantity"
        });
      }

      const price = Number(product.price);

      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          error: "Invalid product price"
        });
      }

      normalizedItems.push({
        product_id: product.id,
        name: product.name,
        price,
        quantity,
        total: price * quantity
      });
    }

    const totalAmount = normalizedItems.reduce(
      (sum, item) => sum + item.total,
      0
    );

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({
        error: "Invalid order total"
      });
    }

    await supabase(
      `profiles?id=eq.${encodeURIComponent(profile.id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          name: String(name).trim(),
          phone: String(phone).trim()
        })
      }
    );

    const insertedOrders = await supabase("orders", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: profile.auth_user_id,
        telegram_id: telegramId,
        customer_name: String(name).trim(),
        phone: String(phone).trim(),
        items: normalizedItems,
        total_amount: totalAmount,
        status: "pending",
        payment_status: "pending",
        points_earned: 0,
        points_spent: 0
      })
    });

    const order = insertedOrders?.[0];

    if (!order) {
      throw new Error("Order was not created");
    }

    const shortId = String(order.id).slice(0, 8).toUpperCase();

    let paymentMessageSent = true;

    try {
      await telegram("sendMessage", {
        chat_id: telegramId,
        text:
          `Здравствуйте, ${escapeHtml(name)}!\n\n` +
          `Ваш заказ RAVO PRIVÉ №${shortId} оформлен.\n\n` +
          `Сумма к оплате: ${totalAmount.toFixed(0)} ₽\n\n` +
          `Переведите точную сумму на карту Сбербанка:\n` +
          `<code>${cardNumber}</code>\n` +
          (SBER_CARDHOLDER
            ? `Получатель: ${escapeHtml(SBER_CARDHOLDER)}\n\n`
            : "\n") +
          `После перевода отправьте сюда фотографию или скриншот чека.\n\n` +
          `Мы проверим поступление денег вручную и сообщим результат.\n\n` +
          `Никому не отправляйте PIN-код, CVV или коды из SMS.`,
        parse_mode: "HTML"
      });
    } catch (error) {
      paymentMessageSent = false;
      console.error("Buyer payment message failed:", error);
    }

    const adminText =
      `🛍 НОВЫЙ ЗАКАЗ RAVO PRIVÉ\n\n` +
      `Заказ: ${shortId}\n` +
      `Покупатель: ${escapeHtml(name)}\n` +
      `Telegram ID: ${telegramId}\n` +
      `Телефон: ${escapeHtml(phone)}\n\n` +
      normalizedItems.map(item =>
        `${escapeHtml(item.name)} × ${item.quantity} — ${item.total} ₽`
      ).join("\n") +
      `\n\nИтого: ${totalAmount} ₽` +
      `\nОплата: ожидается перевод` +
      (paymentMessageSent
        ? ""
        : "\n⚠️ Не удалось отправить покупателю реквизиты");

    await telegram("sendMessage", {
      chat_id: TELEGRAM_ADMIN_CHAT_ID,
      text: adminText,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          {
            text: "✅ Подтвердить заказ",
            callback_data: `order_confirm:${order.id}`
          },
          {
            text: "❌ Отменить",
            callback_data: `order_cancel:${order.id}`
          }
        ], [
          {
            text: "📦 Заказ доставлен",
            callback_data: `order_done:${order.id}`
          }
        ]]
      }
    });

    return res.status(200).json({
      success: true,
      order_id: order.id,
      payment_message_sent: paymentMessageSent
    });

  } catch (error) {
    console.error("Order creation error:", error);

    return res.status(500).json({
      error: "Could not create order"
    });
  }
}
