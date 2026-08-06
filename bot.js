/**
 * =========================================================
 *  j3_discloud — بوت السجن (Jail Bot) — نسخة JavaScript
 * =========================================================
 *  تحويل كامل من Python (discord.py) إلى JavaScript (discord.js v14)
 *  — يعمل مباشرة على استضافات Node.js (Pterodactyl) بدون أي
 *    اعتماد على Python أو pip.
 *
 *  الميزات (منقولة بالكامل من النسخة الأصلية):
 *    - /settings  لوحة تحكم (مزامنة الرومات، تحرير الكل، صلاحيات،
 *                 روم اللوق، رتبة السجن، روم السجن، فحص، ريسيت)
 *    - /jail      سجن عضو (سبب + مدة اختيارية)
 *    - /jailmany  سجن جماعي (منشنات وآيديات)
 *    - /unjail    فك سجن
 *    - /jailtime  تعديل مدة السجن (أو permanent)
 *    - /jailinfo  تفاصيل سجن عضو
 *    - /jaillist  قائمة المسجونين
 *    - تحرير تلقائي كل 30 ثانية لمن انتهت مدته
 *    - إعادة سجن تلقائي عند عودة مسجون غادر السيرفر (الهروب)
 *    - keep-alive كل 14 دقيقة لروم محدد (منع إطفاء الاستضافة)
 *    - خادم HTTP صغير (PORT أو 8080) لإبقاء الخدمة حية على Render
 * =========================================================
 */

const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  REST,
  Routes,
} = require('discord.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ================= إعدادات ثابتة =================
const DEV_ID = '1387331972094890036';
const CONFIG_FILE = 'config.json';
const DATABASE_FILE = 'database.json';
const ENV_FILE = '.env';
const KEEP_ALIVE_CHANNEL_ID_DEFAULT = '1530910507408560128';
const DURATION_MULTIPLIERS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000 };
const DURATION_HELP =
  'استخدم مثل: 30s (ثواني), 10m (دقائق), 1h (ساعات), 2d (أيام), 1w (أسابيع), 3mo (أشهر)';

// ألوان مطابقة لنسخة بايثون (discord.py)
const COLOR = {
  blurple: 0x5865f2,
  red: 0xed4245,
  green: 0x57f287,
  orange: 0xfee75c,
  dark_red: 0x992d22,
};

// ================= قراءة .env =================
function loadDotenvFile(filePath = ENV_FILE) {
  if (!fs.existsSync(filePath)) return;
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* تجاهل */
  }
}

// ================= إدارة الملفات =================
function loadJson(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return defaultValue;
    return JSON.parse(content);
  } catch {
    return defaultValue;
  }
}

function saveJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

let config = loadJson(CONFIG_FILE, {
  token: process.env.TOKEN || '',
  jail_role_id: '',
  jail_room_id: '',
  log_room_id: '',
});

function saveConfig() {
  saveJsonAtomic(CONFIG_FILE, config);
}

function loadDatabase() {
  return loadJson(DATABASE_FILE, {});
}

function saveDatabase(db) {
  saveJsonAtomic(DATABASE_FILE, db);
  if (mongoCollection) {
    // حفظ في MongoDB (بدون انتظار — لا تعطل البوت لو فشل)
    mongoCollection
      .updateOne({ _id: 'db' }, { $set: { data: db } }, { upsert: true })
      .catch((err) => console.error('⚠️ فشل الحفظ في MongoDB:', err.message));
  }
}

// ================= تخزين MongoDB (اختياري) =================
// عند وضع MONGODB_URI في .env أو متغير البيئة → تُحفظ كل البيانات في القاعدة
// وإلا يعمل البوت بشكل عادي على database.json المحلي.
let mongoClient = null;
let mongoDb = null;
let mongoCollection = null;

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGO_URI || '';
}

async function initMongo() {
  const uri = getMongoUri();
  if (!uri) {
    console.log('💾 التخزين: database.json محلي (لا يوجد MONGODB_URI)');
    return false;
  }
  try {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await mongoClient.connect();
    mongoDb = mongoClient.db('c2');
    mongoCollection = mongoDb.collection('j3_jail_state');

    const doc = await mongoCollection.findOne({ _id: 'db' });
    if (doc && doc.data && Object.keys(doc.data).length) {
      // القاعدة هي المصدر — نزامن الملف المحلي معها
      saveJsonAtomic(DATABASE_FILE, doc.data);
      console.log('🍃 MongoDB متصل — تم تحميل البيانات من القاعدة');
    } else {
      // أول اتصال: ترحيل البيانات المحلية (database.json) إلى القاعدة
      const local = loadJson(DATABASE_FILE, {});
      if (Object.keys(local).length) {
        await mongoCollection.updateOne({ _id: 'db' }, { $set: { data: local } }, { upsert: true });
        console.log('🍃 MongoDB متصل — تم ترحيل database.json إلى القاعدة');
      } else {
        console.log('🍃 MongoDB متصل — قاعدة جديدة جاهزة');
      }
    }
    return true;
  } catch (err) {
    console.error('⚠️ تعذر الاتصال بـ MongoDB:', err.message);
    console.error('   سيستمر العمل على database.json المحلي.');
    return false;
  }
}

function getGuildEntry(db, guildId) {
  const key = String(guildId);
  if (!db[key]) db[key] = { allowed_ids: [], prisoners: {} };
  if (!db[key].allowed_ids) db[key].allowed_ids = [];
  if (!db[key].prisoners) db[key].prisoners = {};
  return db[key];
}

// ================= أدوات مساعدة =================
function parseDuration(durationStr) {
  const match = /^(\d+)(s|mo|m|h|d|w)$/i.exec(String(durationStr).trim());
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return value * DURATION_MULTIPLIERS[unit];
}

function extractUserIds(text) {
  const ids = [];
  const seen = new Set();
  const mentionRe = /<@!?(\d+)>/g;
  let m;
  while ((m = mentionRe.exec(text)) !== null) {
    const uid = m[1];
    if (!seen.has(uid)) {
      seen.add(uid);
      ids.push(uid);
    }
  }
  const idRe = /(?<!\d)(\d{15,20})(?!\d)/g;
  while ((m = idRe.exec(text)) !== null) {
    const uid = m[1];
    if (!seen.has(uid)) {
      seen.add(uid);
      ids.push(uid);
    }
  }
  return ids;
}

