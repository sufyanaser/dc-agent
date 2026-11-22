# ربط dc-custom بأدوات الذكاء الاصطناعي

رابط الأداة (MCP) لكل الأدوات:

```
https://dc-custom-relay.sufianaser.workers.dev/mcp
```

تسجيل الدخول يكون دائماً عبر GitHub، ومقفول على حساب `sufyanaser` فقط. لا تحتاج أي توكن أو مفتاح داخل الأداة.

> كل الخطوات أدناه مكتوبة حسب واجهات هذه الأدوات وقت كتابة الملف. إذا تغيّر اسم زر أو قائمة، فالفكرة نفسها: "أضف خادم MCP بعنوان URL، ثم سجّل دخول GitHub".

## Claude Code

```powershell
claude mcp add --transport http dc-custom https://dc-custom-relay.sufianaser.workers.dev/mcp
```

بعدها داخل Claude Code اكتب `/mcp`، اختر `dc-custom`، ثم Authenticate، فتفتح صفحة GitHub للموافقة.

## Claude (التطبيق أو claude.ai)

Settings ← Connectors ← Add custom connector، ثم الصق الرابط أعلاه واضغط Connect وسجّل دخول GitHub.

## ChatGPT

Settings ← Apps ← Advanced ← Developer mode (فعّله)، ثم Create app/connector:
- URL: الرابط أعلاه
- Authentication: OAuth

ثم سجّل دخول GitHub.

## Antigravity وأي أداة MCP أخرى

أضف خادماً بعيداً (remote / Streamable HTTP) بهذا الشكل في ملف إعداد MCP الخاص بالأداة:

```json
{
  "mcpServers": {
    "dc-custom": { "serverUrl": "https://dc-custom-relay.sufianaser.workers.dev/mcp" }
  }
}
```

بعض الأدوات تستعمل المفتاح `url` بدل `serverUrl`. أول استعمال يفتح صفحة GitHub للموافقة.

## Figwright (Figma) كرابط مستقل

أدوات Figwright (147 أداة) لها رابط خاص، تضيفه كأداة ثانية بنفس الطريقة أعلاه:

```
https://dc-custom-relay.sufianaser.workers.dev/mcp/figwright
```

- يعمل إذا كان Figwright مثبّتاً على الكمبيوتر (`npm i -g @figwright/mcp`، الأمر `figwright-mcp`) وdc-custom شغّالاً.
- لتنفيذ أوامر على التصميم يجب أن يكون Figma مفتوحاً وفيه إضافة Figwright شغّالة.
- مُختبر على ويندوز: قائمة الأدوات و`ping` يمرّان عبر الـ Relay. لم يُختبر على ماك.
- لإيقافه على جهاز معيّن: أضف `"bridges": {}` في `config.json` وأعد تشغيل dc-custom.

## جهازين في نفس الوقت

- اطلب من الأداة تشغيل `device_status` لترى أجهزتك وأيها متصل (الاسم هو اسم الكمبيوتر، مثل `SUFYAN`).
- إذا كان جهاز واحد فقط متصلاً، تذهب كل الأوامر إليه تلقائياً.
- إذا كان الجهازان متصلين، قل للأداة اسم الجهاز، مثلاً: "اعرض ملفات سطح المكتب على جهاز SUFYAN"، فتمرّر `device: "SUFYAN"`.

## الأيقونة

الأيقونة (مربع نيلي بعلامة `>_`) معلنة داخل بيانات الخادم (`serverInfo.icons`)، وموجودة على:
- `https://dc-custom-relay.sufianaser.workers.dev/icon.png`
- `https://dc-custom-relay.sufianaser.workers.dev/icon.svg`
- `https://dc-custom-relay.sufianaser.workers.dev/favicon.ico`

عرضها داخل كل أداة يعتمد على الأداة نفسها. بعض الأدوات تأخذها تلقائياً، وبعضها يعرض أيقونة عامة.

## تثبيت الوكيل على الجهاز

**بأمر واحد** (يحتاج GitHub CLI مسجّل الدخول: `gh auth login`):

ويندوز، في PowerShell:
```powershell
gh api repos/sufyanaser/dc-agent/contents/install.ps1 -H "Accept: application/vnd.github.raw" | Out-String | iex
```

ماك، في Terminal (لم يُختبر على ماك):
```bash
gh api repos/sufyanaser/dc-agent/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

أو يدوياً من صفحة Releases في المستودع `sufyanaser/dc-agent`. ملفات التنصيب لا تحتوي التوكن: أول تنصيب على كل كمبيوتر يطلب منك لصق توكن الجهاز مرة واحدة، وأي تحديث بعدها لا يسأل.

- **ويندوز:** شغّل `dc-custom-setup.exe` بنقرة مزدوجة والصق التوكن، فتظهر رسالة "installed and running in the background" ولا تظهر أي نافذة بعدها. يشتغل تلقائياً مع كل تسجيل دخول. للإزالة: Settings ← Apps ← dc-custom ← Uninstall.
- **ماك:** افتح `dc-custom.app` بنقرة مزدوجة، فينسخ نفسه إلى `~/Applications` ويشتغل في الخلفية بدون أيقونة في الـ Dock.
  - (لم يُختبر على ماك) إذا رفض macOS فتحه: System Settings ← Privacy & Security ← Open Anyway.
  - (لم يُختبر على ماك) حتى يقرأ ملفات Desktop وDocuments وDownloads قد يلزم: System Settings ← Privacy & Security ← Files and Folders أو Full Disk Access.

ملف التثبيت يحتوي على توكن الجهاز، فلا ترفعه ولا تشاركه.
