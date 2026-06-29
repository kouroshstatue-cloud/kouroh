export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/') {
            return new Response(getHtmlContent(), {
                headers: { 'Content-Type': 'text/html;charset=UTF-8' },
            });
        }

        if (request.method === 'POST' && url.pathname === '/api/deploy') {
            try {
                const { token } = await request.json();
                if (!token) throw new Error("توکن نمی‌تواند خالی باشد.");

                const headers = {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                };

                const accRes = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers });
                const accData = await accRes.json();
                
                if (!accData.success || accData.result.length === 0) {
                    throw new Error("اکانتی یافت نشد. از صحت توکن مطمئن شوید.");
                }
                
                const accountId = accData.result[0].id;

                let devSub = null;
                const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers });
                const subData = await subRes.json();
                
                if (subData.success && subData.result && subData.result.subdomain) {
                    devSub = subData.result.subdomain;
                } else {
                    const newSub = `kourosh-${Math.random().toString(36).substring(2, 8)}`;
                    const createSub = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ subdomain: newSub })
                    });
                    const createSubData = await createSub.json();
                    
                    if (!createSubData.success) {
                        const cfError = createSubData.errors && createSubData.errors.length > 0 ? createSubData.errors[0].message : "نامشخص";
                        throw new Error(`CF_TOS_ERROR|${cfError}`);
                    }
                    devSub = newSub;
                }

                const uniqueSuffix = Math.random().toString(36).substring(2, 8);
                const workerName = `kourosh-asli-${uniqueSuffix}`;
                const dbName = `kourosh-asli-db-${uniqueSuffix}`;
                
                const dbRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: dbName })
                });
                const dbData = await dbRes.json();
                
                if (!dbData.success) {
                    const cfError = dbData.errors && dbData.errors.length > 0 ? dbData.errors[0].message : "نامشخص";
                    throw new Error(`CF_DB_ERROR|${cfError}`);
                }
                const dbUuid = dbData.result.uuid;

                await new Promise(resolve => setTimeout(resolve, 1000));

                const githubRes = await fetch("https://raw.githubusercontent.com/kouroshstatue-cloud/kouroh/refs/heads/main/kourosh.js?t=" + Date.now());
                if (!githubRes.ok) throw new Error("خطا در دریافت سورس از گیت‌هاب.");
                let kouroshCode = await githubRes.text();
                const verMatch = kouroshCode.match(/const CURRENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
                if (verMatch) {
                    kouroshCode = kouroshCode.replace(
                        /(const CURRENT_VERSION\s*=\s*)['"]([^'"]+)['"]/,
                        `$1'${verMatch[1]}-d'`
                    );
                }

                const metadata = {
                    main_module: "kourosh.js",
                    compatibility_date: "2025-02-08",
                    bindings: [
                        { type: "d1", name: "DB", id: dbUuid },
                        { type: "secret_text", name: "CF_API_TOKEN", text: token },
                        { type: "secret_text", name: "CF_ACCOUNT_ID", text: accountId }
                    ]
                };

                const formData = new FormData();
                formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
                formData.append("kourosh.js", new Blob([kouroshCode], { type: "application/javascript+module" }), "kourosh.js");

                const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, {
                    method: 'PUT',
                    headers: { "Authorization": `Bearer ${token}` },
                    body: formData
                });
                const deployData = await deployRes.json();
                
                if (!deployData.success) {
                    const cfError = deployData.errors && deployData.errors.length > 0 ? deployData.errors[0].message : "نامشخص";
                    throw new Error(`CF_DEPLOY_ERROR|${cfError}`);
                }

                try {
                    await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
                        method: 'POST',
                        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                        body: '{"enabled":true}'
                    });
                } catch (_) {}

                const panelUrl = `https://${workerName}.${devSub}.workers.dev`;
                return new Response(JSON.stringify({ success: true, url: panelUrl }), {
                    headers: { 'Content-Type': 'application/json' }
                });

            } catch (error) {
                return new Response(JSON.stringify({ success: false, error: error.message }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/list-panels') {
            try {
                const { token } = await request.json();
                const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

                const accRes = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers });
                const accData = await accRes.json();
                if (!accData.success || !accData.result.length) throw new Error("توکن نامعتبر است.");
                const accountId = accData.result[0].id;

                const scriptsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, { headers });
                const scriptsData = await scriptsRes.json();
                if (!scriptsData.success) throw new Error("خطا در دریافت لیست ورکرها.");

                const kouroshScripts = (scriptsData.result || []).filter(s => s.id.startsWith('kourosh-asli-'));
                
                const ghRes = await fetch("https://raw.githubusercontent.com/kouroshstatue-cloud/kouroh/refs/heads/main/kourosh.js?t=" + Date.now());
                let latestVersion = "Unknown";
                if (ghRes.ok) {
                    const ghText = await ghRes.text();
                    const match = ghText.match(/CURRENT_VERSION\s*=\s*['"]([0-9\.]+)['"]/i);
                    if (match) latestVersion = match[1];
                }

                return new Response(JSON.stringify({ success: true, panels: kouroshScripts, latestVersion }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ success: false, error: e.message }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/get-panel-version') {
            try {
                const { token, scriptName } = await request.json();
                const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

                const accRes = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers });
                const accData = await accRes.json();
                if (!accData.success || !accData.result.length) throw new Error("Invalid token");
                const accountId = accData.result[0].id;

                const scriptRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, { headers });
                const scriptData = await scriptRes.json();
                
                if (scriptData.success) {
                    const contentRes = await fetch(scriptData.result.live_content || `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/content/v2`, { headers });
                    let version = "Unknown";
                    if (contentRes.ok) {
                        const contentText = await contentRes.text();
                        const varMatch = contentText.match(/CURRENT_VERSION\s*=\s*['"]([^'"]+)['"]/i);
                        if (varMatch) version = varMatch[1];
                    }
                    return new Response(JSON.stringify({ success: true, version }), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                throw new Error("Script not found");
            } catch (e) {
                return new Response(JSON.stringify({ success: false, error: e.message }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/do-update') {
            try {
                const { token, scriptName } = await request.json();
                const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

                const accRes = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers });
                const accData = await accRes.json();
                if (!accData.success || !accData.result.length) throw new Error("توکن نامعتبر است.");
                const accountId = accData.result[0].id;

                const ghRes = await fetch("https://raw.githubusercontent.com/kouroshstatue-cloud/kouroh/main/kourosh.js?t=" + Date.now());
                if (!ghRes.ok) throw new Error("خطا در دریافت نسخه جدید از گیت‌هاب.");
                let newCode = await ghRes.text();
                const verMatch2 = newCode.match(/const CURRENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
                if (verMatch2) {
                    newCode = newCode.replace(
                        /(const CURRENT_VERSION\s*=\s*)['"]([^'"]+)['"]/,
                        `$1'${verMatch2[1]}-d'`
                    );
                }

                const bindingsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/bindings`, { headers });
                const bindingsData = await bindingsRes.json();
                const newBindings = [];
                if (bindingsData.success) {
                    for (const b of bindingsData.result) {
                        if (b.type === 'd1') {
                            newBindings.push({ type: 'd1', name: b.name, id: b.database_id || b.id });
                        } else if (b.name === 'CF_API_TOKEN') {
                            newBindings.push({ type: 'secret_text', name: 'CF_API_TOKEN', text: token });
                        } else if (b.name === 'CF_ACCOUNT_ID') {
                            newBindings.push({ type: 'secret_text', name: 'CF_ACCOUNT_ID', text: accountId });
                        }
                    }
                }

                const metadata = {
                    main_module: "kourosh.js",
                    compatibility_date: "2025-02-08",
                    bindings: newBindings
                };

                const formData = new FormData();
                formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
                formData.append("kourosh.js", new Blob([newCode], { type: "application/javascript+module" }), "kourosh.js");

                const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, {
                    method: 'PUT',
                    headers: { "Authorization": `Bearer ${token}` },
                    body: formData
                });
                const deployData = await deployRes.json();
                
                if (!deployData.success) throw new Error("خطا در اعمال آپدیت.");

                return new Response(JSON.stringify({ success: true }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) {
                return new Response(JSON.stringify({ success: false, error: e.message }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    }
};

function getHtmlContent() {
    return `
<!DOCTYPE html>
<html lang="fa" dir="rtl" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kourosh Asli Deployer</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet" type="text/css" />
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: { sans: ['Vazirmatn', 'sans-serif'] }
                }
            }
        }
    </script>
    <style>
        body { font-family: 'Vazirmatn', sans-serif; }
        .token-input::-ms-reveal, .token-input::-ms-clear { display: none; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }
        * { scrollbar-width: thin; scrollbar-color: #1e293b transparent; }
        @keyframes slide-up { 0% { opacity: 0; transform: translateY(12px); } 100% { opacity: 1; transform: translateY(0); } }
        .animate-slide-up { animation: slide-up 0.4s ease-out; }
        .glass { backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); }
    </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col items-center justify-center p-3 sm:p-4 relative overflow-hidden">

    <div class="fixed inset-0 overflow-hidden pointer-events-none">
        <div class="absolute -top-48 -right-48 w-[500px] h-[500px] bg-teal-500/5 rounded-full blur-[100px]"></div>
        <div class="absolute -bottom-48 -left-48 w-[500px] h-[500px] bg-sky-600/5 rounded-full blur-[100px]"></div>
        <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-500/3 rounded-full blur-[150px]"></div>
    </div>

    <div id="mainCard" class="w-full max-w-md relative z-10 animate-slide-up">
        <div class="bg-slate-900/70 glass border border-slate-800/60 rounded-2xl shadow-2xl p-6 sm:p-8">

            <div class="text-center mb-6">
                <div class="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-teal-500/20 to-sky-500/10 border border-teal-500/30 text-teal-400 rounded-xl mb-3">
                    <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                </div>
                <h1 class="text-2xl font-bold text-white">پنل کوروش اصلی</h1>
                <p class="text-xs text-slate-400 mt-1">Kourosh Asli Panel — Auto Deployer</p>
            </div>

            <div class="space-y-3">
                <a href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_subdomain%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Kourosh-Deployer-Token" target="_blank" class="flex items-center justify-center w-full py-2.5 bg-slate-800/60 hover:bg-slate-700/60 text-slate-200 font-medium rounded-xl text-xs transition-all border border-slate-700/50 gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
                    دریافت توکن اتصال
                </a>
                <div class="relative">
                    <input type="password" id="apiToken" placeholder="توکن خود را وارد کنید..." autocomplete="off" spellcheck="false" class="w-full pl-10 pr-3 py-2.5 bg-slate-800/50 border border-slate-700/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/50 text-sm font-mono text-left text-slate-100 placeholder-slate-500 transition token-input" dir="ltr">
                    <button type="button" onclick="toggleToken()" class="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500 hover:text-teal-400 transition">
                        <svg id="eyeIcon" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                    </button>
                </div>
                <button id="deployBtn" onclick="startDeploy()" class="w-full py-3 bg-gradient-to-r from-teal-600 to-sky-600 hover:from-teal-500 hover:to-sky-500 text-white font-bold rounded-xl text-sm transition-all duration-300 shadow-lg shadow-teal-900/40 active:scale-[0.98]">
                    ساخت پنل کوروش
                </button>
                <button type="button" id="openUpdateModalBtn" onclick="toggleUpdateModal(true)" class="w-full py-3 bg-gradient-to-r from-teal-600 to-sky-600 hover:from-teal-500 hover:to-sky-500 text-white font-bold rounded-xl text-sm transition-all duration-300 shadow-lg shadow-teal-900/40 active:scale-[0.98]">
                    بروزرسانی پنل
                </button>

                <div id="status-container" class="hidden bg-slate-800/40 rounded-xl p-3 border border-slate-700/50">
                    <div class="flex justify-between items-center mb-1.5">
                        <span id="status-text" class="text-xs font-medium text-slate-300">شروع فرآیند...</span>
                        <span id="status-pct" class="text-xs font-bold text-teal-400">۰٪</span>
                    </div>
                    <div class="w-full bg-slate-800/80 rounded-full h-1.5 overflow-hidden">
                        <div id="progressBar" class="h-full bg-gradient-to-r from-teal-500 to-sky-500 rounded-full transition-all duration-500" style="width:0%"></div>
                    </div>
                </div>
                <div id="error-box" class="hidden p-3 bg-rose-950/40 border border-rose-800/40 rounded-xl text-xs text-rose-300 text-center font-medium"></div>
            </div>
        </div>
    </div>

    <div class="flex items-center gap-3 mt-6 z-10">
        <a href="https://t.me/kouroshasli" target="_blank" class="flex items-center gap-2 px-3 py-1.5 bg-slate-800/40 hover:bg-slate-700/40 border border-slate-700/40 text-slate-400 rounded-full transition-all text-xs">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.94-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.37.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .24z"/></svg>
            @kouroshasli
        </a>
    </div>

    <script>
        function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

        function toggleToken() {
            const tokenInput = document.getElementById('apiToken');
            const eyeIcon = document.getElementById('eyeIcon');
            if (tokenInput.type === 'password') {
                tokenInput.type = 'text';
                eyeIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path>';
            } else {
                tokenInput.type = 'password';
                eyeIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>';
            }
        }
        function toggleUpdateModal(show) {
            const modal = document.getElementById('update-modal');
            const card = document.getElementById('update-modal-card');
            if (show) {
                const mainToken = document.getElementById('apiToken').value.trim();
                const updateInput = document.getElementById('updateApiToken');
                if (mainToken) updateInput.value = mainToken;
                modal.classList.remove('opacity-0', 'pointer-events-none');
                modal.classList.add('opacity-100', 'pointer-events-auto');
                card.classList.remove('opacity-0', 'scale-95');
                card.classList.add('opacity-100', 'scale-100');
                setTimeout(() => checkExistingPanels(), 300);
            } else {
                modal.classList.remove('opacity-100', 'pointer-events-auto');
                modal.classList.add('opacity-0', 'pointer-events-none');
                card.classList.remove('opacity-100', 'scale-100');
                card.classList.add('opacity-0', 'scale-95');
            }
        }

async function checkExistingPanels() {
    const token = document.getElementById('updateApiToken').value.trim();
    const listContainer = document.getElementById('panels-list-container');
    const statusBox = document.getElementById('update-status');

    if (!token) {
        listContainer.classList.add('hidden');
        listContainer.innerHTML = '';
        statusBox.classList.remove('hidden');
        statusBox.className = 'text-center text-xs font-bold p-3 rounded-xl bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400';
        statusBox.innerText = 'لطفاً توکن را وارد کنید.';
        return;
    }

    statusBox.classList.add('hidden');
    listContainer.classList.remove('hidden');
    listContainer.innerHTML = '<div class="text-center text-xs text-slate-400 py-4 animate-pulse">در حال دریافت لیست پنل‌ها...</div>';

    try {
        const response = await fetch('/api/list-panels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });

        const result = await response.json();

        if (result.success) {
            const latestVersion = result.latestVersion || "Unknown";

            if (result.panels.length === 0) {
                listContainer.innerHTML = '<div class="text-center text-xs text-slate-400 py-4">هیچ پنل کوروشی در این اکانت یافت نشد.</div>';
            } else {
                listContainer.innerHTML = '';
                result.panels.forEach(panel => {
                    const panelDiv = document.createElement('div');
                    panelDiv.className = 'flex items-center justify-between p-3 bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 rounded-xl';
                    panelDiv.id = 'panel-item-' + panel.name;

                    panelDiv.innerHTML = '<div class="flex flex-col">' +
                        '<span class="font-bold text-gray-900 dark:text-zinc-100">' + panel.name + '</span>' +
                        '<span id="version-text-' + panel.name + '" class="text-[11px] text-blue-500 font-medium mt-1 animate-pulse" dir="rtl">در حال بررسی نسخه...</span>' +
                    '</div>' +
                    '<div id="btn-container-' + panel.name + '">' +
                        '<div class="w-16 h-6 bg-gray-200 dark:bg-zinc-700 rounded-lg animate-pulse"></div>' +
                    '</div>';

                    listContainer.appendChild(panelDiv);

                    fetchPanelVersion(token, panel.name, latestVersion);
                });
            }
        } else {
            throw new Error(result.error);
        }
    } catch (e) {
        listContainer.innerHTML = '<div class="text-center text-xs text-red-400 py-4">' + e.message + '</div>';
    }
}

async function fetchPanelVersion(token, scriptName, latestVersion) {
    try {
        const response = await fetch('/api/get-panel-version', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, scriptName })
        });

        const result = await response.json();
        const version = result.success ? result.version : "Unknown";

        const displayVersion = version === "Unknown" ? "نسخه قدیمی / نامشخص" : version;
        const cleanVersion = version.replace(/-[a-z0-9]+$/i, '');
        const isLatest = (cleanVersion === latestVersion && latestVersion !== "Unknown");

        const versionText = document.getElementById('version-text-' + scriptName);
        const btnContainer = document.getElementById('btn-container-' + scriptName);

        if (versionText && btnContainer) {
            versionText.className = 'text-[11px] text-gray-500 dark:text-zinc-400 font-medium mt-1';
            versionText.innerText = displayVersion;

            if (isLatest) {
                btnContainer.innerHTML = '<button data-name="' + scriptName + '" onclick="updateKouroshPanel(this.dataset.name)" class="px-3 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 dark:text-emerald-400 font-bold rounded-lg text-xs transition">بروزرسانی مجدد</button>';
            } else {
                btnContainer.innerHTML = '<button data-name="' + scriptName + '" onclick="updateKouroshPanel(this.dataset.name)" class="px-3 py-1.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 dark:text-indigo-400 font-bold rounded-lg text-xs transition">آپدیت</button>';
            }
        }
    } catch (e) {
        const versionText = document.getElementById('version-text-' + scriptName);
        if (versionText) {
            versionText.className = 'text-[11px] text-red-500 font-medium mt-1';
            versionText.innerText = 'خطا در دریافت نسخه';
        }
    }
}

        async function updateKouroshPanel(scriptName) {
            const token = document.getElementById('updateApiToken').value.trim();
            const statusBox = document.getElementById('update-status');

            if (!confirm('آیا از آپدیت پنل ' + scriptName + ' مطمئن هستید؟')) return;

            statusBox.classList.remove('hidden');
            statusBox.className = 'mt-4 text-center text-sm font-bold p-3 rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400';
            statusBox.innerText = 'در حال بروزرسانی ' + scriptName + '...';

            try {
                const response = await fetch('/api/do-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, scriptName })
                });

                const result = await response.json();

                if (result.success) {
                    statusBox.className = 'mt-4 text-center text-sm font-bold p-3 rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400';
                    statusBox.innerText = '✅ پنل کوروش ' + scriptName + ' با موفقیت آپدیت شد!';
                    setTimeout(() => checkExistingPanels(), 2000);
                } else {
                    throw new Error(result.error);
                }
            } catch (e) {
                statusBox.className = 'mt-4 text-center text-sm font-bold p-3 rounded-xl bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400';
                statusBox.innerText = 'خطا: ' + e.message;
            }
        }
        async function startDeploy() {
            const token = document.getElementById('apiToken').value.trim();
            const btn = document.getElementById('deployBtn');
            const statusContainer = document.getElementById('status-container');
            const statusText = document.getElementById('status-text');
            const statusPct = document.getElementById('status-pct');
            const progressBar = document.getElementById('progressBar');
            const errorBox = document.getElementById('error-box');

            const oldText = document.getElementById('successTxt');
            if (oldText) oldText.remove();

            const oldSuccessLink = document.getElementById('successBtn');
            if (oldSuccessLink) oldSuccessLink.remove();

            if(!token) {
                errorBox.classList.remove('hidden');
                errorBox.innerText = 'لطفاً ابتدا توکن را وارد کنید.';
                return;
            }

            errorBox.classList.add('hidden');
            btn.disabled = true;
            document.getElementById('apiToken').disabled = true;
            btn.innerText = 'در حال پردازش...';
            statusContainer.classList.remove('hidden');

            statusText.innerText = 'در حال بررسی توکن...';
            statusPct.innerText = '۱۵٪';
            progressBar.style.width = '15%';
            await sleep(500);

            statusText.innerText = 'در حال ارتباط با کلودفلر...';
            statusPct.innerText = '۳۰٪';
            progressBar.style.width = '30%';
            await sleep(500);

            statusText.innerText = 'در حال ایجاد دیتابیس D1...';
            statusPct.innerText = '۵۰٪';
            progressBar.style.width = '50%';

            try {
                const response = await fetch('/api/deploy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token })
                });

                statusText.innerText = 'در حال دریافت پنل کوروش...';
                statusPct.innerText = '۷۵٪';
                progressBar.style.width = '75%';
                await sleep(600);

                statusText.innerText = 'در حال فعال‌سازی لینک کوروش...';
                statusPct.innerText = '۹۰٪';
                progressBar.style.width = '90%';
                await sleep(500);

                const result = await response.json();

                if (result.success) {
                    progressBar.style.width = '100%';
                    statusPct.innerText = '۱۰۰٪';
                    statusText.innerText = 'تکمیل شد!';
                    await sleep(400);

                    statusContainer.classList.add('hidden');

                    const successText = document.createElement('div');
                    successText.id = 'successTxt';
                    successText.className = 'text-center mt-6 font-bold text-sm text-emerald-600 dark:text-emerald-400';
                    successText.innerText = '✅ پنل کوروش با موفقیت ساخته شد';
                    document.getElementById('mainCard').appendChild(successText);

                    const successLink = document.createElement('a');
                    successLink.href = result.url;
                    successLink.target = '_blank';
                    successLink.className = 'block w-full py-3.5 mt-3 bg-blue-600 hover:bg-blue-700 text-white text-center font-bold rounded-xl transition duration-300 shadow-lg shadow-blue-500/25';
                    successLink.id = 'successBtn';
                    successLink.innerText = 'ورود به پنل کوروش';

                    document.getElementById('mainCard').appendChild(successLink);
                } else {
                    throw new Error(result.error);
                }
            } catch(e) {
                statusContainer.classList.add('hidden');
                errorBox.classList.remove('hidden');

                btn.disabled = false;
                document.getElementById('apiToken').disabled = false;
                btn.innerText = 'ساخت پنل کوروش';

                const errorMsg = e.message;
                const rawError = errorMsg.includes('|') ? errorMsg.split('|')[1] : errorMsg;

                if (errorMsg.includes("databases per account") || errorMsg.includes("limit reached")) {
                    errorBox.innerHTML = '<div class="mb-2 font-bold">شما به سقف مجاز ساخت دیتابیس D1 رسیده‌اید.</div>' +
                        '<div class="text-[11px] opacity-70 mb-3" dir="ltr">' + rawError + '</div>' +
                        '<a href="https://dash.cloudflare.com/?to=/:account/workers/d1" target="_blank" class="inline-block bg-red-500 text-white px-4 py-2 rounded-lg font-bold text-xs">مدیریت دیتابیس‌ها</a>';
                }
                else if (errorMsg.includes("script limit") || errorMsg.includes("scripts per account")) {
                    errorBox.innerHTML = '<div class="mb-2 font-bold">شما به سقف مجاز ساخت ورکر رسیده‌اید.</div>' +
                        '<div class="text-[11px] opacity-70 mb-3" dir="ltr">' + rawError + '</div>' +
                        '<a href="https://dash.cloudflare.com/?to=/:account/workers/services" target="_blank" class="inline-block bg-red-500 text-white px-4 py-2 rounded-lg font-bold text-xs">مدیریت ورکرها</a>';
                }
                else if (errorMsg.includes("اکانتی یافت نشد") || errorMsg.includes("Authentication") || errorMsg.includes("Invalid")) {
                    errorBox.innerHTML = '<div class="mb-2 font-bold">توکن نامعتبر است یا دسترسی ندارد.</div>' +
                        '<div class="text-[11px] opacity-70 mb-3" dir="ltr">' + rawError + '</div>' +
                        '<a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" class="inline-block bg-red-500 text-white px-4 py-2 rounded-lg font-bold text-xs">مدیریت توکن‌ها</a>';
                }
                else if (errorMsg.includes("CF_TOS_ERROR") || errorMsg.includes("CF_DB_ERROR") || errorMsg.includes("CF_DEPLOY_ERROR")) {
                    if (errorMsg.includes("email") || errorMsg.includes("verify")) {
                        errorBox.innerHTML = '<div class="mb-2 font-bold">ابتدا ایمیل خود را در کلودفلر تایید کنید.</div>' +
                            '<div class="text-[11px] opacity-70 mb-3" dir="ltr">' + rawError + '</div>' +
                            '<a href="https://dash.cloudflare.com/profile" target="_blank" class="inline-block bg-red-500 text-white px-4 py-2 rounded-lg font-bold text-xs">تایید ایمیل</a>';
                    } else {
                        errorBox.innerHTML = '<div class="mb-2 font-bold">قوانین کلودفلر را در داشبورد تایید کنید.</div>' +
                            '<div class="text-[11px] opacity-70 mb-3" dir="ltr">' + rawError + '</div>' +
                            '<a href="https://dash.cloudflare.com/?to=/:account/workers/overview" target="_blank" class="inline-block bg-red-500 text-white px-4 py-2 rounded-lg font-bold text-xs">ورود به کلودفلر</a>';
                    }
                } else {
                    errorBox.innerText = errorMsg;
                }
            }
        }
    </script>

