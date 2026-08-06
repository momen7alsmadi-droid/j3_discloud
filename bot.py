import json
import os
import re
import asyncio
import time
import threading
from datetime import datetime, timezone

import discord
from discord import app_commands
from discord.ext import commands, tasks

# ================= إعدادات ثابتة =================
DEV_ID = 1387331972094890036
DEV_USERNAME = "m_smadi"

CONFIG_FILE = "config.json"
DATABASE_FILE = "database.json"
ENV_FILE = ".env"

_db_lock = asyncio.Lock()
_config_lock = asyncio.Lock()


def load_dotenv_file(path: str = ENV_FILE) -> None:
    """قراءة ملف .env (سطر KEY=VALUE لكل سطر) وإضافتها إلى متغيرات البيئة.
    الملف غير مرفوع على GitHub (.gitignore يستبعده) — يحمي التوكن."""
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


# ================= إدارة الملفات =================
def load_json(path: str, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return default
            return json.loads(content)
    except (json.JSONDecodeError, OSError):
        return default


def save_json_atomic(path: str, data) -> None:
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


config = load_json(CONFIG_FILE, {
    "token": os.environ.get("TOKEN", ""),
    "jail_role_id": "",
    "jail_room_id": "",
    "log_room_id": ""
})


async def save_config() -> None:
    async with _config_lock:
        save_json_atomic(CONFIG_FILE, config)


def load_database() -> dict:
    return load_json(DATABASE_FILE, {})


async def save_database(db: dict) -> None:
    async with _db_lock:
        save_json_atomic(DATABASE_FILE, db)


def get_guild_entry(db: dict, guild_id: int) -> dict:
    key = str(guild_id)
    if key not in db:
        db[key] = {"allowed_ids": [], "prisoners": {}}
    if "allowed_ids" not in db[key]:
        db[key]["allowed_ids"] = []
    if "prisoners" not in db[key]:
        db[key]["prisoners"] = {}
    return db[key]


# ================= أدوات مساعدة =================
# الوحدات المتاحة لتحديد المدة: s = ثواني, m = دقائق, h = ساعات, d = أيام, w = أسابيع, mo = أشهر (٣٠ يومًا لكل شهر)
DURATION_PATTERN = re.compile(r"^(\d+)(s|mo|m|h|d|w)$", re.IGNORECASE)
DURATION_MULTIPLIERS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800, "mo": 2592000}
DURATION_HELP = "استخدم مثل: 30s (ثواني), 10m (دقائق), 1h (ساعات), 2d (أيام), 1w (أسابيع), 3mo (أشهر)"


def parse_duration(duration_str: str):
    match = DURATION_PATTERN.match(duration_str.strip())
    if not match:
        return None
    value, unit = match.groups()
    return int(value) * DURATION_MULTIPLIERS[unit.lower()]


# استخراج آيدي الأعضاء من نص واحد (منشنات و/أو آيديات مفصولة بمسافات) — يُستخدم في السجن الجماعي
MENTION_PATTERN = re.compile(r"<@!?(\d+)>")
ID_PATTERN = re.compile(r"(?<!\d)(\d{15,20})(?!\d)")


def extract_user_ids(text: str) -> list:
    ids = []
    seen = set()
    for match in MENTION_PATTERN.finditer(text):
        uid = int(match.group(1))
        if uid not in seen:
            seen.add(uid)
            ids.append(uid)
    for match in ID_PATTERN.finditer(text):
        uid = int(match.group(1))
        if uid not in seen:
            seen.add(uid)
            ids.append(uid)
    return ids


def format_remaining(end_timestamp) -> str:
    if end_timestamp is None:
        return "مؤبد"
    remaining = int(end_timestamp - time.time())
    if remaining <= 0:
        return "على وشك الانتهاء"
    days, rem = divmod(remaining, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days} يوم")
    if hours:
        parts.append(f"{hours} ساعة")
    if minutes:
        parts.append(f"{minutes} دقيقة")
    return " و ".join(parts) if parts else "أقل من دقيقة"


def is_dev(user_id: int) -> bool:
    return user_id == DEV_ID


def is_owner_or_dev_raw(interaction: discord.Interaction) -> bool:
    if is_dev(interaction.user.id):
        return True
    return bool(interaction.guild and interaction.guild.owner_id == interaction.user.id)


# ================= إعداد البوت =================
intents = discord.Intents.default()
intents.members = True
intents.guilds = True


class JailBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!__unused__", intents=intents)

    async def setup_hook(self):
        self.add_view(SettingsPanelView())
        await self.tree.sync()
        auto_unjail_task.start()
        keep_alive_task.start()


bot = JailBot()


# ================= فحوصات الصلاحيات (Slash Commands) =================
def is_owner_or_dev():
    async def predicate(interaction: discord.Interaction) -> bool:
        if is_owner_or_dev_raw(interaction):
            return True
        raise app_commands.CheckFailure("هذا الأمر مخصص لمالك السيرفر أو مطور البوت فقط.")
    return app_commands.check(predicate)


def has_jail_permission():
    async def predicate(interaction: discord.Interaction) -> bool:
        if is_dev(interaction.user.id):
            return True
        if interaction.user.guild_permissions.administrator:
            return True
        db = load_database()
        entry = get_guild_entry(db, interaction.guild.id)
        allowed_ids = set(entry["allowed_ids"])
        if interaction.user.id in allowed_ids:
            return True
        user_role_ids = {role.id for role in interaction.user.roles}
        if user_role_ids & allowed_ids:
            return True
        raise app_commands.CheckFailure("ليس لديك صلاحية استخدام هذا الأمر.")
    return app_commands.check(predicate)


@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    message = str(error) if isinstance(error, app_commands.CheckFailure) and str(error) else None
    if message is None:
        message = "حدث خطأ غير متوقع أثناء تنفيذ الأمر."
    if interaction.response.is_done():
        await interaction.followup.send(message, ephemeral=True)
    else:
        await interaction.response.send_message(message, ephemeral=True)
    if not isinstance(error, app_commands.CheckFailure):
        raise error