function formatRemaining(endTimestamp) {
  if (endTimestamp == null) return 'مؤبد';
  const remaining = Math.floor(endTimestamp - Date.now() / 1000);
  if (remaining <= 0) return 'على وشك الانتهاء';
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days} يوم`);
  if (hours) parts.push(`${hours} ساعة`);
  if (minutes) parts.push(`${minutes} دقيقة`);
  return parts.length ? parts.join(' و ') : 'أقل من دقيقة';
}

function isDev(userId) {
  return String(userId) === DEV_ID;
}

function isOwnerOrDev(interaction) {
  if (isDev(interaction.user.id)) return true;
  return Boolean(interaction.guild && interaction.guild.ownerId === interaction.user.id);
}

/** فحص صلاحية استخدام أوامر السجن — يرجع true عند السماح، وإلا يرد برسالة ويعيد false */
async function requireJailPermission(interaction) {
  if (isDev(interaction.user.id)) return true;
  if (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const db = loadDatabase();
  const entry = getGuildEntry(db, interaction.guild.id);
  const allowedIds = new Set(entry.allowed_ids);
  if (allowedIds.has(interaction.user.id)) return true;
  if (interaction.member) {
    for (const role of interaction.member.roles.cache.values()) {
      if (allowedIds.has(role.id)) return true;
    }
  }
  await interaction.reply({ content: 'ليس لديك صلاحية استخدام هذا الأمر.', ephemeral: true });
  return false;
}

/** صلاحية أمر الكتابة — مطابقة /jail تماماً */
async function messageHasJailPermission(message) {
  if (isDev(message.author.id)) return true;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const db = loadDatabase();
  const entry = getGuildEntry(db, message.guild.id);
  const allowedIds = new Set(entry.allowed_ids);
  if (allowedIds.has(message.author.id)) return true;
  for (const role of message.member.roles.cache.values()) {
    if (allowedIds.has(role.id)) return true;
  }
  return false;
}

function botCanManageMember(guild, member) {
  const me = guild.members.me;
  if (!me) return false;
  if (guild.ownerId === me.id) return true;
  return me.roles.highest.comparePositionTo(member.roles.highest) > 0;
}

async function getMember(guild, userId) {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

// ================= صلاحيات القنوات الخاصة (تكت / رومات فردية) =================
async function stripMemberChannelOverwrites(guild, member) {
  const captured = {};
  for (const channel of guild.channels.cache.values()) {
    const overwrite = channel.permissionOverwrites?.cache?.get(member.id);
    if (!overwrite) continue;
    captured[String(channel.id)] = [overwrite.allow.bitfield, overwrite.deny.bitfield];
    try {
      await channel.permissionOverwrites.delete(member.id, 'سجن - إخفاء قناة خاصة مؤقتًا');
    } catch {
      /* تجاهل */
    }
  }
  return captured;
}

async function restoreMemberChannelOverwrites(guild, member, captured) {
  for (const [channelIdStr, pair] of Object.entries(captured || {})) {
    const channel = guild.channels.cache.get(channelIdStr);
    if (!channel) continue;
    const [allowBits, denyBits] = pair;
    try {
      await channel.permissionOverwrites.set(
        member.id,
        { allow: new PermissionsBitField(allowBits), deny: new PermissionsBitField(denyBits) },
        'فك سجن - استعادة قناة خاصة'
      );
    } catch {
      /* تجاهل */
    }
  }
}

// ================= لوق =================
async function sendLog(guild, embed) {
  const logId = config.log_room_id;
  if (!logId) return;
  const channel = guild.channels.cache.get(String(logId));
  if (channel) {
    try {
      await channel.send({ embeds: [embed] });
    } catch {
      /* تجاهل */
    }
  }
}

async function sendJailRoomMessage(guild, content) {
  const roomId = config.jail_room_id;
  if (!roomId) return;
  const channel = guild.channels.cache.get(String(roomId));
  if (channel) {
    try {
      await channel.send(content);
    } catch {
      /* تجاهل */
    }
  }
}

// ================= منطق التحرير الجماعي =================
async function releasePrisoner(guild, userId, record) {
  const member = await getMember(guild, userId);
  const jailRoleId = config.jail_role_id;
  const jailRole = jailRoleId ? guild.roles.cache.get(String(jailRoleId)) : null;

  if (member) {
    try {
      if (jailRole && member.roles.cache.has(jailRole.id)) {
        await member.roles.remove(jailRole, 'تحرير جماعي');
      }
      const rolesToRestore = (record.original_roles || [])
        .map((rid) => guild.roles.cache.get(String(rid)))
        .filter((r) => r);
      if (rolesToRestore.length) {
        await member.roles.add(rolesToRestore, 'تحرير جماعي - استعادة الرتب');
      }
    } catch (err) {
      if (err.code === 50013) return false; // Missing Permissions
      return false;
    }
    await restoreMemberChannelOverwrites(guild, member, record.channel_overwrites);
  }
  return true;
}

async function releaseAllPrisoners(guild) {
  const db = loadDatabase();
  const entry = getGuildEntry(db, guild.id);
  const prisoners = entry.prisoners;

  if (!Object.keys(prisoners).length) return [0, 0];

  let released = 0;
  let failed = 0;
  for (const userIdStr of Object.keys(prisoners)) {
    const record = prisoners[userIdStr];
    const ok = await releasePrisoner(guild, userIdStr, record);
    if (ok) {
      released++;
      delete prisoners[userIdStr];
    } else {
      failed++;
    }
    await sleep(200);
  }

  await saveDatabase(db);

  const embed = new EmbedBuilder()
    .setTitle('🔓 تحرير جماعي')
    .setDescription(`تم تحرير ${released} عضو.` + (failed ? ` فشل تحرير ${failed}.` : ''))
    .setColor(COLOR.green)
    .setTimestamp(new Date());
  await sendLog(guild, embed);
  return [released, failed];
}

// ================= فحص وتحرير من انتهت مدته =================
async function checkAndReleaseExpiredForGuild(guild, db) {
  const entry = getGuildEntry(db, guild.id);
  const prisoners = entry.prisoners;
  const jailRoleId = config.jail_role_id;
  const jailRole = jailRoleId ? guild.roles.cache.get(String(jailRoleId)) : null;

  const checked = Object.keys(prisoners).length;
  let released = 0;

  for (const userIdStr of Object.keys(prisoners)) {
    const record = prisoners[userIdStr];
    const endTime = record.end_time;
    if (endTime == null || endTime > Date.now() / 1000) continue; // مؤبد أو لم تنتهِ مدته

    const member = await getMember(guild, userIdStr);
    if (member && jailRole) {
      try {
        if (member.roles.cache.has(jailRole.id)) {
          await member.roles.remove(jailRole, 'انتهاء مدة السجن');
        }
        const rolesToRestore = (record.original_roles || [])
          .map((rid) => guild.roles.cache.get(String(rid)))
          .filter((r) => r);
        if (rolesToRestore.length) {
          await member.roles.add(rolesToRestore, 'انتهاء مدة السجن - استعادة الرتب');
        }
      } catch {
        /* تجاهل */
      }
      await restoreMemberChannelOverwrites(guild, member, record.channel_overwrites);
    }

    const embed = new EmbedBuilder()
      .setTitle('⏰ انتهاء مدة السجن')
      .setDescription(`تم فك سجن <@${userIdStr}> بعد التأكد من انتهاء المدة المحددة.`)
      .setColor(COLOR.green)
      .setTimestamp(new Date());
    await sendLog(guild, embed);

    delete prisoners[userIdStr];
    released++;
  }

  return [checked, released];
}

// ================= مزامنة الرومات مع رتبة السجن =================
async function syncJailRoleChannels(guild, jailRole, jailRoomId) {
  const targets = new Map();
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildCategory || c.isTextBased() || c.isVoiceBased()) {
      targets.set(c.id, c);
    }
  }

  let success = 0;
  let failed = 0;
  for (const channel of targets.values()) {
    try {
      const overwrite = channel.permissionOverwrites.cache.get(jailRole.id);
      const allow = overwrite ? overwrite.allow.bitfield : 0n;
      const deny = overwrite ? overwrite.deny.bitfield : 0n;
      const isJailRoom = String(channel.id) === String(jailRoomId);
      // view_channel = (هذا هو روم السجن) — الباقي يُحجب
      let allowBits = allow;
      let denyBits = deny;
      if (isJailRoom) {
        allowBits |= PermissionsBitField.Flags.ViewChannel;
        denyBits &= ~PermissionsBitField.Flags.ViewChannel;
      } else {
        allowBits &= ~PermissionsBitField.Flags.ViewChannel;
        denyBits |= PermissionsBitField.Flags.ViewChannel;
      }
      await channel.permissionOverwrites.set(
        jailRole.id,
        { allow: new PermissionsBitField(allowBits), deny: new PermissionsBitField(denyBits) },
        'مزامنة صلاحيات رتبة السجن'
      );
      success++;
    } catch {
      failed++;
    }
    await sleep(250);
  }

  return [success, failed];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================= عمليات السجن =================
/**
 * تنفيذ السجن الفعلي — مشترك بين أمر /jail وأمر الكتابة (سجن @عضو)
 * يرجع { ok: true, result } أو { ok: false, error }
 */
async function performJail(guild, actorUserId, actorMember, member, reason, durationStr) {
  const jailRoleId = config.jail_role_id;
  if (!jailRoleId) return { ok: false, error: 'لم يتم تحديد رتبة السجن بعد. استخدم /settings.' };
  const jailRole = guild.roles.cache.get(String(jailRoleId));
  if (!jailRole) return { ok: false, error: 'رتبة السجن المحددة غير موجودة في السيرفر.' };

  let endTimestamp = null;
  let durationLabel = 'مؤبد';
  if (durationStr) {
    const seconds = parseDuration(durationStr);
    if (seconds == null) return { ok: false, error: `صيغة المدة غير صحيحة. ${DURATION_HELP}` };
    endTimestamp = Math.floor(Date.now() / 1000) + seconds;
    durationLabel = durationStr;
  }

  const originalRoleIds = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);

  try {
    const rolesToRemove = member.roles.cache
      .filter((r) => r.id !== guild.id && r.id !== jailRole.id)
      .map((r) => r);
    if (rolesToRemove.length) await member.roles.remove(rolesToRemove, 'سجن');
    if (!member.roles.cache.has(jailRole.id)) await member.roles.add(jailRole, 'سجن');
  } catch {
    return { ok: false, error: 'صلاحيات البوت غير كافية لتعديل رتب هذا العضو.' };
  }

  const channelOverwrites = await stripMemberChannelOverwrites(guild, member);

  const db = loadDatabase();
  const entry = getGuildEntry(db, guild.id);
  const userKey = String(member.id);
  const priors = (entry.prisoners[userKey]?.priors || 0) + 1;

  entry.prisoners[userKey] = {
    original_roles: originalRoleIds,
    channel_overwrites: channelOverwrites,
    end_time: endTimestamp,
    priors,
    reason,
    jailed_by: actorUserId,
  };
  await saveDatabase(db);

  return { ok: true, result: { endTimestamp, durationLabel, priors, channelOverwrites } };
}

/** فك السجن المشترك (رتبة + استعادة الرتب + استعادة القنوات الخاصة) */
async function performUnjail(guild, actor, member, record) {
  const jailRoleId = config.jail_role_id;
  const jailRole = jailRoleId ? guild.roles.cache.get(String(jailRoleId)) : null;
  try {
    if (member) {
      if (jailRole && member.roles.cache.has(jailRole.id)) {
        await member.roles.remove(jailRole, 'فك سجن');
      }
      const rolesToRestore = (record.original_roles || [])
        .map((rid) => guild.roles.cache.get(String(rid)))
        .filter((r) => r);
      if (rolesToRestore.length) {
        await member.roles.add(rolesToRestore, 'فك سجن - استعادة الرتب');
      }
    }
  } catch {
    return { ok: false, error: 'صلاحيات البوت غير كافية لتعديل رتب هذا العضو.' };
  }
  if (member) await restoreMemberChannelOverwrites(guild, member, record.channel_overwrites);
  return { ok: true };
}

/** نسخة التفاعل: تنفذ السجن وترد الأخطاء عبر followUp */
async function applyJail(interaction, member, reason, durationStr, isMass) {
  const res = await performJail(
    interaction.guild,
    interaction.user.id,
    interaction.member,
    member,
    reason,
    durationStr
  );
  if (!res.ok) {
    await interaction.followUp({ content: res.error, ephemeral: true });
    return null;
  }
  return res.result;
}

/** فحوصات الهدف المشتركة — يرجع رسالة الخطأ أو null عند القبول */
function jailTargetError(actorMember, actorUserId, member, jailRole, guild) {
  if (isDev(member.id)) return 'لا يمكنك سجن مطور البوت!';
  if (member.user.bot) return 'لا يمكن سجن حسابات البوتات.';
  if (member.id === actorUserId) return 'لا يمكنك سجن نفسك.';
  if (!jailRole) return 'رتبة السجن المحددة غير موجودة في السيرفر.';
  if (member.roles.cache.has(jailRole.id)) return 'هذا العضو مسجون بالفعل.';
  if (!botCanManageMember(guild, member)) return 'رتبة هذا العضو أعلى من رتبة البوت، لا يمكن تعديل رتبه.';
  if (
    actorMember.roles.highest.comparePositionTo(member.roles.highest) <= 0 &&
    guild.ownerId !== actorUserId &&
    !isDev(actorUserId)
  ) {
    return 'لا يمكنك سجن عضو برتبة أعلى من رتبتك أو مساوية لها.';
  }
  return null;
}

/** استخراج مدة من نص رسالة (مثل 1h أو 30s أو 2d أو 3mo) */
function extractDurationFromText(text) {
  const match = text.match(/(^|\s)(\d+)(mo|m|s|h|d|w)(\s|$)/i);
  if (!match) return null;
  return match[2] + match[3].toLowerCase();
}

// ================= العميل =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ================= الأوامر (Slash) =================
const COMMANDS = [
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('فتح لوحة تحكم إعدادات بوت السجن'),
  new SlashCommandBuilder()
    .setName('jail')
    .setDescription('سجن عضو')
    .addUserOption((o) => o.setName('user').setDescription('العضو المراد سجنه').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('سبب السجن').setRequired(true))
    .addStringOption((o) =>
      o.setName('duration').setDescription('مدة السجن مثل 30s أو 10m أو 1h أو 2d أو 1w أو 3mo (اختياري = مؤبد)')
    ),
  new SlashCommandBuilder()
    .setName('jailmany')
    .setDescription('سجن عدة أعضاء دفعة واحدة بنفس السبب ونفس المدة (مفيد في حالات السبام)')
    .addStringOption((o) =>
      o.setName('users').setDescription('منشن أو آيدي الأعضاء المطلوب سجنهم، مفصولين بمسافة').setRequired(true)
    )
    .addStringOption((o) => o.setName('reason').setDescription('سبب السجن (سيُطبّق على الجميع)').setRequired(true))
    .addStringOption((o) =>
      o.setName('duration').setDescription('مدة السجن للجميع مثل 30s أو 10m أو 1h أو 2d أو 1w أو 3mo (اختياري = مؤبد)')
    ),
  new SlashCommandBuilder()
    .setName('unjail')
    .setDescription('فك سجن عضو')
    .addUserOption((o) => o.setName('user').setDescription('العضو المراد فك سجنه').setRequired(true)),
  new SlashCommandBuilder()
    .setName('jailtime')
    .setDescription('تعديل مدة سجن قائم')
    .addUserOption((o) => o.setName('user').setDescription('العضو المسجون').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('duration')
        .setDescription('المدة الجديدة من الآن مثل 30s أو 10m أو 1h أو 2d أو 1w أو 3mo، أو permanent للمؤبد')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('jailinfo')
    .setDescription('عرض تفاصيل سجن عضو')
    .addUserOption((o) => o.setName('user').setDescription('العضو المراد عرض تفاصيله').setRequired(true)),
  new SlashCommandBuilder().setName('jaillist').setDescription('عرض قائمة المسجونين حاليًا'),
].map((c) => c.toJSON());

// ================= لوحة الإعدادات =================
function buildSettingsPanel() {
  const row0 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('jailbot:sync').setLabel('🔄 مزامنة الرومات').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('jailbot:release_all').setLabel('🔓 تحرير الكل').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('jailbot:add_perm').setLabel('➕ إضافة صلاحية سجن').setStyle(ButtonStyle.Success)
  );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('jailbot:log_room').setLabel('📜 روم اللوق').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('jailbot:jail_role').setLabel('⛓️ رتبة السجن').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('jailbot:jail_room').setLabel('🚪 روم السجن').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('jailbot:list_perm').setLabel('📋 عرض الصلاحيات').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('jailbot:remove_perm').setLabel('➖ إزالة صلاحية').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('jailbot:check_expired').setLabel('🔍 فحص المسجونين').setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('jailbot:reset_guild').setLabel('🗑️ ريسيت كل شيء').setStyle(ButtonStyle.Danger)
  );
  return [row0, row1, row2, row3];
}

// ================= معالج الأوامر =================
async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'settings': {
      if (!isOwnerOrDev(interaction)) {
        await interaction.reply({
          content: 'هذا الأمر مخصص لمالك السيرفر أو مطور البوت فقط.',
          ephemeral: true,
        });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle('⚙️ لوحة تحكم بوت السجن')
        .setDescription('اللوحة مرئية لك فقط. اختر أحد الأزرار أدناه لإدارة النظام.')
        .setColor(COLOR.blurple);
      await interaction.reply({ embeds: [embed], components: buildSettingsPanel(), ephemeral: true });
      break;
    }

    case 'jail': {
      if (!(await requireJailPermission(interaction))) return;
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const duration = interaction.options.getString('duration');

      if (isDev(user.id)) {
        await interaction.reply({ content: 'لا يمكنك سجن مطور البوت!', ephemeral: true });
        return;
      }
      if (user.bot) {
        await interaction.reply({ content: 'لا يمكن سجن حسابات البوتات.', ephemeral: true });
        return;
      }
      if (user.id === interaction.user.id) {
        await interaction.reply({ content: 'لا يمكنك سجن نفسك.', ephemeral: true });
        return;
      }

      const member = await getMember(interaction.guild, user.id);
      if (!member) {
        await interaction.reply({ content: 'العضو غير موجود في السيرفر.', ephemeral: true });
        return;
      }

      const jailRoleId = config.jail_role_id;
      if (!jailRoleId) {
        await interaction.reply({ content: 'لم يتم تحديد رتبة السجن بعد. استخدم /settings.', ephemeral: true });
        return;
      }
      const jailRole = interaction.guild.roles.cache.get(String(jailRoleId));
      if (!jailRole) {
        await interaction.reply({ content: 'رتبة السجن المحددة غير موجودة في السيرفر.', ephemeral: true });
        return;
      }
      if (member.roles.cache.has(jailRole.id)) {
        await interaction.reply({ content: 'هذا العضو مسجون بالفعل.', ephemeral: true });
        return;
      }
      if (!botCanManageMember(interaction.guild, member)) {
        await interaction.reply({ content: 'رتبة هذا العضو أعلى من رتبة البوت، لا يمكن تعديل رتبه.', ephemeral: true });
        return;
      }
      if (
        interaction.member.roles.highest.comparePositionTo(member.roles.highest) <= 0 &&
        interaction.guild.ownerId !== interaction.user.id &&
        !isDev(interaction.user.id)
      ) {
        await interaction.reply({
          content: 'لا يمكنك سجن عضو برتبة أعلى من رتبتك أو مساوية لها.',
          ephemeral: true,
        });
        return;
      }

      if (duration) {
        const seconds = parseDuration(duration);
        if (seconds == null) {
          await interaction.reply({ content: `صيغة المدة غير صحيحة. ${DURATION_HELP}`, ephemeral: true });
          return;
        }
      }

      await interaction.deferReply({ ephemeral: true });
      const result = await applyJail(interaction, member, reason, duration, false);
      if (!result) return;

      await sendJailRoomMessage(
        interaction.guild,
        `${member} تم سجنك.\nالسبب: ${reason}\nالمدة: ${result.durationLabel}`
      );

      const embed = new EmbedBuilder()
        .setTitle('🔒 عملية سجن جديدة')
        .setColor(COLOR.red)
        .setTimestamp(new Date());
      embed.addFields(
        { name: 'الإداري', value: `${interaction.user}`, inline: true },
        { name: 'المسجون', value: `${member}`, inline: true },
        { name: 'السبب', value: reason, inline: false },
        { name: 'المدة', value: result.durationLabel, inline: true },
        { name: 'عدد السوابق', value: String(result.priors), inline: true }
      );
      if (Object.keys(result.channelOverwrites).length) {
        embed.addFields({
          name: 'قنوات خاصة تم إخفاؤها',
          value: String(Object.keys(result.channelOverwrites).length),
          inline: true,
        });
      }
      await sendLog(interaction.guild, embed);

      await interaction.followUp({ content: `تم سجن ${member} بنجاح.`, ephemeral: true });
      break;
    }

    case 'jailmany': {
      if (!(await requireJailPermission(interaction))) return;
      const users = interaction.options.getString('users');
      const reason = interaction.options.getString('reason');
      const duration = interaction.options.getString('duration');

      const jailRoleId = config.jail_role_id;
      if (!jailRoleId) {
        await interaction.reply({ content: 'لم يتم تحديد رتبة السجن بعد. استخدم /settings.', ephemeral: true });
        return;
      }
      const jailRole = interaction.guild.roles.cache.get(String(jailRoleId));
      if (!jailRole) {
        await interaction.reply({ content: 'رتبة السجن المحددة غير موجودة في السيرفر.', ephemeral: true });
        return;
      }

      if (duration) {
        const seconds = parseDuration(duration);
        if (seconds == null) {
          await interaction.reply({ content: `صيغة المدة غير صحيحة. ${DURATION_HELP}`, ephemeral: true });
          return;
        }
      }

      const targetIds = extractUserIds(users);
      if (!targetIds.length) {
        await interaction.reply({ content: 'لم أجد أي منشن أو آيدي صالح داخل النص المُرسل.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const jailedMembers = [];
      const skipped = [];

      for (const targetId of targetIds) {
        const member = await getMember(interaction.guild, targetId);

        if (!member) {
          skipped.push([targetId, 'غير موجود في السيرفر']);
          continue;
        }
        if (isDev(member.id)) {
          skipped.push([targetId, 'مطور البوت']);
          continue;
        }
        if (member.user.bot) {
          skipped.push([targetId, 'حساب بوت']);
          continue;
        }
        if (member.id === interaction.user.id) {
          skipped.push([targetId, 'لا يمكنك سجن نفسك']);
          continue;
        }
        if (member.roles.cache.has(jailRole.id)) {
          skipped.push([targetId, 'مسجون بالفعل']);
          continue;
        }
        if (!botCanManageMember(interaction.guild, member)) {
          skipped.push([targetId, 'رتبته أعلى من رتبة البوت']);
          continue;
        }
        if (
          interaction.member.roles.highest.comparePositionTo(member.roles.highest) <= 0 &&
          interaction.guild.ownerId !== interaction.user.id &&
          !isDev(interaction.user.id)
        ) {
          skipped.push([targetId, 'رتبته أعلى من رتبتك أو مساوية لها']);
          continue;
        }

        const result = await applyJail(interaction, member, reason, duration, true);
        if (!result) continue;

        jailedMembers.push(member);
        await sendJailRoomMessage(
          interaction.guild,
          `${member} تم سجنك ضمن عملية سجن جماعي.\nالسبب: ${reason}\nالمدة: ${result.durationLabel}`
        );
        await sleep(300); // لتفادي حدود Discord عند سجن عدد كبير دفعة واحدة
      }

      const embed = new EmbedBuilder()
        .setTitle('🔒 سجن جماعي')
        .setColor(COLOR.red)
        .setTimestamp(new Date());
      embed.addFields(
        { name: 'الإداري', value: `${interaction.user}`, inline: true },
        { name: 'عدد المسجونين', value: String(jailedMembers.length), inline: true },
        { name: 'المدة', value: duration || 'مؤبد', inline: true },
        { name: 'السبب', value: reason, inline: false }
      );
      if (jailedMembers.length) {
        const mentionsText = jailedMembers.slice(0, 30).map((m) => `${m}`).join(' ');
        embed.addFields({
          name: 'الأعضاء الذين تم سجنهم',
          value: jailedMembers.length > 30 ? `${mentionsText} ... و${jailedMembers.length - 30} آخرين` : mentionsText,
          inline: false,
        });
      }
      if (skipped.length) {
        const skippedText = skipped
          .slice(0, 20)
          .map(([sid, why]) => `\`${sid}\` — ${why}`)
          .join('\n');
        embed.addFields({
          name: `تم تخطيهم (${skipped.length})`,
          value: skipped.length > 20 ? `${skippedText}\n... و${skipped.length - 20} آخرين تم تخطيهم` : skippedText,
          inline: false,
        });
      }
      await sendLog(interaction.guild, embed);

      let summary = `✅ تم سجن ${jailedMembers.length} عضو بنجاح، بمدة ${duration || 'مؤبد'}.`;
      if (skipped.length) summary += ` تم تخطي ${skipped.length} (راجع سجل اللوق للتفاصيل).`;
      await interaction.followUp({ content: summary, ephemeral: true });
      break;
    }

    case 'unjail': {
      if (!(await requireJailPermission(interaction))) return;
      const user = interaction.options.getUser('user');
      const db = loadDatabase();
      const entry = getGuildEntry(db, interaction.guild.id);
      const userKey = String(user.id);

      if (!entry.prisoners[userKey]) {
        await interaction.reply({ content: 'هذا العضو غير مسجون.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const record = entry.prisoners[userKey];
      delete entry.prisoners[userKey];
      await saveDatabase(db);

      const member = await getMember(interaction.guild, user.id);
      const unjailRes = await performUnjail(interaction.guild, interaction.user, member, record);
      if (!unjailRes.ok) {
        await interaction.followUp({ content: unjailRes.error, ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🔓 فك سجن')
        .setColor(COLOR.green)
        .setTimestamp(new Date());
      embed.addFields(
        { name: 'الإداري', value: `${interaction.user}`, inline: true },
        { name: 'العضو', value: `${user}`, inline: true }
      );
      await sendLog(interaction.guild, embed);

      await interaction.followUp({ content: `تم فك سجن ${user} بنجاح.`, ephemeral: true });
      break;
    }

    case 'jailtime': {
      if (!(await requireJailPermission(interaction))) return;
      const user = interaction.options.getUser('user');
      const duration = interaction.options.getString('duration');
      const db = loadDatabase();
      const entry = getGuildEntry(db, interaction.guild.id);
      const userKey = String(user.id);

      if (!entry.prisoners[userKey]) {
        await interaction.reply({ content: 'هذا العضو غير مسجون.', ephemeral: true });
        return;
      }

      if (duration.toLowerCase() === 'permanent') {
        entry.prisoners[userKey].end_time = null;
        await saveDatabase(db);
        await interaction.reply({ content: `أصبحت مدة سجن ${user} مؤبدة.`, ephemeral: true });
        return;
      }

      const seconds = parseDuration(duration);
      if (seconds == null) {
        await interaction.reply({ content: `صيغة المدة غير صحيحة. ${DURATION_HELP}`, ephemeral: true });
        return;
      }

      entry.prisoners[userKey].end_time = Math.floor(Date.now() / 1000) + seconds;
      await saveDatabase(db);
      await interaction.reply({
        content: `تم تعديل مدة سجن ${user} إلى ${duration} من الآن.`,
        ephemeral: true,
      });
      break;
    }

    case 'jailinfo': {
      const user = interaction.options.getUser('user');
      const db = loadDatabase();
      const entry = getGuildEntry(db, interaction.guild.id);
      const record = entry.prisoners[String(user.id)];

      if (!record) {
        await interaction.reply({ content: 'هذا العضو غير مسجون حاليًا.', ephemeral: true });
        return;
      }

      const jailer = await getMember(interaction.guild, record.jailed_by);
      const embed = new EmbedBuilder()
        .setTitle('تفاصيل السجن')
        .setColor(COLOR.orange);
      embed.addFields(
        { name: 'العضو', value: `${user}`, inline: true },
        { name: 'بواسطة', value: jailer ? `${jailer}` : 'غير معروف', inline: true },
        { name: 'السبب', value: record.reason || 'غير محدد', inline: false },
        { name: 'المتبقي', value: formatRemaining(record.end_time), inline: true },
        { name: 'عدد السوابق', value: String(record.priors || 0), inline: true }
      );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }

    case 'jaillist': {
      const db = loadDatabase();
      const entry = getGuildEntry(db, interaction.guild.id);
      const prisoners = entry.prisoners;

      if (!Object.keys(prisoners).length) {
        await interaction.reply({ content: 'لا يوجد أي مسجونين حاليًا.', ephemeral: true });
        return;
      }

      const lines = [];
      for (const [userId, record] of Object.entries(prisoners)) {
        const member = await getMember(interaction.guild, userId);
        const name = member ? `${member}` : `\`${userId}\``;
        const remaining = formatRemaining(record.end_time);
        lines.push(`${name} — المتبقي: ${remaining} — السوابق: ${record.priors || 0}`);
      }

      const embed = new EmbedBuilder()
        .setTitle('قائمة المسجونين')
        .setDescription(lines.join('\n'))
        .setColor(COLOR.orange);
      await interaction.reply({ embeds: [embed] });
      break;
    }
  }
}

// ================= معالج الأزرار =================
async function handleButton(interaction) {
  const { customId } = interaction;

  switch (customId) {
    case 'jailbot:sync': {
      const jailRoleId = config.jail_role_id;
      const jailRoomId = config.jail_room_id;
      if (!jailRoleId || !jailRoomId) {
        await interaction.reply({
          content: 'يجب تحديد رتبة السجن وروم السجن أولاً من الأزرار المخصصة قبل المزامنة.',
          ephemeral: true,
        });
        return;
      }
      const jailRole = interaction.guild.roles.cache.get(String(jailRoleId));
      if (!jailRole) {
        await interaction.reply({ content: 'رتبة السجن المحفوظة لم تعد موجودة في السيرفر.', ephemeral: true });
        return;
      }

      await interaction.reply({
        content: '⏳ جارٍ مزامنة الرومات، قد يستغرق هذا بعض الوقت...',
        ephemeral: true,
      });
      const [success, failed] = await syncJailRoleChannels(interaction.guild, jailRole, jailRoomId);
      const result = `✅ تمت المزامنة: ${success} روم بنجاح` + (failed ? `، فشل ${failed}.` : '.');
      await interaction.editReply({ content: result });

      const embed = new EmbedBuilder()
        .setTitle('🔄 مزامنة صلاحيات رتبة السجن')
        .setDescription(result)
        .setColor(COLOR.blurple)
        .setTimestamp(new Date());
      embed.addFields({ name: 'بواسطة', value: `${interaction.user}` });
      await sendLog(interaction.guild, embed);
      break;
    }

    case 'jailbot:release_all': {
      await interaction.reply({
        content: 'هل أنت متأكد من تحرير **جميع** المسجونين حاليًا؟',
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jailbot:release_all_confirm').setLabel('تأكيد التحرير').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('jailbot:cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
          ),
        ],
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:release_all_confirm': {
      await interaction.update({ content: '⏳ جارٍ تحرير جميع المسجونين...', components: [] });
      const [released, failed] = await releaseAllPrisoners(interaction.guild);
      const result = `✅ تم تحرير ${released} عضو.` + (failed ? ` فشل تحرير ${failed}.` : '');
      await interaction.editReply({ content: result });
      break;
    }

    case 'jailbot:add_perm': {
      await interaction.reply({
        content: 'اختر رتبة أو شخصًا لمنحه صلاحية استخدام أوامر السجن:',
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('jailbot:add_role').setPlaceholder('➕ إضافة رتبة').setMinValues(1).setMaxValues(1)
          ),
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId('jailbot:add_user').setPlaceholder('➕ إضافة شخص').setMinValues(1).setMaxValues(1)
          ),
        ],
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:remove_perm': {
      await interaction.reply({
        content: 'اختر رتبة أو شخصًا لإزالة صلاحيته:',
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('jailbot:remove_role').setPlaceholder('➖ إزالة رتبة').setMinValues(1).setMaxValues(1)
          ),
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId('jailbot:remove_user').setPlaceholder('➖ إزالة شخص').setMinValues(1).setMaxValues(1)
          ),
        ],
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:log_room': {
      await interaction.reply({
        content: 'اختر روم اللوق:',
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('jailbot:log_room_select')
              .setPlaceholder('اختر روم اللوق')
              .setChannelTypes(ChannelType.GuildText)
              .setMinValues(1)
              .setMaxValues(1)
          ),
        ],
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:jail_room': {
      await interaction.reply({
        content: 'اختر روم السجن (هذا الروم يُستثنى تلقائيًا من المزامنة):',
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('jailbot:jail_room_select')
              .setPlaceholder('اختر روم السجن')
              .setChannelTypes(ChannelType.GuildText)
              .setMinValues(1)
              .setMaxValues(1)
          ),
        ],
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:jail_role': {
      await interaction.reply({
        content: 'اختر رتبة السجن:',
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('jailbot:jail_role_select').setPlaceholder('اختر رتبة السجن').setMinValues(1).setMaxValues(1)
          ),
        ],
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:list_perm': {
      const db = loadDatabase();
      const entry = getGuildEntry(db, interaction.guild.id);
      if (!entry.allowed_ids.length) {
        await interaction.reply({ content: 'لا يوجد أي رتب أو أشخاص مصرح لهم حاليًا.', ephemeral: true });
        return;
      }
      const lines = [];
      for (const itemId of entry.allowed_ids) {
        const role = interaction.guild.roles.cache.get(String(itemId));
        if (role) {
          lines.push(`رتبة: ${role}`);
          continue;
        }
        const member = await getMember(interaction.guild, String(itemId));
        lines.push(member ? `شخص: ${member}` : `غير معروف: \`${itemId}\``);
      }
      const embed = new EmbedBuilder()
        .setTitle('قائمة الصلاحيات')
        .setDescription(lines.join('\n'))
        .setColor(COLOR.blurple);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }

    case 'jailbot:check_expired': {
      await interaction.deferReply({ ephemeral: true });
      const db = loadDatabase();
      const [checked, released] = await checkAndReleaseExpiredForGuild(interaction.guild, db);
      await saveDatabase(db);

      let result;
      if (checked === 0) {
        result = 'لا يوجد أي مسجونين حاليًا في هذا السيرفر.';
      } else {
        result = `✅ تم فحص ${checked} مسجون، وتم تحرير ${released} منهم لانتهاء مدة عقوبتهم.`;
      }
      await interaction.followUp({ content: result, ephemeral: true });
      break;
    }

    case 'jailbot:reset_guild': {
      const warning =
        '⚠️ هذا الإجراء سيقوم بما يلي:\n' +
        '• تحرير **جميع** المسجونين حاليًا في هذا السيرفر (فك الرتبة واستعادة رتبهم الأصلية).\n' +
        '• حذف **كل بيانات** هذا السيرفر من قاعدة البيانات (المسجونين + قائمة الصلاحيات المسموح لها) نهائيًا.\n\n' +
        'لا يمكن التراجع عن هذا الإجراء. هل أنت متأكد؟';
      await interaction.reply({
        content: warning,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jailbot:reset_confirm').setLabel('نعم، احذف كل شيء').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('jailbot:cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
          ),
        ],
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:reset_confirm': {
      await interaction.update({ content: '⏳ جارٍ تحرير الجميع ومسح بيانات هذا السيرفر بالكامل...', components: [] });

      const [released, failed] = await releaseAllPrisoners(interaction.guild);

      const db = loadDatabase();
      delete db[String(interaction.guild.id)];
      await saveDatabase(db);

      const result =
        `✅ تم تحرير ${released} عضو` +
        (failed ? ` (فشل تحرير ${failed})` : '') +
        '. وتم حذف جميع بيانات هذا السيرفر (المسجونين وقائمة الصلاحيات) نهائيًا.';
      await interaction.editReply({ content: result });

      const embed = new EmbedBuilder()
        .setTitle('🗑️ ريسيت كامل للسيرفر')
        .setDescription(result)
        .setColor(COLOR.dark_red)
        .setTimestamp(new Date());
      embed.addFields({ name: 'بواسطة', value: `${interaction.user}` });
      await sendLog(interaction.guild, embed);
      break;
    }

    case 'jailbot:cancel': {
      await interaction.update({ content: 'تم الإلغاء.', components: [] });
      break;
    }
  }
}

// ================= معالج القوائم المنسدلة =================
async function handleSelect(interaction) {
  const { customId } = interaction;
  const value = interaction.values[0];

  const db = loadDatabase();
  const entry = getGuildEntry(db, interaction.guild.id);

  switch (customId) {
    case 'jailbot:add_role': {
      const role = interaction.guild.roles.cache.get(value);
      if (entry.allowed_ids.includes(role.id)) {
        await interaction.reply({ content: `الرتبة ${role} مضافة بالفعل.`, ephemeral: true });
        return;
      }
      entry.allowed_ids.push(role.id);
      await saveDatabase(db);
      await interaction.reply({ content: `✅ تمت إضافة الرتبة ${role} إلى قائمة الصلاحيات.`, ephemeral: true });
      break;
    }

    case 'jailbot:add_user': {
      const user = await getMember(interaction.guild, value);
      if (entry.allowed_ids.includes(value)) {
        await interaction.reply({ content: `الشخص ${user || `<@${value}>`} مضاف بالفعل.`, ephemeral: true });
        return;
      }
      entry.allowed_ids.push(value);
      await saveDatabase(db);
      await interaction.reply({ content: `✅ تمت إضافة ${user || `<@${value}>`} إلى قائمة الصلاحيات.`, ephemeral: true });
      break;
    }

    case 'jailbot:remove_role': {
      const role = interaction.guild.roles.cache.get(value);
      if (!entry.allowed_ids.includes(role.id)) {
        await interaction.reply({ content: `الرتبة ${role} غير موجودة في القائمة.`, ephemeral: true });
        return;
      }
      entry.allowed_ids = entry.allowed_ids.filter((id) => id !== role.id);
      await saveDatabase(db);
      await interaction.reply({ content: `✅ تمت إزالة الرتبة ${role} من قائمة الصلاحيات.`, ephemeral: true });
      break;
    }

    case 'jailbot:remove_user': {
      const user = await getMember(interaction.guild, value);
      if (!entry.allowed_ids.includes(value)) {
        await interaction.reply({ content: `الشخص ${user || `<@${value}>`} غير موجود في القائمة.`, ephemeral: true });
        return;
      }
      entry.allowed_ids = entry.allowed_ids.filter((id) => id !== value);
      await saveDatabase(db);
      await interaction.reply({ content: `✅ تمت إزالة ${user || `<@${value}>`} من قائمة الصلاحيات.`, ephemeral: true });
      break;
    }

    case 'jailbot:log_room_select': {
      const channel = interaction.guild.channels.cache.get(value);
      config.log_room_id = String(channel.id);
      saveConfig();
      await interaction.reply({ content: `✅ تم تعيين روم اللوق إلى ${channel}.`, ephemeral: true });
      break;
    }

    case 'jailbot:jail_room_select': {
      const channel = interaction.guild.channels.cache.get(value);
      config.jail_room_id = String(channel.id);
      saveConfig();
      await interaction.reply({
        content: `✅ تم تعيين روم السجن إلى ${channel}. لا تنسَ الضغط على زر 🔄 مزامنة الرومات لتطبيق ذلك.`,
        ephemeral: true,
      });
      break;
    }

    case 'jailbot:jail_role_select': {
      const role = interaction.guild.roles.cache.get(value);
      config.jail_role_id = String(role.id);
      saveConfig();
      await interaction.reply({
        content: `✅ تم تعيين رتبة السجن إلى ${role}. لا تنسَ الضغط على زر 🔄 مزامنة الرومات لتطبيق ذلك.`,
        ephemeral: true,
      });
      break;
    }
  }
}

// ================= توزيع التفاعلات =================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // كل تفاعلات اللوحة (أزرار وقوائم jailbot:*) مخصصة لمالك السيرفر أو المطور فقط
    if (interaction.customId && String(interaction.customId).startsWith('jailbot:') && !isOwnerOrDev(interaction)) {
      await interaction.reply({
        content: 'هذه اللوحة مخصصة لمالك السيرفر أو مطور البوت فقط.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isAnySelectMenu()) {
      await handleSelect(interaction);
    }
  } catch (error) {
    console.error('خطأ في معالجة التفاعل:', error);
    const content = 'حدث خطأ غير متوقع أثناء تنفيذ الأمر.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch {
      /* تجاهل */
    }
  }
});

