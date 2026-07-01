# الگوریتم ربات تلگرام پنل‌ساز کوروش — v2 (بازنویسی شده)

## باگ‌های نسخه اول الگوریتم
1. **لو رفتن آدرس پنل**: الگوریتم قبلی هم پنل URL رو نشون میداد → کاربر گفته فقط ساب متنی، پس پنل URL هرگز نشون داده نشه
2. **ساب روی دامنه پنل**: ساب لینک روی `panelUrl/sub/user` بازم آدرس پنل رو لو میده → نیاز به reverse proxy Worker جدا
3. **عدم اعتبارسنجی توکن**: توکن قبل از دیپلوی چک نمیشد که دسترسی Worker + D1 رو داره → دیپلوی نصفه میموند
4. **عدم setup پنل**: بعد از دیپلوی، پنل نیاز به `/api/setup` داره (ست پسورد ادمین) — این مرحله نبود
5. **استایل اشتباه دکمه**: `"secondary"` در Telegram Bot API وجود نداره → فقط `primary` (آبی)، `success` (سبز)، `danger` (قرمز)
6. **تایم‌اوت وب‌هوک**: دیپلوی ۱۰-۳۰ ثانیه طول میکشه، وب‌هوک تلگرام ۳۰ ثانیه تایم‌اوت داره → نیاز به پردازش ناهمگام با پیام‌های progress
7. **مدیریت نشدن multi-port**: هر کاربر پنل یک پورت داره، برای چندتا پورت باید یا چند یوزر ساخت یا sub proxy
8. **`limit_gb: 0`**: در بعضی پنل‌ها ۰ یعنی مسدود نه نامحدود → باید از عدد بزرگ مثلاً ۹۹۹۹۹۹ استفاده کرد
9. **بدون state machine**: کاربر مراحل مختلف رو طی میکنه (توکن ← اپراتور ← IP) — نیاز به session management
10. **ذخیره توکن در KV بدون رمزنگاری**: توکن API کلودفلر دسترسی کامل داره → باید حداقل تو hide کنیم

---

## معماری کلی

```
┌─────────────────────────────────────────────────────┐
│                   Cloudflare Workers                  │
│  ┌──────────────────┐     ┌──────────────────────┐   │
│  │  Bot Worker        │     │  Subscription Proxy   │   │
│  │  (Webhook Handler) │◄───►│  (Sub Generator)      │   │
│  │                    │     │                       │   │
│  │  KV: user sessions │     │  KV: sub mappings    │   │
│  │  KV: user panels   │     │                       │   │
│  └────────┬───────────┘     └──────────┬────────────┘   │
│           │                            │                │
│           ▼                            ▼                │
│  ┌─────────────────────────────────────────────────┐   │
│  │          Cloudflare API (deploy/update)          │   │
│  └─────────────────────────────────────────────────┘   │
│           │                                            │
│           ▼                                            │
│  ┌─────────────────────────────────────────────────┐   │
│  │     Panel User (kourosh-asli-xxx)               │   │
│  │     روی اکانت کاربر دیپلوی شده                    │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## فلو کامل (State Machine)

```
                      ┌──────────┐
                      │  /start   │
                      └────┬─────┘
                           │
                    پیام خوشامد + ۳ دکمه:
                    [🚀 ساخت پنل] [📋 پنل‌ها] [❓ راهنما]
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         STATE:       STATE:       STATE:
       AWAIT_TOKEN  READY      HELP
              │
              ▼
    کاربر متن (توکن) رو فرستاد
              │
              ▼
    Validation: GET /accounts
    ├─ Failed → "توکن نامعتبر" + [🔄 تلاش مجدد]
    │           (state هنوز AWAIT_TOKEN)
    └─ Success → تست دسترسی‌ها:
         POST /workers/scripts/test (یا LIST)
         POST /d1/database
         └─ Permission OK → ذخیره توکن در KV
                            state ← AWAIT_OPERATOR
                            ▼
                 ┌──────────────────────┐
                 │  انتخاب اپراتور:      │
                 │                      │
                 │ [🔵 همراه اول]       │
                 │ [🟢 ایرانسل]         │
                 │ [🟣 رایتل+سامانتل]   │
                 │ [🟠 شاتل]            │
                 │ [🔴 ADSL]            │
                 └──────────────────────┘
                           │
                           ▼
                      STATE: AWAIT_IPS
                 ┌──────────────────────┐
                 │ "IPهای اپراتور رو    │
                 │  وارد کن (هر خط یک): │
                 │                      │
                 │ مثال:                │
                 │ 1.1.1.1              │
                 │ 2.2.2.2              │
                 │ 3.3.3.3              │
                 └──────────────────────┘
                           │
                           ▼
                 ┌──────────────────────────────────┐
                 │  STATE: DEPLOYING (غیرهمزمان)     │
                 │                                   │
                 │  ⏳ مراحل به ترتیب:               │
                 │  1. دریافت Account ID             │
                 │  2. ساخت/فعالسازی Subdomain       │
                 │  3. ساخت D1 Database              │
                 │  4. گرفتن کد از گیت‌هاب           │
                 │  5. اعمال تغییرات (رِپلیس)        │
                 │  6. دیپلوی روی Worker             │
                 │  7. فعالسازی Subdomain پنل        │
                 │  8. Setup پنل (ست پسورد ادمین)    │
                 │  9. ساخت کاربر کانفیگ نامحدود     │
                 │  10. ثبت هش در D1 پنل             │
                 │  11. ثبت در Subscription Proxy    │
                 │                                   │
                 │  ✅ ساب شما ساخته شد!             │
                 └──────────────────────────────────┘
                           │
                           ▼
              ساب لینک (بدون آدرس پنل) ارسال شد
              + دکمه‌های پایانی
