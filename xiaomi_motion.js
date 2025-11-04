/*
小米运动刷步数 - 青龙脚本版 (支持多账号)
原PHP版本转换为JavaScript版本
基于https://github.com/TonyJiangWJ/mimotion和https://github.com/hanximeng/Zepp_API实现

环境变量说明:
XIAOMI_ACCOUNTS: 账号信息，格式为 账号&密码&步数，多个账号用#分隔
示例: 13800138000&123456&15000-20000#user@example.com&654321&18000

或者分别设置:
XIAOMI_USERS: 用户名（手机号或邮箱），多个用#分隔
XIAOMI_PASSWORDS: 密码，多个用#分隔
XIAOMI_STEPS: 步数范围，多个用#分隔（可选，默认随机8000-25000）

使用方法:
1. 在青龙面板添加环境变量
2. 运行此脚本

cron: 0 9,15 * * *
*/

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const uuid = require('uuid');
// 导入青龙通知模块
let sendNotify;
try {
    sendNotify = require('./sendNotify');
} catch (e) {
    console.log('❌ 未找到sendNotify模块，将跳过通知功能');
}

// 全局配置
const $ = new Env('小米运动刷步数');
const cacheDir = path.join(__dirname, 'cache');

// 创建缓存目录
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

// 日志收集器
let logs = [];
const logger = {
    info: (msg, account = '') => {
        const time = new Date().toLocaleString('zh-CN');
        const logMsg = account ? `[${account}] ${msg}` : msg;
        console.log(`[INFO] ${time} - ${logMsg}`);
        logs.push(`[INFO] ${time} - ${logMsg}`);
    },
    success: (msg, account = '') => {
        const time = new Date().toLocaleString('zh-CN');
        const logMsg = account ? `[${account}] ${msg}` : msg;
        console.log(`[SUCCESS] ${time} - ${logMsg}`);
        logs.push(`[SUCCESS] ${time} - ${logMsg}`);
    },
    warn: (msg, account = '') => {
        const time = new Date().toLocaleString('zh-CN');
        const logMsg = account ? `[${account}] ${msg}` : msg;
        console.warn(`[WARN] ${time} - ${logMsg}`);
        logs.push(`[WARN] ${time} - ${logMsg}`);
    },
    error: (msg, account = '') => {
        const time = new Date().toLocaleString('zh-CN');
        const logMsg = account ? `[${account}] ${msg}` : msg;
        console.error(`[ERROR] ${time} - ${logMsg}`);
        logs.push(`[ERROR] ${time} - ${logMsg}`);
    }
};

// 脱敏用户名
function desensitizeUserName(user) {
    if (!user) return '***';
    const len = user.length;
    if (len <= 8) {
        const ln = Math.max(Math.floor(len / 3), 1);
        return user.substring(0, ln) + '***' + user.substring(len - ln);
    }
    return user.substring(0, 3) + '****' + user.substring(len - 4);
}

// 安全文件名过滤
function getSafeFilename(username) {
    // 移除可能引起路径遍历的字符
    let safeName = username.replace(/[^a-zA-Z0-9_\-@.]/g, '_');
    // 限制文件名长度
    if (safeName.length > 100) {
        safeName = safeName.substring(0, 100);
    }
    return safeName;
}

// 生成随机步数
function generateRandomSteps(min = 8000, max = 25000) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

// 解析步数范围
function parseStepsRange(stepsStr) {
    if (!stepsStr) return null;

    // 支持格式: "15000-20000" 或 "18000"
    if (stepsStr.includes('-')) {
        const [min, max] = stepsStr.split('-').map(s => parseInt(s.trim()));
        if (min && max && min <= max) {
            return { min, max };
        }
    } else {
        const steps = parseInt(stepsStr);
        if (steps && steps > 0) {
            // 如果只提供单个数值，则在该值±2000范围内随机
            return { min: Math.max(steps - 2000, 5000), max: steps + 2000 };
        }
    }
    return null;
}

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// AES加密功能 (替换PHP的openssl_encrypt)
function encryptData(plain) {
    const key = Buffer.from('xeNtBVqzDc6tuNTh', 'utf8');
    const iv = Buffer.from('MAAAYAAAAAAAAABg', 'utf8');

    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(true);

    let encrypted = cipher.update(plain, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return encrypted;
}

// AES解密功能
function decryptData(encrypted, key, iv) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted;
}

