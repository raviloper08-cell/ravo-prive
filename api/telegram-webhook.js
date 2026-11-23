
import { createHash } from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !adminChatId) {
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
    const update = req.body || {};
    const callback = update.callback_query;

    if (!callback) {
      return res.status(200).json({ ok: true });
    }

    const message = callback.message;
    const chatId = message?.chat?.id;

    if (String(chatId) !== String(adminChatId)) {
      await fetch(
        `https://api.telegram.org/bot${token}/answerCallbackQuery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callback.id,
            text: "Нет доступа"
          })
        }
      );

      return res.status(200).json({ ok: true });
    }

    const statuses = {
      order_confirm: "✅ <b>ЗАКАЗ ПОДТВЕРЖДЁН</b>",
      order_cancel: "❌ <b>ЗАКАЗ ОТМЕНЁН</b>",
      order_done: "📦 <b>ЗАКАЗ ВЫПОЛНЕН</b>"
    };

    const status = statuses[callback.data];

    if (!status || !message?.message_id) {
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
          text: cleanText + "\n\n" + status,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] }
        })
      }
    );

    const editResult = await editResponse.json();

    await fetch(
      `https://api.telegram.org/bot${token}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callback.id,
          text: editResult.ok
            ? "Статус заказа обновлён"
            : "Не удалось изменить заказ"
        })
      }
    );

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({ ok: true });
  }
}
