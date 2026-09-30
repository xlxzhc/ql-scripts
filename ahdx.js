/**
 * 安徽电信 小程序签到（仅支持青龙面板）
 *
 * cron: 1 10,18 * * *
 *
 * ─────────────────────────── 环境变量 ───────────────────────────
 *
 * 【必填】AnHuiTelecom —— 账号列表，多账号用换行或 & 分隔，单账号格式：备注#凭证
 *   凭证只支持 2 种写法（自动识别：含 = 或 ; 视为 Cookie，否则视为取码服务的账号 ref）：
 *
 *   ① 取码服务模式（推荐，可无人值守）：填取码服务里的账号 ref
 *       AnHuiTelecom="199****8397#1"          // ref 为 /accounts 里的 id / uin / openid
 *       AnHuiTelecom="199****8397#yyb@1"      // 也可用 yyb@ 前缀显式声明
 *       ⚠️ 单次运行会申请 2 个 code（1 个登录 + 1 个查余额），微信 code 一次性
 *       ⚠️ 所用微信号必须先关注「安徽电信」公众号，否则 login 返回 402
 *
 *   ② Cookie 模式（须含 qdyl=xxx，仅 1 小时内有效，一般只用于临时调试）
 *       AnHuiTelecom="199****8397#sajssdk_2015_cross_new_user=1; qdyl=9f8724…; openid-uuid=…"
 *
 * 【取码服务模式必填】wx_server_url —— 获取 wxcode 的服务地址
 *   例：wx_server_url="http://127.0.0.1:8080"
 *
 * 【可选】wx_server_appid —— 目标 appid，默认已内置安徽电信公众号「wx8ebdb28d971c6097」
 *   （注意：login 校验的是公众号 code，不能用小程序的 wx1c9e55df51ce792b）
 * ────────────────────────────────────────────────────────────────
 */

const axios = require('axios');

const $ = new Env('安徽电信');

const ckName = 'AnHuiTelecom';
const BASE_HOST = 'wx.ah.189.cn';
const BASE = `https://${BASE_HOST}`;

/**
 * 目标 appid —— 关键坑点！
 * qdylNew/login 实际校验的是「安徽电信公众号」的网页授权 code，不是小程序 code。
 * 实测对比（2026-09-30）：
 *   用小程序 appid wx1c9e55df51ce792b 取码 → login 返回 401「缺少必要参数,请从活动页进入」
 *   用公众号 appid wx8ebdb28d971c6097 取码 → login 返回 402「用户未关注安徽电信公众号」，说明 code 被正确识别
 * 依据：活动页 index.html 构造的授权地址为
 *   open.weixin.qq.com/connect/oauth2/authorize?appid=wx8ebdb28d971c6097&...&scope=snsapi_base
 * 所以取码必须用公众号 appid。
 */
const DEFAULT_APPID = 'wx8ebdb28d971c6097';
const DEFAULT_WX_SERVER_URL = 'http://127.0.0.1:8080';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364 miniProgram/wx1c9e55df51ce792b';
const REFER_SIGN = `${BASE}/wxws/zbimg/xcx/qdyl0427/index.html?sourceStr=xcx_grzx`;
const REFER_GOLD = `${BASE}/wxws/zbimg/xcx/chargeNew/index.html?sourceStr=xcx_grzx`;
const REFER_LOGIN = (code) =>
    `${BASE}/wxws/zbimg/xcx/qdyl0427/index.html?sourceStr=xcx_grzx&code=${code}&state=123`;

/* =============================== 通用工具 =============================== */

/** 统一 axios 文本请求（不自动解析 JSON、不抛 HTTP 错误） */
async function http(options) {
    return axios({
        timeout: 20000,
        validateStatus: () => true,
        maxRedirects: 0,
        responseType: 'text',
        transformResponse: [(d) => d],
        ...options,
    });
}

