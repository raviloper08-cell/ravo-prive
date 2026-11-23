
import { createHash } from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !adminChatId) {
    return res.status(500).json({ ok: false });
  }

  const expectedSecret = createHash("sha256")
    .update(token)
    .digest("hex");

  if (
    req.headers["x-telegram-bot-api-secret-token"] !== expectedSecret
  ) {
    return res.status(401).json({ ok: false });
  }

  try {
    const callback = req.body?.callback_query;

    if (!callback) {
      return res.status(200).json({ ok: true });
    }

    const message = callback.message;
    const chatId = String(message?.chat?.id || "");

    if (chatId !== String(adminChatId)) {
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

    const cleanText = (message.text || "").replace(
      /\n\n(?:✅ <b>ЗАКАЗ ПОДТВЕРЖДЁН<\/b>|❌ <b>ЗАКАЗ ОТМЕНЁН<\/b>|📦 <b>ЗАКАЗ ВЫПОЛНЕН<\/b>)$/,
      ""
    );

    await fetch(
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

    await fetch(
      `https://api.telegram.org/bot${token}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callback.id,
          text: "Статус заказа обновлён"
        })
      }
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({ ok: true });
  }
}
