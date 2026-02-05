// 基于前一版本修改：
// 1. 前端页面美化（注册/登录/用户面板/管理员后台）
// 2. 用户密码改为 Hash（crypto.subtle），KV 中不保存明文
// 3. 管理后台不显示明文密码，仅提供“重置/修改”
// 4. 修复：分离 handleAdmin 和 handleCardManager，修复语法错误

import { connect } from 'cloudflare:sockets';

// 全局配置
let subPath = 'link';     
let password = 'hh2333';  
let proxyIP = '210.61.97.241:81'; 
let yourUUID = '5dc15e15-f285-4a9d-959b-0e4fbdd77b63'; // 超级管理员UUID

// CDN 配置
let cfip = [ 
    'saas.sin.fan#哄哄CDN线路HK', 'cf.008500.xyz#哄哄CDN线路HK2', 'cf.877774.xyz#哄哄CDN线路HK3','cf.zhetengsha.eu.org#哄哄CDN线路HK4','sub.danfeng.eu.org#哄哄CDN线路TW', 
    'cf.130519.xyz#哄哄CDN线路KR', 'store.ubi.com#哄哄CDN线路JP','cdns.doon.eu.org#哄哄CDN线路JP2','mfa.gov.ua#哄哄CDN线路SG','cf.090227.xyz#哄哄CDN线路SG2',
    '104.16.16.16#哄哄CDN线路US'
];

export default {
    async fetch(request, env, ctx) {
        try {
            // 初始化
            if (env.PROXYIP) proxyIP = env.PROXYIP.split(',')[0].trim();
            password = env.PASSWORD || password;
            subPath = env.SUB_PATH || subPath;
            yourUUID = env.UUID || yourUUID;

            const url = new URL(request.url);
            const path = url.pathname;
            
            // 1. 管理员后台
            if (path === '/admin') return handleAdmin(request, env);

            // 【新增】卡密管理路由
            if (path === '/cards') return handleCardManager(request, env);

            // 2. 用户注册 (卡密 + 用户名 + 密码)
            if (path === '/register') return handleRegister(request, env);

            // 3. 用户面板 (用户名 + 密码登录)
            if (path === '/user') return handleUserDashboard(request, env, url.hostname);

            // 4. ProxyIP 设置
            if (path.startsWith('/proxyip=')) {
               let pathProxyIP = decodeURIComponent(path.substring(9)).trim();
               if (pathProxyIP && !request.headers.get('Upgrade')) {
                   proxyIP = pathProxyIP;
                   return new Response(`set proxyIP to: ${proxyIP}\n\n`, { headers: { 'Content-Type': 'text/plain' } });
               }
            }

            // 5. WebSocket (VLESS 核心)
            if (request.headers.get('Upgrade') === 'websocket') {
                const customProxyIP = url.searchParams.get('proxyip') || request.headers.get('proxyip');
                return await handleVlsRequest(request, customProxyIP, env, yourUUID);
            } 
            
            // 6. 订阅下发
            else if (request.method === 'GET') {
                if (url.pathname === '/') return Response.redirect(`${url.origin}/user`, 302);
                
                let targetUUID = null;
                const pathParts = path.split('/').filter(Boolean);
                // 仅 Token 订阅生效：/${subPath}/<token>
                if (path.toLowerCase().includes(subPath.toLowerCase())) {
                    const key = pathParts[pathParts.length - 1];
                    // 仅 Token 生效（旧的用户名/UUID 订阅链接已全部失效）
                    targetUUID = await env.USER_DB.get(`TOKEN:${key}`);
                }
                
                if (!targetUUID && path.toLowerCase().includes(subPath.toLowerCase())) {
                    const key = pathParts[pathParts.length - 1] || '';
                    let reason = '订阅链接无效或已失效（Token 不存在 / 已被重置 / 输入错误）';
                    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
                        reason = '旧版 UUID 订阅链接已停用，请使用新的 Token 订阅地址。';
                    } else if (/^[a-zA-Z0-9]{3,20}$/.test(key)) {
                        reason = '旧版用户名订阅链接已停用，请登录面板获取新的 Token 订阅地址。';
                    }
                    
                    const reasonCode = (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))
                        ? 'old_uuid'
                        : (/^[a-zA-Z0-9]{3,20}$/.test(key) ? 'old_username' : 'invalid_token');

                    const cacheUrl = new URL(request.url);
                    cacheUrl.pathname = '/__invalid_sub_page';
                    cacheUrl.search = 'r=' + reasonCode;
                    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
                    const cache = caches.default;
                    const cached = await cache.match(cacheKey);
                    if (cached) return cached;

                    const resp = new Response(subscriptionInvalidPageHTML(reason), {
                        status: 404,
                        headers: {
                            "Content-Type": "text/html;charset=utf-8",
                            "Cache-Control": "public, max-age=86400"
                        },
                    });
                    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
                    return resp;
                }

                if (targetUUID) {
                    const u = await env.USER_DB.get(`USER:${targetUUID}`, { type: 'json' });
                    if (!u) {
                        const reason = '订阅对应账号不存在或已被删除，请登录面板获取最新订阅地址。';
                        return new Response(subscriptionInvalidPageHTML(reason), {
                            status: 404,
                            headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
                        });
                    }
                    if (u.status === 'banned') {
                        const reason = '账号已封禁，订阅不可用；请联系管理员解封。';
                        return new Response(subscriptionInvalidPageHTML(reason), {
                            status: 403,
                            headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
                        });
                    }
                    if (Date.now() > u.expiry) {
                        const reason = '账号已过期，订阅不可用；请联系管理员续期。';
                        return new Response(subscriptionInvalidPageHTML(reason), {
                            status: 403,
                            headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
                        });
                    }
                    await ensureAuthUUIDForUser(u, env);

                    const extra = await fetchAddApiCfip(env, ctx);
                    // 按代码中的 cfip 原始顺序输出；ADDAPI 节点追加到末尾
                    const finalList = cfip.concat(extra || []);
                    return await generateSubscription(url.hostname, u.authUUID, finalList);
                }
            }
            return new Response('Not Found', { status: 404 });
        } catch (err) {
            return new Response(`Internal Error: ${err.message}`, { status: 500 });
        }
    },
};

// ==========================================
// 数据库与管理逻辑
// ==========================================

async function checkUserAuth(uuid, env) {
    if (!uuid) return { valid: false };
    // 管理员 UUID（直连/测试用）
    if (uuid === yourUUID) return { valid: true, type: 'admin' };
    if (!env.USER_DB) return { valid: false, reason: "KV not bound" };

    // 仅使用 AUTH 映射进行鉴权（内测版本：不兼容旧的 userId 直连）
    const userId = await env.USER_DB.get(`AUTH:${uuid}`);
    if (!userId) return { valid: false, reason: "Auth not found" };

    const userData = await env.USER_DB.get(`USER:${userId}`, { type: "json" });
    if (!userData) return { valid: false, reason: "User not found" };
    if (userData.status === 'banned') return { valid: false, reason: "Banned" };
    if (Date.now() > userData.expiry) return { valid: false, reason: "Expired" };

    return { valid: true, user: userData };
}

