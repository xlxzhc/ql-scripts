/**
 * 项目: 全棉时代 - 每日签到 + 种棉花(自动种树 + 浇水)
 * 入口: 微信小程序「全棉时代」-> 我的·每日签到 / 首页·种棉花
 * 说明: 通过 wx_server(smallcat) 用 openid 换取 wx.login code 自动登录(nmp),
 *       完成每日签到(得积分); 若为已注册会员, 再对自己的树执行种棉花浇水。
 *       账号尚未种树时会自动种下一棵(选定成长目标奖品), 之后每日自动浇水。
 *       每次运行现取 code、现登录, 不再依赖手动粘贴的 code#token(易过期)。
 *
 * 环境变量:
 *   qmzmh         必需。wx_server 中的 openid, 多账号用换行或 & 分割, 可选 #备注
 *   wx_server_url 可选。取码服务地址, 默认 http://192.168.31.196:8787
 *                 兼容 smallcat 风格(POST /wx/code, 需 wx_auth)
 *                 与本机「应用宝 Go 控制台」(POST /wx/code, 无需 auth)
 *   wx_auth       可选。取码服务的 auth 令牌, smallcat 需要; 服务端不需要认证时留空即可
 *   qmzmh_prize_id 可选。种树成长目标奖品 id, 默认 1046(加厚棉柔巾 6片/包*1包)
 *                  可选值来自 GET https://sg01.purcotton.com/api/prize/home
 *
 * new Env('全棉时代签到')
 * cron: 30 8 * * *
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NAME = '全棉时代签到';
const ENV_NAME = 'qmzmh';

// 配置参数(均来自小程序反编译源码, 非机密)
const MINI_APP_ID = 'wxdfcaa44b1aa891a7';
const NMP = 'https://nmp.pureh2b.com';              // config.js SERVER (生产)
const SG01 = 'https://sg01.purcotton.com';          // config.js 种棉花 H5 与其 /api
const PRIZE_ID_DEFAULT = '1046';                    // 种树默认成长目标: 加厚棉柔巾 6片/包*1包
const SG01_SIGN_SALT = 'z0hQTvC21f8SXlLbL9Hv';      // H5 formatMd5 的固定盐

const WX_SERVER_URL = String(process.env.wx_server_url || 'http://192.168.31.196:8787').replace(/\/+$/, '');
const WX_AUTH = process.env.wx_auth || '';
const PRIZE_ID = String(process.env.qmzmh_prize_id || PRIZE_ID_DEFAULT).trim();

let TOKEN_CACHE_PATH = '';
try { TOKEN_CACHE_PATH = path.join(__dirname, 'quanmianshidai_token_cache.json'); } catch (e) { TOKEN_CACHE_PATH = ''; }

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 11; ONEPLUS A6000 Build/RKQ1.201217.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20231201 MMWEBID/2930 MicroMessenger/8.0.45.2521(0x28002D3D) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 miniProgram/wxdfcaa44b1aa891a7';

// ============================ 通用小工具 ============================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function md5Upper(str) {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

function mask(value) {
    if (!value) return '';
    const v = String(value);
    return v.length <= 12 ? v.slice(0, 2) + '***' : `${v.slice(0, 4)}***${v.slice(-4)}`;
}

function genGuid() {
    return crypto.randomUUID();
}

// 北京时间(UTC+8) 的 YYYY-MM-DD
function beijingDate() {
    return new Date(Date.now() + new Date().getTimezoneOffset() * 60 * 1000 + 8 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
}

function get_env_variable(varName) {
    const value = process.env[varName];
    if (value === undefined || value === null || value === '') {
        console.log(`环境变量${varName}未设置，请检查。`);
        return null;
    }
    const accounts = value.replace(/&/g, '\n').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    console.log(`-----------本次账号运行数量：${accounts.length}-----------`);
    console.log('------全棉时代签到+种棉花-----2.0------');
    return accounts;
}

// 统一请求封装: 网络异常返回 null, HTTP 非 2xx 由调用方自行判断 code 字段
async function req(config) {
    try {
        return await axios(Object.assign({ timeout: 30000, validateStatus: () => true }, config));
    } catch (e) {
        console.log(`请求失败: ${e.message}`);
        return null;
    }
}

// ============================ sg01 请求头与签名 ============================

function create_headers(code, token) {
    return {
        accept: 'application/json, text/plain, */*',
        'app-id': 'wxdfcaa44b1aa891a7',
        'user-agent': USER_AGENT,
        'content-type': 'application/json;charset=UTF-8',
        origin: 'https://sg01.purcotton.com',
        'x-requested-with': 'com.tencent.mm',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        cookie: 'sajssdk_2015_cross_new_user=1',
        code: code,
        token: token,
    };
}

