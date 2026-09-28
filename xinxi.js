// 辛喜 青龙版
const https = require('https');
const NAME = '辛喜';

// ===== 环境变量 XinXi =====
// 推荐：一行一个 token，多账号换行/ & / | / , 分隔
// 兼容：id#token 每行一个，或 JSON 数组 [{"id":..,"token":".."}]
const XinXi = parseAccounts(process.env.XinXi || '');

function parseAccounts(raw) {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
        try {
            return JSON.parse(s)
                .map(x => ({id: String(x.id), token: String(x.token)}))
                .filter(x => x.token);
        } catch (e) { console.log('XinXi 环境变量 JSON 解析失败'); return []; }
    }
    return s.split(/[\n&|,]+/)
        .map(x => x.trim())
        .filter(Boolean)
        .map(line => {
            const m = line.match(/^(\d+)#(.+)$/);
            if (m) return {id: m[1], token: m[2]};
            return {id: idFromToken(line), token: line};
        })
        .filter(x => x.token);
}

function idFromToken(token) {
    try {
        const jwt = token.replace(/^Wmeimob_/, '');
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf-8'));
        return String(payload.sub).split('#')[0];
    } catch (e) { return 'unknown'; }
}

const HEADERS = {
    'Connection': 'keep-alive',
    'xweb_xhr': 1,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) XWEB/9117',
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Referer': 'https://servicewechat.com/wx673f827a4c2c94fa/264/page-frame.html',
    'Accept-Language': 'zh-CN,zh;q=0.9'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(host, method, path, token, body) {
    return new Promise(resolve => {
        const data = body ? JSON.stringify(body) : null;
        const headers = Object.assign({}, HEADERS, {sso: token});
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = https.request({
            hostname: host,
            path: `/mini${path}`,
            method,
            headers,
            timeout: 30000
        }, res => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch (e) { console.log(`解析失败: ${buf.slice(0, 200)}`); resolve(null); }
            });
        });
        req.on('error', e => { console.log(`请求错误: ${e.message}`); resolve(null); });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        if (data) req.write(data);
        req.end();
    });
}

let _token = '';
const api = {
    get:  path      => request('api.xinc818.com',     'GET',  path, _token),
    post: (path, b) => request('api.xinc818.com',     'POST', path, _token, b),
    put:  (path, b) => request('api.xinc818.com',     'PUT',  path, _token, b),
    cdn:  path      => request('cdn-api.xinc818.com', 'GET',  path, _token)
};