async function generateSubscription(hostname, uuid, cfipList) {
    const list = Array.isArray(cfipList) ? cfipList : cfip;
    const vlsHeader = 'vless';
    const vlsLinks = list.map(cdnItem => {
        let host, port = 443, nodeName = '';
        if (cdnItem.includes('#')) {
            const parts = cdnItem.split('#');
            cdnItem = parts[0];
            nodeName = parts[1];
        }
        if (cdnItem.startsWith('[') && cdnItem.includes(']:')) {
            const ipv6End = cdnItem.indexOf(']:');
            host = cdnItem.substring(0, ipv6End + 1); 
            const portStr = cdnItem.substring(ipv6End + 2); 
            port = parseInt(portStr) || 443;
        } else if (cdnItem.includes(':')) {
            const parts = cdnItem.split(':');
            host = parts[0];
            port = parseInt(parts[1]) || 443;
        } else {
            host = cdnItem;
        }
        const vlsNodeName = nodeName ? `${nodeName}` : `Workers`;
        return `${vlsHeader}://${uuid}@${host}:${port}?encryption=none&security=tls&sni=${hostname}&fp=firefox&allowInsecure=1&type=ws&host=${hostname}&path=%2F%3Fed%3D2560#${vlsNodeName}`;
    });
    
    return new Response(btoa(unescape(encodeURIComponent(vlsLinks.join('\n')))), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}

// ==========================================
// UI 模板 & 密码 Hash
// ==========================================

function htmlEscape(str='') {
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function uiBaseCSS() {
    return `
    :root{
        --bg1:#0b1020;
        --bg2:#0d1b2a;
        --card: rgba(255,255,255,.08);
        --card2: rgba(255,255,255,.12);
        --text: rgba(255,255,255,.92);
        --muted: rgba(255,255,255,.68);
        --line: rgba(255,255,255,.12);
        --accent:#7c3aed;
        --accent2:#22c55e;
        --danger:#ef4444;
        --warn:#f59e0b;
        --shadow: 0 10px 30px rgba(0,0,0,.35);
        --radius:16px;
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
    }
    *{box-sizing:border-box}
    body{
        margin:0;
        font-family:var(--sans);
        color:var(--text);
        background:
          radial-gradient(1200px 800px at 20% 10%, rgba(124,58,237,.35), transparent 60%),
          radial-gradient(1000px 700px at 80% 20%, rgba(34,197,94,.25), transparent 55%),
          linear-gradient(180deg, var(--bg1), var(--bg2));
        min-height:100vh;
    }
    a{color:inherit}
    .wrap{max-width:980px;margin:0 auto;padding:28px 16px 40px}
    .topbar{display:flex;gap:12px;align-items:center;justify-content:center;margin-bottom:16px;flex-direction:column;text-align:center}
    .brand{display:flex;gap:12px;align-items:center;justify-content:center;flex-direction:column}
    .logo{
        width:56px;height:56px;border-radius:18px;
        background: linear-gradient(135deg, rgba(124,58,237,.9), rgba(34,197,94,.75));
        box-shadow: var(--shadow);
        display:grid;place-items:center;
        border:1px solid rgba(255,255,255,.14);
    }
    .logo svg{width:30px;height:30px;filter: drop-shadow(0 8px 18px rgba(0,0,0,.25));}
    .brand h1{font-size:22px;margin:0;letter-spacing:.3px;font-weight:800}
    .brand small{display:block;color:var(--muted);font-size:14px;margin-top:4px}
    @media(min-width:860px){.brand h1{font-size:26px}.brand small{font-size:15px}}

    .grid{display:grid;grid-template-columns:1fr;gap:14px}
    .card{
        background: linear-gradient(180deg, var(--card), rgba(255,255,255,.05));
        border:1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding:18px;
        backdrop-filter: blur(10px);
    }
    .card h2{margin:0 0 10px;font-size:18px}
    .card p{margin:10px 0;color:var(--muted);line-height:1.55}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .row.nowrap{flex-wrap:nowrap;overflow-x:auto;align-items:center}
    .actions{display:flex;gap:8px;flex-wrap:nowrap;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch}
    .actions .btn{white-space:nowrap}
    .actions input{min-width:78px}
    .tableWrap table{min-width:980px}
    .field{display:flex;flex-direction:column;gap:6px;margin:10px 0}
    label{font-size:12px;color:var(--muted)}
    input, textarea, select{
        width:100%;
        background: rgba(0,0,0,.25);
        border:1px solid var(--line);
        color: var(--text);
        border-radius: 12px;
        padding:12px 12px;
        outline:none;
    }
    input:focus, textarea:focus{border-color: rgba(124,58,237,.8); box-shadow: 0 0 0 3px rgba(124,58,237,.18)}
    .btn{
        appearance:none;border:0;cursor:pointer;
        padding:11px 14px;border-radius: 12px;
        color: var(--text);
        background: rgba(255,255,255,.10);
        border:1px solid var(--line);
        transition: transform .04s ease, background .15s ease, border-color .15s ease;
        user-select:none;
        font-weight:600;
    }
    .btn:active{transform: translateY(1px)}
    .btn.primary{background: linear-gradient(135deg, rgba(124,58,237,.95), rgba(124,58,237,.65)); border-color: rgba(124,58,237,.55)}
    .btn.good{background: linear-gradient(135deg, rgba(34,197,94,.95), rgba(34,197,94,.60)); border-color: rgba(34,197,94,.55)}
    .btn.danger{background: linear-gradient(135deg, rgba(239,68,68,.95), rgba(239,68,68,.62)); border-color: rgba(239,68,68,.55)}
    .btn.warn{background: linear-gradient(135deg, rgba(245,158,11,.95), rgba(245,158,11,.62)); border-color: rgba(245,158,11,.55); color: rgba(0,0,0,.85)}
    .hint{font-size:12px;color:var(--muted)}
    .hint.big{font-size:14px;line-height:1.75;color:rgba(255,255,255,.78)}
    .badge{
        display:inline-flex;align-items:center;gap:6px;
        padding:6px 10px;border-radius:999px;
        font-size:12px;font-weight:700;
        border:1px solid var(--line);
        background: rgba(255,255,255,.08);
    }
    .badge.ok{background: rgba(34,197,94,.12); border-color: rgba(34,197,94,.35)}
    .badge.bad{background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.35)}
    .badge.off{background: rgba(148,163,184,.10); border-color: rgba(148,163,184,.25)}
    .mono{font-family:var(--mono)}
    .divider{height:1px;background:var(--line);margin:14px 0}
    .toast{
        position:fixed;left:50%;bottom:18px;transform:translateX(-50%);
        background: rgba(0,0,0,.55);
        border:1px solid rgba(255,255,255,.14);
        padding:10px 12px;border-radius:12px;
        color:var(--text);
        box-shadow: var(--shadow);
        opacity:0;pointer-events:none;
        transition: opacity .2s ease, transform .2s ease;
    }
    .toast.show{opacity:1;transform:translateX(-50%) translateY(-6px)}
    table{width:100%;border-collapse:collapse}
    th,td{padding:12px 10px;border-bottom:1px solid rgba(255,255,255,.10);text-align:left;vertical-align:top}
    th{font-size:12px;color:var(--muted);font-weight:700}
    td{font-size:14px}
    .tableWrap{overflow:auto;border-radius:14px;border:1px solid rgba(255,255,255,.10)}
    `;
}

// ===== Brand Logo SVGs (inline) =====
const ICON_DEFAULT = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 2l1.2 3.6L17 7l-3.8 1.4L12 12l-1.2-3.6L7 7l3.8-1.4L12 2Z" stroke="rgba(255,255,255,.92)" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M5 13l.9 2.7L9 17l-3.1 1.3L5 21l-.9-2.7L1 17l3.1-1.3L5 13Z" stroke="rgba(255,255,255,.80)" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M19 12l.9 2.7L23 16l-3.1 1.3L19 20l-.9-2.7L15 16l3.1-1.3L19 12Z" stroke="rgba(255,255,255,.72)" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`.trim();

const ICON_LOGIN = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M7 11V8.5a5 5 0 0 1 10 0V11" stroke="rgba(255,255,255,.85)" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M6.5 11h11A2.5 2.5 0 0 1 20 13.5v5A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5v-5A2.5 2.5 0 0 1 6.5 11Z" stroke="rgba(255,255,255,.92)" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M12 15v2" stroke="rgba(255,255,255,.92)" stroke-width="1.9" stroke-linecap="round"/>
  <path d="M12 14.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z" stroke="rgba(255,255,255,.92)" stroke-width="1.6"/>
</svg>`.trim();

const ICON_REGISTER = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke="rgba(255,255,255,.86)" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="rgba(255,255,255,.92)" stroke-width="1.8"/>
  <path d="M19 8v6" stroke="rgba(255,255,255,.92)" stroke-width="1.9" stroke-linecap="round"/>
  <path d="M16 11h6" stroke="rgba(255,255,255,.92)" stroke-width="1.9" stroke-linecap="round"/>
</svg>`.trim();

const ICON_DASHBOARD = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M4 13a8 8 0 1 1 16 0" stroke="rgba(255,255,255,.85)" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M12 13l3.2-3.2" stroke="rgba(255,255,255,.92)" stroke-width="1.9" stroke-linecap="round"/>
  <path d="M6 13h12" stroke="rgba(255,255,255,.60)" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M12 17.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z" stroke="rgba(255,255,255,.92)" stroke-width="1.8"/>
</svg>`.trim();

const ICON_ADMIN = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 2l8 4v6c0 5-3.5 9.4-8 10-4.5-.6-8-5-8-10V6l8-4Z" stroke="rgba(255,255,255,.90)" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M12 8v4" stroke="rgba(255,255,255,.92)" stroke-width="1.9" stroke-linecap="round"/>
  <path d="M12 16h.01" stroke="rgba(255,255,255,.92)" stroke-width="2.6" stroke-linecap="round"/>
</svg>`.trim();
// ===================================

function page(title, inner, opts={}) {
    const extraStyle = opts.extraStyle || '';
    const extraHead = opts.extraHead || '';
    const logoHTML = opts.logoHTML || ICON_DEFAULT;
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>${uiBaseCSS()}${extraStyle}</style>
${extraHead}
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="brand">
      <div class="logo">${logoHTML}</div>
      <div>
        <h1>${htmlEscape(opts.brandTitle || '用户中心')}</h1>
        <small>${htmlEscape(opts.brandSubtitle || 'Cloudflare Workers')}</small>
      </div>
    </div>
    ${opts.topRightHTML || ''}
  </div>
  ${inner}
</div>
<div id="toast" class="toast"></div>
<script>
  function toast(msg){
    const t=document.getElementById('toast');
    t.textContent=msg; t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), 1600);
  }
</script>
${opts.extraScript || ''}
</body></html>`;
}

function subscriptionInvalidPageHTML(reasonText) {
    const reason = reasonText || '订阅链接无效或已失效';
    const inner = `
      <div class="card" style="max-width:720px;margin:0 auto">
        <h2>订阅失效</h2>
        <p>${htmlEscape(reason)}</p>
        <div class="divider"></div>
        <p class="hint">可能原因：</p>
        <p>
          • 旧的订阅地址（用户名/UUID）已停用<br>
          • 订阅 Token 已被重置（旧地址自动失效）<br>
          • 账号已过期或被封禁
        </p>
        <div class="divider"></div>
        <div class="row">
          <a class="btn good" href="/user" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">登录获取新订阅</a>
          <a class="btn" href="/register" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">注册新账号</a>
          <a class="btn primary" href="http://t.me/xhwteambot" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">联系 TG Bot</a>
        </div>
        <p class="hint" style="margin-top:12px">提示：请保护好自己的订阅地址，防止泄露造成损失。</p>
      </div>`;
    return page('订阅失效', inner, {
        brandTitle: '订阅失效',
        brandSubtitle: 'Subscription invalid',
        logoHTML: ICON_DEFAULT
    });
}

function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function randomSaltB64(len = 16) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
async function sha256B64(input) {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return bufToB64(digest);
}
async function hashPassword(pass, saltB64) {
    const salt = saltB64 || randomSaltB64(16);
    const hash = await sha256B64(`${salt}:${pass}`);
    return { salt, hash };
}
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let out = 0;
    for (let i = 0; i < a.length; i++) out |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return out === 0;
}
async function verifyPassword(pass, saltB64, expectedHashB64) {
    if (!saltB64 || !expectedHashB64) return false;
    const got = await sha256B64(`${saltB64}:${pass}`);
    return timingSafeEqual(got, expectedHashB64);
}

// ===== Subscription Token (random, resettable) =====
function genSubToken(len = 12) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

async function ensureSubTokenForUser(userData, env) {
    if (!userData) return userData;
    // Ensure user has subToken and TOKEN mapping exists
    if (!userData.subToken) {
        userData.subToken = genSubToken(12);
        userData.subUpdated = Date.now();
        await env.USER_DB.put(`TOKEN:${userData.subToken}`, userData.uuid);
        await env.USER_DB.put(`USER:${userData.uuid}`, JSON.stringify(userData));
    } else {
        const mapped = await env.USER_DB.get(`TOKEN:${userData.subToken}`);
        if (!mapped) await env.USER_DB.put(`TOKEN:${userData.subToken}`, userData.uuid);
    }
    return userData;
}


async function resetSubTokenForUser(userData, env) {
        if (!userData) return null;

        // 1) 重置订阅 Token（控制订阅链接）
        const oldToken = userData.subToken;
        const nextToken = genSubToken(12);
        userData.subToken = nextToken;
        userData.subUpdated = Date.now();

        // 2) 同步轮换订阅 UUID（用于 VLESS 连接鉴权），解决配置泄露后仍可连接的问题
        await ensureAuthUUIDForUser(userData, env);
        const oldAuth = userData.authUUID;
        const nextAuth = crypto.randomUUID();
        userData.authUUID = nextAuth;
        userData.authUpdated = Date.now();

        await env.USER_DB.put(`USER:${userData.uuid}`, JSON.stringify(userData));
        await env.USER_DB.put(`TOKEN:${nextToken}`, userData.uuid);
        await env.USER_DB.put(`AUTH:${nextAuth}`, userData.uuid);

        if (oldToken) await env.USER_DB.delete(`TOKEN:${oldToken}`);
        if (oldAuth) await env.USER_DB.delete(`AUTH:${oldAuth}`);

        return { userData, subToken: nextToken, authUUID: nextAuth };
    }


async function ensureAuthUUIDForUser(userData, env) {
    if (!userData) return userData;
    // authUUID 用于 VLESS 连接鉴权（可轮换）；userData.uuid 仍作为用户ID/存储Key
    if (!userData.authUUID) {
        userData.authUUID = userData.uuid; // 兼容老用户：默认与用户ID一致
        userData.authUpdated = Date.now();
        await env.USER_DB.put(`AUTH:${userData.authUUID}`, userData.uuid);
        await env.USER_DB.put(`USER:${userData.uuid}`, JSON.stringify(userData));
    } else {
        const mapped = await env.USER_DB.get(`AUTH:${userData.authUUID}`);
        if (!mapped) await env.USER_DB.put(`AUTH:${userData.authUUID}`, userData.uuid);
    }
    return userData;
}

async function rotateAuthUUIDForUser(userData, env) {
    if (!userData) return null;
    await ensureAuthUUIDForUser(userData, env);
    const oldAuth = userData.authUUID;
    const nextAuth = crypto.randomUUID();
    userData.authUUID = nextAuth;
    userData.authUpdated = Date.now();
    await env.USER_DB.put(`USER:${userData.uuid}`, JSON.stringify(userData));
    await env.USER_DB.put(`AUTH:${nextAuth}`, userData.uuid);
    if (oldAuth) await env.USER_DB.delete(`AUTH:${oldAuth}`);
    return { userData, authUUID: nextAuth };
}


// ===== ADDAPI: external CDN list (format: IP:PORT#REMARK per line) =====

async function fetchAddApiCfip(env, ctx) {
        const api = (env && env.ADDAPI ? String(env.ADDAPI).trim() : '');
        if (!api) return [];
        try {
            const cache = caches.default;
            const cacheKey = new Request(api, { method: 'GET' });
            const cached = await cache.match(cacheKey);
            let text;
            if (cached) {
                text = await cached.text();
            } else {
                const r = await fetch(api, { method: 'GET' });
                if (!r.ok) return [];
                text = await r.text();
                const stored = new Response(text, {
                    headers: {
                        "Content-Type": "text/plain; charset=utf-8",
                        "Cache-Control": "public, max-age=300"
                    }
                });
                ctx && ctx.waitUntil && ctx.waitUntil(cache.put(cacheKey, stored.clone()));
            }

            function extractRegionCode(remark) {
                if (!remark) return 'OT';
                // 优先提取类似 “哄哄CDN线路HK2 / 哄哄API线路HK2” 的地区码
                let m = remark.match(/哄哄(?:CDN|API)线路([A-Za-z]{2,3})/i);
                if (m) return m[1].toUpperCase();
                // 其次取备注里出现的第一个 2~3 位英文地区码（HK/SG/JP/TW/KR/US 等）
                m = remark.match(/([A-Za-z]{2,3})/);
                return m ? m[1].toUpperCase() : 'OT';
            }

            const raw = [];
            for (const line0 of text.split(/\r?\n/)) {
                const line = line0.trim();
                if (!line) continue;
                if (line.startsWith('#') || line.startsWith('//')) continue;

                const hashIdx = line.indexOf('#');
                let addr = line;
                let remark = '';
                if (hashIdx >= 0) {
                    addr = line.slice(0, hashIdx).trim();
                    remark = line.slice(hashIdx + 1).trim();
                }
                if (!addr) continue;

                raw.push({ addr, remark });
            }

            // 统一把 ADDAPI 的备注改成：哄哄API线路 + 地区 + 序号（同地区重复才加序号）
            const counters = {};
            const out = [];
            for (const it of raw) {
                const region = extractRegionCode(it.remark);
                counters[region] = (counters[region] || 0) + 1;
                const suffix = counters[region] === 1 ? '' : String(counters[region]);
                const newRemark = `哄哄API线路${region}${suffix}`;
                out.push(`${it.addr}#${newRemark}`);
            }
            return out;
        } catch (e) {
            return [];
        }
    }