// sg01 的 H5 只对 3 个接口(task/complete-task、task/complete-manual-task、answer/complete)
// 的请求体做了参数签名(h5/js 里的 formatMd5)，不带签名时服务端返回 {"code":400,"msg":"参数格式错误"}。
// 算法: 追加 timestamp(毫秒) → 丢掉值为 null/"" 的项 → 按 key 排序拼成 query 串 → md5(串+固定盐).upper()
function sg01_sign(params) {
    const payload = Object.assign({}, params);
    payload.timestamp = Date.now();
    const kept = Object.keys(payload)
        .filter((k) => payload[k] !== null && payload[k] !== undefined && payload[k] !== '')
        .sort()
        .map((k) => `${encodeURIComponent(String(k))}=${encodeURIComponent(String(payload[k]))}`);
    const query = kept.join('&');
    payload.sign = md5Upper(query + SG01_SIGN_SALT);
    return payload;
}

// ============================ smallcat + nmp 登录 ============================

function read_token_cache() {
    try {
        if (TOKEN_CACHE_PATH && fs.existsSync(TOKEN_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8')) || {};
        }
    } catch (e) { /* 忽略缓存读取异常 */ }
    return {};
}

function write_token_cache(cache) {
    try {
        if (!TOKEN_CACHE_PATH) return;
        fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
        console.log(`⚠️ 写入token缓存失败: ${e.message}`);
    }
}

// 从取码服务返回体里挑出微信 code。
// 各家服务封装不一: smallcat 常在顶层给 {code:"<wxcode>", status:...},
// 「应用宝 Go 控制台」返回 {code:0, data:{code:"<wxcode>", result:{code:"<wxcode>"}}}。
// 因此不能只看顶层 code —— 顶层可能是数字业务码(0/200), 需按字段名 + 形态筛选。
function looksLikeWxCode(v) {
    return typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v) && !/^\d+$/.test(v);
}

function pickWxCode(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const hit = [];
    const queue = [obj];
    while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object') continue;
        for (const [k, v] of Object.entries(cur)) {
            if (v && typeof v === 'object') { queue.push(v); continue; }
            if (typeof v !== 'string') continue;
            if (/^(code|js_code|jsCode|wxcode|wx_code)$/i.test(k) && looksLikeWxCode(v)) hit.push(v);
        }
    }
    return hit[0] || '';
}

async function get_wx_code(openid) {
    // smallcat 需要鉴权头; 本机取码服务无鉴权, wx_auth 留空即可
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (WX_AUTH) headers.auth = WX_AUTH;
    const body = JSON.stringify({ appid: MINI_APP_ID, openid });
    let lastMsg = '';
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) {
            // smallcat 偶发 "获取失败"(会话抖动), 刷新会话后间隔重试
            await req({ method: 'post', url: `${WX_SERVER_URL}/wx/refresh`, headers, data: body });
            await sleep(3000);
        }
        const resp = await req({ method: 'post', url: `${WX_SERVER_URL}/wx/code`, headers, data: body });
        if (!resp) { lastMsg = '请求 wx_server 失败'; continue; }
        const data = resp.data;
        if (data && typeof data === 'object' && data.status === false) {
            lastMsg = data.message || '获取失败';
            continue;
        }
        const code = pickWxCode(data);
        if (code) return code;
        lastMsg = `wx_server 未返回 code: ${JSON.stringify(data).slice(0, 120)}`;
    }
    throw new Error(`wx_server 获取 code 失败(已重试): ${lastMsg}`);
}

