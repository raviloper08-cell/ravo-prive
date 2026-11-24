
import { createHash } from "node:crypto";

function parseCallbackData(data) {
  const value = String(data || "").trim();

  const patterns = [
    /^(order_confirm|order_cancel|order_done)[:_-]([A-Za-z0-9_-]+)$/i,
    /^(confirm|cancel|done)[:_-]([A-Za-z0-9_-]+)$/i,
    /^(confirm_order|cancel_order|done_order)[:_-]([A-Za-z0-9_-]+)$/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(value);

    if (match) {
      const actionName = match[1].toLowerCase();
      const orderId = match[2];

      const actionMap = {
        order_confirm: "order_confirm",
        order_cancel: "order_cancel",
        order_done: "order_done",
        confirm: "order_confirm",
        cancel: "order_cancel",
        done: "order_done",
        confirm_order: "order_confirm",
        cancel_order: "order_cancel",
        done_order: "order_done"
      };

      return {
        action: actionMap[actionName],
        orderId
      };
    }
  }

  return null;
}

async function answerCallback(token, callbackId, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text
      })
    }
  );

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!token || !adminChatId || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server not configured" });
  }

  const expectedSecret = createHash("sha256")
    .update(token)
    .digest("hex");

  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"];

  if (receivedSecret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const callback = req.body?.callback_query;

  if (!callback) {
    return res.status(200).json({ ok: true });
  }

  try {
    console.log("RAVO CALLBACK:", JSON.stringify({
      data: callback.data,
      messageId: callback.message?.message_id,
      chatId: callback.message?.chat?.id
    }));

    const message = callback.message;
    const chatId = message?.chat?.id;

    if (String(chatId) !== String(adminChatId)) {
      await answerCallback(token, callback.id, "Нет доступа");
      return res.status(200).json({ ok: true });
    }

    if (!message?.message_id) {
      await answerCallback(token, callback.id, "Сообщение заказа не найдено");
      return res.status(200).json({ ok: true });
    }

    const parsed = parseCallbackData(callback.data);

    if (!parsed) {
      console.error("Invalid callback data:", callback.data);
      await answerCallback(token, callback.id, "Не удалось распознать кнопку");
      return res.status(200).json({ ok: true });
    }

    const statusMap = {
      order_confirm: {
        value: "processing",
        text: "✅ <b>ЗАКАЗ ПОДТВЕРЖДЁН</b>",
        answer: "Заказ подтверждён"
      },
      order_cancel: {
        value: "cancelled",
        text: "❌ <b>ЗАКАЗ ОТМЕНЁН</b>",
        answer: "Заказ отменён"
      },
      order_done: {
        value: "delivered",
        text: "📦 <b>ЗАКАЗ ВЫПОЛНЕН</b>",
        answer: "Заказ выполнен"
      }
    };

    const selected = statusMap[parsed.action];

    if (!selected) {
      await answerCallback(token, callback.id, "Неизвестное действие");
      return res.status(200).json({ ok: true });
    }

    const updateResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(parsed.orderId)}&select=id,status`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: selected.value,
          updated_at: new Date().toISOString()
        })
      }
    );

    const updateText = await updateResponse.text();
    let updatedOrders = [];

    try {
      updatedOrders = updateText ? JSON.parse(updateText) : [];
    } catch {
      console.error("Supabase returned invalid JSON:", updateText);
    }

    if (!updateResponse.ok || !updatedOrders.length) {
      console.error("Order update failed:", {
        status: updateResponse.status,
        response: updateText,
        orderId: parsed.orderId
      });

      await answerCallback(token, callback.id, "Не удалось обновить заказ");
      return res.status(200).json({ ok: true });
    }

    const originalText = message.text || message.caption || "";

    const cleanText = originalText.replace(
      /\n\n(?:✅ <b>ЗАКАЗ ПОДТВЕРЖДЁН<\/b>|❌ <b>ЗАКАЗ ОТМЕНЁН<\/b>|📦 <b>ЗАКАЗ ВЫПОЛНЕН<\/b>)$/,
      ""
    );

    const editResponse = await fetch(
      `https://api.telegram.org/bot${token}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: message.message_id,
          text: cleanText + "\n\n" + selected.text,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: []
          }
        })
      }
    );

    const editResult = await editResponse.json();

    if (!editResult.ok) {
      console.error("Telegram edit error:", editResult);
    }

    await answerCallback(
      token,
      callback.id,
      editResult.ok
        ? selected.answer
        : "Статус сохранён, но сообщение не обновилось"
    );

    console.log("RAVO ORDER UPDATED:", {
      orderId: parsed.orderId,
      status: selected.value,
      telegramUpdated: editResult.ok
    });

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("RAVO WEBHOOK ERROR:", error);

    try {
      await answerCallback(
        token,
        callback.id,
        "Ошибка обработки. Попробуйте ещё раз."
      );
    } catch (callbackError) {
      console.error("Callback answer error:", callbackError);
    }

    return res.status(200).json({ ok: true });
  }
}