// ================= الأحداث =================
client.once(Events.ClientReady, async (c) => {
  console.log(`تم تسجيل الدخول باسم ${c.user.tag} (${c.user.id})`);

  // تسجيل الأوامر (Slash Commands)
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN || config.token || '');
    await rest.put(Routes.applicationCommands(c.user.id), { body: COMMANDS });
    console.log(`✅ تم تسجيل ${COMMANDS.length} أمر بنجاح`);
  } catch (err) {
    console.error('❌ فشل تسجيل الأوامر:', err.message);
  }

  // رسالة ترحيب عند التشغيل
  const channelId =
    process.env.KEEP_ALIVE_CHANNEL_ID || config.keep_alive_channel_id || KEEP_ALIVE_CHANNEL_ID_DEFAULT;
  if (channelId) {
    const channel = c.channels.cache.get(String(channelId));
    if (channel) {
      try {
        await channel.send('🚀 **البوت شغال!** تم النشر بنجاح ✅');
      } catch {
        /* تجاهل */
      }
    }
  }
});

// إعادة سجن من غادر السيرفر وعاد (محاولة هروب)
client.on(Events.GuildMemberAdd, async (member) => {
  const db = loadDatabase();
  const entry = getGuildEntry(db, member.guild.id);
  const userKey = String(member.id);

  if (!entry.prisoners[userKey]) return;

  const jailRoleId = config.jail_role_id;
  const jailRole = jailRoleId ? member.guild.roles.cache.get(String(jailRoleId)) : null;

  if (jailRole) {
    try {
      const rolesToRemove = member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => r);
      if (rolesToRemove.length) await member.roles.remove(rolesToRemove, 'محاولة هروب من السجن');
      await member.roles.add(jailRole, 'محاولة هروب من السجن');
    } catch {
      /* تجاهل */
    }
  }

  const record = entry.prisoners[userKey];
  if (record.channel_overwrites) {
    for (const channelIdStr of Object.keys(record.channel_overwrites)) {
      const channel = member.guild.channels.cache.get(channelIdStr);
      if (channel) {
        try {
          await channel.permissionOverwrites.delete(member.id, 'محاولة هروب - إخفاء قناة خاصة مجددًا');
        } catch {
          /* تجاهل */
        }
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('⚠️ محاولة هروب من السجن')
    .setDescription(`${member} غادر السيرفر وعاد بينما كان مسجونًا. تم إعادة سجنه تلقائيًا.`)
    .setColor(COLOR.dark_red)
    .setTimestamp(new Date());
  await sendLog(member.guild, embed);
});

// ================= أمر الكتابة: سجن @عضو [المدة] [السبب] =================
// يعمل في أي شات: سجن @عضو → مؤبد | سجن @عضو 1h → ساعة | سجن @عضو 1h سبب...
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild || !message.member) return;

  const content = message.content.trim();
  const isJail = content.startsWith('سجن');
  const isUnjail = content.startsWith('تحرير');
  if (!isJail && !isUnjail) return;

  // استخراج الآيديات (منشنات + آيديات مكتوبة)
  const mentionIds = [...message.mentions.users.keys()];
  const idsFromText = extractUserIds(content);
  const targetIds = [...new Set([...mentionIds, ...idsFromText])];
  if (!targetIds.length) return; // بدون منشن — ليست أمراً

  // الصلاحية: مطابقة /jail (مطور، أدمن، أو في قائمة الصلاحيات)
  if (!(await messageHasJailPermission(message))) {
    await message.reply('ليس لديك صلاحية استخدام هذا الأمر.');
    return;
  }

  // ================= 🔓 أمر الكتابة: تحرير @عضو =================
  if (isUnjail) {
    const db = loadDatabase();
    const entry = getGuildEntry(db, message.guild.id);
    const released = [];
    const skipped = [];

    for (const targetId of targetIds) {
      const userKey = String(targetId);
      const record = entry.prisoners[userKey];
      if (!record) {
        skipped.push([targetId, 'غير مسجون']);
        continue;
      }
      const member = await getMember(message.guild, targetId);
      const res = await performUnjail(message.guild, message.author, member, record);
      if (!res.ok) {
        skipped.push([targetId, res.error]);
        continue;
      }
      delete entry.prisoners[userKey];
      released.push(member || targetId);
    }
    await saveDatabase(db);

    if (!released.length) {
      await message.reply(`❌ لم يُحرَّر أحد. ${skipped.map(([, why]) => why).join('؛ ')}`);
      return;
    }

    const unjailEmbed = new EmbedBuilder()
      .setTitle('🔓 تحرير عبر الرسائل')
      .setColor(COLOR.green)
      .setTimestamp(new Date());
    unjailEmbed.addFields(
      { name: 'الإداري', value: `${message.author}`, inline: true },
      { name: 'عدد المُحرَّرين', value: String(released.length), inline: true },
      {
        name: 'الأعضاء',
        value: released.slice(0, 20).map((m) => `${m}`).join(' '),
        inline: false,
      }
    );
    await sendLog(message.guild, unjailEmbed);
    await message.reply(`✅ تم تحرير ${released.length} عضو بنجاح.`);
    return;
  }

  // ================= 🔒 أمر الكتابة: سجن @عضو [المدة] [السبب] =================
  const jailRoleId = config.jail_role_id;
  if (!jailRoleId) {
    await message.reply('لم يتم تحديد رتبة السجن بعد. استخدم /settings.');
    return;
  }
  const jailRole = message.guild.roles.cache.get(String(jailRoleId));
  if (!jailRole) {
    await message.reply('رتبة السجن المحددة غير موجودة في السيرفر.');
    return;
  }

  // المدة والسبب
  const duration = extractDurationFromText(content);
  let reason = content.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (duration) {
    reason = reason.replace(new RegExp(`\\b${duration}\\b`, 'gi'), ' ');
  }
  reason = reason.replace(/^سجن\s*/i, '').replace(/\s+/g, ' ').trim();

  const jailedMembers = [];
  const skipped = [];

  for (const targetId of targetIds) {
    const member = await getMember(message.guild, targetId);
    if (!member) {
      skipped.push([targetId, 'غير موجود في السيرفر']);
      continue;
    }
    const err = jailTargetError(message.member, message.author.id, member, jailRole, message.guild);
    if (err) {
      skipped.push([targetId, err]);
      continue;
    }

    const res = await performJail(
      message.guild,
      message.author.id,
      message.member,
      member,
      reason || 'بدون سبب',
      duration
    );
    if (!res.ok) {
      skipped.push([targetId, res.error]);
      continue;
    }

    jailedMembers.push(member);
    await sendJailRoomMessage(
      message.guild,
      `${member} تم سجنك.\nالسبب: ${reason || 'بدون سبب'}\nالمدة: ${res.result.durationLabel}`
    );
    await sleep(300);
  }

  if (!jailedMembers.length) {
    await message.reply(`❌ لم يُسجن أحد. ${skipped.map(([, why]) => why).join('؛ ')}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🔒 سجن عبر الرسائل')
    .setColor(COLOR.red)
    .setTimestamp(new Date());
  embed.addFields(
    { name: 'الإداري', value: `${message.author}`, inline: true },
    { name: 'عدد المسجونين', value: String(jailedMembers.length), inline: true },
    { name: 'المدة', value: duration || 'مؤبد', inline: true },
    { name: 'السبب', value: reason || 'بدون سبب', inline: false }
  );
  if (jailedMembers.length) {
    embed.addFields({
      name: 'الأعضاء الذين تم سجنهم',
      value: jailedMembers.slice(0, 20).map((m) => `${m}`).join(' '),
      inline: false,
    });
  }
  if (skipped.length) {
    embed.addFields({
      name: `تم تخطيهم (${skipped.length})`,
      value: skipped.slice(0, 10).map(([sid, why]) => `\`${sid}\` — ${why}`).join('\n'),
      inline: false,
    });
  }
  await sendLog(message.guild, embed);

  let summary = `✅ تم سجن ${jailedMembers.length} عضو` + (duration ? ` بمدة ${duration}` : ' مؤبد') + '.';
  if (skipped.length) summary += ` تخطي ${skipped.length} (راجع سجل اللوق).`;
  await message.reply(summary);
});