// ================================================================
// ===============================================

// 处理注册 (修改：增加密码)
async function handleRegister(request, env) {
    const url = new URL(request.url);
    const card = url.searchParams.get('card');
    const username = url.searchParams.get('user');
    const pass = url.searchParams.get('pass');

    // GET: show register form
    if (!card || !username || !pass) {
        const inner = `
        <div class="grid">
          <div class="card">
            <h2>新用户注册</h2>
            <p>输入 <b>用户名</b>、<b>登录密码</b> 与 <b>充值卡密</b> 完成激活。注册成功后使用同一用户名与密码登录。</p>
            <form>
              <div class="field">
                <label>用户名（字母/数字，3-20 位）</label>
                <input name="user" placeholder="例如: user123" required pattern="[a-zA-Z0-9]{3,20}" title="仅限字母和数字，3-20位">
              </div>
              <div class="field">
                <label>登录密码（6-64 位）</label>
                <input name="pass" type="password" placeholder="设置登录密码" minlength="6" maxlength="64" required>
              </div>
              <div class="field">
                <label>充值卡密</label>
                <input name="card" placeholder="请输入卡密" required>
                <div style="margin-top:12px;font-size:14px;font-weight:700;color:rgba(255,255,255,.88)">PS：如无卡密请联系客服 TG Bot：@xhwteam</div>
</div>
              <div class="row nowrap">
                <button class="btn good" type="submit">立即注册并激活</button>
                <a class="btn" href="/user" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">已有账号去登录</a>
                <a class="btn primary" href="http://t.me/xhwteambot" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">联系客服TG Bot</a>
              </div>
            </form>
          </div>

          <div class="card">
            <h2>注意事项</h2>
            <p>• 卡密用完即作废，一张卡只可以充值一次。<br>
               • 请妥善设置自己的密码， 防止遗忘和被猜出哦。</p>
            <div class="divider"></div>
            <p class="hint">安全说明：密码以 Hash 形式存储与校验（crypto.subtle）不保存明文密码请放心使用。</p>
          </div>
        </div>`;
        return new Response(page('用户注册', inner, { brandTitle: '用户注册', brandSubtitle: 'Activate your account', logoHTML: ICON_REGISTER }), {
            headers: { "Content-Type": "text/html;charset=utf-8" },
        });
    }

    // validate inputs
    if (!/^[a-zA-Z0-9]{3,20}$/.test(username)) return new Response("用户名格式不正确（仅字母/数字，3-20 位）", { status: 400 });
    if (pass.length < 6 || pass.length > 64) return new Response("密码长度不正确（6-64 位）", { status: 400 });

    // 1) verify card
    const cardData = await env.USER_DB.get(`CARD:${card}`, { type: "json" });
    if (!cardData) return new Response("无效的卡密 / Invalid Card", { status: 400 });

    // 2) username unique
    const existingUUID = await env.USER_DB.get(`USERNAME:${username}`);
    if (existingUUID) return new Response("用户名已被占用 / Username taken", { status: 400 });

    // 3) create user with hashed password
    const newUUID = crypto.randomUUID();
    const now = Date.now();
    const expiryTime = now + (cardData.duration * 24 * 60 * 60 * 1000);

    const { salt, hash } = await hashPassword(pass);

    const subToken = genSubToken(12);

    const authUUID = crypto.randomUUID();
    const newUser = {
        uuid: newUUID,
        username,
        passwordHash: hash,
        passwordSalt: salt,
        subToken: subToken,
        subUpdated: now,
        authUUID: authUUID,
        authUpdated: now,
        expiry: expiryTime,
        registerDate: now,
        status: 'active',
        note: `Via Card`
    };

    await env.USER_DB.put(`USER:${newUUID}`, JSON.stringify(newUser));
    await env.USER_DB.put(`USERNAME:${username}`, newUUID);
    await env.USER_DB.put(`TOKEN:${subToken}`, newUUID);
    await env.USER_DB.put(`AUTH:${authUUID}`, newUUID);
    await env.USER_DB.delete(`CARD:${card}`);

    const inner = `
      <div class="card">
        <h2>🎉 注册成功</h2>
        <p>欢迎，<b>${htmlEscape(username)}</b>！你的账号已激活。</p>
        <div class="divider"></div>
        <p class="hint">请妥善保管密码（系统不保存明文）。如需重置请联系管理员。</p>
        <div class="row" style="margin-top:12px">
          <a class="btn good" href="/user?user=${encodeURIComponent(username)}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">前往登录</a>
          <a class="btn" href="/user" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">返回登录页</a>
        </div>
      </div>`;
    return new Response(page('注册成功', inner, { brandTitle: '注册成功', brandSubtitle: 'Account activated' }), {
        headers: { "Content-Type": "text/html;charset=utf-8" },
    });
}