// 小米运动类
class MiMotionRunner {
    constructor(user, password) {
        this.user = user;
        this.password = password;
        this.logStr = '';
        this.invalid = false;
        this.cacheFile = path.join(cacheDir, getSafeFilename(user) + '.json');
        this.device_id = `hm-node-${uuid.v4()}`;

        if (!user || !password) {
            this.invalid = true;
            this.logStr += '用户名或密码填写有误！\n';
            return;
        }
    }

    // 读取缓存
    readCache() {
        try {
            if (!fs.existsSync(this.cacheFile)) {
                return null;
            }

            const data = fs.readFileSync(this.cacheFile, 'utf8');
            const cache = JSON.parse(data);

            if (!cache || !cache.expire_time || cache.expire_time < Date.now()) {
                this.clearCache();
                return null;
            }

            return cache;
        } catch (error) {
            logger.warn(`读取缓存失败: ${error.message}`, this.user);
            return null;
        }
    }

    // 写入缓存
    writeCache(data) {
        try {
            const cacheData = {
                ...data,
                user: this.user,
                create_time: Date.now(),
                // app_token有效期较短，这里设置一个总的缓存有效期，比如30天
                expire_time: Date.now() + 30 * 24 * 60 * 60 * 1000
            };

            fs.writeFileSync(this.cacheFile, JSON.stringify(cacheData, null, 2));
            return true;
        } catch (error) {
            logger.error(`写入缓存失败: ${error.message}`, this.user);
            return false;
        }
    }