# ================= التحكم بالتسلسل الهرمي =================
def bot_can_manage_member(guild: discord.Guild, member: discord.Member) -> bool:
    if guild.owner_id == guild.me.id:
        return True
    return guild.me.top_role > member.top_role


# ================= صلاحيات القنوات الخاصة (تكت / رومات فردية) =================
async def strip_member_channel_overwrites(guild: discord.Guild, member: discord.Member) -> dict:
    captured = {}
    for channel in guild.channels:
        member_overwrite = None
        for target, overwrite in channel.overwrites.items():
            if isinstance(target, discord.Member) and target.id == member.id:
                member_overwrite = overwrite
                break
        if member_overwrite is None:
            continue
        allow, deny = member_overwrite.pair()
        captured[str(channel.id)] = [allow.value, deny.value]
        try:
            await channel.set_permissions(member, overwrite=None, reason="سجن - إخفاء قناة خاصة مؤقتًا")
        except (discord.Forbidden, discord.HTTPException):
            pass
    return captured


async def restore_member_channel_overwrites(guild: discord.Guild, member: discord.Member, captured: dict) -> None:
    for channel_id_str, pair in captured.items():
        channel = guild.get_channel(int(channel_id_str))
        if channel is None:
            continue
        allow_value, deny_value = pair
        overwrite = discord.PermissionOverwrite.from_pair(
            discord.Permissions(allow_value), discord.Permissions(deny_value)
        )
        try:
            await channel.set_permissions(member, overwrite=overwrite, reason="فك سجن - استعادة قناة خاصة")
        except (discord.Forbidden, discord.HTTPException):
            pass


# ================= لوق =================
async def send_log(guild: discord.Guild, embed: discord.Embed) -> None:
    log_id = config.get("log_room_id")
    if not log_id:
        return
    channel = guild.get_channel(int(log_id))
    if channel:
        try:
            await channel.send(embed=embed)
        except discord.HTTPException:
            pass


async def send_jail_room_message(guild: discord.Guild, content: str) -> None:
    room_id = config.get("jail_room_id")
    if not room_id:
        return
    channel = guild.get_channel(int(room_id))
    if channel:
        try:
            await channel.send(content)
        except discord.HTTPException:
            pass


# ================= منطق التحرير الجماعي =================
async def release_prisoner(guild: discord.Guild, user_id: int, record: dict) -> bool:
    member = guild.get_member(user_id)
    jail_role_id = config.get("jail_role_id")
    jail_role = guild.get_role(int(jail_role_id)) if jail_role_id else None

    if member is not None:
        try:
            if jail_role and jail_role in member.roles:
                await member.remove_roles(jail_role, reason="تحرير جماعي")
            roles_to_restore = [guild.get_role(rid) for rid in record.get("original_roles", [])]
            roles_to_restore = [r for r in roles_to_restore if r is not None]
            if roles_to_restore:
                await member.add_roles(*roles_to_restore, reason="تحرير جماعي - استعادة الرتب")
        except discord.Forbidden:
            return False
        await restore_member_channel_overwrites(guild, member, record.get("channel_overwrites", {}))
    return True


async def release_all_prisoners(guild: discord.Guild):
    db = load_database()
    entry = get_guild_entry(db, guild.id)
    prisoners = entry["prisoners"]

    if not prisoners:
        return 0, 0

    released, failed = 0, 0
    for user_id_str in list(prisoners.keys()):
        record = prisoners[user_id_str]
        ok = await release_prisoner(guild, int(user_id_str), record)
        if ok:
            released += 1
            del prisoners[user_id_str]
        else:
            failed += 1
        await asyncio.sleep(0.2)

    await save_database(db)

    embed = discord.Embed(
        title="🔓 تحرير جماعي",
        description=f"تم تحرير {released} عضو." + (f" فشل تحرير {failed}." if failed else ""),
        color=discord.Color.green(),
        timestamp=datetime.now(timezone.utc),
    )
    await send_log(guild, embed)
    return released, failed


# ================= فحص وتحرير من انتهت مدته (يدويًا أو تلقائيًا) =================
async def check_and_release_expired_for_guild(guild: discord.Guild, db: dict) -> tuple:
    """يفحص كل مسجوني هذا السيرفر: يقارن وقت السجن + المدة بالوقت الحالي،
    ويحرر تلقائيًا كل من انتهت مدته (فك الرتبة واستعادة الرتب والقنوات).
    لا يحفظ القاعدة بنفسه — على المستدعي استدعاء save_database بعد ذلك إذا لزم.
    يُعيد (عدد المفحوصين, عدد من تم تحريرهم)."""
    entry = get_guild_entry(db, guild.id)
    prisoners = entry["prisoners"]
    jail_role_id = config.get("jail_role_id")
    jail_role = guild.get_role(int(jail_role_id)) if jail_role_id else None

    checked = len(prisoners)
    released = 0

    for user_id_str, record in list(prisoners.items()):
        end_time = record.get("end_time")
        if end_time is None or end_time > time.time():
            continue  # مؤبد أو لم تنتهِ مدته بعد

        member = guild.get_member(int(user_id_str))
        if member and jail_role:
            try:
                if jail_role in member.roles:
                    await member.remove_roles(jail_role, reason="انتهاء مدة السجن")
                roles_to_restore = [guild.get_role(rid) for rid in record.get("original_roles", [])]
                roles_to_restore = [r for r in roles_to_restore if r is not None]
                if roles_to_restore:
                    await member.add_roles(*roles_to_restore, reason="انتهاء مدة السجن - استعادة الرتب")
            except discord.Forbidden:
                pass
            await restore_member_channel_overwrites(guild, member, record.get("channel_overwrites", {}))

        embed = discord.Embed(
            title="⏰ انتهاء مدة السجن",
            description=f"تم فك سجن <@{user_id_str}> بعد التأكد من انتهاء المدة المحددة.",
            color=discord.Color.green(),
            timestamp=datetime.now(timezone.utc),
        )
        await send_log(guild, embed)

        del prisoners[user_id_str]
        released += 1

    return checked, released