// ================= المهام الدورية =================
// فك السجن التلقائي كل 30 ثانية (يكتشف من انتهت مدته حتى أثناء إطفاء البوت)
async function autoUnjailLoop() {
  try {
    const db = loadDatabase();
    let changed = false;
    for (const guildIdStr of Object.keys(db)) {
      const guild = client.guilds.cache.get(guildIdStr);
      if (!guild) continue;
      const [, released] = await checkAndReleaseExpiredForGuild(guild, db);
      if (released) changed = true;
    }
    if (changed) await saveDatabase(db);
  } catch (err) {
    console.error('خطأ في مهمة فك السجن التلقائي:', err.message);
  }
}

// keep-alive كل 14 دقيقة لمنع الاستضافة من إطفاء البوت
async function keepAliveLoop() {
  try {
    const channelId =
      process.env.KEEP_ALIVE_CHANNEL_ID || config.keep_alive_channel_id || KEEP_ALIVE_CHANNEL_ID_DEFAULT;
    if (!channelId) return;
    const channel = client.channels.cache.get(String(channelId));
    if (channel) {
      await channel.send('🟢 البوت نشط');
    }
  } catch {
    /* تجاهل */
  }
}

// ================= خادم HTTP (لإبقاء الخدمة حية على Render) =================
function startHttpKeepAlive() {
  try {
    const port = parseInt(process.env.PORT || '8080', 10);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });
    server.listen(port, '0.0.0.0', () => {
      console.log(`🌐 خادم HTTP يعمل على المنفذ ${port}`);
    });
    server.on('error', () => {
      /* المنفذ مشغول أو البيئة لا تدعمه — نكمل بدون خادم */
    });
  } catch {
    /* تجاهل */
  }
}