    // 清除缓存
    clearCache() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                fs.unlinkSync(this.cacheFile);
            }
        } catch (error) {
            logger.warn(`清除缓存失败: ${error.message}`, this.user);
        }
    }

    // HTTP请求
    async httpRequest(url, options = {}) {
        const defaultHeaders = {
            'Accept': 'application/json',
            'Accept-Language': 'zh-CN,zh;q=0.8',
            'Connection': 'keep-alive',
            'app_name': 'com.xiaomi.hm.health',
            'appname': 'com.xiaomi.hm.health',
            'appplatform': 'android_phone',
            'User-Agent': 'MiFit6.14.0 (OPD2413; Android 15; Density/2.625)'
        };

        const config = {
            url: url,
            method: options.method || 'GET',
            headers: { ...defaultHeaders, ...options.headers },
            timeout: 10000,
            ...options
        };

        try {
            const response = await axios(config);
            return {
                status: response.status,
                headers: response.headers,
                data: response.data
            };
        } catch (error) {
            logger.error(`HTTP请求失败: ${error.message}`, this.user);
            throw error;
        }
    }

    // 1. 获取 Access Token
    async getAccessToken(username, password) {
        const isPhone = !username.includes('@');
        let loginName = username;
        if (isPhone && !username.startsWith('+86')) {
            loginName = '+86' + username;
        }

        const url = 'https://api-user.zepp.com/v2/registrations/tokens';
        const loginData = {
            'emailOrPhone': loginName,
            'password': password,
            'state': 'REDIRECTION',
            'client_id': 'HuaMi',
            'country_code': 'CN',
            'token': 'access',
            'redirect_uri': 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html',
        };

        const queryString = new URLSearchParams(loginData).toString();
        const body = encryptData(queryString);

        try {
            const response = await this.httpRequest(url, {
                method: 'POST',
                headers: {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "user-agent": "MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)",
                    "app_name": "com.xiaomi.hm.health",
                    "x-hm-ekv": "1",
                    "hm-privacy-ceip": "false"
                },
                data: body,
                maxRedirects: 0, // 禁止自动重定向
                validateStatus: status => status === 303 // 只接受303状态码
            });

            const location = response.headers.location || response.headers.Location;
            if (!location) {
                throw new Error('获取access token失败，未找到Location头');
            }

            const accessMatch = location.match(/access=([^&\s]+)/);
            if (accessMatch && accessMatch[1]) {
                logger.info('成功获取access_token', desensitizeUserName(this.user));
                return accessMatch[1];
            } else {
                const errorMatch = location.match(/error=([^&\s]+)/);
                throw new Error(`获取access_token失败: ${errorMatch ? errorMatch[1] : '未知错误'}`);
            }
        } catch (error) {
            logger.error(`获取access_token请求失败: ${error.response ? JSON.stringify(error.response.data) : error.message}`, desensitizeUserName(this.user));
            if (error.message.includes('401') || error.message.includes('auth_failed')) {
                throw new Error('账号或密码错误！');
            }
            throw error;
        }
    }

    // 2. 使用 Access Token 获取 Login Token 和 App Token
    async grantLoginTokens(accessToken) {
        const url = "https://account.huami.com/v2/client/login";
        const isPhone = !this.user.includes('@');

        const data = {
            "app_name": "com.xiaomi.hm.health",
            "app_version": "6.14.0",
            "code": accessToken,
            "country_code": "CN",
            "device_id": this.device_id,
            "device_model": "phone",
            "grant_type": "access_token",
            "third_name": isPhone ? "huami_phone" : "email",
        };

        try {
            const response = await this.httpRequest(url, {
                method: 'POST',
                data: new URLSearchParams(data).toString(),
                headers: {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                }
            });

            const result = response.data;
            if (result.result === 'ok' && result.token_info) {
                logger.info('成功获取login_token和app_token', desensitizeUserName(this.user));
                const { login_token, app_token, user_id } = result.token_info;
                this.writeCache({
                    login_token,
                    app_token,
                    user_id,
                    device_id: this.device_id,
                    login_token_time: Date.now(),
                    app_token_time: Date.now()
                });
                return { login_token, app_token, user_id };
            } else {
                throw new Error(`获取login_token失败: ${JSON.stringify(result)}`);
            }
        } catch (error) {
            logger.error(`grantLoginTokens请求失败: ${error.message}`, desensitizeUserName(this.user));
            throw error;
        }
    }

    // 3. 检查 App Token 是否有效
    async checkAppToken(appToken) {
        const url = "https://api-mifit-cn3.zepp.com/huami.health.getUserInfo.json";
        const params = { "apptoken": appToken };
        try {
            const response = await this.httpRequest(url, { params });
            // 如果能成功请求（即使返回特定错误码），说明token至少被服务器接受了
            return response.data && response.data.message === 'success';
        } catch (e) {
            // 请求失败，如401，说明token无效
            return false;
        }
    }

    // 核心登录逻辑
    async login() {
        const cache = this.readCache();

        // 1. 尝试使用缓存的 app_token
        if (cache && cache.app_token && (Date.now() - (cache.app_token_time || 0)) < 12 * 60 * 60 * 1000) { // 12小时内有效
            logger.info('检查缓存的app_token...', desensitizeUserName(this.user));
            const isAppTokenValid = await this.checkAppToken(cache.app_token);
            if (isAppTokenValid) {
                logger.success('缓存的app_token有效', desensitizeUserName(this.user));
                this.device_id = cache.device_id;
                return [cache.app_token, cache.user_id];
            }
            logger.warn('缓存的app_token已失效', desensitizeUserName(this.user));
        }

        // 2. app_token失效，尝试使用 login_token (如果存在且未过期)
        // Zepp Life的login_token有效期很长，这里可以适当放宽
        if (cache && cache.login_token && (Date.now() - (cache.login_token_time || 0)) < 15 * 24 * 60 * 60 * 1000) { // 15天
            logger.info('尝试使用缓存的login_token刷新app_token...', desensitizeUserName(this.user));
            try {
                // 在mimotion中，是直接用access_token去获取login token和app token，这里我们也遵循这个逻辑
                const newAccessToken = await this.getAccessToken(this.user, this.password);
                const { app_token, user_id } = await this.grantLoginTokens(newAccessToken);
                logger.success('通过login_token刷新app_token成功', desensitizeUserName(this.user));
                return [app_token, user_id];
            } catch (e) {
                logger.error(`使用login_token刷新失败: ${e.message}，将执行完整登录`, desensitizeUserName(this.user));
            }
        }

        // 3. 缓存无效或刷新失败，执行完整登录流程
        logger.info('执行完整登录流程...', desensitizeUserName(this.user));
        try {
            const accessToken = await this.getAccessToken(this.user, this.password);
            const { app_token, user_id } = await this.grantLoginTokens(accessToken);
            logger.success('完整登录成功', desensitizeUserName(this.user));
            return [app_token, user_id];
        } catch (error) {
            logger.error(`完整登录流程失败: ${error.message}`, desensitizeUserName(this.user));
            this.clearCache(); // 登录失败，清除可能错误的缓存
            return [null, null];
        }
    }

    // 提交步数数据
    async loginAndPostStep(step) {
        if (this.invalid) {
            return { success: false, message: '账号或密码配置有误' };
        }

        const [token, userid] = await this.login();
        if (!token) {
            return { success: false, message: '登录失败！' };
        }

        try {
            const url = `https://api-mifit-cn.huami.com/v1/data/band_data.json?&t=${Date.now()}&r=${uuid.v4()}`;

            // 构建步数数据JSON
            const currentDate = new Date().toISOString().split('T')[0];
            const data_hr_str = "//////9L////////////Vv///////////0v///////////9e/////0n/a///S////////////0b//////////1FK////////////R/////////////////9PTFFpaf9L////////////R////////////0j///////////9K////////////Ov///////////zf///86/zr/Ov88/zf/Pf///0v/S/8/////////////Sf///////////z3//////0r/Ov//////S/9L/zb/Sf9K/0v/Rf9H/zj/Sf9K/0//N////0D/Sf83/zr/Pf9M/0v/Ov9e////////////S////////////zv//z7/O/83/zv/N/83/zr/N/86/z//Nv83/zn/Xv84/zr/PP84/zj/N/9e/zr/N/89/03/P/89/z3/Q/9N/0v/Tv9C/0H/Of9D/zz/Of88/z//PP9A/zr/N/86/zz/Nv87/0D/Ov84/0v/O/84/zf/MP83/zH/Nv83/zf/N/84/zf/Of82/zf/OP83/zb/Mv81/zX/R/9L/0v/O/9I/0T/S/9A/zn/Pf89/zn/Nf9K/07/N/83/zn/Nv83/zv/O/9A/0H/Of8//zj/PP83/zj/S/87/zj/Nv84/zf/Of83/zf/Of83/zb/Nv9L/zj/Nv82/zb/N/85/zf/N/9J/zf/Nv83/zj/Nv84/0r/Sv83/zf/MP///zb/Mv82/zb/Of85/z7/Nv8//0r/S/85/0H/QP9B/0D/Nf89/zj/Ov83/zv/Nv8//0f/Sv9O/0ZeXv///////////1X///////////9B////////////TP///1b//////0////////////9N/////////v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+";
            const stepData = {
                data_hr: "//////9L////////////Vv///////////0v///////////9e/////0n/a///S////////////0b//////////1FK////////////R/////////////////9PTFFpaf9L////////////R////////////0j///////////9K////////////Ov///////////zf///86/zr/Ov88/zf/Pf///0v/S/8/////////////Sf///////////z3//////0r/Ov//////S/9L/zb/Sf9K/0v/Rf9H/zj/Sf9K/0//N////0D/Sf83/zr/Pf9M/0v/Ov9e////////////S////////////zv//z7/O/83/zv/N/83/zr/N/86/z//Nv83/zn/Xv84/zr/PP84/zj/N/9e/zr/N/89/03/P/89/z3/Q/9N/0v/Tv9C/0H/Of9D/zz/Of88/z//PP9A/zr/N/86/zz/Nv87/0D/Ov84/0v/O/84/zf/MP83/zH/Nv83/zf/N/84/zf/Of82/zf/OP83/zb/Mv81/zX/R/9L/0v/O/9I/0T/S/9A/zn/Pf89/zn/Nf9K/07/N/83/zn/Nv83/zv/O/9A/0H/Of8//zj/PP83/zj/S/87/zj/Nv84/zf/Of83/zf/Of83/zb/Nv9L/zj/Nv82/zb/N/85/zf/N/9J/zf/Nv83/zj/Nv84/0r/Sv83/zf/MP///zb/Mv82/zb/Of85/z7/Nv8//0r/S/85/0H/QP9B/0D/Nf89/zj/Ov83/zv/Nv8//0f/Sv9O/0ZeXv///////////1X///////////9B////////////TP///1b//////0////////////9N/////////v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+",
                date: currentDate,
                data: [{
                    start: 0,
                    stop: 1439,
                    value: "UA8AUBQAUAwAUBoAUAEAYCcAUBkAUB4AUBgAUCAAUAEAUBkAUAwAYAsAYB8AYB0AYBgAYCoAYBgAYB4AUCcAUBsAUB8AUBwAUBIAYBkAYB8AUBoAUBMAUCEAUCIAYBYAUBwAUCAAUBgAUCAAUBcAYBsAYCUAATIPYD0KECQAYDMAYB0AYAsAYCAAYDwAYCIAYB0AYBcAYCQAYB0AYBAAYCMAYAoAYCIAYCEAYCYAYBsAYBUAYAYAYCIAYCMAUB0AUCAAUBYAUCoAUBEAUC8AUB0AUBYAUDMAUDoAUBkAUC0AUBQAUBwAUA0AUBsAUAoAUCEAUBYAUAwAUB4AUAwAUCcAUCYAUCwKYDUAAUUlEC8IYEMAYEgAYDoAYBAAUAMAUBkAWgAAWgAAWgAAWgAAWgAAUAgAWgAAUBAAUAQAUA4AUA8AUAkAUAIAUAYAUAcAUAIAWgAAUAQAUAkAUAEAUBkAUCUAWgAAUAYAUBEAWgAAUBYAWgAAUAYAWgAAWgAAWgAAWgAAUBcAUAcAWgAAUBUAUAoAUAIAWgAAUAQAUAYAUCgAWgAAUAgAWgAAWgAAUAwAWwAAXCMAUBQAWwAAUAIAWgAAWgAAWgAAWgAAWgAAWgAAWgAAWgAAWREAWQIAUAMAWSEAUDoAUDIAUB8AUCEAUC4AXB4AUA4AWgAAUBIAUA8AUBAAUCUAUCIAUAMAUAEAUAsAUAMAUCwAUBYAWgAAWgAAWgAAWgAAWgAAWgAAUAYAWgAAWgAAWgAAUAYAWwAAWgAAUAYAXAQAUAMAUBsAUBcAUCAAWwAAWgAAWgAAWgAAWgAAUBgAUB4AWgAAUAcAUAwAWQIAWQkAUAEAUAIAWgAAUAoAWgAAUAYAUB0AWgAAWgAAUAkAWgAAWSwAUBIAWgAAUC4AWSYAWgAAUAYAUAoAUAkAUAIAUAcAWgAAUAEAUBEAUBgAUBcAWRYAUA0AWSgAUB4AUDQAUBoAXA4AUA8AUBwAUA8AUA4AUA4AWgAAUAIAUCMAWgAAUCwAUBgAUAYAUAAAUAAAUAAAUAAAUAAAUAAAUAAAUAAAUAAAWwAAUAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAeSEAeQ8AcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcBcAcAAAcAAAcCYOcBUAUAAAUAAAUAAAUAAAUAUAUAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcCgAeQAAcAAAcAAAcAAAcAAAcAAAcAYAcAAAcBgAeQAAcAAAcAAAegAAegAAcAAAcAcAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcCkAeQAAcAcAcAAAcAAAcAwAcAAAcAAAcAIAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcCIAeQAAcAAAcAAAcAAAcAAAcAAAeRwAeQAAWgAAUAAAUAAAUAAAUAAAUAAAcAAAcAAAcBoAeScAeQAAegAAcBkAeQAAUAAAUAAAUAAAUAAAUAAAUAAAcAAAcAAAcAAAcAAAcAAAcAAAegAAegAAcAAAcAAAcBgAeQAAcAAAcAAAcAAAcAAAcAAAcAkAegAAegAAcAcAcAAAcAcAcAAAcAAAcAAAcAAAcA8AeQAAcAAAcAAAeRQAcAwAUAAAUAAAUAAAUAAAUAAAUAAAcAAAcBEAcA0AcAAAWQsAUAAAUAAAUAAAUAAAUAAAcAAAcAoAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAYAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcBYAegAAcAAAcAAAegAAcAcAcAAAcAAAcAAAcAAAcAAAeRkAegAAegAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAEAcAAAcAAAcAAAcAUAcAQAcAAAcBIAeQAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcBsAcAAAcAAAcBcAeQAAUAAAUAAAUAAAUAAAUAAAUBQAcBYAUAAAUAAAUAoAWRYAWTQAWQAAUAAAUAAAUAAAcAAAcAAAcAAAcAAAcAAAcAMAcAAAcAQAcAAAcAAAcAAAcDMAeSIAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcBQAeQwAcAAAcAAAcAAAcAMAcAAAeSoAcA8AcDMAcAYAeQoAcAwAcFQAcEMAeVIAaTYAbBcNYAsAYBIAYAIAYAIAYBUAYCwAYBMAYDYAYCkAYDcAUCoAUCcAUAUAUBAAWgAAYBoAYBcAYCgAUAMAUAYAUBYAUA4AUBgAUAgAUAgAUAsAUAsAUA4AUAMAUAYAUAQAUBIAASsSUDAAUDAAUBAAYAYAUBAAUAUAUCAAUBoAUCAAUBAAUAoAYAIAUAQAUAgAUCcAUAsAUCIAUCUAUAoAUA4AUB8AUBkAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAAfgAA",
                    tz: 32,
                    did: "DA932FFFFE8816E7",
                    src: 24
                }],
                summary: JSON.stringify({
                    v: 6,
                    slp: {
                        st: 1628296479,
                        ed: 1628296479,
                        dp: 0,
                        lt: 0,
                        wk: 0,
                        usrSt: -1440,
                        usrEd: -1440,
                        wc: 0,
                        is: 0,
                        lb: 0,
                        to: 0,
                        dt: 0,
                        rhr: 0,
                        ss: 0
                    },
                    stp: {
                        ttl: step,
                        dis: 10627,
                        cal: 510,
                        wk: 41,
                        rn: 50,
                        runDist: 7654,
                        runCal: 397,
                        stage: [{
                            start: 327,
                            stop: 341,
                            mode: 1,
                            dis: 481,
                            cal: 13,
                            step: 680
                        }, 
                        { "start": 342, "stop": 367, "mode": 3, "dis": 2295, "cal": 95, "step": 2874 }, 
                        { "start": 368, "stop": 377, "mode": 4, "dis": 1592, "cal": 88, "step": 1664 }, 
                        { "start": 378, "stop": 386, "mode": 3, "dis": 1072, "cal": 51, "step": 1245 }, 
                        { "start": 387, "stop": 393, "mode": 4, "dis": 1036, "cal": 57, "step": 1124 }, 
                        { "start": 394, "stop": 398, "mode": 3, "dis": 488, "cal": 19, "step": 607 }, 
                        { "start": 399, "stop": 414, "mode": 4, "dis": 2220, "cal": 120, "step": 2371 }, 
                        { "start": 415, "stop": 427, "mode": 3, "dis": 1268, "cal": 59, "step": 1489 }, 
                        { "start": 428, "stop": 433, "mode": 1, "dis": 152, "cal": 4, "step": 238 }, 
                        { "start": 434, "stop": 444, "mode": 3, "dis": 2295, "cal": 95, "step": 2874 }, 
                        { "start": 445, "stop": 455, "mode": 4, "dis": 1592, "cal": 88, "step": 1664 }, 
                        { "start": 456, "stop": 466, "mode": 3, "dis": 1072, "cal": 51, "step": 1245 }, 
                        { "start": 467, "stop": 477, "mode": 4, "dis": 1036, "cal": 57, "step": 1124 }, 
                        { "start": 478, "stop": 488, "mode": 3, "dis": 488, "cal": 19, "step": 607 }, 
                        { "start": 489, "stop": 499, "mode": 4, "dis": 2220, "cal": 120, "step": 2371 }, 
                        { "start": 500, "stop": 511, "mode": 3, "dis": 1268, "cal": 59, "step": 1489 }, 
                        { "start": 512, "stop": 522, "mode": 1, "dis": 152, "cal": 4, "step": 238 }]
                    },
                    goal: 8000,
                    tz: "28800"
                }),
                source: 24,
                type: 0
            };

            const submitData = {
                data_json: JSON.stringify([stepData]),
                userid: userid,
                device_type: '0',
                last_sync_data_time: Date.now().toString(),
                last_deviceid: 'C4D2D4FFFE8C5068'
            };

            const response = await this.httpRequest(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'apptoken': token
                },
                data: new URLSearchParams(submitData).toString()
            });

            const result = response.data;
            if (!result) {
                throw new Error('修改步数接口请求失败');
            } else if (result.code === 1) {
                logger.success(`修改步数成功：${step}步`, desensitizeUserName(this.user));
                return { success: true, message: `修改步数（${step}）`, step: step };
            } else {
                const message = result.message || JSON.stringify(result);
                throw new Error('修改步数失败：' + message);
            }
        } catch (error) {
            logger.error(`修改步数失败: ${error.message}`, desensitizeUserName(this.user));
            return { success: false, message: error.message };
        }
    }
}

