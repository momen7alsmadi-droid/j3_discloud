/**
 * =========================================================
 *  j3_discloud — نقطة الدخول لاستضافات Node.js (Pterodactyl)
 * =========================================================
 *  البوت كامل في bot.js (discord.js v14).
 *  هذا الملف يشغّل البوت صراحةً — يعمل سواء كان
 *  MAIN_FILE = index.js أو MAIN_FILE = bot.js.
 * =========================================================
 */

console.log('🚀 j3_discloud (JS v5) — نقطة الدخول تعمل ✅');

const bot = require('./bot.js');

bot.main().catch((e) => {
  console.error('❌ خطأ غير متوقع:', e.message);
  process.exit(1);
});