// 复刻 request.js: 每个请求头带 code=GUID、tag=v3.0, 登录后再带 token
function nmp_headers(guid, token) {
    const h = { 'Content-Type': 'application/json;charset=UTF-8', code: guid, tag: 'v3.0' };
    if (token) h.token = token;
    return h;
}

// wx.login code -> GET /api/wx/main/login。返回 {token, member, bind}
// member 为 null 或无 phone 表示尚未绑定手机号/注册, 无法签到
async function nmp_login(openid, guid) {
    const wxcode = await get_wx_code(openid);
    const resp = await req({
        method: 'get',
        url: `${NMP}/api/wx/main/login`,
        params: { code: wxcode },
        headers: nmp_headers(guid),
    });
    const body = (resp && resp.data) || {};
    const data = body && typeof body.data === 'object' && body.data ? body.data : null;
    const token = (data && data.token) || body.token;
    let member = data ? data.member : null;
    if (member === undefined || member === null) member = body.member || null;
    const bind = data ? data.bind : body.bind;
    return { token, member, bind };
}

// 现取 code、现登录, 复用缓存的设备 GUID。返回 {guid, token, member, bind}
async function get_account_session(openid, index) {
    const cache = read_token_cache();
    const entry = cache[openid] || {};
    const guid = entry.guid || genGuid();
    const { token, member, bind } = await nmp_login(openid, guid);
    const phone = member && typeof member === 'object' ? member.phone : null;
    cache[openid] = { guid, hasPhone: Boolean(phone), updatedAt: Math.floor(Date.now() / 1000) };
    write_token_cache(cache);
    const tag = phone ? '已绑定手机号会员' : `未绑定(bind=${bind})`;
    console.log(`账号 ${index} nmp登录: token=${mask(token)} ${tag}`);
    return { guid, token, member, bind };
}

// 每日签到: GET /api/member/signIn/point。响应体为裸数字 1=成功 0=今日已签到
async function member_sign_in(guid, token) {
    const resp = await req({
        method: 'get',
        url: `${NMP}/api/member/signIn/point`,
        headers: nmp_headers(guid, token),
    });
    if (!resp) return { ok: false, msg: '签到请求失败' };
    if (resp.status !== 200) return { ok: false, msg: `签到请求HTTP ${resp.status}` };
    let val = resp.data;
    if (typeof val === 'string') {
        const t = val.trim();
        try { val = JSON.parse(t); } catch (e) { val = t; }
    }
    if (val === 1 || val === '1') return { ok: true, msg: '签到成功' };
    if (val === 0 || val === '0') return { ok: true, msg: '今日已签到' };
    return { ok: false, msg: `签到失败(返回=${String(resp.data).slice(0, 80)})` };
}

// ============================ sg01 种棉花业务 ============================

async function login(code, token) { // 提取的号码
    const resp = await req({
        method: 'post',
        url: `${SG01}/api/login`,
        headers: create_headers(code, token),
        data: { invite_source: 'task', channel: '' },
    });
    const d = resp && resp.data;
    if (d && d.code === 200 && d.data) {
        return { phone: d.data.phone, userId: d.data.id };
    }
    if (d) console.log(`登录失败，错误代码: ${d.code}，错误信息: ${d.msg}`);
    return { phone: null, userId: null };
}

// 获取树木ID和阳光信息, 返回 [treeId, sunshine, totalSunshine]
async function hqid(code, token) {
    const resp = await req({ method: 'get', url: `${SG01}/api/index`, headers: create_headers(code, token) });
    const rd = resp && resp.data;
    if (!rd || rd.code !== 200) {
        if (rd) console.log(`请求失败，错误代码: ${rd.code}, 错误信息: ${rd.msg}`);
        return [null, null, null];
    }
    const payload = rd.data || {};
    let treeData = payload.tree;
    // 接口的 tree 字段有两种形态: 单棵树为 dict, 多棵/未种树为 list(空列表表示尚未种树)
    if (Array.isArray(treeData)) treeData = treeData.length ? treeData[0] : {};
    if (!treeData || typeof treeData !== 'object') treeData = {};
    let userData = payload.user;
    if (!userData || typeof userData !== 'object') userData = {};
    const treeId = treeData.id !== undefined ? treeData.id : null;
    const sunshine = userData.sunshine !== undefined ? userData.sunshine : 0;
    const totalSunshine = userData.total_sunshine !== undefined ? userData.total_sunshine : 0;
    return [treeId, sunshine, totalSunshine];
}