// 获取环境变量配置
function getAccountsFromEnv() {
    const accounts = [];

    // 方式1: 使用XIAOMI_ACCOUNTS变量 (账号&密码&步数#账号&密码&步数)
    if (process.env.XIAOMI_ACCOUNTS) {
        const accountList = process.env.XIAOMI_ACCOUNTS.split('#');
        for (const accountStr of accountList) {
            const parts = accountStr.trim().split('&');
            if (parts.length >= 2) {
                let steps;
                if (parts[2]) {
                    const range = parseStepsRange(parts[2]);
                    steps = range ? generateRandomSteps(range.min, range.max) : generateRandomSteps();
                } else {
                    steps = generateRandomSteps();
                }

                accounts.push({
                    user: parts[0],
                    password: parts[1],
                    steps: steps,
                    stepsRange: parts[2] || '8000-25000'
                });
            }
        }
    }
    // 方式2: 使用分别的环境变量
    else if (process.env.XIAOMI_USERS) {
        const users = process.env.XIAOMI_USERS.split('#');
        const passwords = process.env.XIAOMI_PASSWORDS ? process.env.XIAOMI_PASSWORDS.split('#') : [];
        const steps = process.env.XIAOMI_STEPS ? process.env.XIAOMI_STEPS.split('#') : [];

        for (let i = 0; i < users.length; i++) {
            if (users[i] && passwords[i]) {
                let stepCount;
                let stepsRange = '8000-25000';

                if (steps[i]) {
                    const range = parseStepsRange(steps[i]);
                    stepCount = range ? generateRandomSteps(range.min, range.max) : generateRandomSteps();
                    stepsRange = steps[i];
                } else {
                    stepCount = generateRandomSteps();
                }

                accounts.push({
                    user: users[i].trim(),
                    password: passwords[i].trim(),
                    steps: stepCount,
                    stepsRange: stepsRange
                });
            }
        }
    }
    return accounts;
}