// 处理用户中心 (修改：PS文字放大加粗)
async function handleUserDashboard(request, env, hostname) {
    const url = new URL(request.url);
    const username = url.searchParams.get('user');
    const pass = url.searchParams.get('pass');

    // GET: show login
    if (!username || !pass) {
        const inner = `
          <div class="grid">
            <div class="card">
              <h2>用户登录</h2>
              <p>请输入用户名和密码登录管理面板。</p>
              <form>
                <div class="field">
                  <label>用户名</label>
                  <input name="user" placeholder="例如: user123" required>
                </div>
                <div class="field">
                  <label>密码</label>
                  <input name="pass" type="password" placeholder="你的登录密码" required>
                </div>
                <button class="btn good" type="submit" style="width:100%">登录</button>
              </form>
              <div class="divider"></div>
              <div class="row nowrap">
                <a class="btn" href="/register" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">没有账号？去注册</a>
                <a class="btn primary" href="http://t.me/xhwteambot" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">联系客服TG Bot</a>
              </div>
              <p class="hint" style="margin-top:10px">提示：订阅链接在登录后显示，可一键复制。</p>
            </div>

            <div class="card">
              <h2>常见问题</h2>
              <p>• 忘记密码或者修改密码？请联系管理员重置。<br>
                 • 请保护好自己的订阅地址，防止泄露造成损失。</p>
              <div class="divider"></div>
              <p class="hint">安全说明：密码以 Hash 形式存储与校验（crypto.subtle）不保存明文密码请放心使用。</p>
            </div>
          </div>`;
        return new Response(page('用户登录', inner, { brandTitle: '用户登录', brandSubtitle: 'Sign in to dashboard', logoHTML: ICON_LOGIN }), {
            headers: { "Content-Type": "text/html;charset=utf-8" },
        });
    }

    // lookup uuid
    const uuid = await env.USER_DB.get(`USERNAME:${username}`);
    if (!uuid) {
        const inner = `<div class="card"><h2>登录失败</h2><p>用户名或密码错误。</p><div class="row"><a class="btn" href="/user" style="text-decoration:none">返回</a></div></div>`;
        return new Response(page('登录失败', inner, { brandTitle: '用户登录', brandSubtitle: 'Sign in' }), { headers: { "Content-Type": "text/html;charset=utf-8" }, status: 403 });
    }

    const userData = await env.USER_DB.get(`USER:${uuid}`, { type: "json" });
    if (!userData) return new Response("数据异常", { status: 500 });

    // verify password
    let ok = false;
    if (userData.passwordHash && userData.passwordSalt) {
        ok = await verifyPassword(pass, userData.passwordSalt, userData.passwordHash);
    } else if (userData.password) {
        ok = (userData.password === pass);
        if (ok) {
            // migrate to hash
            const { salt, hash } = await hashPassword(pass);
            userData.passwordHash = hash;
            userData.passwordSalt = salt;
            delete userData.password;
            await env.USER_DB.put(`USER:${uuid}`, JSON.stringify(userData));
        }
    }

    if (!ok) {
        const inner = `
          <div class="card">
            <h2 style="margin-bottom:6px">密码错误</h2>
            <p>请检查用户名与密码后重试。</p>
            <div class="row">
              <a class="btn" href="/user" style="text-decoration:none">返回登录</a>
              <a class="btn" href="/register" style="text-decoration:none">去注册</a>
            </div>
          </div>`;
        return new Response(page('密码错误', inner, { brandTitle: '用户登录', brandSubtitle: 'Sign in' }), {
            headers: { "Content-Type": "text/html;charset=utf-8" },
            status: 403
        });
    }

    await ensureSubTokenForUser(userData, env);
    await ensureAuthUUIDForUser(userData, env);

    // 用户自助重置订阅地址
    const action = url.searchParams.get('action');
    if (action === 'reset_sub') {
        const r = await resetSubTokenForUser(userData, env);
        const subKey = r?.subToken || userData.subToken || username;
        const subUrl = `https://${hostname}/${subPath}/${subKey}`;
        return new Response(JSON.stringify({ status: 'ok', subToken: subKey, subUrl }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    const isBanned = userData.status === 'banned';
    const isExpired = Date.now() > userData.expiry;
    const daysLeft = Math.max(0, Math.ceil((userData.expiry - Date.now()) / 86400000));
    const leftBadgeCls = isBanned ? 'bad' : (isExpired ? 'bad' : 'ok');
    let statusText = "正常 / Active";
    let badgeCls = "ok";
    if (isBanned) { statusText = "已封禁 / Banned"; badgeCls = "bad"; }
    else if (isExpired) { statusText = "已过期 / Expired"; badgeCls = "bad"; }

    const subKey = userData.subToken || username;
    const subUrl = `https://${hostname}/${subPath}/${subKey}`;

    // ================= 修改点：PS 字体放大加粗 =================
    const inner = `
      <div class="grid">
        <div class="card">
          <h2>👋 你好，${htmlEscape(username)}</h2>
          <p>状态：<span class="badge ${badgeCls}">${htmlEscape(statusText)}</span></p>
          <p>到期时间：<b>${htmlEscape(new Date(userData.expiry).toLocaleString())}</b> <span class="badge ${leftBadgeCls}">剩余 ${daysLeft} 天</span></p>
          <div class="divider"></div>
          <p class="hint big">如果已过期/封禁，订阅将无法使用；联系管理员续期或解封。</p>
        </div>

        <div class="card">
          <h2>常用客户端</h2>
          <p class="hint">以下为常见代理软件名称（仅供参考）：</p>
          <p>
          <b>Android</b>：v2rayNG / NekoBox / Clash Meta for Android<br>
          <b>iOS</b>：Shadowrocket / Quantumult X / Surge / Stash<br>
          <b>PC</b>：v2rayN / Clash Verge Rev / NekoRay
          </p>
        </div>

        <div class="card">
          <h2>订阅地址管理</h2>
          <p class="hint big">如有问题使用问题和咨询事情请联系客服。<br>点击输入框可全选；也可以使用“一键复制订阅地址”。<br>请妥善保管您的订阅地址，防止泄露造成您的财产损失。<br>你可以重置订阅地址以降低泄露风险（旧订阅地址将失效）。</p>
          <div class="field">
            <label>Subscription URL</label>
            <input id="sub" class="mono" value="${htmlEscape(subUrl)}" readonly onclick="this.select()">
          </div>
          <div class="row nowrap">
            <button class="btn good" onclick="navigator.clipboard?.writeText(document.getElementById('sub').value).then(()=>toast('已复制订阅链接')).catch(()=>toast('复制失败，请手动复制'))">一键复制订阅</button>
            <button class="btn danger" onclick="resetSub()">重置订阅地址</button>
            <a class="btn warn" href="https://sub.cmliussss.com/" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">订阅转换</a>
            <a class="btn primary" href="http://t.me/xhwteambot" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">联系客服TG Bot</a>
          </div>
          
          <p style="margin-top:16px; font-size:16px; font-weight:bold; color:#fff; line-height:1.6;">
            PS：如果遇见您的代理软件无法更新使用更新订阅的情况，请使用 <a href="https://sub.cmliussss.com/" target="_blank" style="color:#f59e0b; text-decoration:underline">订阅转换</a> 进行订阅转换。
          </p>
        </div>
      </div>`;
    // ========================================================

    return new Response(page('用户面板', inner, { 
        brandTitle: '用户面板', 
        brandSubtitle: 'Dashboard', 
        logoHTML: ICON_DASHBOARD,
        extraScript: `
<script>
async function resetSub(){
  if(!confirm('确认重置订阅地址？重置后旧地址将失效。')) return;
  const params = new URLSearchParams(location.search);
  params.set('action','reset_sub');
  const r = await fetch('/user?' + params.toString());
  const data = await r.json().catch(()=>null);
  if(data && data.status==='ok'){
    const el = document.getElementById('sub');
    if(el) el.value = data.subUrl;
    toast('订阅地址已重置');
  } else {
    toast('重置失败');
  }
}
</script>
` 
    }), {
        headers: { "Content-Type": "text/html;charset=utf-8" },
    });
}

// ==========================================
// 管理员后台处理函数 (已优化：每页10条 + 搜索置顶 + 跳转页码)
// ==========================================
async function handleAdmin(request, env) {
    const url = new URL(request.url);
    const pass = url.searchParams.get('pass');
    const action = url.searchParams.get('action');

    const isAuthed = (pass && env.ADMIN_PASS && pass === env.ADMIN_PASS);

    if (!isAuthed) {
        const inner = `
          <div class="card" style="max-width:520px;margin:0 auto">
            <h2>管理员后台</h2>
            <p>请输入管理员密码登录。</p>
            <form>
              <div class="field">
                <label>Admin Password</label>
                <input type="password" name="pass" placeholder="管理员密码" required autofocus>
              </div>
              <button class="btn primary" type="submit" style="width:100%">登录</button>
            </form>
          </div>`;
        return new Response(page('Admin', inner, { brandTitle: '管理员后台', brandSubtitle: 'Admin console', logoHTML: ICON_ADMIN }), { headers: { "Content-Type": "text/html;charset=utf-8" }, status: 401 });
    }

    // ===== APIs =====
    // 1. 获取用户列表 (支持搜索 + 分页)
    if (action === 'get_users') {
        const cursor = url.searchParams.get('cursor') || undefined;
        const search = url.searchParams.get('search') || '';
        const limit = 10; // 【需求】每页显示 10 位
        
        const users = [];
        let nextCursor = null;

        if (search) {
            // --- 搜索逻辑 ---
            // 1. 尝试直接搜用户名
            let targetUUID = await env.USER_DB.get(`USERNAME:${search}`);
            
            // 2. 如果不是用户名，尝试直接搜 UUID (KV key)
            if (!targetUUID) {
                // 有可能输入的是 UUID，直接检查 USER:UUID 是否存在
                const u = await env.USER_DB.get(`USER:${search}`, { type: "json" });
                if (u) {
                    delete u.password; delete u.passwordHash; delete u.passwordSalt;
                    users.push(u);
                }
            } else {
                // 是用户名，通过映射获取 UUID 再取 User
                const u = await env.USER_DB.get(`USER:${targetUUID}`, { type: "json" });
                if (u) {
                    delete u.password; delete u.passwordHash; delete u.passwordSalt;
                    users.push(u);
                }
            }
            // 搜索模式下没有分页游标
            nextCursor = null;

        } else {
            // --- 正常分页逻辑 ---
            const list = await env.USER_DB.list({ prefix: "USER:", limit: limit, cursor: cursor });
            nextCursor = list.list_complete ? null : list.cursor;
            
            await Promise.all(list.keys.map(async (key) => {
                try {
                    const u = await env.USER_DB.get(key.name, { type: "json" });
                    if (u) {
                        delete u.password; delete u.passwordHash; delete u.passwordSalt;
                        users.push(u);
                    }
                } catch (e) {}
            }));
            
            // 当前页排序
            users.sort((a, b) => (a.expiry || 0) - (b.expiry || 0));
        }
        
        return new Response(JSON.stringify({
            users: users,
            cursor: nextCursor,
            isSearch: !!search
        }), { headers: { "Content-Type": "application/json" } });
    }

    // 2. 生成卡密 (保持不变)
    if (action === 'gen_card') {
        const days = parseInt(url.searchParams.get('days') || 30);
        const count = parseInt(url.searchParams.get('count') || 1);
        const cards = [];
        for (let i = 0; i < count; i++) {
            const code = 'KEY_' + Math.random().toString(36).substring(2, 8).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
            await env.USER_DB.put(`CARD:${code}`, JSON.stringify({ duration: days, createDate: Date.now() }));
            cards.push(code);
        }
        return new Response(JSON.stringify({ cards }), { headers: { "Content-Type": "application/json" } });
    }

    // 3. 切换状态 (保持不变)
    if (action === 'toggle_status') {
        const id = url.searchParams.get('id');
        const user = await env.USER_DB.get(`USER:${id}`, { type: "json" });
        if (user) {
            user.status = user.status === 'banned' ? 'active' : 'banned';
            await env.USER_DB.put(`USER:${id}`, JSON.stringify(user));
            return new Response(JSON.stringify({ status: 'ok' }));
        }
    }

    // 4. 删除用户 (保持不变)
    if (action === 'del_user') {
        const id = url.searchParams.get('id');
        const user = await env.USER_DB.get(`USER:${id}`, { type: "json" });
        if (user) {
            await env.USER_DB.delete(`USER:${id}`);
            if (user.username) await env.USER_DB.delete(`USERNAME:${user.username}`);
            if (user.subToken) await env.USER_DB.delete(`TOKEN:${user.subToken}`);
            if (user.authUUID) await env.USER_DB.delete(`AUTH:${user.authUUID}`);
        }
        return new Response(JSON.stringify({ status: 'ok' }));
    }

    // 5. 修改时间 (保持不变)
    if (action === 'modify_time') {
        const id = url.searchParams.get('id');
        const days = parseInt(url.searchParams.get('days') || 0);
        const user = await env.USER_DB.get(`USER:${id}`, { type: "json" });
        if (user) {
            let base = user.expiry > Date.now() ? user.expiry : Date.now();
            if (days < 0) base = user.expiry; 
            user.expiry = base + (days * 86400000);
            user.status = 'active';
            await env.USER_DB.put(`USER:${id}`, JSON.stringify(user));
            return new Response(JSON.stringify({ status: 'ok', newExpiry: user.expiry }));
        }
    }

    // 6. 设置密码 (保持不变)
    if (action === 'set_pass') {
        let id = url.searchParams.get('id');
        let newpass = url.searchParams.get('newpass');
        if (request.method === 'POST') {
            try { const data = await request.json(); id = data.id || id; newpass = data.newpass || newpass; } catch (e) {}
        }
        if (!id || !newpass) return new Response(JSON.stringify({ status: 'err', msg: 'missing id/newpass' }), { status: 400 });
        if (newpass.length < 6 || newpass.length > 64) return new Response(JSON.stringify({ status: 'err', msg: 'bad password length' }), { status: 400 });
        const user = await env.USER_DB.get(`USER:${id}`, { type: "json" });
        if (!user) return new Response(JSON.stringify({ status: 'err', msg: 'user not found' }), { status: 404 });
        const { salt, hash } = await hashPassword(newpass);
        user.passwordHash = hash; user.passwordSalt = salt; delete user.password;
        await env.USER_DB.put(`USER:${id}`, JSON.stringify(user));
        return new Response(JSON.stringify({ status: 'ok' }), { headers: { "Content-Type": "application/json" } });
    }

    // ===== Admin UI =====
    const inner = `
      <div class="grid">
        <div class="card">
          <h2>生成卡密</h2>
          <div class="row">
            <div class="field" style="min-width:140px;flex:1">
              <label>时长（天）</label>
              <input id="days" value="30" type="number" min="1">
            </div>
            <div class="field" style="min-width:140px;flex:1">
              <label>数量</label>
              <input id="count" value="1" type="number" min="1" max="50">
            </div>
          </div>
          <div class="row">
            <button class="btn primary" onclick="genCard()">生成卡密</button>
            <button class="btn" onclick="copyCards()">复制结果</button>
            <a class="btn" href="/cards?pass=${encodeURIComponent(pass)}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">卡密管理</a>
          </div>
          <div class="field">
            <textarea id="result" class="mono" style="height:90px" placeholder="生成结果..."></textarea>
          </div>
        </div>

        <div class="card">
          <div class="row nowrap" style="justify-content:space-between;align-items:center;margin-bottom:10px">
             <h2 style="margin:0">用户列表</h2>
             <div class="row nowrap" style="gap:5px; flex:1; justify-content:flex-end; max-width:300px">
                <input id="searchInput" placeholder="搜索用户名或UUID" style="padding:8px;font-size:13px">
                <button class="btn primary" onclick="doSearch()" style="padding:8px 12px">🔍</button>
             </div>
          </div>
          
          <div class="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>状态 / 到期</th>
                  <th>时长调整</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="list"><tr><td colspan="4" style="color:rgba(255,255,255,.6)">加载中...</td></tr></tbody>
            </table>
          </div>
          
          <div class="divider"></div>
          
          <div id="paginationRow" class="row" style="justify-content:space-between; align-items:center; flex-wrap:nowrap">
             <div class="row nowrap" style="gap:5px">
                 <button id="btnPrev" class="btn" onclick="prevPage()" disabled>◀</button>
                 <button id="btnRefresh" class="btn good" onclick="refreshCurrent()">⟳</button>
                 <button id="btnNext" class="btn primary" onclick="nextPage()" disabled>▶</button>
             </div>
             
             <div class="row nowrap" style="gap:5px; align-items:center">
                 <span id="pageIndicator" class="hint" style="white-space:nowrap">Page 1</span>
                 <div style="width:1px;height:20px;background:var(--line);margin:0 5px"></div>
                 <input type="number" id="jumpInput" placeholder="#" style="width:60px;padding:6px;text-align:center">
                 <button class="btn" onclick="jumpToPage()" style="padding:6px 10px">跳页</button>
             </div>
          </div>
          
          <div id="searchBarHelper" class="row" style="display:none; justify-content:center; margin-top:10px">
              <button class="btn" onclick="clearSearch()">退出搜索 / 返回列表</button>
          </div>
        </div>
      </div>`;

    const extraScript = `
<script>
const pass = ${JSON.stringify(pass)};

// 分页状态
let cursorStack = []; // 历史游标
let currentCursor = null; 
let nextCursor = null;
let pageIndex = 1;

// 绑定回车搜索
document.getElementById('searchInput').addEventListener('keyup', (e)=>{ if(e.key==='Enter') doSearch(); });
document.getElementById('jumpInput').addEventListener('keyup', (e)=>{ if(e.key==='Enter') jumpToPage(); });

async function api(act, params = '', opt = {}) {
  const url = \`/admin?pass=\${encodeURIComponent(pass)}&action=\${encodeURIComponent(act)}\${params}\`;
  const r = await fetch(url, opt);
  if (r.headers.get('content-type').includes('application/json')) return await r.json();
  return { status: 'err', msg: await r.text() };
}

// 核心加载函数
async function loadUsers(cursor, searchTerm = '') {
  const tbody = document.getElementById('list');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:rgba(255,255,255,.6)">加载中...</td></tr>';
  
  // 构建参数
  let params = '';
  if (searchTerm) {
      params += \`&search=\${encodeURIComponent(searchTerm)}\`;
  } else if (cursor) {
      params += \`&cursor=\${encodeURIComponent(cursor)}\`;
  }

  const data = await api('get_users', params);
  
  if(!data || !data.users) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center">加载失败</td></tr>';
      return false;
  }

  const users = data.users;
  const isSearch = data.isSearch;
  
  // 更新游标 (仅非搜索模式)
  if (!isSearch) {
      nextCursor = data.cursor;
      updatePaginationUI();
      document.getElementById('paginationRow').style.display = 'flex';
      document.getElementById('searchBarHelper').style.display = 'none';
  } else {
      document.getElementById('paginationRow').style.display = 'none';
      document.getElementById('searchBarHelper').style.display = 'flex';
  }

  // 渲染
  if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted)">未找到相关用户</td></tr>';
      return true;
  }

  const now = Date.now();
  const rows = users.map(u => {
    const exp = u.expiry || 0;
    const isBanned = u.status === 'banned';
    let badge = '<span class="badge ok">正常</span>';
    if (isBanned) badge = '<span class="badge bad">封禁</span>';
    else if (exp < now) badge = '<span class="badge bad">过期</span>';

    const uname = u.username ? \`<b>\${escapeHtml(u.username)}</b>\` : '<span class="hint">无名</span>';
    const uuidShort = u.uuid ? \`<div class="hint mono" style="font-size:10px">\${u.uuid}</div>\` : '';

    return \`<tr>
      <td>\${uname}\${uuidShort}</td>
      <td>\${badge}<div class="hint">\${new Date(exp).toLocaleDateString()}</div></td>
      <td>
        <div class="actions">
          <input type="number" id="t-\${u.uuid}" value="30" style="width:50px;padding:6px">
          <button class="btn primary" style="padding:6px 10px" onclick="mod('\${u.uuid}', 1)">+</button>
          <button class="btn warn" style="padding:6px 10px" onclick="mod('\${u.uuid}', -1)">-</button>
        </div>
      </td>
      <td>
        <div class="actions">
          <button class="btn warn" style="font-size:12px;padding:6px 10px" onclick="tog('\${u.uuid}')">\${isBanned?'解封':'封禁'}</button>
          <button class="btn primary" style="font-size:12px;padding:6px 10px" onclick="setPass('\${u.uuid}', '\${escapeHtml(u.username||'')}')">改密</button>
          <button class="btn danger" style="font-size:12px;padding:6px 10px" onclick="delUser('\${u.uuid}')">删</button>
        </div>
      </td>
    </tr>\`;
  }).join('');
  tbody.innerHTML = rows;
  return true;
}

// UI更新
function updatePaginationUI() {
    document.getElementById('btnPrev').disabled = (cursorStack.length === 0);
    document.getElementById('btnNext').disabled = !nextCursor;
    document.getElementById('pageIndicator').innerText = 'Page ' + pageIndex;
}

// --- 分页逻辑 ---
function nextPage() {
    if(!nextCursor) return;
    cursorStack.push(currentCursor);
    currentCursor = nextCursor;
    pageIndex++;
    loadUsers(currentCursor);
}
function prevPage() {
    if(cursorStack.length === 0) return;
    const prev = cursorStack.pop();
    currentCursor = prev;
    pageIndex--;
    loadUsers(currentCursor);
}
function refreshCurrent() {
    loadUsers(currentCursor);
}

// --- 跳转逻辑 (KV不支持offset，必须循环fetch) ---
async function jumpToPage() {
    const input = document.getElementById('jumpInput');
    let target = parseInt(input.value);
    if (!target || target < 1) return toast('请输入有效页码');
    if (target === pageIndex) return;

    // 向上跳转（使用缓存）
    if (target < pageIndex) {
        // 回退 stack
        while (pageIndex > target && cursorStack.length > 0) {
            currentCursor = cursorStack.pop();
            pageIndex--;
        }
        loadUsers(currentCursor);
        return;
    }

    // 向下跳转（需要 fetch）
    if (target > pageIndex) {
        if (!confirm(\`KV数据库限制：跳转到第 \${target} 页需要依次读取前序页面，可能会比较慢。确定跳转？\`)) return;
        
        const tbody = document.getElementById('list');
        tbody.innerHTML = \`<tr><td colspan="4" style="text-align:center">正在快进至第 \${target} 页...<br><span class="hint">请勿关闭页面</span></td></tr>\`;
        
        try {
            // 循环获取 cursor
            while (pageIndex < target) {
                if (!nextCursor) {
                    toast('已达到最后一页');
                    break;
                }
                // 保存当前 cursor 到栈
                cursorStack.push(currentCursor);
                currentCursor = nextCursor;
                
                // 仅获取 cursor，不渲染 DOM 以加速
                // 注意：这里需要真正请求 API 拿到 cursor
                const data = await api('get_users', \`&cursor=\${encodeURIComponent(currentCursor)}\`);
                if (!data || !data.users) throw new Error('Fetch error');
                
                nextCursor = data.cursor; // 更新下一个 cursor
                pageIndex++;
            }
            // 循环结束，加载最终页面
            loadUsers(currentCursor);
        } catch(e) {
            toast('跳转失败或已达底');
            loadUsers(currentCursor);
        }
    }
}

// --- 搜索逻辑 ---
function doSearch() {
    const term = document.getElementById('searchInput').value.trim();
    if (!term) return toast('请输入搜索内容');
    loadUsers(null, term);
}
function clearSearch() {
    document.getElementById('searchInput').value = '';
    loadUsers(currentCursor); // 回到之前的分页
}

// --- 业务操作 ---
async function genCard(){
  const d = document.getElementById('days').value;
  const c = document.getElementById('count').value;
  const r = await api('gen_card', \`&days=\${encodeURIComponent(d)}&count=\${encodeURIComponent(c)}\`);
  document.getElementById('result').value = (r.cards || []).join('\\n');
  toast('已生成');
}
async function copyCards(){
  const text = document.getElementById('result').value;
  if(text) navigator.clipboard.writeText(text).then(()=>toast('已复制'));
}
async function mod(id, factor){
  const v = document.getElementById('t-' + id).value;
  if(!confirm(\`确认修改时长？\`)) return;
  await api('modify_time', \`&id=\${encodeURIComponent(id)}&days=\${encodeURIComponent(v*factor)}\`);
  toast('已更新'); refreshCurrent();
}
async function tog(id){
  await api('toggle_status', \`&id=\${encodeURIComponent(id)}\`);
  toast('已更新'); refreshCurrent();
}
async function delUser(id){
  if(!confirm('确认删除？不可恢复。')) return;
  await api('del_user', \`&id=\${encodeURIComponent(id)}\`);
  toast('已删除'); refreshCurrent();
}
async function setPass(id, name){
  const p = prompt(\`新密码 for \${name}:\`);
  if(p) {
    const r = await api('set_pass', \`&id=\${encodeURIComponent(id)}&newpass=\${encodeURIComponent(p)}\`);
    if(r.status==='ok') toast('密码已修改'); else toast(r.msg);
  }
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Init
loadUsers();
</script>`;

    return new Response(page('Admin', inner, { brandTitle: '管理员后台', brandSubtitle: 'Admin console', logoHTML: ICON_ADMIN, extraScript }), {
        headers: { "Content-Type": "text/html;charset=utf-8" },
    });
}

// ==========================================
// 卡密管理页面处理函数（已更新：增加一键清空功能）
// ==========================================
async function handleCardManager(request, env) {
    const url = new URL(request.url);
    const pass = url.searchParams.get('pass');
    const isAuthed = (pass && env.ADMIN_PASS && pass === env.ADMIN_PASS);

    if (!isAuthed) {
        const inner = `
          <div class="card" style="max-width:520px;margin:0 auto">
            <h2>卡密管理</h2>
            <p>请输入管理员密码登录。</p>
            <form>
              <div class="field">
                <label>管理员密码</label>
                <input type="password" name="pass" placeholder="请输入管理员密码" required>
              </div>
              <div class="row nowrap" style="margin-top:10px">
                <button class="btn primary" type="submit">进入卡密管理</button>
                <a class="btn" href="/admin" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">返回后台</a>
              </div>
            </form>
          </div>`;
        return new Response(page('卡密管理', inner, { brandTitle: '卡密管理', brandSubtitle: 'Card Manager', logoHTML: ICON_ADMIN }), {
            headers: { "Content-Type": "text/html;charset=utf-8" },
        });
    }

    // ---- API: list cards (限制数量防止崩溃) ----
    if (url.searchParams.get('action') === 'list_cards') {
        const limit = 30; 
        const cursor = url.searchParams.get('cursor') || undefined;

        try {
            const res = await env.USER_DB.list({ prefix: 'CARD:', limit, cursor });
            const items = [];

            for (const k of res.keys) {
                const card = k.name.slice('CARD:'.length);
                try {
                    const v = await env.USER_DB.get(k.name, { type: 'json' });
                    if (!v || v.used) continue;
                    items.push({
                        card,
                        duration: v.duration || v.days || 0,
                        createDate: v.createDate || v.createdAt || 0,
                    });
                } catch (e) {
                    console.error(`Error loading card ${card}:`, e);
                }
            }

            items.sort((a, b) => (b.createDate || 0) - (a.createDate || 0));

            return new Response(JSON.stringify({ 
                status: 'ok', 
                cards: items, 
                cursor: res.cursor, 
                list_complete: res.list_complete 
            }), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (err) {
            return new Response(JSON.stringify({ status: 'err', msg: err.message }), { status: 500 });
        }
    }

    // ---- API: delete single card ----
    if (url.searchParams.get('action') === 'delete_card') {
        const card = url.searchParams.get('card');
        if (!card) return new Response(JSON.stringify({ status: 'err', msg: 'missing card' }), { status: 400 });
        await env.USER_DB.delete(`CARD:${card}`);
        return new Response(JSON.stringify({ status: 'ok' }), { headers: { "Content-Type": "application/json" } });
    }

    // ---- 【新增】 API: delete all cards ----
    if (url.searchParams.get('action') === 'delete_all_cards') {
        try {
            let cursor = null;
            let count = 0;
            // 循环批处理删除，防止卡密过多导致一次请求处理不完
            do {
                const list = await env.USER_DB.list({ prefix: 'CARD:', limit: 1000, cursor });
                const tasks = list.keys.map(k => env.USER_DB.delete(k.name));
                await Promise.all(tasks); // 并发删除
                count += tasks.length;
                cursor = list.list_complete ? null : list.cursor;
            } while (cursor);
            
            return new Response(JSON.stringify({ status: 'ok', count }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
            return new Response(JSON.stringify({ status: 'err', msg: e.message }), { status: 500 });
        }
    }

    // ---- Page rendering ----
    const inner = `
      <div class="grid">
        <div class="card" style="grid-column:1 / -1">
          <div class="row nowrap" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;">
            <div>
              <h2 style="margin:0">未使用卡密列表</h2>
              <p class="hint big" style="margin-top:6px">
                每次加载 30 条数据。卡密删除后不可恢复。
              </p>
            </div>
            <div class="row nowrap" style="justify-content:flex-end; gap:10px;">
              <a class="btn" href="/admin?pass=${encodeURIComponent(pass)}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">返回后台</a>
              <button class="btn danger" onclick="deleteAllCards()">清空所有</button>
              <button class="btn primary" onclick="loadCards()">刷新</button>
            </div>
          </div>

          <div class="divider"></div>

          <div style="overflow:auto">
            <table class="table">
              <thead>
                <tr>
                  <th>卡密</th>
                  <th>时长(天)</th>
                  <th>创建时间</th>
                  <th style="min-width:140px">操作</th>
                </tr>
              </thead>
              <tbody id="cardsBody">
                <tr><td colspan="4" style="color:rgba(255,255,255,.6)">加载中...</td></tr>
              </tbody>
            </table>
          </div>
          
          <div class="row" id="pagination" style="margin-top:15px; display:none; justify-content:center">
             <button class="btn" onclick="loadNextPage()">加载更多...</button>
          </div>
        </div>
      </div>`;

    const extraScript = `
<script>
let allCards = [];
let nextCursor = null;
const pass = ${JSON.stringify(pass)};

function fmt(ts){
  if(!ts) return '-';
  return new Date(ts).toLocaleString();
}
function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function api(action, params=''){
  const url = \`/cards?pass=\${encodeURIComponent(pass)}&action=\${encodeURIComponent(action)}\${params}\`;
  const r = await fetch(url);
  return await r.json().catch(()=>null);
}

function render(append = false){
  const tb = document.getElementById('cardsBody');
  if(!append) tb.innerHTML = '';
  
  if (!allCards.length) {
    tb.innerHTML = '<tr><td colspan="4" style="color:rgba(255,255,255,.6)">暂无数据</td></tr>';
    return;
  }
  
  const html = allCards.map(x => \`
    <tr>
      <td><code style="color:rgba(255,255,255,.92)">\${escapeHtml(x.card)}</code></td>
      <td>\${x.duration || 0}</td>
      <td>\${fmt(x.createDate)}</td>
      <td>
        <div class="row nowrap" style="gap:8px">
          <button class="btn" data-card="\${escapeHtml(x.card)}" onclick="copyCard(this)">复制</button>
          <button class="btn danger" data-card="\${escapeHtml(x.card)}" onclick="deleteCard(this.getAttribute('data-card'))">删除</button>
        </div>
      </td>
    </tr>
  \`).join('');

  if(append) tb.innerHTML += html;
  else tb.innerHTML = html;
  
  const pag = document.getElementById('pagination');
  pag.style.display = nextCursor ? 'flex' : 'none';
}

function copyCard(btn){
  const card = btn && btn.getAttribute('data-card');
  if(!card) return;
  navigator.clipboard.writeText(card).then(()=>toast('已复制')).catch(()=>toast('复制失败'));
}

async function deleteCard(card){
  if(!card) return;
  if(!confirm('确认删除该卡密？此操作不可恢复。')) return;
  const res = await api('delete_card', \`&card=\${encodeURIComponent(card)}\`);
  if(res && res.status === 'ok'){ 
     toast('已删除'); 
     allCards = allCards.filter(c => c.card !== card);
     render();
  } else toast('删除失败');
}

// 【新增】清空所有卡密
async function deleteAllCards() {
    if(!confirm('【高危操作】确认要删除数据库中“所有”未使用的卡密吗？')) return;
    if(!confirm('再次确认：删除后无法恢复，确定要清空吗？')) return;
    
    toast('正在清理中...');
    const res = await api('delete_all_cards');
    if(res && res.status === 'ok') {
        toast(\`操作成功，已删除 \${res.count} 张卡密\`);
        loadCards(); // 重新加载列表
    } else {
        toast('操作失败: ' + (res ? res.msg : '未知错误'));
    }
}

async function loadCards(cursor){
  if(!cursor) {
      allCards = [];
      document.getElementById('cardsBody').innerHTML = '<tr><td colspan="4" style="color:rgba(255,255,255,.6)">加载中...</td></tr>';
  }
  
  const cursorParam = cursor ? \`&cursor=\${encodeURIComponent(cursor)}\` : '';
  const res = await api('list_cards', cursorParam);
  
  if(!res || res.status !== 'ok'){ toast('加载失败：可能卡密过多'); return; }
  
  if(cursor) {
      allCards = res.cards || []; 
      render(true); 
  } else {
      allCards = res.cards || [];
      render(false);
  }
  
  nextCursor = res.list_complete ? null : res.cursor;
  const pag = document.getElementById('pagination');
  pag.style.display = nextCursor ? 'flex' : 'none';
}

function loadNextPage(){
    if(nextCursor) loadCards(nextCursor);
}

loadCards();
</script>
    `;

    return new Response(page('卡密管理', inner, { brandTitle: '卡密管理', brandSubtitle: 'Card Manager', logoHTML: ICON_ADMIN, extraScript }), {
        headers: { "Content-Type": "text/html;charset=utf-8" },
    });
}

// VLESS 核心 (保持不变)
async function handleVlsRequest(request, customProxyIP, env, adminUUID) {
    const wssPair = new WebSocketPair();
    const [clientSock, serverSock] = Object.values(wssPair);
    serverSock.accept();
    let remoteConnWrapper = { socket: null };
    let isDnsQuery = false;
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readable = makeReadableStr(serverSock, earlyDataHeader);
    let isAuthChecked = false;
    readable.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDnsQuery) return await forwardataudp(chunk, serverSock, null);
            if (remoteConnWrapper.socket) {
                const writer = remoteConnWrapper.socket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const { hasError, message, addressType, port, hostname, rawIndex, version, isUDP, requestUUID } = parseVLsPacketHeader(chunk, null);
            if (hasError) throw new Error(message);
            if (!isAuthChecked) {
                if (requestUUID !== adminUUID) {
                    const authResult = await checkUserAuth(requestUUID, env);
                    if (!authResult.valid) { closeSocketQuietly(serverSock); throw new Error(`Auth failed: ${authResult.reason}`); }
                }
                isAuthChecked = true;
            }
            if (isUDP) { if (port === 53) isDnsQuery = true; else throw new Error('UDP not supported'); }
            const respHeader = new Uint8Array([version[0], 0]);
            const rawData = chunk.slice(rawIndex);
            if (isDnsQuery) return forwardataudp(rawData, serverSock, respHeader);
            await forwardataTCP(hostname, port, rawData, serverSock, respHeader, remoteConnWrapper, customProxyIP, proxyIP);
        },
    })).catch((err) => { closeSocketQuietly(serverSock); if(remoteConnWrapper.socket) closeSocketQuietly(remoteConnWrapper.socket); });
    return new Response(null, { status: 101, webSocket: clientSock });
}

// 辅助函数 (保持不变)
function closeSocketQuietly(socket) { try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close(); } catch (error) {} }
function base64ToArray(b64Str) { if (!b64Str) return { error: null }; try { const binaryString = atob(b64Str.replace(/-/g, '+').replace(/_/g, '/')); const bytes = new Uint8Array(binaryString.length); for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i); return { earlyData: bytes.buffer, error: null }; } catch (error) { return { error }; } }
function parsePryAddress(serverStr) { if (!serverStr) return null; serverStr = serverStr.trim(); if (serverStr.startsWith('socks://') || serverStr.startsWith('socks5://')) { const urlStr = serverStr.replace(/^socks:\/\//, 'socks5://'); try { const url = new URL(urlStr); return { type: 'socks5', host: url.hostname, port: parseInt(url.port) || 1080, username: url.username ? decodeURIComponent(url.username) : '', password: url.password ? decodeURIComponent(url.password) : '' }; } catch (e) { return null; } } if (serverStr.startsWith('http://') || serverStr.startsWith('https://')) { try { const url = new URL(serverStr); return { type: 'http', host: url.hostname, port: parseInt(url.port) || (serverStr.startsWith('https://') ? 443 : 80), username: url.username ? decodeURIComponent(url.username) : '', password: url.password ? decodeURIComponent(url.password) : '' }; } catch (e) { return null; } } if (serverStr.startsWith('[')) { const closeBracket = serverStr.indexOf(']'); if (closeBracket > 0) { const host = serverStr.substring(1, closeBracket); const rest = serverStr.substring(closeBracket + 1); if (rest.startsWith(':')) { const port = parseInt(rest.substring(1), 10); if (!isNaN(port) && port > 0 && port <= 65535) return { type: 'direct', host, port }; } return { type: 'direct', host, port: 443 }; } } const lastColonIndex = serverStr.lastIndexOf(':'); if (lastColonIndex > 0) { const host = serverStr.substring(0, lastColonIndex); const port = parseInt(serverStr.substring(lastColonIndex + 1), 10); if (!isNaN(port) && port > 0 && port <= 65535) return { type: 'direct', host, port }; } return { type: 'direct', host: serverStr, port: 443 }; }
function formatIdentifier(arr) { const hex = [...arr].map(b => b.toString(16).padStart(2, '0')).join(''); return `${hex.substring(0,8)}-${hex.substring(8,12)}-${hex.substring(12,16)}-${hex.substring(16,20)}-${hex.substring(20)}`; }
function parseVLsPacketHeader(chunk, token) { if (chunk.byteLength < 24) return { hasError: true, message: 'Invalid data' }; const version = new Uint8Array(chunk.slice(0, 1)); const requestUUID = formatIdentifier(new Uint8Array(chunk.slice(1, 17))); if (token && requestUUID !== token) return { hasError: true, message: 'Invalid uuid' }; const optLen = new Uint8Array(chunk.slice(17, 18))[0]; const cmd = new Uint8Array(chunk.slice(18 + optLen, 19 + optLen))[0]; let isUDP = false; if (cmd === 1) {} else if (cmd === 2) { isUDP = true; } else { return { hasError: true, message: 'Invalid command' }; } const portIdx = 19 + optLen; const port = new DataView(chunk.slice(portIdx, portIdx + 2)).getUint16(0); let addrIdx = portIdx + 2, addrLen = 0, addrValIdx = addrIdx + 1, hostname = ''; const addressType = new Uint8Array(chunk.slice(addrIdx, addrValIdx))[0]; switch (addressType) { case 1: addrLen = 4; hostname = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + addrLen)).join('.'); break; case 2: addrLen = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + 1))[0]; addrValIdx += 1; hostname = new TextDecoder().decode(chunk.slice(addrValIdx, addrValIdx + addrLen)); break; case 3: addrLen = 16; const ipv6 = []; const ipv6View = new DataView(chunk.slice(addrValIdx, addrValIdx + addrLen)); for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16)); hostname = ipv6.join(':'); break; default: return { hasError: true, message: `Invalid address type: ${addressType}` }; } if (!hostname) return { hasError: true, message: `Invalid address: ${addressType}` }; return { hasError: false, addressType, port, hostname, isUDP, rawIndex: addrValIdx + addrLen, version, requestUUID }; }
function makeReadableStr(socket, earlyDataHeader) { let cancelled = false; return new ReadableStream({ start(controller) { socket.addEventListener('message', (event) => { if (!cancelled) controller.enqueue(event.data); }); socket.addEventListener('close', () => { if (!cancelled) { closeSocketQuietly(socket); controller.close(); } }); socket.addEventListener('error', (err) => controller.error(err)); const { earlyData, error } = base64ToArray(earlyDataHeader); if (error) controller.error(error); else if (earlyData) controller.enqueue(earlyData); }, cancel() { cancelled = true; closeSocketQuietly(socket); } }); }
async function connectStreams(remoteSocket, webSocket, headerData, retryFunc) { let header = headerData, hasData = false; await remoteSocket.readable.pipeTo( new WritableStream({ async write(chunk, controller) { hasData = true; if (webSocket.readyState !== WebSocket.OPEN) controller.error('ws.readyState is not open'); if (header) { const response = new Uint8Array(header.length + chunk.byteLength); response.set(header, 0); response.set(chunk, header.length); webSocket.send(response.buffer); header = null; } else { webSocket.send(chunk); } }, abort() {}, }) ).catch((err) => { closeSocketQuietly(webSocket); }); if (!hasData && retryFunc) { await retryFunc(); } }
async function forwardataTCP(host, portNum, rawData, ws, respHeader, remoteConnWrapper, customProxyIP, defaultProxyIP) { async function connectDirect(address, port, data) { const remoteSock = connect({ hostname: address, port: port }); const writer = remoteSock.writable.getWriter(); await writer.write(data); writer.releaseLock(); return remoteSock; } let proxyConfig = null; let shouldUseProxy = false; const effectiveProxyIP = customProxyIP || defaultProxyIP; if (effectiveProxyIP) { proxyConfig = parsePryAddress(effectiveProxyIP); if (proxyConfig && (['socks5', 'http', 'https'].includes(proxyConfig.type))) { shouldUseProxy = true; } else if (!proxyConfig) { proxyConfig = { type: 'direct', host: effectiveProxyIP, port: 443 }; } } async function connecttoPry() { let newSocket; if (proxyConfig.type === 'socks5') { newSocket = await connect2Socks5(proxyConfig, host, portNum, rawData); } else if (proxyConfig.type === 'http' || proxyConfig.type === 'https') { newSocket = await connect2Http(proxyConfig, host, portNum, rawData); } else { newSocket = await connectDirect(proxyConfig.host, proxyConfig.port, rawData); } remoteConnWrapper.socket = newSocket; newSocket.closed.catch(() => {}).finally(() => closeSocketQuietly(ws)); connectStreams(newSocket, ws, respHeader, null); } if (shouldUseProxy) { try { await connecttoPry(); } catch (err) { throw err; } } else { try { const initialSocket = await connectDirect(host, portNum, rawData); remoteConnWrapper.socket = initialSocket; connectStreams(initialSocket, ws, respHeader, connecttoPry); } catch (err) { await connecttoPry(); } } }
async function forwardataudp(udpChunk, webSocket, respHeader) { try { const tcpSocket = connect({ hostname: '8.8.4.4', port: 53 }); let vlessHeader = respHeader; const writer = tcpSocket.writable.getWriter(); await writer.write(udpChunk); writer.releaseLock(); await tcpSocket.readable.pipeTo(new WritableStream({ async write(chunk) { if (webSocket.readyState === WebSocket.OPEN) { if (vlessHeader) { const response = new Uint8Array(vlessHeader.length + chunk.byteLength); response.set(vlessHeader, 0); response.set(chunk, vlessHeader.length); webSocket.send(response.buffer); vlessHeader = null; } else { webSocket.send(chunk); } } }, })); } catch (error) {} }
async function connect2Socks5(proxyConfig, targetHost, targetPort, initialData) { const { host, port, username, password } = proxyConfig; const socket = connect({ hostname: host, port: port }); const writer = socket.writable.getWriter(); const reader = socket.readable.getReader(); try { const authMethods = username && password ? new Uint8Array([0x05, 0x02, 0x00, 0x02]) : new Uint8Array([0x05, 0x01, 0x00]); await writer.write(authMethods); const methodResponse = await reader.read(); if (methodResponse.done || methodResponse.value.byteLength < 2) throw new Error('S5 method selection failed'); const selectedMethod = new Uint8Array(methodResponse.value)[1]; if (selectedMethod === 0x02) { const userBytes = new TextEncoder().encode(username); const passBytes = new TextEncoder().encode(password); const authPacket = new Uint8Array(3 + userBytes.length + passBytes.length); authPacket[0] = 0x01; authPacket[1] = userBytes.length; authPacket.set(userBytes, 2); authPacket[2 + userBytes.length] = passBytes.length; authPacket.set(passBytes, 3 + userBytes.length); await writer.write(authPacket); const authResponse = await reader.read(); if (authResponse.done || new Uint8Array(authResponse.value)[1] !== 0x00) throw new Error('S5 authentication failed'); } const hostBytes = new TextEncoder().encode(targetHost); const connectPacket = new Uint8Array(7 + hostBytes.length); connectPacket[0] = 0x05; connectPacket[1] = 0x01; connectPacket[2] = 0x00; connectPacket[3] = 0x03; connectPacket[4] = hostBytes.length; connectPacket.set(hostBytes, 5); new DataView(connectPacket.buffer).setUint16(5 + hostBytes.length, targetPort, false); await writer.write(connectPacket); const connectResponse = await reader.read(); if (connectResponse.done || new Uint8Array(connectResponse.value)[1] !== 0x00) throw new Error('S5 connection failed'); await writer.write(initialData); writer.releaseLock(); reader.releaseLock(); return socket; } catch (error) { writer.releaseLock(); reader.releaseLock(); throw error; } }
async function connect2Http(proxyConfig, targetHost, targetPort, initialData) { const { host, port, username, password } = proxyConfig; const socket = connect({ hostname: host, port: port }); const writer = socket.writable.getWriter(); const reader = socket.readable.getReader(); try { let connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`; if (username && password) connectRequest += `Proxy-Authorization: Basic ${btoa(`${username}:${password}`)}\r\n`; connectRequest += `User-Agent: Mozilla/5.0\r\nConnection: keep-alive\r\n\r\n`; await writer.write(new TextEncoder().encode(connectRequest)); let responseBuffer = new Uint8Array(0); let headerEndIndex = -1; while (headerEndIndex === -1) { const { done, value } = await reader.read(); if (done) throw new Error('Connection closed'); const newBuffer = new Uint8Array(responseBuffer.length + value.length); newBuffer.set(responseBuffer); newBuffer.set(value, responseBuffer.length); responseBuffer = newBuffer; for (let i = 0; i < responseBuffer.length - 3; i++) { if (responseBuffer[i] === 0x0d && responseBuffer[i + 1] === 0x0a && responseBuffer[i + 2] === 0x0d && responseBuffer[i + 3] === 0x0a) { headerEndIndex = i + 4; break; } } } const headerText = new TextDecoder().decode(responseBuffer.slice(0, headerEndIndex)); if (!headerText.includes(' 200 ')) throw new Error('HTTP Proxy connection failed'); await writer.write(initialData); writer.releaseLock(); reader.releaseLock(); return socket; } catch (error) { try{writer.releaseLock()}catch(e){}; try{reader.releaseLock()}catch(e){}; try{socket.close()}catch(e){}; throw error; } }