// GET /api/prize/home: 可选的成长目标(奖品)列表
async function prize_home(code, token) {
    const resp = await req({ method: 'get', url: `${SG01}/api/prize/home`, headers: create_headers(code, token) });
    const d = resp && resp.data;
    if (d && d.code === 200) {
        const list = (d.data || {}).list;
        return Array.isArray(list) ? list : [];
    }
    if (d) console.log(`获取目标奖品列表失败: code=${d.code} msg=${d.msg}`);
    return [];
}

// 种树: 选定成长目标后 POST /api/gain-tree {prize_id}
// 选苗(choiceSeed)只是前端下标, 无额外校验; 该动作一次性且不消耗水滴。
async function zhongshu(code, token) {
    const prizes = await prize_home(code, token);
    if (!prizes.length) return { ok: false, msg: '无可选成长目标(prize/home 为空), 未种树' };

    let chosen = prizes.find((p) => String(p.id) === PRIZE_ID);
    if (!chosen) {
        chosen = prizes[0];
        console.log(`目标 prize_id=${PRIZE_ID} 已不在列表中, 回退为首项`);
    }
    const title = chosen.title || chosen.name || '';

    const resp = await req({
        method: 'post',
        url: `${SG01}/api/gain-tree`,
        headers: create_headers(code, token),
        data: { prize_id: chosen.id },
    });
    const d = resp && resp.data;
    if (!d) return { ok: false, msg: '种树请求失败' };
    if (d.code === 200) return { ok: true, msg: `已种下(目标: ${title})` };
    const msg = d.msg || `code=${d.code}`;
    // 已有树时服务端会拒绝, 视为幂等成功
    if (['已', '存在', '重复'].some((k) => String(msg).includes(k))) return { ok: true, msg: `已有树(${msg})` };
    return { ok: false, msg: `种树失败: ${msg}` };
}

async function jscz(code, token) { // 浇水
    let [treeId] = await hqid(code, token);

    if (treeId === null) {
        // tree 为空列表 => 尚未种树。种树 = 选定成长目标 + gain-tree, 一次性动作,
        // 不消耗水滴; 种下后继续本次浇水。
        console.log('尚未种树, 正在自动种下...');
        const { ok, msg } = await zhongshu(code, token);
        console.log(`种树: ${msg}`);
        if (!ok) return false;
        [treeId] = await hqid(code, token);
        if (treeId === null) {
            console.log('种树后仍未取到树木ID, 跳过浇水');
            return false;
        }
    }

    while (true) { // 开始一个无限循环
        const resp = await req({
            method: 'post',
            url: `${SG01}/api/watering`,
            headers: create_headers(code, token),
            data: { tree_user_id: treeId, water_cnt: 1 },
        });
        const rd = resp && resp.data;
        if (!rd) break; // 请求异常时停止循环

        if (rd.code === 200) {
            const remaining = rd.data && rd.data.info ? rd.data.info.sy_water : undefined;
            console.log(`剩余水滴数: ${remaining}`);
            if (typeof remaining !== 'number') break;
            if (remaining < 30) { // 剩余水滴数小于30则停止
                console.log('水滴不足，停止浇水。');
                break;
            }
            console.log('执行浇水操作...');
            await sleep(randInt(1, 3) * 1000); // 暂停1到3秒
        } else if (rd.code === 400) {
            console.log(rd.msg || '未知错误');
            break;
        } else {
            console.log('未知的响应code:', rd.code);
            console.log('完整响应:', JSON.stringify(rd));
            break;
        }
    }
    return true;
}

async function cscscs(code, token) { // 刷新/领取日常
    const { userId } = await login(code, token);
    await req({
        method: 'post',
        url: `${SG01}/api/statistics/store`,
        headers: create_headers(code, token),
        data: { uid: userId, type: 301 },
    });
}