// ================= التشغيل =================
async function main() {
  // إصدار البوت — يُطبع دائماً مهما كان MAIN_FILE (index.js أو bot.js)
  console.log(`🚀 j3_discloud (JS v6.${require('./package.json').version}) — بدء التشغيل`);

  // قراءة ملف .env أولاً (التوكن يكون هنا أو في متغير البيئة TOKEN)
  loadDotenvFile(ENV_FILE);

  // إبقاء الخدمة حية على Render
  startHttpKeepAlive();

  // المهام الدورية
  setInterval(autoUnjailLoop, 30 * 1000);
  setInterval(keepAliveLoop, 14 * 60 * 1000);

  // إيقاف نظيف
  process.on('SIGTERM', () => {
    console.log('🛑 استقبلت SIGTERM — إيقاف البوت...');
    client.destroy();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    console.log('🛑 استقبلت SIGINT — إيقاف البوت...');
    client.destroy();
    process.exit(0);
  });

  // 🔄 انتظار التوكن (لا نخرج أبداً) — يبقي العملية حية وخادم HTTP يرد 200
  // حتى ينجح فحص بناء النشر التلقائي، ويعيد المحاولة كل 30 ثانية حتى يجد التوكن.
  for (;;) {
    // إعادة قراءة .env و config.json (قد يُضاف التوكن لاحقاً)
    loadDotenvFile(ENV_FILE);
    config = loadJson(CONFIG_FILE, {
      token: process.env.TOKEN || '',
      jail_role_id: config.jail_role_id || '',
      jail_room_id: config.jail_room_id || '',
      log_room_id: config.log_room_id || '',
    });

    const token = process.env.TOKEN || config.token || '';
    if (!token) {
      console.error('⏳ لا يوجد توكن بعد — سأعيد المحاولة كل 30 ثانية. (ضعه في ملف .env أو متغير البيئة TOKEN)');
      await sleep(30000);
      continue;
    }

    try {
      await client.login(token);
      // الاتصال بقاعدة البيانات MongoDB (إن وُجد الرابط في .env)
      await initMongo();
      return; // نجح الاتصال — البوت يعمل
    } catch (err) {
      if (err.code === 4014 || /disallowed intents/i.test(String(err.message || ''))) {
        console.error(
          '❌ يجب تفعيل Message Content Intent من بوابة المطورين:\n' +
            '   discord.com/developers/applications ← Bot ← Privileged Gateway Intents\n' +
            '   ← فعّل "Message Content Intent" ثم أعد Start (مطلوب لأمر الكتابة: سجن @عضو)'
        );
      } else {
        console.error('❌ فشل الاتصال بديسكورد:', err.message, '(سأعيد المحاولة بعد 30 ثانية)');
      }
      await sleep(30000);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ خطأ غير متوقع:', e.message);
    process.exit(1);
  });
}

// تصدير main ليكون index.js قادراً على تشغيل البوت صراحةً
// (حتى لو كان MAIN_FILE=index.js بدل bot.js)
module.exports = { main };