function tryJson(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/** 接口返回的 code 可能是数字也可能是字符串，统一成数字比较 */
function isOk(data, ...expects) {
    return expects.includes(Number(data && data.code));
}

/** 把 Set-Cookie 合并进现有 Cookie 串（同名覆盖） */
function mergeCookie(base, setCookieList) {
    const map = new Map();
    const put = (str) => {
        const first = String(str).split(';')[0];
        const i = first.indexOf('=');
        if (i > 0) map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    };
    if (base) String(base).split(';').forEach((p) => p.trim() && put(p));
    (setCookieList || []).forEach(put);
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 从 Cookie 串中读取某个键 */
function readCookie(cookie, key) {
    const m = String(cookie || '').match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
    return m ? m[1] : '';
}

/* ========================= 安徽电信接口封装 ========================= */

function adHeaders(cookie, referer, isForm) {
    const h = {
        'Connection': 'keep-alive',
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': BASE,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': referer || REFER_SIGN,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    if (isForm) h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    if (cookie) h['Cookie'] = cookie;
    return h;
}

async function adRequest(method, path, { cookie, referer, form } = {}) {
    const resp = await http({
        method,
        url: `${BASE}${path}`,
        headers: adHeaders(cookie, referer, form !== undefined),
        data: form === undefined ? undefined : form,
    });
    return {
        status: resp.status,
        setCookie: resp.headers['set-cookie'] || [],
        data: tryJson(resp.data),
        text: resp.data,
    };
}

/* ===================== code 来源：取码服务（/wxapp/getCode） ===================== */

/** 在任意嵌套结构里找出形似小程序 code 的字符串（优先常见字段名） */
function pickCode(obj, depth = 0) {
    if (depth > 5 || obj === null || obj === undefined) return '';
    if (typeof obj === 'string') {
        const s = obj.trim();
        return /^[A-Za-z0-9_-]{20,40}$/.test(s) ? s : '';
    }
    if (typeof obj !== 'object') return '';
    for (const k of ['code', 'js_code', 'jsCode', 'wxcode', 'wx_code']) {
        if (obj[k] !== undefined) {
            const v = pickCode(obj[k], depth + 1);
            if (v) return v;
        }
    }
    for (const k of Object.keys(obj)) {
        const v = pickCode(obj[k], depth + 1);
        if (v) return v;
    }
    return '';
}

/**
 * 调用取码服务换取小程序 code
 * POST {wx_server_url}/wxapp/getCode   { ref, app_id }
 * @returns {Promise<{code:string, err?:string}>}
 */
async function codeFromYYB(ref) {
    const api = (process.env.wx_server_url || DEFAULT_WX_SERVER_URL).replace(/\/+$/, '');
    const appid = process.env.wx_server_appid || DEFAULT_APPID;
    let resp;
    try {
        resp = await http({
            method: 'POST',
            url: `${api}/wxapp/getCode`,
            headers: { 'Content-Type': 'application/json' },
            data: { ref: String(ref), app_id: appid },
        });
    } catch (e) {
        return { code: '', err: `无法连接取码服务 ${api}（${e.message}）` };
    }
    const d = tryJson(resp.data);
    if (!d) {
        const tip = resp.status !== 200 ? `HTTP ${resp.status}` : '非 JSON 响应';
        return { code: '', err: `取码服务${tip}：${String(resp.data).slice(0, 120)}` };
    }
    if (Number(d.code) !== 0) return { code: '', err: `取码服务业务错误：${d.msg || '未知'}` };
    const code = pickCode(d.data && d.data.result);
    if (!code) {
        return { code: '', err: `未在取码服务返回中解析到 code：${JSON.stringify(d.data).slice(0, 200)}` };
    }
    return { code };
}

/* =============================== 账号任务 =============================== */

class Task {
    constructor(raw, index) {
        this.index = index;
        const i = raw.indexOf('#');
        if (i > -1) {
            this.name = raw.slice(0, i).trim() || `账号${index}`;
            this.credential = raw.slice(i + 1).trim();
        } else {
            this.name = `账号${index}`;
            this.credential = raw.trim();
        }

        this.cookie = '';
        this.code = '';
        this.message = '';

        // 只两种模式：含 = 或 ; 视为 Cookie，否则视为取码服务的账号 ref
        const cred = this.credential;
        if (cred.includes('=') || cred.includes(';')) {
            this.type = 'cookie';
            this.cookie = cred;
        } else {
            this.type = 'yyb';
            this.ref = cred.replace(/^yyb[@:]/i, '').trim();
        }
    }

    log(...args) {
        $.log(`[${this.name}] ${args.join(' ')}`);
    }

    /** 准备登录凭证：拿到 code 并换取 Cookie（cookie 模式直接返回） */
    async prepare() {
        if (this.type === 'cookie') {
            if (!readCookie(this.cookie, 'qdyl')) {
                this.log('⚠️ Cookie 中未发现 qdyl 字段，签到大概率失败');
            }
            return true;
        }

        // 1) 向取码服务换取 code
        this.log(`🔎 向取码服务请求 wxcode（ref=${this.ref}）…`);
        const r = await codeFromYYB(this.ref);
        if (!r.code) {
            this.message = `取 code 失败：${r.err}`;
            this.log(`❌ 取 code 失败：${r.err}`);
            return false;
        }
        this.code = r.code;
        this.log(`📦 已获取 wxcode：${this.code.slice(0, 8)}****`);

        // 2) code 换 Cookie
        this.log('🔑 使用 wxcode 登录换取 Cookie …');
        const resp = await adRequest('POST', '/hd/ahwxboot/qdylNew/login', {
            form: `code=${this.code}&source=xcx_grzx`,
            referer: REFER_LOGIN(this.code),
        });
        const d = resp.data || {};
        if (isOk(d, 200)) {
            this.cookie = mergeCookie(this.cookie, resp.setCookie);
            const phone = (d.data && d.data.bdPhone) || '';
            if (phone && /^账号/.test(this.name)) this.name = phone;
            this.log(`✅ 登录成功${phone ? `，绑定号码 ${phone}` : ''}`);
            const list = (d.data && d.data.list) || [];
            if (list.length) {
                const days = list.map((x) => x.signDay).filter(Boolean);
                this.log(`📅 本月已签到 ${days.length} 天：${days.join('、')}`);
            }
            return true;
        }
        const msg = (d && d.msg) || resp.text;
        const code = Number(d && d.code);
        this.log(`❌ 登录失败：${msg}`);
        if (code === 401) {
            this.log('   ⇒ code 已失效（约 5 分钟），或 appid 用的不是公众号 wx8ebdb28d971c6097');
        } else if (code === 402) {
            this.log('   ⇒ 该微信号尚未关注「安徽电信」公众号，请先用它关注后重试');
        } else if (code === 400) {
            this.log('   ⇒ 登录过于频繁（请勿重复点击），稍后重试即可');
        }
        this.message = `登录失败：${msg}`;
        return false;
    }

    /** 每日签到 */
    async sign() {
        this.log('📝 开始签到 …');
        const resp = await adRequest('POST', '/hd/ahwxboot/qdylNew/qd', {
            cookie: this.cookie,
            referer: REFER_SIGN,
        });
        this.cookie = mergeCookie(this.cookie, resp.setCookie);
        const d = resp.data || {};

        if (isOk(d, 200)) {
            this.log(`✅ 签到成功，获得星钻 ${d.data}`);
            this.message = `签到成功 +${d.data}星钻`;
            return true;
        }

        const msg = (d && d.msg) || (typeof d === 'string' ? d : JSON.stringify(d));

        // 「今日已签到」是正常状态，不算失败
        if (/已签到|已领取|重复/.test(msg)) {
            this.log(`ℹ️ ${msg}，今日任务已完成`);
            this.message = '今日已签到';
            return true;
        }

        this.log(`❌ 签到失败：${msg}`);
        this.message = `签到失败：${msg}`;
        if (Number(d && d.code) === 99 || /过期|未登录|重新进入/.test(msg)) {
            this.log('⚠️ 登录态已失效（Cookie 约 1 小时过期）');
        }
        return false;
    }

    /** 查询星钻 / 权益金（myGoldNew 必须携带一个新鲜 code 作查询参数，与 login 用的不能是同一个） */
    async queryGold() {
        try {
            let code = '';
            if (this.type === 'yyb') {
                const r = await codeFromYYB(this.ref);
                code = r.code || '';
                if (!code) this.log(`⚠️ 查余额取 code 失败：${r.err}`);
            }
            const path = code
                ? `/hd/ahwxboot/exchange/myGoldNew?code=${code}&source=xcx_grzx`
                : '/hd/ahwxboot/exchange/myGoldNew?source=xcx_grzx';
            const referer = code
                ? `${BASE}/wxws/zbimg/xcx/chargeNew/index.html?sourceStr=xcx_grzx&code=${code}&state=123`
                : REFER_GOLD;
            const resp = await adRequest('GET', path, { cookie: this.cookie, referer });
            this.cookie = mergeCookie(this.cookie, resp.setCookie);
            const d = resp.data || {};
            if (isOk(d, 0) && d.data) {
                const { xzNum = 0, goldNum = 0, xzExpireNum = 0 } = d.data;
                this.log(`💰 当前星钻：${xzNum}（即将过期 ${xzExpireNum}）｜权益金：${goldNum}`);
                this.message += ` ｜ 余额 ${xzNum} 星钻`;
                return;
            }
            this.log(`⚠️ 余额查询异常：${(d && d.msg) || resp.text}`);
        } catch (e) {
            this.log(`⚠️ 余额查询异常：${e.message}`);
        }
    }

    async run() {
        try {
            if (!(await this.prepare())) return;
            const ok = await this.sign();
            if (ok) await this.queryGold();
        } catch (e) {
            this.log(`❌ 任务异常：${e.message}`);
            this.message = `任务异常：${e.message}`;
        }
    }
}

/* =============================== 主流程 =============================== */

function parseAccounts() {
    const raw = process.env[ckName] || '';
    if (!raw.trim()) return [];
    let parts = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    // 只写了一行、且用 & 分隔多账号时才按 & 拆分（避免误伤 Cookie 里的字符）
    if (parts.length === 1 && parts[0].includes('&')) {
        parts = parts[0].split('&').map((s) => s.trim()).filter(Boolean);
    }
    return parts.map((s, i) => new Task(s, i + 1));
}

/**
 * 加载通知模块：优先 CJS require，其次 ESM 动态 import
 * 注：本仓库的 sendNotify.js 为 ESM 写法（import/export），
 *     Node 默认按 CJS 解析会报 "Unexpected reserved word"，
 *     需改成 CJS（module.exports = { sendNotify }）才能被 require 到。
 */
async function loadNotify() {
    const errors = [];
    for (const p of ['./sendNotify', '../sendNotify']) {
        const esmPath = `${p}.js`;
        try {
            const m = require(p);
            const fn = m.sendNotify || (m.default && (m.default.sendNotify || m.default)) || m;
            if (typeof fn === 'function') return fn;
        } catch (e) {
            errors.push(`${p} → ${e.message.split('\n')[0]}`);
        }
        try {
            const m = await import(esmPath);
            const fn = m.sendNotify || (m.default && (m.default.sendNotify || m.default)) || m.default;
            if (typeof fn === 'function') return fn;
        } catch (e) {
            errors.push(`${esmPath} → ${e.message.split('\n')[0]}`);
        }
    }
    console.log('⚠️ 通知模块加载失败，跳过通知。原因：');
    errors.slice(0, 2).forEach((x) => console.log(`   - ${x}`));
    return null;
}

async function sendMsg(title, content) {
    try {
        const notify = await loadNotify();
        if (notify) {
            await notify(title, content);
            console.log('✅ 通知已发送');
        }
    } catch (e) {
        console.log(`⚠️ 通知发送失败：${e.message}`);
    }
}

!(async () => {
    const tasks = parseAccounts();
    if (tasks.length === 0) {
        $.log(`❌ 未找到环境变量【${ckName}】`);
        $.log('   格式：备注#取码服务账号ref  或  备注#完整Cookie，多账号用换行/& 分隔');
        return;
    }
    $.log(`✅ 共读取到 ${tasks.length} 个账号`);

    for (const task of tasks) {
        await task.run();
        await $.wait(1000);
    }

    const notice = tasks.map((t) => `${t.name}：${t.message || '无结果'}`).join('\n');
    await sendMsg($.name, notice);
})().catch((e) => $.log(`❌ 脚本异常：${e.message}`)).finally(() => $.done());

/* =============================== 基础类 =============================== */

function Env(name) {
    return new (class {
        constructor(name) {
            this.name = name;
            this.logs = [];
            this.startTime = Date.now();
            console.log(`🔔 ${this.name} 开始`);
        }
        log(...args) {
            const msg = args.join('\n');
            this.logs.push(msg);
            console.log(msg);
        }
        wait(ms) {
            return new Promise((r) => setTimeout(r, ms));
        }
        done() {
            const cost = ((Date.now() - this.startTime) / 1000).toFixed(2);
            console.log(`🔔 ${this.name} 结束，耗时 ${cost} 秒`);
            process.exit(0);
        }
    })(name);
}
