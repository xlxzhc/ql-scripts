/**
 * 粉象生活App自动化脚本（本地版）
 * 
 * 使用方法：
 * 1. 在下方 localCookie 处填入你的账号参数：did#finger#token#oaid
 * 2. 安装依赖：npm install axios tough-cookie
 * 3. 运行：node fenxsh.js
 * 
 * 多账号用 & 分隔，例如：
 * did1#finger1#token1#oaid1&did2#finger2#token2#oaid2
 */

// ⭐⭐⭐ 在这里填入你的账号参数（抓包获取），留空则读取环境变量 fenxiang ⭐⭐⭐
let localCookie = "did#finger#token#oaid";

// ================================================================

const $ = new Env("粉象生活App");
let ckName = "fenxiang";
let envSplitor = ["&", "\n"]; // 多账号分隔符
let strSplitor = "#";         // 单账号多变量分隔符
let userIdx = 0;
let userList = [];

class Task {
    constructor(str) {
        this.index = ++userIdx;
        this.did = str.split(strSplitor)[0];
        this.finger = str.split(strSplitor)[1];
        this.token = str.split(strSplitor)[2];
        this.oaid = str.split(strSplitor)[3];
        this.ckStatus = true;
        this.taskList = [];
    }

    async main() {
        await this.user_info();
        await this.sign_reward();
        await this.special_finish();
        await this.task_list();

        for (let i of this.taskList) {
            await $.wait(5000);
            await this.task_finish(i.id);
        }
    }

    // 获取用户信息
    async user_info() {
        let result = await this.taskRequest("get", `https://api.fenxianglife.com/njia/users/info`);
        if (result.code == 200) {
            $.log(`✅账号[${this.index}] 欢迎用户: ${result.data.userInfo.id}`);
            this.ckStatus = true;
        } else {
            $.log(`❌账号[${this.index}] 用户查询: 失败`);
            this.ckStatus = false;
        }
    }

    // 完成任务
    async task_finish(id) {
        let result = await this.taskRequest("post", `https://fenxiang-lottery-api.fenxianglife.com/fenxiang-lottery/lotteryCode/task/finish`, JSON.stringify({
            "taskId": id
        }));
        if (result.code == 200) {
            $.log(`✅账号[${this.index}] 任务${id}完成`);
        } else {
            $.log(`❌账号[${this.index}] 任务${id}失败`);
        }
    }

    // 完成特殊任务
    async special_finish() {
        let result = await this.taskRequest("post", `https://api.fenxianglife.com/njia/game/task/special/finish`, JSON.stringify({}));
        if (result.errcode == 0) {
            $.log(`✅账号[${this.index}] 特殊任务完成`);
        } else {
            $.log(`❌账号[${this.index}] 特殊任务失败`);
        }
    }

    // 签到
    async sign_reward() {
        let result = await this.taskRequest("post", `https://fenxiang-lottery-api.fenxianglife.com/fenxiang-lottery/user/sign/reward`, JSON.stringify({}));
        if (result.code == 200) {
            $.log(`✅账号[${this.index}] 签到成功`);
        } else {
            $.log(`❌账号[${this.index}] 签到失败`);
        }
    }

    // 获取任务列表
    async task_list() {
        let result = await this.taskRequest("post", 'https://fenxiang-lottery-api.fenxianglife.com/fenxiang-lottery/home/data/V2', JSON.stringify({
            "plateform": "android",
            "version": "5.4.3"
        }));
        if (result.code == 200) {
            for (let i of result.data.taskModule.taskResult) {
                if (i.taskStatus == 0) {
                    this.taskList.push(i);
                }
            }
        } else {
            $.log(`❌账号[${this.index}] 获取任务失败`);
        }
    }

    // 核心请求方法（带签名）
    async taskRequest(method, url, body = "") {
        let re = function (e) {
            function convertObjectToQueryString(obj) {
                let queryString = "";
                if (obj) {
                    const keys = Object.keys(obj).sort();
                    keys.forEach(key => {
                        const value = obj[key];
                        if (value !== null && typeof value !== 'object') {
                            queryString += `&${key}=${value}`;
                        }
                    });
                }
                return queryString.slice(1);
            }
            return convertObjectToQueryString(e);
        }

        function v(e) {
            const crypto = require("crypto");
            return crypto.createHash("md5").update(e).digest("hex");
        }

        const g = {
            traceid: v((new Date).getTime().toString() + Math.random().toString()),
            noncestr: Math.random().toString().slice(2, 10),
            timestamp: Date.now(),
            platform: "h5",
            did: this.did,
            version: "1.0.0",
            finger: this.finger,
            token: this.token,
            oaid: this.oaid,
        }

        const c = "\u7c89\u8c61\u597d\u725b\u903ca8c19d8267527ea4c7d2f011acf7766f";
        let s = method === "get" ? void 0 : JSON.parse(body);
        let e = void 0 === s ? {} : s;
        g.sign = v(re(e) + re(g) + c);

        let headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; MI 8 Lite Build/QKQ1.190910.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/80.0.3987.99 Mobile Safari/537.36 AgentWeb/5.0.0 UCBrowser/11.6.4.950',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
            'origin': 'https://m.fenxianglife.com',
            'x-requested-with': 'com.n_add.android',
            'referer': 'https://m.fenxianglife.com/h5-lottery/index.html',
            'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            "Content-Type": "application/json"
        };

