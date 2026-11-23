
import { createHash } from "node:crypto";

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

  try {
    const callback = req.body?.callback_query;

    if (!callback) {
      return res.status(200).json({ ok: true });
    }

    const message = callback.message;
    const chatId = message?.chat?.id;

    if (String(chatId) !== String(adminChatId)) {
      await answerCallback(token, callback.id, "Нет доступа");
      return res.status(200).json({ ok: true });
    }

    const match = /^(order_confirm|order_cancel|order_done):(\d+)$/
      .exec(callback.data || "");

    if (!match || !message?.message_id) {
      await answerCallback(token, callback.id, "Некорректная кнопка");
      return res.status(200).json({ ok: true });
    }

    const action = match[1];
    const orderId = match[2];

    const statusMap = {
      order_confirm: {
        value: "confirmed",
        text: "✅ <b>ЗАКАЗ ПОДТВЕРЖДЁН</b>",
        answer: "Заказ подтверждён"
      },
      order_cancel: {
        value: "cancelled",
        text: "❌ <b>ЗАКАЗ ОТМЕНЁН</b>",
        answer: "Заказ отменён"
      },
      order_done: {
        value: "completed",
        text: "📦 <b>ЗАКАЗ ВЫПОЛНЕН</b>",
        answer: "Заказ выполнен"
      }
    };

    const selected = statusMap[action];

    const updateResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id,status`,
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

    const updatedOrders = await updateResponse.json();

    if (!updateResponse.ok || !updatedOrders.length) {
      console.error("Order status update error:", updatedOrders);
      await answerCallback(token, callback.id, "Не удалось обновить заказ");
      return res.status(200).json({ ok: true });
    }

    const originalText = message.text || "";
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
          chat_id: adminChatId,
          message_id: message.message_id,
          text: cleanText + "\n\n" + selected.text,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] }
        })
      }
    );

    const editResult = await editResponse.json();

    await answerCallback(
      token,
      callback.id,
      editResult.ok
        ? selected.answer
        : "Статус сохранён, но сообщение не обновилось"
    );

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({ ok: true });
  }
}

async function answerCallback(token, callbackId, text) {
  await fetch(
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
}