// 主函数
async function main() {
    logger.info('🚀 小米运动刷步数开始执行');

    const accounts = getAccountsFromEnv();

    if (accounts.length === 0) {
        logger.error('未找到有效的账号配置！请检查环境变量');
        logger.info('环境变量配置说明：');
        logger.info('方式1: XIAOMI_ACCOUNTS=账号&密码&步数范围#账号&密码&步数范围');
        logger.info('方式2: XIAOMI_USERS=账号#账号 XIAOMI_PASSWORDS=密码#密码 XIAOMI_STEPS=步数范围#步数范围(可选)');
        return;
    }

    logger.info(`📱 共找到 ${accounts.length} 个账号`);

    const results = [];

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        logger.info(`\n======== 第 ${i + 1}/${accounts.length} 个账号 ========`);

        const runner = new MiMotionRunner(account.user, account.password);
        const result = await runner.loginAndPostStep(account.steps);

        results.push({
            account: desensitizeUserName(account.user),
            steps: account.steps,
            stepsRange: account.stepsRange,
            success: result.success,
            message: result.message
        });

        // 账号间延迟
        if (i < accounts.length - 1) {
            const delay_time = Math.floor(Math.random() * 5000) + 3000; // 3-8秒随机延迟
            logger.info(`⏰ 等待 ${delay_time / 1000} 秒后处理下一个账号...`);
            await delay(delay_time);
        }
    }

    // 生成执行报告
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    let summary = `📊 小米运动刷步数执行报告\n\n`;
    summary += `✅ 执行成功：${successCount}/${results.length}\n`;
    summary += `❌ 执行失败：${failCount}/${results.length}\n\n`;

    if (successCount > 0) {
        summary += `🏆 成功详情：\n`;
        results.filter(r => r.success).forEach(r => {
            summary += `✅ ${r.account} - ${r.steps}步 (范围:${r.stepsRange})\n`;
        });
        summary += '\n';
    }

    if (failCount > 0) {
        summary += `⚠️ 失败详情：\n`;
        results.filter(r => !r.success).forEach(r => {
            summary += `❌ ${r.account} - ${r.message}\n`;
        });
        summary += '\n';
    }

    summary += `📅 执行时间：${new Date().toLocaleString('zh-CN')}`;

    logger.info('\n' + summary);

    // 发送通知
    if (sendNotify && sendNotify.sendNotify) {
        try {
            await sendNotify.sendNotify('小米运动刷步数', summary);
            logger.success('通知发送成功');
        } catch (error) {
            logger.error(`通知发送失败: ${error.message}`);
        }
    }

    logger.info('🎉 小米运动刷步数执行完成');
}

// 简化的Env函数 (兼容青龙环境)
function Env(name) {
    return {
        name: name,
        log: (...args) => console.log(...args),
        logErr: (...args) => console.error(...args)
    };
}

// 执行主函数
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { MiMotionRunner, main };