async function today_water(code, token) {
    const resp = await req({ method: 'post', url: `${SG01}/api/get-today-water`, headers: create_headers(code, token) });
    const rd = resp && resp.data;
    if (rd && rd.code === 200) {
        const d = rd.data || {};
        console.log(`今日获取水量: ${d.get_water}`);
        console.log(`明日可获取水量: ${d.tomorrow_get_water_num}`);
        console.log(`今日获取水量: ${d.get_water} 明日可获取水量: ${d.tomorrow_get_water_num}`);
    } else if (rd) {
        console.log(`水瓶  ${rd.msg || '未知错误'}`);
    }
}

async function sj_yg(code, token) { // 收集阳光
    while (true) {
        const resp = await req({
            method: 'post',
            url: `${SG01}/api/get-sunshine`,
            headers: create_headers(code, token),
            data: { time: Date.now() },
        });
        const rd = resp && resp.data;
        if (!rd) break;
        if (rd.code === 200) {
            console.log(`成功领取阳光: 剩余阳光: ${rd.data && rd.data.sy_sunshine}, 获得阳光: ${rd.data && rd.data.get_sunshine}`);
            await sleep(randInt(1, 3) * 1000);
        } else if (rd.code === 400) {
            console.log('没有可领取的阳光');
            break; // 如果没有可领取的阳光，跳出循环
        } else {
            console.log(`阳光操作响应: ${JSON.stringify(rd)}`);
            break;
        }
    }
}

async function syyg(code, token) { // 阳光值大于100时完成阳光任务
    const [, sunshine] = await hqid(code, token);
    if (typeof sunshine !== 'number') return;
    if (sunshine > 99) {
        const resp = await req({
            method: 'post',
            url: `${SG01}/api/sunshine-task/complete-task`,
            headers: create_headers(code, token),
            data: { tid: 1 },
        });
        const rd = resp && resp.data;
        if (rd && rd.code === 200) console.log('成功完成阳光任务。');
        else if (rd) console.log(`完成阳光任务失败，错误代码: ${rd.code}, 错误信息: ${rd.msg}`);
    } else {
        console.log(`阳光值未达到${sunshine}/100，不执行任务。`);
    }
}

async function task_list(code, token) { // 任务列表
    const resp = await req({ method: 'get', url: `${SG01}/api/task/list`, headers: create_headers(code, token) });
    const rd = resp && resp.data;
    const todayDate = beijingDate();
    const taskNames = {
        1: '签到,        1',
        2: '不知道1,      0',
        4: '三餐福袋,      3',
        6: '逛甄选好棉品, 4',
        10: '订阅奖励提醒, 1',
        13: '浏览新用户,   2',
        14: '庄园小课堂,   3',
        15: '棉花工厂,     1',
        16: '社区送福利,   1',
    };
    const todayTasks = [];
    if (rd && rd.code === 200) {
        const taskUserInfo = (rd.data || {}).task_user_info || [];
        console.log('------任务进度条-----------');
        for (const task of taskUserInfo) {
            const taskId = task.task_id;
            const completeNum = task.complete_num;
            const completeDate = task.complete_date;
            if (completeDate === todayDate) {
                const taskName = taskNames[taskId] || `未知任务 ${taskId}`;
                console.log(`任务ID: ${taskId} ${taskName}/${completeNum}, 任务时间: ${completeDate}`);
                todayTasks.push(task);
            }
        }
        console.log('-----------------');
        console.log();
        return todayTasks;
    }
    if (rd) console.log(`获取任务列表失败，错误信息：${rd.msg}`);
    return [];
}

// 任务领取奖励: POST /api/task/receive-task-water {tid}
async function tjlq_mpjl(code, token, tid) {
    const resp = await req({
        method: 'post',
        url: `${SG01}/api/task/receive-task-water`,
        headers: create_headers(code, token),
        data: { tid: tid },
    });
    const rd = resp && resp.data;
    if (rd && rd.code === 200) {
        console.log('奖励领取成功。');
        const d = rd.data || {};
        console.log(`剩余水量：${d.sy_water !== undefined ? d.sy_water : '未知'}, 获取水量：${d.get_water !== undefined ? d.get_water : '未知'}`);
    } else if (rd) {
        console.log(`奖励领取失败，错误信息：${rd.msg}`);
    }
}