(async () => {
    console.log(`🔔${NAME}, 开始!`);
    console.log('作者：@xlxzhc\n');

    if (!XinXi.length) {
        console.log('未读取到账号，请检查环境变量 XinXi');
        return;
    }

    for (const item of XinXi) {
        const id = item.id;
        _token = item.token;
        console.log(`\n===== 用户：${id} 开始任务 =====`);

        console.log('开始签到');
        const sign = await api.get('/sign/in?dailyTaskId=');
        if (!sign || sign.code != 0) {
            console.log(`用户 ${id} token 已过期，跳过`);
            continue;
        }
        console.log(sign.data.flag ? `签到成功, 获得: ${sign.data.integral}` : '今日已签到');
        await sleep(2000);

        console.log('————————————\n开始任务');
        const taskList = await api.get('/dailyTask/daily');
        if (!taskList || !taskList.data) { console.log('任务列表获取失败'); continue; }

        for (const task of taskList.data) {
            console.log(`任务：${task.name} id: ${task.id}`);
            if (task.status) { console.log('任务已完成'); continue; }

            const total = task.rewardLimit / task.singleReward;

            if (task.id == 14) {
                for (let i = task.finishNum; i < total; i++) {
                    const posts = await api.post('/posts', {
                        topicNames: ['进来笑一个'],
                        content: '护士：你今天有福了，梁老板亲自给你做检查熊顿：梁医生？为什么叫他老板？护士：因为他老板着脸——《滚蛋吧！肿瘤君》',
                        medias: ['https://static.xinc818.com/console/console/28fc4bbb-2678-4957-a619-099898894145.png'],
                        groupId: 0, groupClassifyId: 0,
                        attachments: [{enumType: 1, url: 'https://static.xinc818.com/console/console/28fc4bbb-2678-4957-a619-099898894145.png'}],
                        voteType: 0, commentType: '0',
                        dailyTaskId: task.id, platform: 'windows', sid: 1713957614844
                    });
                    console.log(posts && posts.code == 0 ? `任务完成, 获得：${posts.data.singleReward}` : (posts ? posts.msg : '请求失败'));
                    await sleep(5000);
                }
            }

            if (task.id == 17) {
                let count = total - task.finishNum;
                const sorts = await api.cdn('/posts/sorts?sortType=NEWEST&pageNum=1&pageSize=10&groupClassId=0');
                for (const sort of (sorts?.data?.list || [])) {
                    if (count <= 0) break;
                    const c = await api.post('/postsComments', {customizeImages: [], content: '好', postsId: sort.id, publisherId: id, floorId: '', voice: ''});
                    console.log(`评论成功, 获得：${c?.data?.taskResult?.singleReward}`);
                    count--;
                    await sleep(2000);
                }
            }

            if (task.id == 19) {
                let count = total - task.finishNum;
                const sorts = await api.cdn('/posts/sorts?sortType=NEWEST&pageNum=1&pageSize=10&groupClassId=0');
                for (const sort of (sorts?.data?.list || [])) {
                    if (count <= 0) break;
                    const f = await api.put('/user/follow', {followUserId: sort.publisherId, decision: true});
                    if (f && f.data) { console.log(`关注成功, 获得：${f.data.singleReward}`); count--; }
                    await api.put('/user/follow', {followUserId: sort.publisherId, decision: false});
                    console.log('取消关注成功');
                    await sleep(2000);
                }
            }

            if (task.id == 20) {
                let count = total - task.finishNum;
                const goods = await api.cdn('/integralGoods?orderField=sort&orderScheme=DESC&pageSize=10&pageNum=1');
                for (const good of (goods?.data?.list || [])) {
                    if (count <= 0) break;
                    const detail = await api.cdn(`/integralGoods/${good.id}?type=`);
                    const like = await api.post('/live/likeLiveItem', {isLike: true, dailyTaskId: task.id, productId: detail?.data?.outerId});
                    console.log(`收藏成功, 获得：${like?.data?.singleReward}`);
                    await api.post('/live/likeLiveItem', {isLike: false, dailyTaskId: task.id, productId: detail?.data?.outerId});
                    console.log('取消收藏成功');
                    count--;
                    await sleep(2000);
                }
            }

            if (task.id == 18) {
                let count = total - task.finishNum;
                const sorts = await api.cdn('/posts/sorts?sortType=NEWEST&pageNum=1&pageSize=10&groupClassId=0');
                for (const sort of (sorts?.data?.list || [])) {
                    if (count <= 0) break;
                    const like = await api.put('/posts/like', {postsId: sort.id, decision: true});
                    console.log(`点赞成功, 获得：${like?.data?.singleReward}`);
                    await api.put('/posts/like', {postsId: sort.id, decision: false});
                    console.log('取消点赞成功');
                    count--;
                    await sleep(2000);
                }
            }

            if (task.id == 16) {
                for (let i = task.finishNum; i < total; i++) {
                    const r = await api.get('/dailyTask/share');
                    console.log(`任务完成, 获得：${r?.data?.singleReward}`);
                    await sleep(2000);
                }
            }

            if (task.id == 22) {
                for (let i = task.finishNum; i < total; i++) {
                    const r = await api.get(`/dailyTask/browseGoods/${task.id}`);
                    console.log(`任务完成, 获得：${r?.data?.singleReward}`);
                    await sleep(2000);
                }
            }

            if (task.id == 2) {
                const r = await api.get(`/dailyTask/benefits/${task.id}`);
                console.log(`任务完成, 获得：${r?.data?.singleReward}`);
                await sleep(2000);
            }
        }

        console.log('————————————\n大转盘');
        const free = await api.get('/lottery/65/freeNum');
        const freeNum = free?.data || 0;
        for (let i = 0; i < freeNum; i++) {
            const draw = await api.post('/lottery/draw', {activityId: 65, batch: false, isIntegral: false, userId: id, dailyTaskId: 9});
            console.log(JSON.stringify(draw));
            await sleep(2000);
        }

        console.log('————————————\n走路赢麻了');
        const steps = await api.get('/walkStep/queryUserStepTotal');
        if (steps && steps.data > 100) {
            let count = parseInt(steps.data / 100);
            while (count > 0) {
                await api.get('/walkCell/queryDiceNum');
                const map = await api.get('/walkCell/initMap');
                if (map?.data?.cellType == 3) console.log(`获得碎片：${map.data.prizeResultDTO.pieceName}`);
                if (map?.data?.cellType == 4) console.log(`获得喜点：${map.data.prizeResultDTO.integralNum}`);
                if (map?.data?.cellType == 5 || map?.data?.cellType == 6) console.log(`${map.data.content}`);
                count--;
                await sleep(2000);
            }
        }

        console.log('————————————\n喜点查询');
        const user = await api.get('/user');
        console.log(`用户 ${id} 拥有喜点: ${user?.data?.integral}`);
    }
})().catch(e => console.log('运行错误:', e.message));