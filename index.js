/**
 * =========================================================
 *  j3_discloud — نقطة الدخول لاستضافات Node.js (Pterodactyl)
 * =========================================================
 * البوت مكتوب بـ Python (bot.py) لكن لوحة الاستضافة تعمل
 * بإعداد Node.js وتطلب ملف index.js.
 *
 * هذا الملف (index.js) يحل المشكلة:
 *   1) يتأكد من وجود python3 — وإن لم يوجد يثبّته تلقائياً
 *      (apt-get ثم apk كبديل — يعمل على معظم الصور).
 *   2) يثبّت المتطلبات من requirements.txt (discord.py).
 *   3) يشغّل bot.py ويوصل مخرجاته بالكونسول مباشرة.
 *   4) يعيد توجيه إشارات الإيقاف (SIGTERM/SIGINT) — حتى
 *      تتوقف عملية البوت فعلاً عند الضغط على Stop من اللوحة،
 *      ويمرر كود الخروج حتى تعمل إعادة التشغيل التلقائي
 *      بشكل صحيح (بدون دائرة تعطل Crash Loop).
 * =========================================================
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BOT_FILE = path.join(__dirname, 'bot.py');
const REQ_FILE = path.join(__dirname, 'requirements.txt');

/** تنفيذ أمر في القشرة مع طباعته في الكونسول */
function run(cmd) {
  console.log('> ' + cmd);
  return execSync(cmd, { stdio: 'inherit' });
}

/** هل python3 (أو python) متوفر؟ */
function findPython() {
  try {
    execSync('python3 --version', { stdio: 'ignore' });
    return 'python3';
  } catch { /* متابعة */ }
  try {
    execSync('python --version', { stdio: 'ignore' });
    return 'python';
  } catch { /* متابعة */ }
  return null;
}

/** تثبيت Python تلقائياً إن لم يكن موجوداً (apt ثم apk) */
function ensurePython() {
  if (findPython()) return findPython();
  console.log('⚠️ python3 غير موجود — أحاول تثبيته تلقائياً...');
  const installers = [
    'apt-get update -y && apt-get install -y python3 python3-pip',
    'apk add --no-cache python3 py3-pip',
  ];
  for (const cmd of installers) {
    try {
      run(cmd);
      if (findPython()) return findPython();
    } catch (e) {
      console.log('   (فشلت المحاولة — أجرب الطريقة التالية)');
    }
  }
  console.error('❌ تعذر تثبيت Python تلقائياً.');
  console.error('💡 الحل: في لوحة الاستضافة غيّر إعداد التشغيل إلى Python، أو اطلب من الدعم تثبيت python3 على الصورة.');
  process.exit(1);
}

function main() {
  if (!fs.existsSync(BOT_FILE)) {
    console.error('❌ الملف bot.py غير موجود في: ' + BOT_FILE);
    console.error('💡 تأكد من رفع كل ملفات المشروع إلى /home/container/ (المسار الجذري).');
    process.exit(1);
  }

  const py = ensurePython();
  console.log('✅ تم العثور على: ' + py);

  // تثبيت المتطلبات (discord.py) — إن فشل نكمل لأن البوت قد يكون مثبتاً في الصورة
  if (fs.existsSync(REQ_FILE)) {
    console.log('📦 تثبيت المتطلبات من requirements.txt...');
    try {
      run(py + ' -m pip install -r ' + REQ_FILE);
    } catch (e) {
      console.log('⚠️ pip install لم يكتمل — سأحاول تشغيل البوت على أي حال.');
    }
  }

  console.log('🚀 تشغيل البوت: ' + py + ' bot.py');
  const proc = spawn(py, ['bot.py'], { cwd: __dirname, stdio: 'inherit' });

  // مرر كود الخروج إلى اللوحة (إعادة تشغيل تلقائي صحيحة)
  proc.on('exit', (code, signal) => {
    console.log(`⛔ انتهى البوت (code=${code}, signal=${signal})`);
    process.exit(code !== null ? code : 1);
  });
  proc.on('error', (err) => {
    console.error('❌ فشل تشغيل العملية:', err.message);
    process.exit(1);
  });

  // إيقاف نظيف عند الضغط على Stop من اللوحة
  process.on('SIGTERM', () => {
    console.log('🛑 استقبلت SIGTERM — إيقاف البوت...');
    proc.kill('SIGTERM');
  });
  process.on('SIGINT', () => {
    console.log('🛑 استقبلت SIGINT — إيقاف البوت...');
    proc.kill('SIGINT');
  });
}

main();