// nmp 完成任务(POST form 表单): action 为任务动作, phone 由 sg01 login 提取
async function llhmp(code, token, action, tid) {
    const { phone } = await login(code, token);

    const headers = {
        Host: 'nmp.pureh2b.com',
        'XWeb-Xhr': '1',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        code: code,
        token: token,
    };
    const actionDescriptions = {
        browse_venue: '逛甄选好棉品',
        browse_new_user_zone: '浏览新用户专区',
        browse_community: '社区送福利',
        subscibe: '订阅奖励提醒',
    };
    const actionDescription = actionDescriptions[action] || '执行任务';

    const resp = await req({
        method: 'post',
        url: `${NMP}/api/purcotton/completetask`,
        headers: headers,
        params: { action: action, phone: phone, from: 'guoyuan' },
    });
    const rd = resp && resp.data;
    if (rd && rd.code === 200) {
        console.log(`${actionDescription} 任务成功，暂停一段时间再继续...`);
        await sleep(randInt(15, 20) * 1000);
        await tjlq_mpjl(code, token, tid); // 在任务成功后调用领取奖励的函数
    } else if (rd && rd.code === 400) {
        console.log(`${actionDescription} ：${rd.msg}`);
    } else if (rd) {
        console.log('收到未预期的响应，响应内容如下：');
        console.log(JSON.stringify(rd));
    }
}

async function complete_task(code, token, tid) { // 棉花工厂
    const resp = await req({
        method: 'post',
        url: `${SG01}/api/task/complete-manual-task`,
        headers: create_headers(code, token),
        data: sg01_sign({ tid: tid, relate_id: 0 }),
    });
    const rd = resp && resp.data;
    if (rd && rd.code === 200) {
        console.log('奖励领取成功。');
        await tjlq_mpjl(code, token, tid);
    } else if (rd) {
        console.log(`任务失败：${rd.msg}`);
    }
}

async function lq_fd(code, token, tid) { // 三餐福袋和签到
    tid = parseInt(tid, 10); // 转换为整型以确保与整数进行比较
    let taskName = '未知任务';
    if (tid === 4) taskName = '三餐福袋';
    else if (tid === 1) taskName = '签到';

    const resp = await req({
        method: 'post',
        url: `${SG01}/api/task/complete-task`,
        headers: create_headers(code, token),
        data: sg01_sign({ tid: tid }),
    });
    const rd = resp && resp.data;
    if (rd && rd.code === 200) {
        console.log(`${taskName} 奖励领取成功。`);
        const d = rd.data || {};
        console.log(`${taskName} 剩余水量：${d.sy_water !== undefined ? d.sy_water : '未知'}, 获取水量：${d.get_water !== undefined ? d.get_water : '未知'}`);
    } else if (rd) {
        console.log(`${taskName}：${rd.msg}`);
    }
}

