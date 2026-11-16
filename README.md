# بوت تواصل بالمواضيع (Mirror Topic Bot) — Node.js 24 LTS

بوت تواصل احترافي يعمل على Vercel وUpstash Redis بدون أي مكتبات خارجية، يربط كل مستخدم بموضوع مستقل داخل مجموعة تيليجرام مع دعم المحادثة المتزامنة طبق الأصل (الرد المتبادل، الاقتباس الجزئي، التفاعلات، التبديل بين إظهار الاسم وإخفائه، وحفظ سجل الرسائل قبل التعديل).

## 1. المتغيرات المطلوبة في Vercel
- `BOT_TOKEN`: توكن البوت من `@BotFather`.
- `OWNER_ID`: معرّف حسابك الرقمي في تيليجرام (يمكنك وضع `0` مؤقتاً وإرسال `/id` للبوت لمعرفته).
- `WEBHOOK_SECRET`: كلمة سر عشوائية من حروف إنجليزية وأرقام (16 حرفاً فأكثر).
- متغيرات Redis (تُضاف تلقائياً عند ربط Upstash من Vercel Storage أو يدوياً):
  - `UPSTASH_REDIS_REST_URL` (أو `KV_REST_API_URL`)
  - `UPSTASH_REDIS_REST_TOKEN` (أو `KV_REST_API_TOKEN`)

## 2. تفعيل الـ Webhook
بعد نشر المشروع على Vercel، افتح الرابط التالي في المتصفح مرة واحدة بعد استبدال القيم الثلاث (`<BOT_TOKEN>` و `<PROJECT_DOMAIN>` و `<WEBHOOK_SECRET>`):

```text
[https://api.telegram.org/bot](https://api.telegram.org/bot)<BOT_TOKEN>/setWebhook?url=https://<PROJECT_DOMAIN>/api/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message","edited_message","callback_query","message_reaction"]