        Object.assign(headers, g);

        const reqeuestOptions = {
            url: url,
            method: method,
            headers: headers,
            body: body
        };

        let { body: result } = await $.httpRequest(reqeuestOptions);
        return result;
    }
}

// 主函数
!(async () => {
    console.log(`==================================================\n 脚本执行 - 北京时间(UTC+8): ${new Date(
        new Date().getTime() + new Date().getTimezoneOffset() * 60 * 1000 + 8 * 60 * 60 * 1000
    ).toLocaleString()} \n==================================================`);

    if (!(await checkEnv())) return;

    if (userList.length > 0) {
        let taskall = [];
        for (let user of userList) {
            if (user.ckStatus) {
                taskall.push(user.main());
            }
        }
        await Promise.all(taskall);
    }

    // 将本次执行日志汇总后，通过项目中的 sendNotify 模块发送通知
    console.log($.logs.join("\n"));
    const notify = await loadSendNotify();
    if (notify) {
        try {
            await notify("粉象生活App", $.logs.join("\n"));
            console.log("✅ 执行结果通知已发送");
        } catch (e) {
            console.log(`❌ 执行结果通知发送失败: ${e.message}`);
        }
    }
})()
    .catch((e) => console.log(e))
    .finally(() => $.done());

// 兼容 sendNotify.js 位于当前目录或青龙 scripts 上级目录的情况
async function loadSendNotify() {
    for (const modulePath of ["./sendNotify.js", "../sendNotify.js"]) {
        try {
            const notifyModule = await import(modulePath);
            const notify = notifyModule.sendNotify || notifyModule.default?.sendNotify;
            if (typeof notify === "function") return notify;
        } catch (e) {
            // 尝试下一个候选路径；全部失败时保持脚本原有任务流程可用
        }
    }
    console.log("⚠️ 未找到可用的 sendNotify 模块，跳过通知");
    return null;
}

// 环境变量检查：优先用代码里填的 localCookie，否则读环境变量
async function checkEnv() {
    let userCookie = localCookie || ($.isNode() ? process.env[ckName] : "") || "";

    if (!userCookie || userCookie === "did#finger#token#oaid") {
        userCookie = ($.isNode() ? process.env[ckName] : "") || "";
    }

    if (userCookie) {
        let e = envSplitor[0];
        for (let o of envSplitor)
            if (userCookie.indexOf(o) > -1) {
                e = o;
                break;
            }
        for (let n of userCookie.split(e)) n && userList.push(new Task(n));
    } else {
        console.log(`❌ 未找到账号参数！请在代码顶部 localCookie 处填入，或设置环境变量【${ckName}】`);
        return;
    }
    return console.log(`✅ 共找到${userList.length}个账号`), true;
}

// 环境工具类（已移除通知功能）
function Env(t, s) {
    return new (class {
        constructor(t, s) {
            this.name = t;
            this.logs = [];
            this.logSeparator = "\n";
            this.startTime = new Date().getTime();
            Object.assign(this, s);
            this.log("", `🔔${this.name},开始!`);
        }
        isNode() {
            return "undefined" != typeof module && !!module.exports;
        }
        initRequestEnv(t) {
            try {
                require.resolve("axios") && ((this.requset = require("axios")), (this.requestModule = "axios"));
            } catch (e) { }
            this.cktough = this.cktough ? this.cktough : require("tough-cookie");
            this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar();
        }
        isJSONString(str) {
            try {
                JSON.parse(str);
                return true;
            } catch (e) {
                return false;
            }
        }
        async httpRequest(options) {
            let t = { ...options };
            t.headers = t.headers || {};
            t.method = t.method.toLowerCase();

            if (this.isNode()) {
                this.initRequestEnv(t);
                if (this.requestModule === "axios" && t.method === "post") {
                    t.data = t.body ? JSON.parse(t.body) : {};
                    delete t.body;
                }
                let httpResult = await this.requset(t);
                httpResult.body = httpResult.data;
                return httpResult;
            }
        }
        log(...t) {
            t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(t.join(this.logSeparator));
        }
        wait(t) {
            return new Promise((s) => setTimeout(s, t));
        }
        done(t = {}) {
            const s = new Date().getTime(),
                e = (s - this.startTime) / 1e3;
            this.log("", `🔔${this.name},结束!⏱ ${e}秒`);
            this.log();
            if (this.isNode()) {
                process.exit(1);
            }
        }
    })(t, s);
}