async function hdwt_box(code, token, tid) { // 庄园小课堂
    const headers = create_headers(code, token);
    const resp = await req({ method: 'get', url: `${SG01}/api/answer`, headers: headers });
    const rd = resp && resp.data;
    if (!rd) return;
    const exams = (rd.data || {}).exams || [];
    for (const exam of exams) {
        const examId = exam.id;
        console.log(`正在处理问题ID: ${examId}`);

        // H5 提交的是所选选项字母(answer=A/B/C/D)，服务端在响应里回正确答案
        const options = ['A', 'B', 'C', 'D'].filter((letter) => exam[letter.toLowerCase()]);
        const choice = options.length ? options[0] : 'A';
        const submitResp = await req({
            method: 'post',
            url: `${SG01}/api/answer/complete`,
            headers: headers,
            data: sg01_sign({ answer: choice, exam_id: examId, tid: parseInt(tid, 10) }),
        });
        const sd = submitResp && submitResp.data;
        if (!sd || sd.code !== 200) {
            if (sd) console.log(`提交答案失败：${sd.msg}`);
            continue;
        }
        const dataAns = sd.data || {};
        const getWater = dataAns.get_water !== undefined ? dataAns.get_water : 0;
        const completeNum = dataAns.complete_num !== undefined ? dataAns.complete_num : 0;
        const boxId = dataAns.box_id !== undefined ? dataAns.box_id : 0;
        console.log(`答${choice} 正确答案${dataAns.answer !== undefined ? dataAns.answer : '?'} 获取水量：${getWater}, 完成数量：${completeNum}, 宝箱ID：${boxId}`);

        if (boxId > 0) {
            console.log(`检测到宝箱ID: ${boxId}，尝试打开宝箱...`);
            const boxResp = await req({
                method: 'post',
                url: `${SG01}/api/answer/open-box`,
                headers: headers,
                data: { box_id: boxId },
            });
            const bd = boxResp && boxResp.data;
            if (bd) {
                const bdd = bd.data || {};
                console.log(`宝箱  剩余水量：${bdd.sy_water !== undefined ? bdd.sy_water : 0}, 宝箱水量：${bdd.get_water !== undefined ? bdd.get_water : 0}`);
            }
        }
        await sleep(randInt(3, 5) * 1000); // 随机停止3-5秒
    }
}

// 判断任务: 根据任务完成情况执行任务
async function pdrw(code, token) {
    const taskUserInfo = await task_list(code, token);

    // 注意: 这里必须用数组保序 —— JS 对象会把「整数型 key」按数值升序重排,
    // 写对象字面量会打乱任务执行顺序(与 Python dict 的插入序不一致)。
    const taskCompletionLimits = [
        [6, 4],   // 逛甄选好棉品
        [13, 2],  // 浏览新用户专区
        [15, 1],  // 棉花工厂
        [4, 3],   // 三餐福袋
        [16, 1],  // 社区送福利
        [10, 1],  // 订阅奖励提醒
        [14, 1],  // 庄园小课堂
        [1, 1],   // 签到
    ];

    const existingTaskIds = taskUserInfo.map((t) => t.task_id);

    for (const [taskId, maxCompletes] of taskCompletionLimits) {
        const taskInfo = taskUserInfo.find((t) => t.task_id === taskId);

        // 在今日列表中: 未达上限才执行; 不在列表中: 说明今日还没做, 直接执行
        const inList = Boolean(taskInfo);
        const needRun = inList ? taskInfo.complete_num < maxCompletes : !existingTaskIds.includes(taskId);
        if (!needRun) continue;

        console.log();
        if (taskId === 6) {
            await llhmp(code, token, 'browse_venue', '6');
            if (!inList) await today_water(code, token);
        } else if (taskId === 13) {
            await llhmp(code, token, 'browse_new_user_zone', '13');
            if (inList) await today_water(code, token);
            await sj_yg(code, token); // 收集阳光
            await syyg(code, token);  // 使用阳光
        } else if (taskId === 15) {
            await complete_task(code, token, '15');
        } else if (taskId === 16) {
            await llhmp(code, token, 'browse_community', '16');
        } else if (taskId === 10) {
            await llhmp(code, token, 'subscibe', '10');
        } else if (taskId === 14) {
            await hdwt_box(code, token, '14');
        } else if (taskId === 4) {
            await lq_fd(code, token, '4');
        } else if (taskId === 1) {
            await lq_fd(code, token, '1');
        }
        await sleep(randInt(1, 5) * 1000);
    }
}

// 说明: 原脚本的「给好友浇水」(hyid / access_friend_detail / water_friend_tree /
//       process_all_friends) 是把自身水量消耗到他人的树上, 属社交/代浇,
//       非「种自己的树」目标, 按安全约束停用, 因此本次 JS 版未移植。
//       如需启用, 可参照 sg01 /api/friend/list、/api/friend/index、/api/friend/water 三个接口自行补回。

// ============================ 通知 ============================