```

---

## جزییات هر مرحله

### 1. استارت /start

```javascript
// پیام خوشامد
inlineKeyboard: [
  [{ text: "🚀 ساخت پنل جدید", callback_data: "new_panel", style: "primary" }],
  [{ text: "📋 پنل‌های من", callback_data: "my_panels", style: "primary" }],
  [{ text: "❓ راهنما", callback_data: "help", style: "danger" }]
]
```

### 2. دریافت توکن

```javascript
// وقتی کاربر "ساخت پنل جدید" رو زد:
if (user.token exists in KV) {
  goto → operator selection
} else {
  setState(AWAIT_TOKEN)
  send("🔑 لطفاً توکن API کلودفلر خود را ارسال کنید.\n\n"
     + "👇 برای ساخت توکن:\n"
     + "https://dash.cloudflare.com/profile/api-tokens\n\n"
     + "نیازمند دسترسی‌های:\n"
     + "• Workers: Edit\n"
     + "• D1: Edit\n"
     + "• Account Settings: Read\n\n"
     + "یا از توکن cfut_ خود استفاده کنید.")
}
```

### 3. اعتبارسنجی توکن

```javascript
validateToken(token) {
  // 1. چک کردن خود توکن
  response = GET "https://api.cloudflare.com/client/v4/accounts"
    headers: { Authorization: "Bearer " + token }

  if (!response.ok) return { valid: false, error: "❌ توکن نامعتبر است" }

  accountId = response.result[0].id

  // 2. تست دسترسی Workers
  test1 = GET "https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts"
  if (!test1.ok) return { valid: false, error: "❌ توکن دسترسی Workers ندارد" }

  // 3. تست دسترسی D1
  test2 = GET "https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database"
  if (!test2.ok) return { valid: false, error: "❌ توکن دسترسی D1 ندارد" }

  // 4. ذخیره در KV (با رمزگذاری ساده)
  kv.put(`user:${chatId}`, encrypt({
    token: token,
    accountId: accountId
  }))

  return { valid: true, accountId }
}
```

### 4. انتخاب اپراتور (دکمه‌های رنگی شیشه‌ای)

```javascript
getOperatorKeyboard() {
  return [
    [
      { text: "📡 همراه اول",   callback_data: "op:hamrah",   style: "primary" },
      { text: "📡 ایرانسل",    callback_data: "op:irancell", style: "success" }
    ],
    [
      { text: "📡 رایتل + سامانتل", callback_data: "op:rightel", style: "primary" },
      { text: "📡 شاتل",            callback_data: "op:shatel",  style: "danger" }
    ],
    [
      { text: "📡 ADSL", callback_data: "op:adsl", style: "danger" }
    ]
  ]
}
```

### 5. دریافت IPها

```javascript
// بعد از انتخاب اپراتور:
setState(AWAIT_IPS, { operator: "hamrah" })
send("🌐 لطفاً IPهای اپراتور ${operator_name} را وارد کنید:\n\n"
   + "هر IP در یک خط:\n"
   + "1.1.1.1\n2.2.2.2\n3.3.3.3\n\n"
   + "میتوانی بعداً بیشتر هم اضافه کنی 👍")