# ================= مزامنة الرومات مع رتبة السجن =================
async def sync_jail_role_channels(guild: discord.Guild, jail_role: discord.Role, jail_room_id: str):
    targets = {}
    for c in guild.categories:
        targets[c.id] = c
    for c in guild.channels:
        targets[c.id] = c

    success, failed = 0, 0
    for channel in targets.values():
        try:
            overwrite = channel.overwrites_for(jail_role)
            overwrite.view_channel = (str(channel.id) == str(jail_room_id))
            await channel.set_permissions(jail_role, overwrite=overwrite, reason="مزامنة صلاحيات رتبة السجن")
            success += 1
        except (discord.Forbidden, discord.HTTPException):
            failed += 1
        await asyncio.sleep(0.25)

    return success, failed


# ================= مكونات لوحة /settings =================
def panel_permission_check(interaction: discord.Interaction) -> bool:
    return is_owner_or_dev_raw(interaction)


class SettingsPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if panel_permission_check(interaction):
            return True
        await interaction.response.send_message("هذه اللوحة مخصصة لمالك السيرفر أو مطور البوت فقط.", ephemeral=True)
        return False

    @discord.ui.button(label="🔄 مزامنة الرومات", style=discord.ButtonStyle.primary, custom_id="jailbot:sync", row=0)
    async def sync_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        jail_role_id = config.get("jail_role_id")
        jail_room_id = config.get("jail_room_id")
        if not jail_role_id or not jail_room_id:
            await interaction.response.send_message(
                "يجب تحديد رتبة السجن وروم السجن أولاً من الأزرار المخصصة قبل المزامنة.", ephemeral=True
            )
            return
        jail_role = interaction.guild.get_role(int(jail_role_id))
        if jail_role is None:
            await interaction.response.send_message("رتبة السجن المحفوظة لم تعد موجودة في السيرفر.", ephemeral=True)
            return

        await interaction.response.send_message("⏳ جارٍ مزامنة الرومات، قد يستغرق هذا بعض الوقت...", ephemeral=True)
        success, failed = await sync_jail_role_channels(interaction.guild, jail_role, jail_room_id)
        result = f"✅ تمت المزامنة: {success} روم بنجاح" + (f"، فشل {failed}." if failed else ".")
        await interaction.edit_original_response(content=result)

        embed = discord.Embed(title="🔄 مزامنة صلاحيات رتبة السجن", description=result,
                               color=discord.Color.blurple(), timestamp=datetime.now(timezone.utc))
        embed.add_field(name="بواسطة", value=interaction.user.mention)
        await send_log(interaction.guild, embed)

    @discord.ui.button(label="🔓 تحرير الكل", style=discord.ButtonStyle.danger, custom_id="jailbot:release_all", row=0)
    async def release_all_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "هل أنت متأكد من تحرير **جميع** المسجونين حاليًا؟", view=ConfirmReleaseAllView(), ephemeral=True
        )

    @discord.ui.button(label="➕ إضافة صلاحية سجن", style=discord.ButtonStyle.success, custom_id="jailbot:add_perm", row=0)
    async def add_perm_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "اختر رتبة أو شخصًا لمنحه صلاحية استخدام أوامر السجن:", view=AddPermissionView(), ephemeral=True
        )

    @discord.ui.button(label="📜 روم اللوق", style=discord.ButtonStyle.secondary, custom_id="jailbot:log_room", row=1)
    async def log_room_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message("اختر روم اللوق:", view=LogRoomSelectView(), ephemeral=True)

    @discord.ui.button(label="⛓️ رتبة السجن", style=discord.ButtonStyle.secondary, custom_id="jailbot:jail_role", row=1)
    async def jail_role_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message("اختر رتبة السجن:", view=JailRoleSelectView(), ephemeral=True)

    @discord.ui.button(label="🚪 روم السجن", style=discord.ButtonStyle.secondary, custom_id="jailbot:jail_room", row=1)
    async def jail_room_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "اختر روم السجن (هذا الروم يُستثنى تلقائيًا من المزامنة):", view=JailRoomSelectView(), ephemeral=True
        )

    @discord.ui.button(label="📋 عرض الصلاحيات", style=discord.ButtonStyle.secondary, custom_id="jailbot:list_perm", row=2)
    async def list_perm_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        db = load_database()
        entry = get_guild_entry(db, interaction.guild.id)
        if not entry["allowed_ids"]:
            await interaction.response.send_message("لا يوجد أي رتب أو أشخاص مصرح لهم حاليًا.", ephemeral=True)
            return
        lines = []
        for item_id in entry["allowed_ids"]:
            role = interaction.guild.get_role(item_id)
            if role:
                lines.append(f"رتبة: {role.mention}")
                continue
            member = interaction.guild.get_member(item_id)
            lines.append(f"شخص: {member.mention}" if member else f"غير معروف: `{item_id}`")
        embed = discord.Embed(title="قائمة الصلاحيات", description="\n".join(lines), color=discord.Color.blurple())
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="➖ إزالة صلاحية", style=discord.ButtonStyle.secondary, custom_id="jailbot:remove_perm", row=2)
    async def remove_perm_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "اختر رتبة أو شخصًا لإزالة صلاحيته:", view=RemovePermissionView(), ephemeral=True
        )

    @discord.ui.button(label="🔍 فحص المسجونين", style=discord.ButtonStyle.secondary, custom_id="jailbot:check_expired", row=2)
    async def check_expired_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        # يفحص كل مسجون: وقت سجنه مقابل الوقت الحالي، ويحرر من انتهت مدته فعليًا.
        # مفيد بعد أي فترة إطفاء للبوت للتأكد أن لا أحد بقي مسجونًا رغم انتهاء مدته.
        await interaction.response.defer(ephemeral=True)
        db = load_database()
        checked, released = await check_and_release_expired_for_guild(interaction.guild, db)
        await save_database(db)

        if checked == 0:
            result = "لا يوجد أي مسجونين حاليًا في هذا السيرفر."
        else:
            result = f"✅ تم فحص {checked} مسجون، وتم تحرير {released} منهم لانتهاء مدة عقوبتهم."
        await interaction.followup.send(result, ephemeral=True)

    @discord.ui.button(label="🗑️ ريسيت كل شيء", style=discord.ButtonStyle.danger, custom_id="jailbot:reset_guild", row=3)
    async def reset_guild_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        warning = (
            "⚠️ هذا الإجراء سيقوم بما يلي:\n"
            "• تحرير **جميع** المسجونين حاليًا في هذا السيرفر (فك الرتبة واستعادة رتبهم الأصلية).\n"
            "• حذف **كل بيانات** هذا السيرفر من قاعدة البيانات (المسجونين + قائمة الصلاحيات المسموح لها) نهائيًا.\n\n"
            "لا يمكن التراجع عن هذا الإجراء. هل أنت متأكد؟"
        )
        await interaction.response.send_message(warning, view=ConfirmResetGuildView(), ephemeral=True)