// 兼容 sendNotify.js 位于当前目录或青龙 scripts 上级目录的情况
async function loadSendNotify() {
    for (const modulePath of ['./sendNotify.js', '../sendNotify.js']) {
        try {
            const notifyModule = await import(modulePath);
            const notify = notifyModule.sendNotify || (notifyModule.default && notifyModule.default.sendNotify);
            if (typeof notify === 'function') return notify;
        } catch (e) {
            // 尝试下一个候选路径；全部失败时保持脚本原有任务流程可用
        }
    }
    console.log('⚠️ 未找到可用的 sendNotify 模块，跳过通知');
    return null;
}

// ============================ 主流程 ============================

async function main() {
    const accounts = get_env_variable(ENV_NAME);
    if (!accounts) return;
    const total = accounts.length;
    if (total > 20) {
        console.log('账号数量超过20个，不执行操作。');
        return;
    }

    console.log('=============== 全棉时代 签到开始 ===============');
    const summaries = [];
    let okCount = 0;

    for (let index = 1; index <= total; index++) {
        const entry = accounts[index - 1];
        const parts = String(entry).split('#');
        const openid = (parts[0] || '').trim();
        const remark = parts.length > 1 ? parts[1].trim() : '';

        console.log();
        console.log(`------账号${index}/${total}，备注: ${remark}-------`);
        const lines = [`【账号 ${index}${remark ? '/' + remark : ''}】`];

        try {
            const { guid, token, member } = await get_account_session(openid, index);
            if (!token) {
                const msg = '登录失败(nmp未返回token)';
                console.log(`❌ ${msg}`);
                lines.push(`❌ ${msg}`);
                summaries.push(lines.join('\n'));
                continue;
            }

            const phone = member && typeof member === 'object' ? member.phone : null;
            if (!(member && typeof member === 'object' && phone)) {
                const msg = '该账号尚未绑定手机号(需先在小程序「全棉时代」内完成手机号授权注册为会员后, 才能签到/种棉花)';
                console.log(`⚠️ ${msg}`);
                lines.push(`⚠️ ${msg}`);
                summaries.push(lines.join('\n'));
                continue;
            }

            // 核心动作: 每日签到
            const { ok, msg } = await member_sign_in(guid, token);
            console.log((ok ? '🎉 ' : '❌ ') + msg);
            lines.push((ok ? '🎉 ' : '❌ ') + msg);
            if (ok) okCount++;

            // 种棉花: 仅给「自己的树」浇水 (沿用原 sg01 游戏流程)。
            // sg01 侧需再登录一次拿到 phone/user_id; 失败仅提示, 不影响签到结果。
            try {
                const { phone: sgPhone, userId: sgUid } = await login(guid, token);
                if (sgPhone && sgUid) {
                    await cscscs(guid, token);     // 刷新/领取日常
                    const watered = await jscz(guid, token); // 浇水(种棉花), 只浇自己的树
                    await pdrw(guid, token);       // 日常任务判断
                    if (watered) lines.push('🌱 种棉花: 已完成浇水/日常任务');
                    else lines.push('🌱 种棉花: 日常任务已完成; 种树/浇水未成功, 详见日志');
                } else {
                    console.log('种棉花: sg01 登录未通过, 跳过浇水(不影响签到)');
                    lines.push('🌱 种棉花: sg01 未登录, 已跳过');
                }
            } catch (e) {
                console.log(`种棉花流程异常(忽略, 不影响签到): ${e.message}`);
                lines.push('🌱 种棉花: 异常已忽略');
            }
        } catch (e) {
            console.log(`❌ 账号 ${index} 执行异常: ${e.message}`);
            lines.push(`❌ 执行异常: ${e.message}`);
        }

        summaries.push(lines.join('\n'));
        await sleep(1000);
    }

    console.log('\n=============== 全棉时代 签到结束 ===============');
    const title = `全棉时代签到 ${okCount}/${total} 成功`;
    const notify = await loadSendNotify();
    if (notify) {
        try {
            await notify(title, summaries.join('\n\n'));
        } catch (e) {
            console.log(`⚠️ 通知发送失败: ${e.message}`);
        }
    } else {
        console.log(`===== ${title} =====`);
        console.log(summaries.join('\n\n'));
    }
}

main().catch((e) => console.log(`脚本运行异常: ${e && e.message ? e.message : e}`));
