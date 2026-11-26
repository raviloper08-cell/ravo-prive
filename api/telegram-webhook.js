import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhook(req, token) {
  const received = req.headers["x-telegram-bot-api-secret-token"];
  const expected = createHash(token);

  if (!received || !expected) return false;

  try {
    return timingSafeEqual(
      Buffer.from(received),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

function createHash(token) {
  return createHmac("sha256", token)
    .update("WebAppData")
    .digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_ADMIN_CHAT_ID
  } = process.env;

  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_ADMIN_CHAT_ID
  ) {
    return res.status(500).send("Missing environment variables");
  }

  if (!verifyWebhook(req, TELEGRAM_BOT_TOKEN)) {
    return res.status(401).send("Unauthorized");
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };

  async function db(path, options = {}) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(text || "Database error");
    }

    return text ? JSON.parse(text) : null;
  }

  async function bot(method, body) {
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
      throw new Error(result.description || "Telegram error");
    }

    return result;
  }

  // Если покупатель заблокировал бота, сервер больше не падает.
  async function notifyBuyer(chatId, message) {
    try {
      await bot("sendMessage", {
        chat_id: chatId,
        text: message
      });
    } catch (error) {
      console.error("Could not notify buyer:", error.message);
    }
  }

  async function answer(callbackId, text, alert = false) {
    try {
      await bot("answerCallbackQuery", {
        callback_query_id: callbackId,
        text,
        show_alert: alert
      });
    } catch (error) {
      console.error("answerCallbackQuery error:", error.message);
    }
  }

  // Меняет заказ только если он ещё в нужном состоянии.
  // Возвращает true, если изменение реально произошло.
  // Двойное нажатие кнопки второй раз ничего не изменит.
  async function updateIfState(orderId, filter, changes) {
    const rows = await db(
      `orders?id=eq.${encodeURIComponent(orderId)}&${filter}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(changes)
      }
    );

    return Array.isArray(rows) && rows.length > 0;
  }

  try {
    const update = req.body || {};

    // Покупатель отправил чек
    if (update.message?.chat?.type === "private" && update.message.from) {
      const message = update.message;
      const telegramId = String(message.from.id);

      const photo = message.photo;
      const document = message.document;

      if (!photo && !document) {
        return res.status(200).send("OK");
      }

      const orders = await db(
        `orders?telegram_id=eq.${encodeURIComponent(telegramId)}&payment_status=in.(pending,rejected)&status=neq.cancelled&select=id,total_amount,created_at&order=created_at.desc&limit=1`
      );

      if (!orders.length) {
        await notifyBuyer(
          telegramId,
          "У тебя нет заказа, ожидающего подтверждения оплаты."
        );

        return res.status(200).send("OK");
      }

      const order = orders[0];
      const shortId = order.id.slice(0, 8).toUpperCase();

      const caption =
        `🧾 ЧЕК ОТ ПОКУПАТЕЛЯ\n\n` +
        `Заказ: ${shortId}\n` +
        `Telegram ID: ${telegramId}\n` +
        `Сумма заказа: ${order.total_amount} ₽\n\n` +
        `Проверь поступление денег в приложении банка.`;

      const keyboard = {
        inline_keyboard: [[
          {
            text: "✅ Деньги поступили",
            callback_data: `payment_approve:${order.id}`
          },
          {
            text: "❌ Не поступили",
            callback_data: `payment_reject:${order.id}`
          }
        ]]
      };

      if (photo) {
        const fileId = photo[photo.length - 1].file_id;

        await bot("sendPhoto", {
          chat_id: TELEGRAM_ADMIN_CHAT_ID,
          photo: fileId,
          caption,
          reply_markup: keyboard
        });
      } else {
        await bot("sendDocument", {
          chat_id: TELEGRAM_ADMIN_CHAT_ID,
          document: document.file_id,
          caption,
          reply_markup: keyboard
        });
      }

      await db(
        `orders?id=eq.${encodeURIComponent(order.id)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            payment_status: "proof_submitted"
          })
        }
      );

      await notifyBuyer(
        telegramId,
        "Чек получен! Мы проверим поступление денег вручную и сообщим результат."
      );

      return res.status(200).send("OK");
    }

    // Нажатие кнопок администратора
    const callback = update.callback_query;

    if (!callback) {
      return res.status(200).send("OK");
    }

    if (String(callback.from.id) !== String(TELEGRAM_ADMIN_CHAT_ID)) {
      await answer(callback.id, "Нет доступа", true);
      return res.status(200).send("OK");
    }

    const [action, orderId] = String(callback.data || "").split(":");

    if (!orderId) {
      return res.status(200).send("OK");
    }

    const rows = await db(
      `orders?id=eq.${encodeURIComponent(orderId)}&select=id,telegram_id,total_amount,status,payment_status&limit=1`
    );

    const order = rows[0];

    if (!order) {
      await answer(callback.id, "Заказ не найден", true);
      return res.status(200).send("OK");
    }

    // Подтверждение оплаты
    if (action === "payment_approve") {
      const changed = await updateIfState(
        orderId,
        "payment_status=eq.proof_submitted",
        { payment_status: "paid" }
      );

      if (!changed) {
        await answer(callback.id, "Чек ещё не отправлен или уже обработан", true);
        return res.status(200).send("OK");
      }

      await notifyBuyer(
        order.telegram_id,
        "✅ Оплата подтверждена! Твой заказ принят и ожидает сборки."
      );

      await answer(callback.id, "Оплата подтверждена");
    }

    // Отклонение оплаты
    else if (action === "payment_reject") {
      const changed = await updateIfState(
        orderId,
        "payment_status=eq.proof_submitted",
        { payment_status: "rejected" }
      );

      if (!changed) {
        await answer(callback.id, "Чек ещё не отправлен или уже обработан", true);
        return res.status(200).send("OK");
      }

      await notifyBuyer(
        order.telegram_id,
        "❌ Оплата пока не подтверждена. Проверь перевод и отправь чек ещё раз."
      );

      await answer(callback.id, "Оплата отклонена");
    }

    // Подтверждение заказа после оплаты
    else if (action === "order_confirm") {
      if (order.payment_status !== "paid") {
        await answer(callback.id, "Сначала подтверди оплату", true);
        return res.status(200).send("OK");
      }

      const changed = await updateIfState(
        orderId,
        "payment_status=eq.paid&status=not.in.(processing,delivered,cancelled)",
        { status: "processing" }
      );

      if (!changed) {
        await answer(callback.id, "Заказ уже обработан", true);
        return res.status(200).send("OK");
      }

      await notifyBuyer(
        order.telegram_id,
        "📦 Твой заказ принят в обработку!"
      );

      await answer(callback.id, "Заказ подтверждён");
    }

    // Отмена заказа (доставленный или уже отменённый отменить нельзя)
    else if (action === "order_cancel") {
      const changed = await updateIfState(
        orderId,
        "status=not.in.(delivered,cancelled)",
        { status: "cancelled" }
      );

      if (!changed) {
        await answer(callback.id, "Этот заказ уже нельзя отменить", true);
        return res.status(200).send("OK");
      }

      await notifyBuyer(
        order.telegram_id,
        "Заказ отменён. Если нужна помощь, напиши @RavoPriveManager."
      );

      await answer(callback.id, "Заказ отменён");
    }

    // Заказ доставлен и начисление бонусов
    // (логика оставлена как была, чтобы не сломать начисление бонусов)
    else if (action === "order_done") {
      if (order.status !== "processing" || order.payment_status !== "paid") {
        await answer(callback.id, "Нельзя завершить этот заказ", true);
        return res.status(200).send("OK");
      }

      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/complete_ravo_order`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            p_order_id: orderId
          })
        }
      );

      if (!response.ok) {
        throw new Error(await response.text());
      }

      await db(`orders?id=eq.${encodeURIComponent(orderId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "delivered"
        })
      });

      await notifyBuyer(
        order.telegram_id,
        "🎉 Заказ доставлен! Спасибо за покупку в RAVO PRIVÉ. Бонусы начислены, если они предусмотрены твоим уровнем."
      );

      await answer(callback.id, "Заказ завершён");
    }

    return res.status(200).send("OK");

  } catch (error) {
    // Отвечаем 200, чтобы Telegram не слал одно и то же сообщение снова и снова.
    console.error("Webhook error:", error);
    return res.status(200).send("OK");
  }
}