```

### 6. پورت‌های پیش‌فرض (هاردکد در ربات)

```javascript
const PORTS = {
  irancell: [8080, 80, 8880],
  rightel:  [8080, 80, 8880],   // رایتل + سامانتل = ایرانسل
  hamrah:   [443, 2053, 2083, 8443, 2096],
  shatel:   [443, 2053, 2083],
  adsl:     [443, 2053, 2083]
}
```

### 7. دیپلوی غیرهمزمان (مهم — رفع تایم‌اوت)

```javascript
// چون دیپلوی طول میکشه:
// 1. اول یه پیام "⏳ در حال ساخت..." میفرستیم
// 2. بعد با ctx.waitUntil() دیپلوی رو اجرا میکنیم
// 3. هر مرحله پیام رو edit میکنیم

async function deployPanel(chatId, env, userData) {
  // پیام اولیه
  msg = await send("⏳ در حال ساخت پنل...\n\n" +
    "▫️ آماده‌سازی حساب...")

  // مرحله 1: Account Info
  accountId = userData.accountId
  await edit(msg, "✅ آماده‌سازی حساب\n▫️ ساخت ساب‌دامین...")

  // مرحله 2: Subdomain
  subdomain = "aslidev"  // یا از env
  await ensureSubdomain(token, accountId, subdomain)
  await edit(msg, "✅ آماده‌سازی حساب\n✅ ساب‌دامین\n▫️ ساخت دیتابیس...")

  // مرحله 3: D1
  dbName = "db-" + random(6)
  dbUuid = await createD1(token, accountId, dbName)
  await edit(msg, "✅ آماده‌سازی حساب\n✅ ساب‌دامین\n✅ دیتابیس\n▫️ دریافت کد پنل...")

  // مرحله 4: Get code from GitHub
  rawCode = await fetch("https://raw.githubusercontent.com/kouroshstatue-cloud/kouroh/main/kourosh.js")
  code = rawCode
    .replaceAll("@KouroshPanel", "@kouroshasli")
    .replace("CURRENT_VERSION", "CURRENT_VERSION + '-d'")
    // BUILD_ID عوض نمیشه — hash-based detection کار میکنه
  await edit(msg, "✅ آماده‌سازی حساب\n✅ ساب‌دامین\n✅ دیتابیس\n✅ کد پنل\n▫️ دیپلوی کردن...")

  // مرحله 5: Deploy
  panelName = "kourosh-asli-" + random(6)
  metadata = {
    main_module: "kourosh.js",
    bindings: [
      { type: "d1", name: "DB", id: dbUuid }
    ],
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"]
  }
  formData = new FormData()
  formData.append("metadata", JSON.stringify(metadata))
  formData.append("kourosh.js", new Blob([code], { type: "application/javascript" }))

  await PUT "https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${panelName}"
    body: formData
    headers: { Authorization: "Bearer ${token}" }

  await edit(msg, "✅ آماده‌سازی حساب\n✅ ساب‌دامین\n✅ دیتابیس\n✅ کد پنل\n✅ دیپلوی\n▫️ فعالسازی آدرس...")

  // مرحله 6: Enable subdomain
  await POST "https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${panelName}/subdomain"
  await edit(msg, "✅ آماده‌سازی حساب\n✅ ساب‌دامین\n✅ دیتابیس\n✅ کد پنل\n✅ دیپلوی\n✅ آدرس\n▫️ تنظیمات اولیه پنل...")

  // مرحله 7: Setup panel (set admin password)
  panelUrl = `https://${panelName}.${subdomain}.workers.dev`
  adminPassword = generatePassword(16)
  await POST `${panelUrl}/api/setup` {
    password: adminPassword
  }
  // ذخیره رمز به همراه توکن
  await kv.put(`panel:${chatId}:${panelName}`, encrypt({
    token, accountId, panelUrl, panelName, dbUuid, adminPassword
  }))

  await edit(msg, "✅ آماده‌سازی حساب\n✅ ساب‌دامین\n✅ دیتابیس\n✅ کد پنل\n✅ دیپلوی\n✅ آدرس\n✅ تنظیمات\n▫️ نصب کانفیگ...")

  // مرحله 8: Login to panel
  loginRes = await POST `${panelUrl}/api/login` {
    password: adminPassword
  }
  // ممکنه پنل از کوکی/توکن استفاده کنه

  // مرحله 9: Create user with unlimited config
  username = "u${chatId}_${random(4)}"
  user_uuid = generateUUID()
  await POST `${panelUrl}/api/users` {
    username: username,
    uuid: user_uuid,
    limit_gb: 999999,       // عملاً نامحدود (0 در بعضی پنل‌ها = مسدود)
    expiry_days: 36500,     // ~100 سال
    max_connections: 10,
    connection_type: "vless",
    ips: userData.ips,
    ports: PORTS[userData.operator]
    // اینجا فرض میکنیم پنل از multi-ip/port پشتیبانی میکنه
    // اگه نه، باید sub proxy چندتا کانفیگ جدا بسازه
  }

  // مرحله 10: Store in Subscription Proxy
  subId = randomString(16)
  await kv.put(`sub:${subId}`, JSON.stringify({
    panelUrl,
    username,
    uuid,
    ips: userData.ips,
    ports: PORTS[userData.operator],
    operator: userData.operator,
    created: Date.now()
  }))

  // مرحله 11: Auto-init hash in panel's D1
  // (همون auto-init که توی v1.0.5 پیاده‌سازی شده)
  // ربات یه درخواست به /api/check-update پنل میزنه
  // تا هش فعلی گیت‌هاب توی D1 ثبت بشه

  subUrl = `https://${env.SUB_WORKER_DOMAIN}/sub/${subId}`

  // FINAL: پیام نهایی (بدون آدرس پنل!)
  await edit(msg, null)  // حذف پیام progress
  await send(
    "✅ کانفیگ نامحدود شما ساخته شد!\n\n"
    + "📅 بدون انقضا\n"
    + "📶 بدون محدودیت حجم\n"
    + "👥 تا ۱۰ اتصال همزمان\n"
    + "🔗 اپراتور: ${OPERATOR_NAMES[userData.operator]}\n"
    + "🌐 تعداد IP: ${userData.ips.length}\n"
    + "🔌 پورت‌ها: ${PORTS[userData.operator].join(', ')}\n\n"
    + "👇 لینک اشتراک (Subscription):\n`${subUrl}`\n\n"
    + "⚠️ این لینک رو در اپ v2rayNG / Nekobox / V2Box\n"
    + "   در قسمت Subscription وارد کن.\n"
    + "   بعد از import، چندین کانفیگ با پورت‌های مختلف\n"
    + "   میبینی — هرکدوم کار میکنه.",
    { parse_mode: "Markdown" }
  )

  // دکمه‌های پایانی (رنگی)
  await send("کارت تمومه! چیکار میخوای بکنی:", {
    reply_markup: [
      [
        { text: "🔁 کانفیگ جدید", callback_data: "new_config", style: "primary" },
        { text: "📋 کپی ساب", callback_data: "copy:${subId}", style: "success" }
      ],
      [
        { text: "📡 اپراتور دیگه", callback_data: "same_panel_new_op", style: "danger" }
      ]
    ]
  })
}
```

### 8. Subscription Proxy Worker

```javascript
// Worker جدا (یا همون بات در مسیر /sub/:id)
// وظیفه: دریافت subId → برگردوندن VLESS configs