<div id="update-modal" class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm opacity-0 pointer-events-none transition-opacity duration-200">
    <div id="update-modal-card" class="w-full max-w-md bg-slate-900/95 glass border border-slate-800/60 rounded-2xl shadow-2xl p-5 sm:p-6 transform transition-all scale-95 opacity-0 duration-200 flex flex-col max-h-[85vh]">
        <div class="flex justify-between items-center mb-5 shrink-0">
            <h3 class="text-base font-bold text-white">بروزرسانی پنل‌ها</h3>
            <button onclick="toggleUpdateModal(false)" class="text-slate-500 hover:text-slate-300 transition">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>

        <div class="space-y-3 shrink-0">
            <input type="password" id="updateApiToken" oninput="checkExistingPanels()" placeholder="توکن را وارد کنید..." autocomplete="off" spellcheck="false" class="w-full px-3 py-2.5 bg-slate-800/50 border border-slate-700/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/50 text-sm font-mono text-left text-slate-100 placeholder-slate-500 transition" dir="ltr">
        </div>

        <div id="update-status" class="hidden text-center text-xs font-bold p-3 rounded-xl"></div>

        <div id="panels-list-container" class="mt-3 hidden overflow-y-auto space-y-2 pr-1 pb-2">
        </div>
    </div>
</div>
</body>
</html>
    `;
}