class ConfirmReleaseAllView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=60)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if panel_permission_check(interaction):
            return True
        await interaction.response.send_message("هذا الإجراء مخصص لمالك السيرفر أو مطور البوت فقط.", ephemeral=True)
        return False

    @discord.ui.button(label="تأكيد التحرير", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="⏳ جارٍ تحرير جميع المسجونين...", view=None)
        released, failed = await release_all_prisoners(interaction.guild)
        result = f"✅ تم تحرير {released} عضو." + (f" فشل تحرير {failed}." if failed else "")
        await interaction.edit_original_response(content=result)

    @discord.ui.button(label="إلغاء", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="تم الإلغاء.", view=None)


class ConfirmResetGuildView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=60)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if panel_permission_check(interaction):
            return True
        await interaction.response.send_message("هذا الإجراء مخصص لمالك السيرفر أو مطور البوت فقط.", ephemeral=True)
        return False

    @discord.ui.button(label="نعم، احذف كل شيء", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(
            content="⏳ جارٍ تحرير الجميع ومسح بيانات هذا السيرفر بالكامل...", view=None
        )

        released, failed = await release_all_prisoners(interaction.guild)

        db = load_database()
        key = str(interaction.guild.id)
        if key in db:
            del db[key]
        await save_database(db)

        result = (
            f"✅ تم تحرير {released} عضو" + (f" (فشل تحرير {failed})" if failed else "")
            + ". وتم حذف جميع بيانات هذا السيرفر (المسجونين وقائمة الصلاحيات) نهائيًا."
        )
        await interaction.edit_original_response(content=result)

        embed = discord.Embed(
            title="🗑️ ريسيت كامل للسيرفر",
            description=result,
            color=discord.Color.dark_red(),
            timestamp=datetime.now(timezone.utc),
        )
        embed.add_field(name="بواسطة", value=interaction.user.mention)
        await send_log(interaction.guild, embed)

    @discord.ui.button(label="إلغاء", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="تم الإلغاء.", view=None)


class AddRolePermissionSelect(discord.ui.RoleSelect):
    def __init__(self):
        super().__init__(placeholder="➕ إضافة رتبة", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        role = self.values[0]
        db = load_database()
        entry = get_guild_entry(db, interaction.guild.id)
        if role.id in entry["allowed_ids"]:
            await interaction.response.send_message(f"الرتبة {role.mention} مضافة بالفعل.", ephemeral=True)
            return
        entry["allowed_ids"].append(role.id)
        await save_database(db)
        await interaction.response.send_message(f"✅ تمت إضافة الرتبة {role.mention} إلى قائمة الصلاحيات.", ephemeral=True)


class AddUserPermissionSelect(discord.ui.UserSelect):
    def __init__(self):
        super().__init__(placeholder="➕ إضافة شخص", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        user = self.values[0]
        db = load_database()
        entry = get_guild_entry(db, interaction.guild.id)
        if user.id in entry["allowed_ids"]:
            await interaction.response.send_message(f"الشخص {user.mention} مضاف بالفعل.", ephemeral=True)
            return
        entry["allowed_ids"].append(user.id)
        await save_database(db)
        await interaction.response.send_message(f"✅ تمت إضافة {user.mention} إلى قائمة الصلاحيات.", ephemeral=True)


class AddPermissionView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(AddRolePermissionSelect())
        self.add_item(AddUserPermissionSelect())

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return panel_permission_check(interaction)


class RemoveRolePermissionSelect(discord.ui.RoleSelect):
    def __init__(self):
        super().__init__(placeholder="➖ إزالة رتبة", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        role = self.values[0]
        db = load_database()
        entry = get_guild_entry(db, interaction.guild.id)
        if role.id not in entry["allowed_ids"]:
            await interaction.response.send_message(f"الرتبة {role.mention} غير موجودة في القائمة.", ephemeral=True)
            return
        entry["allowed_ids"].remove(role.id)
        await save_database(db)
        await interaction.response.send_message(f"✅ تمت إزالة الرتبة {role.mention} من قائمة الصلاحيات.", ephemeral=True)


class RemoveUserPermissionSelect(discord.ui.UserSelect):
    def __init__(self):
        super().__init__(placeholder="➖ إزالة شخص", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        user = self.values[0]
        db = load_database()
        entry = get_guild_entry(db, interaction.guild.id)
        if user.id not in entry["allowed_ids"]:
            await interaction.response.send_message(f"الشخص {user.mention} غير موجود في القائمة.", ephemeral=True)
            return
        entry["allowed_ids"].remove(user.id)
        await save_database(db)
        await interaction.response.send_message(f"✅ تمت إزالة {user.mention} من قائمة الصلاحيات.", ephemeral=True)


class RemovePermissionView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(RemoveRolePermissionSelect())
        self.add_item(RemoveUserPermissionSelect())

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return panel_permission_check(interaction)


class LogRoomSelect(discord.ui.ChannelSelect):
    def __init__(self):
        super().__init__(placeholder="اختر روم اللوق", channel_types=[discord.ChannelType.text],
                          min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        channel = self.values[0]
        config["log_room_id"] = str(channel.id)
        await save_config()
        await interaction.response.send_message(f"✅ تم تعيين روم اللوق إلى {channel.mention}.", ephemeral=True)


class LogRoomSelectView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(LogRoomSelect())

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return panel_permission_check(interaction)


class JailRoomSelect(discord.ui.ChannelSelect):
    def __init__(self):
        super().__init__(placeholder="اختر روم السجن", channel_types=[discord.ChannelType.text],
                          min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        channel = self.values[0]
        config["jail_room_id"] = str(channel.id)
        await save_config()
        await interaction.response.send_message(
            f"✅ تم تعيين روم السجن إلى {channel.mention}. لا تنسَ الضغط على زر 🔄 مزامنة الرومات لتطبيق ذلك.",
            ephemeral=True
        )


class JailRoomSelectView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(JailRoomSelect())

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return panel_permission_check(interaction)


class JailRoleSelect(discord.ui.RoleSelect):
    def __init__(self):
        super().__init__(placeholder="اختر رتبة السجن", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        role = self.values[0]
        config["jail_role_id"] = str(role.id)
        await save_config()
        await interaction.response.send_message(
            f"✅ تم تعيين رتبة السجن إلى {role.mention}. لا تنسَ الضغط على زر 🔄 مزامنة الرومات لتطبيق ذلك.",
            ephemeral=True
        )


class JailRoleSelectView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(JailRoleSelect())

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return panel_permission_check(interaction)


# ================= /settings =================
@bot.tree.command(name="settings", description="فتح لوحة تحكم إعدادات بوت السجن")
@is_owner_or_dev()
async def settings_command(interaction: discord.Interaction):
    embed = discord.Embed(
        title="⚙️ لوحة تحكم بوت السجن",
        description="اللوحة مرئية لك فقط. اختر أحد الأزرار أدناه لإدارة النظام.",
        color=discord.Color.blurple(),
    )
    await interaction.response.send_message(embed=embed, view=SettingsPanelView(), ephemeral=True)


# ================= /jail =================
@bot.tree.command(name="jail", description="سجن عضو")
@app_commands.describe(user="العضو المراد سجنه", reason="سبب السجن",
                        duration="مدة السجن مثل 30s أو 10m أو 1h أو 2d أو 1w أو 3mo (اختياري = مؤبد)")
@has_jail_permission()
async def jail_command(interaction: discord.Interaction, user: discord.Member, reason: str, duration: str = None):
    if is_dev(user.id):
        await interaction.response.send_message("لا يمكنك سجن مطور البوت!", ephemeral=True)
        return

    if user.bot:
        await interaction.response.send_message("لا يمكن سجن حسابات البوتات.", ephemeral=True)
        return

    if user.id == interaction.user.id:
        await interaction.response.send_message("لا يمكنك سجن نفسك.", ephemeral=True)
        return

    jail_role_id = config.get("jail_role_id")
    if not jail_role_id:
        await interaction.response.send_message("لم يتم تحديد رتبة السجن بعد. استخدم /settings.", ephemeral=True)
        return

    jail_role = interaction.guild.get_role(int(jail_role_id))
    if jail_role is None:
        await interaction.response.send_message("رتبة السجن المحددة غير موجودة في السيرفر.", ephemeral=True)
        return

    if jail_role in user.roles:
        await interaction.response.send_message("هذا العضو مسجون بالفعل.", ephemeral=True)
        return

    if not bot_can_manage_member(interaction.guild, user):
        await interaction.response.send_message("رتبة هذا العضو أعلى من رتبة البوت، لا يمكن تعديل رتبه.", ephemeral=True)
        return

    if (interaction.user.top_role <= user.top_role
            and interaction.guild.owner_id != interaction.user.id
            and not is_dev(interaction.user.id)):
        await interaction.response.send_message("لا يمكنك سجن عضو برتبة أعلى من رتبتك أو مساوية لها.", ephemeral=True)
        return

    end_timestamp = None
    duration_label = "مؤبد"
    if duration:
        seconds = parse_duration(duration)
        if seconds is None:
            await interaction.response.send_message(f"صيغة المدة غير صحيحة. {DURATION_HELP}", ephemeral=True)
            return
        end_timestamp = time.time() + seconds
        duration_label = duration

    await interaction.response.defer(ephemeral=True)

    original_role_ids = [r.id for r in user.roles if r != interaction.guild.default_role]

    try:
        roles_to_remove = [r for r in user.roles if r != interaction.guild.default_role and r.id != jail_role.id]
        if roles_to_remove:
            await user.remove_roles(*roles_to_remove, reason="سجن")
        if jail_role not in user.roles:
            await user.add_roles(jail_role, reason="سجن")
    except discord.Forbidden:
        await interaction.followup.send("صلاحيات البوت غير كافية لتعديل رتب هذا العضو.", ephemeral=True)
        return

    channel_overwrites = await strip_member_channel_overwrites(interaction.guild, user)

    db = load_database()
    entry = get_guild_entry(db, interaction.guild.id)
    prisoners = entry["prisoners"]
    user_key = str(user.id)
    priors = prisoners.get(user_key, {}).get("priors", 0) + 1

    prisoners[user_key] = {
        "original_roles": original_role_ids,
        "channel_overwrites": channel_overwrites,
        "end_time": end_timestamp,
        "priors": priors,
        "reason": reason,
        "jailed_by": interaction.user.id,
    }
    await save_database(db)

    await send_jail_room_message(
        interaction.guild,
        f"{user.mention} تم سجنك.\nالسبب: {reason}\nالمدة: {duration_label if duration else 'مؤبد'}"
    )

    embed = discord.Embed(title="🔒 عملية سجن جديدة", color=discord.Color.red(), timestamp=datetime.now(timezone.utc))
    embed.add_field(name="الإداري", value=interaction.user.mention, inline=True)
    embed.add_field(name="المسجون", value=user.mention, inline=True)
    embed.add_field(name="السبب", value=reason, inline=False)
    embed.add_field(name="المدة", value=duration_label if duration else "مؤبد", inline=True)
    embed.add_field(name="عدد السوابق", value=str(priors), inline=True)
    if channel_overwrites:
        embed.add_field(name="قنوات خاصة تم إخفاؤها", value=str(len(channel_overwrites)), inline=True)
    await send_log(interaction.guild, embed)

    await interaction.followup.send(f"تم سجن {user.mention} بنجاح.", ephemeral=True)


# ================= /jailmany (سجن جماعي) =================
@bot.tree.command(name="jailmany", description="سجن عدة أعضاء دفعة واحدة بنفس السبب ونفس المدة (مفيد في حالات السبام)")
@app_commands.describe(
    users="منشن أو آيدي الأعضاء المطلوب سجنهم، مفصولين بمسافة (مثال: @user1 @user2 123456789012345678)",
    reason="سبب السجن (سيُطبّق على الجميع)",
    duration="مدة السجن للجميع مثل 30s أو 10m أو 1h أو 2d أو 1w أو 3mo (اختياري = مؤبد)",
)
@has_jail_permission()
async def jailmany_command(interaction: discord.Interaction, users: str, reason: str, duration: str = None):
    jail_role_id = config.get("jail_role_id")
    if not jail_role_id:
        await interaction.response.send_message("لم يتم تحديد رتبة السجن بعد. استخدم /settings.", ephemeral=True)
        return

    jail_role = interaction.guild.get_role(int(jail_role_id))
    if jail_role is None:
        await interaction.response.send_message("رتبة السجن المحددة غير موجودة في السيرفر.", ephemeral=True)
        return

    end_timestamp = None
    duration_label = "مؤبد"
    if duration:
        seconds = parse_duration(duration)
        if seconds is None:
            await interaction.response.send_message(f"صيغة المدة غير صحيحة. {DURATION_HELP}", ephemeral=True)
            return
        # نحسب وقت الانتهاء مرة واحدة فقط قبل بدء السجن، بحيث يخرج الجميع بنفس اللحظة تمامًا
        end_timestamp = time.time() + seconds
        duration_label = duration

    target_ids = extract_user_ids(users)
    if not target_ids:
        await interaction.response.send_message("لم أجد أي منشن أو آيدي صالح داخل النص المُرسل.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    db = load_database()
    entry = get_guild_entry(db, interaction.guild.id)
    prisoners = entry["prisoners"]

    jailed_members = []
    skipped = []

    for target_id in target_ids:
        member = interaction.guild.get_member(target_id)

        if member is None:
            skipped.append((target_id, "غير موجود في السيرفر"))
            continue
        if is_dev(member.id):
            skipped.append((target_id, "مطور البوت"))
            continue
        if member.bot:
            skipped.append((target_id, "حساب بوت"))
            continue
        if member.id == interaction.user.id:
            skipped.append((target_id, "لا يمكنك سجن نفسك"))
            continue
        if jail_role in member.roles:
            skipped.append((target_id, "مسجون بالفعل"))
            continue
        if not bot_can_manage_member(interaction.guild, member):
            skipped.append((target_id, "رتبته أعلى من رتبة البوت"))
            continue
        if (interaction.user.top_role <= member.top_role
                and interaction.guild.owner_id != interaction.user.id
                and not is_dev(interaction.user.id)):
            skipped.append((target_id, "رتبته أعلى من رتبتك أو مساوية لها"))
            continue

        original_role_ids = [r.id for r in member.roles if r != interaction.guild.default_role]

        try:
            roles_to_remove = [r for r in member.roles if r != interaction.guild.default_role and r.id != jail_role.id]
            if roles_to_remove:
                await member.remove_roles(*roles_to_remove, reason="سجن جماعي")
            if jail_role not in member.roles:
                await member.add_roles(jail_role, reason="سجن جماعي")
        except discord.Forbidden:
            skipped.append((target_id, "صلاحيات البوت غير كافية"))
            continue

        channel_overwrites = await strip_member_channel_overwrites(interaction.guild, member)

        user_key = str(member.id)
        priors = prisoners.get(user_key, {}).get("priors", 0) + 1
        prisoners[user_key] = {
            "original_roles": original_role_ids,
            "channel_overwrites": channel_overwrites,
            "end_time": end_timestamp,
            "priors": priors,
            "reason": reason,
            "jailed_by": interaction.user.id,
        }

        jailed_members.append(member)
        await send_jail_room_message(
            interaction.guild,
            f"{member.mention} تم سجنك ضمن عملية سجن جماعي.\nالسبب: {reason}\nالمدة: {duration_label}"
        )
        await asyncio.sleep(0.3)  # لتفادي حدود Discord عند سجن عدد كبير دفعة واحدة

    await save_database(db)

    embed = discord.Embed(title="🔒 سجن جماعي", color=discord.Color.red(), timestamp=datetime.now(timezone.utc))
    embed.add_field(name="الإداري", value=interaction.user.mention, inline=True)
    embed.add_field(name="عدد المسجونين", value=str(len(jailed_members)), inline=True)
    embed.add_field(name="المدة", value=duration_label, inline=True)
    embed.add_field(name="السبب", value=reason, inline=False)
    if jailed_members:
        mentions_text = " ".join(m.mention for m in jailed_members[:30])
        if len(jailed_members) > 30:
            mentions_text += f" ... و{len(jailed_members) - 30} آخرين"
        embed.add_field(name="الأعضاء الذين تم سجنهم", value=mentions_text, inline=False)
    if skipped:
        skipped_text = "\n".join(f"`{sid}` — {why}" for sid, why in skipped[:20])
        if len(skipped) > 20:
            skipped_text += f"\n... و{len(skipped) - 20} آخرين تم تخطيهم"
        embed.add_field(name=f"تم تخطيهم ({len(skipped)})", value=skipped_text, inline=False)
    await send_log(interaction.guild, embed)

    summary = f"✅ تم سجن {len(jailed_members)} عضو بنجاح، بمدة {duration_label}."
    if skipped:
        summary += f" تم تخطي {len(skipped)} (راجع سجل اللوق للتفاصيل)."
    await interaction.followup.send(summary, ephemeral=True)


# ================= /unjail =================
@bot.tree.command(name="unjail", description="فك سجن عضو")
@app_commands.describe(user="العضو المراد فك سجنه")
@has_jail_permission()
async def unjail_command(interaction: discord.Interaction, user: discord.Member):
    db = load_database()
    entry = get_guild_entry(db, interaction.guild.id)
    prisoners = entry["prisoners"]
    user_key = str(user.id)

    if user_key not in prisoners:
        await interaction.response.send_message("هذا العضو غير مسجون.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    record = prisoners.pop(user_key)
    await save_database(db)

    jail_role_id = config.get("jail_role_id")
    jail_role = interaction.guild.get_role(int(jail_role_id)) if jail_role_id else None

    try:
        if jail_role and jail_role in user.roles:
            await user.remove_roles(jail_role, reason="فك سجن")
        roles_to_restore = [interaction.guild.get_role(rid) for rid in record.get("original_roles", [])]
        roles_to_restore = [r for r in roles_to_restore if r is not None]
        if roles_to_restore:
            await user.add_roles(*roles_to_restore, reason="فك سجن - استعادة الرتب")
    except discord.Forbidden:
        await interaction.followup.send("صلاحيات البوت غير كافية لتعديل رتب هذا العضو.", ephemeral=True)
        return

    await restore_member_channel_overwrites(interaction.guild, user, record.get("channel_overwrites", {}))

    embed = discord.Embed(title="🔓 فك سجن", color=discord.Color.green(), timestamp=datetime.now(timezone.utc))
    embed.add_field(name="الإداري", value=interaction.user.mention, inline=True)
    embed.add_field(name="العضو", value=user.mention, inline=True)
    await send_log(interaction.guild, embed)

    await interaction.followup.send(f"تم فك سجن {user.mention} بنجاح.", ephemeral=True)


# ================= /jailtime =================
@bot.tree.command(name="jailtime", description="تعديل مدة سجن قائم")
@app_commands.describe(user="العضو المسجون",
                        duration="المدة الجديدة من الآن مثل 30s أو 10m أو 1h أو 2d أو 1w أو 3mo، أو permanent للمؤبد")
@has_jail_permission()
async def jailtime_command(interaction: discord.Interaction, user: discord.Member, duration: str):
    db = load_database()
    entry = get_guild_entry(db, interaction.guild.id)
    prisoners = entry["prisoners"]
    user_key = str(user.id)

    if user_key not in prisoners:
        await interaction.response.send_message("هذا العضو غير مسجون.", ephemeral=True)
        return

    if duration.lower() == "permanent":
        prisoners[user_key]["end_time"] = None
        await save_database(db)
        await interaction.response.send_message(f"أصبحت مدة سجن {user.mention} مؤبدة.", ephemeral=True)
        return

    seconds = parse_duration(duration)
    if seconds is None:
        await interaction.response.send_message(f"صيغة المدة غير صحيحة. {DURATION_HELP}", ephemeral=True)
        return

    prisoners[user_key]["end_time"] = time.time() + seconds
    await save_database(db)
    await interaction.response.send_message(f"تم تعديل مدة سجن {user.mention} إلى {duration} من الآن.", ephemeral=True)


# ================= /jailinfo =================
@bot.tree.command(name="jailinfo", description="عرض تفاصيل سجن عضو")
@app_commands.describe(user="العضو المراد عرض تفاصيله")
async def jailinfo_command(interaction: discord.Interaction, user: discord.Member):
    db = load_database()
    entry = get_guild_entry(db, interaction.guild.id)
    record = entry["prisoners"].get(str(user.id))

    if record is None:
        await interaction.response.send_message("هذا العضو غير مسجون حاليًا.", ephemeral=True)
        return

    jailer = interaction.guild.get_member(record.get("jailed_by"))
    embed = discord.Embed(title="تفاصيل السجن", color=discord.Color.orange())
    embed.add_field(name="العضو", value=user.mention, inline=True)
    embed.add_field(name="بواسطة", value=jailer.mention if jailer else "غير معروف", inline=True)
    embed.add_field(name="السبب", value=record.get("reason", "غير محدد"), inline=False)
    embed.add_field(name="المتبقي", value=format_remaining(record.get("end_time")), inline=True)
    embed.add_field(name="عدد السوابق", value=str(record.get("priors", 0)), inline=True)
    await interaction.response.send_message(embed=embed, ephemeral=True)


# ================= /jaillist =================
@bot.tree.command(name="jaillist", description="عرض قائمة المسجونين حاليًا")
async def jaillist_command(interaction: discord.Interaction):
    db = load_database()
    entry = get_guild_entry(db, interaction.guild.id)
    prisoners = entry["prisoners"]

    if not prisoners:
        await interaction.response.send_message("لا يوجد أي مسجونين حاليًا.", ephemeral=True)
        return

    lines = []
    for user_id, record in prisoners.items():
        member = interaction.guild.get_member(int(user_id))
        name = member.mention if member else f"`{user_id}`"
        remaining = format_remaining(record.get("end_time"))
        lines.append(f"{name} — المتبقي: {remaining} — السوابق: {record.get('priors', 0)}")

    embed = discord.Embed(title="قائمة المسجونين", description="\n".join(lines), color=discord.Color.orange())
    await interaction.response.send_message(embed=embed)


# ================= مهمة البقاء نشطاً لـ Render (إرسال رسالة كل 14 دقيقة) =================
KEEP_ALIVE_CHANNEL_ID = "1530910507408560128"

@tasks.loop(minutes=14)
async def keep_alive_task():
    """
    ترسل رسالة كل 14 دقيقة لروم معين لمنع Render من إطفاء البوت.
    """
    channel_id = os.environ.get("KEEP_ALIVE_CHANNEL_ID", "") or config.get("keep_alive_channel_id", KEEP_ALIVE_CHANNEL_ID)
    if not channel_id:
        return
    channel = bot.get_channel(int(channel_id))
    if channel:
        try:
            await channel.send("🟢 البوت نشط")
        except discord.HTTPException:
            pass

@keep_alive_task.before_loop
async def before_keep_alive_task():
    await bot.wait_until_ready()


# ================= أحداث =================
@bot.event
async def on_ready():
    print(f"تم تسجيل الدخول باسم {bot.user} ({bot.user.id})")
    # إرسال رسالة ترحيب عند التشغيل
    channel_id = os.environ.get("KEEP_ALIVE_CHANNEL_ID", "") or config.get("keep_alive_channel_id", KEEP_ALIVE_CHANNEL_ID)
    if channel_id:
        channel = bot.get_channel(int(channel_id))
        if channel:
            try:
                await channel.send("🚀 **البوت شغال!** تم النشر على Render بنجاح ✅")
            except discord.HTTPException:
                pass


@bot.event
async def on_member_join(member: discord.Member):
    db = load_database()
    entry = get_guild_entry(db, member.guild.id)
    prisoners = entry["prisoners"]
    user_key = str(member.id)

    if user_key not in prisoners:
        return

    jail_role_id = config.get("jail_role_id")
    jail_role = member.guild.get_role(int(jail_role_id)) if jail_role_id else None

    if jail_role:
        try:
            roles_to_remove = [r for r in member.roles if r != member.guild.default_role]
            if roles_to_remove:
                await member.remove_roles(*roles_to_remove, reason="محاولة هروب من السجن")
            await member.add_roles(jail_role, reason="محاولة هروب من السجن")
        except discord.Forbidden:
            pass

    record = prisoners[user_key]
    if record.get("channel_overwrites"):
        for channel_id_str in record["channel_overwrites"]:
            channel = member.guild.get_channel(int(channel_id_str))
            if channel:
                try:
                    await channel.set_permissions(member, overwrite=None, reason="محاولة هروب - إخفاء قناة خاصة مجددًا")
                except (discord.Forbidden, discord.HTTPException):
                    pass

    embed = discord.Embed(
        title="⚠️ محاولة هروب من السجن",
        description=f"{member.mention} غادر السيرفر وعاد بينما كان مسجونًا. تم إعادة سجنه تلقائيًا.",
        color=discord.Color.dark_red(),
        timestamp=datetime.now(timezone.utc),
    )
    await send_log(member.guild, embed)


# ================= مهمة فك السجن التلقائي =================
@tasks.loop(seconds=30)
async def auto_unjail_task():
    # هذه المهمة تعمل كل 30 ثانية، وتُنفَّذ أيضًا فور جاهزية البوت (أول تكرار).
    # هذا يعني أنه حتى لو كان البوت مطفأ لفترة وانتهت مدة أحدهم أثناء ذلك،
    # سيتم اكتشافه وتحريره تلقائيًا بمجرد عودة البوت — دون حاجة لأي تدخل يدوي.
    db = load_database()
    changed = False

    for guild_id_str in list(db.keys()):
        guild = bot.get_guild(int(guild_id_str))
        if guild is None:
            continue

        _, released = await check_and_release_expired_for_guild(guild, db)
        if released:
            changed = True

    if changed:
        await save_database(db)


@auto_unjail_task.before_loop
async def before_auto_unjail_task():
    await bot.wait_until_ready()


# ================= خادم HTTP للحفاظ على نشاط الخدمة على Render =================
# Render يعتبر النشر "فاشلاً" إن لم يستجب الخدمة على منفذ HTTP
# (خصوصاً مع نوع Web Service). هذا الخادم الصغير يجيب 200 دائماً
# حتى يعتبر Render الخدمة حية — ولا يؤثر على الاستضافات الأخرى.
def _start_http_keepalive() -> None:
    try:
        import http.server

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"OK")

            def log_message(self, *args):  # إسكات سجلات الخادم
                pass

        port = int(os.environ.get("PORT", "8080"))
        httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), _Handler)
        httpd.serve_forever()
    except Exception:
        pass  # المنفذ مشغول أو البيئة لا تدعمه — نكمل بدون خادم


# ================= تشغيل البوت =================
if __name__ == "__main__":
    # قراءة ملف .env أولاً (التوكن يكون هنا أو في متغير البيئة TOKEN)
    load_dotenv_file(ENV_FILE)

    # إبقاء الخدمة حية على Render (Web Service يتطلب استجابة HTTP)
    threading.Thread(target=_start_http_keepalive, daemon=True).start()

    token = os.environ.get("TOKEN", "") or config.get("token", "")
    if not token:
        raise SystemExit("الرجاء وضع التوكن في متغير البيئة TOKEN أو داخل config.json.")
    bot.run(token)