async function handleSubRequest(request, env) {
  url = new URL(request.url)  // https://sub-worker.workers.dev/sub/abc123
  subId = url.pathname.split("/")[2]

  subData = await kv.get(`sub:${subId}`, "json")
  if (!subData) return new Response("Not found", { status: 404 })

  // ساخت چندین کانفیگ VLESS (هر IP × هر پورت)
  configs = []
  for (ip of subData.ips) {
    for (port of subData.ports) {
      config = `vless://${subData.uuid}@${ip}:${port}?` +
        `path=%2F&security=none&encryption=none&type=tcp&` +
        `headerType=none#${subData.operator}-${ip}-${port}`
      configs.push(config)
    }
  }

  // برگردوندن به صورت plain text (ساب متنی)
  return new Response(configs.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  })
}
```

### 9. مدیریت خطا در هر مرحله

```javascript
// هر مرحله از deploy میتونه fail بشه:
// - Network error → "ارتباط با سرور قطع شد" + دکمه تلاش مجدد
// - Permission error → "توکن دسترسی کافی ندارد"
// - Timeout → "درخواست زمان بر شد" + دکمه تلاش مجدد
// - Panel error → "خطا در تنظیم پنل" + دکمه پشتیبانی

// ساختار پاسخ خطا:
send("❌ خطا در مرحله ${stepName}\n\n"
   + "${errorMessage}\n\n"
   + "میتونی دوباره تلاش کنی یا با پشتیبانی تماس بگیری.",
   reply_markup: [
     [{ text: "🔄 تلاش مجدد", callback_data: "retry:${stepId}", style: "primary" }],
     [{ text: "🔙 برگشت به اول", callback_data: "start", style: "danger" }]
   ]
)
```

### 10. Session / State Machine

```javascript
// ساختار KV برای session:
KEY: `session:${chatId}`
VALUE: {
  state: "AWAIT_TOKEN" | "AWAIT_OPERATOR" | "AWAIT_IPS" | "DEPLOYING" | "READY",
  data: {
    operator: "hamrah",     // آخرین اپراتور انتخاب شده
    ips: ["1.1.1.1"],       // IPهای وارد شده
    selectedPanel: "..."    // برای my_panels flow
  },
  createdAt: timestamp
}

