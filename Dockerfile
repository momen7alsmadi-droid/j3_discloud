# =========================================================
# Dockerfile — نسخة JavaScript (discord.js)
# يعمل على أي نظام بناء يستخدم Docker (Render / الشركات)
# =========================================================
FROM node:20-slim

WORKDIR /app

# تثبيت الاعتماديات (discord.js) — يتطلب الإنترنت أثناء البناء
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# نسخ ملفات المشروع (config.json و database.json و .env مستثناة عبر .dockerignore)
COPY bot.js index.js config.example.json ./

# منفذ خادم HTTP لإبقاء الخدمة حية
EXPOSE 8080

# تشغيل البوت
CMD ["node", "bot.js"]