// State transitions:
const STATE_MACHINE = {
  START: {
    "new_panel": hasToken() ? "AWAIT_OPERATOR" : "AWAIT_TOKEN",
    "my_panels": "LIST_PANELS",
    "help": "HELP"
  },
  AWAIT_TOKEN: {
    // دریافت متن (token) → validate
    onMessage: (text) => validateToken(text) ? "AWAIT_OPERATOR" : "AWAIT_TOKEN"
  },
  AWAIT_OPERATOR: {
    "op:hamrah": "AWAIT_IPS",
    "op:irancell": "AWAIT_IPS",
    // ...
  },
  AWAIT_IPS: {
    onMessage: (text) => parseIPs(text) ? "DEPLOYING" : "AWAIT_IPS"
  },
  DEPLOYING: {
    // در این حالت متن جدید نادیده گرفته بشه
    onMessage: null
  }
}
```

### 11. قابلیت "افزودن اپراتور جدید به پنل موجود"

کاربر میتونه برای پنل قبلاً ساخته شده، یه کانفیگ با اپراتور دیگه هم بگیره:

```javascript
// کاربر دکمه "📡 اپراتور دیگه" رو زد
// ربات به جای دیپلوی پنل جدید، یه یوزر جدید توی پنل قبلی میسازه

// مراحل:
// 1. انتخاب اپراتور جدید
// 2. دریافت IPهای جدید
// 3. POST /api/users روی پنل موجود با username جدید
// 4. ثبت sub جدید در Subscription Proxy
// 5. ارسال ساب لینک جدید

// محدودیت: هر user در پنل یک ساب مجزا داره
// پس کاربر چندتا ساب لینک داره (یکی برای هر اپراتور)
```

---

## خلاصه تفاوت‌ها با الگوریتم قبلی

| موضوع | قبل | بعد |
|-------|-----|-----|
| آدرس پنل | نمایش داده میشد | **هرگز نمایش داده نمیشه** |
| ساب لینک | روی دامنه پنل | **دامنه مجزا (sub proxy)** |
| اعتبارسنجی توکن | فقط GET | **۳ مرحله چک + دسترسی‌ها** |
| Setup پنل | ❌ | **✅ auto-setup پسورد ادمین** |
| دکمه‌های رنگی | secondary استفاده شده | **فقط primary/success/danger** |
| تایم‌اوت | ریسک ۳۰ ثانیه | **async با progress update** |
| Multi-port | تک کانفیگ | **sub proxy: N×M کانفیگ** |
| limit_gb | 0 (مبهم) | **999999 (نامحدود قطعی)** |
| Session | ❌ | **state machine کامل** |
| امنیت توکن | raw در KV | **رمزگذاری ساده** |
| اپراتور جدید | ❌ | **✅ قابلیت اضافه کردن** |
