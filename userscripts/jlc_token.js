// ==UserScript==
// @name         JLC/开源平台 Token 移动端抓取助手
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  专为移动端设计：提取 m.jlc.com 的 Token 或 oshwhub.com 的 Cookie，点击悬浮球自动复制。
// @author       xlxzhc
// @match        *://m.jlc.com/*
// @match        *://oshwhub.com/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ================= 配置样式 =================
    const btnStyle = `
        #jlc-grab-btn {
            position: fixed;
            top: 20%;
            right: 0;
            z-index: 99999;
            background: rgba(30, 144, 255, 0.8);
            color: white;
            padding: 10px 15px;
            border-radius: 20px 0 0 20px;
            font-size: 14px;
            font-weight: bold;
            box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            cursor: pointer;
            user-select: none;
            transition: all 0.3s;
        }
        #jlc-grab-btn:active {
            background: rgba(30, 144, 255, 1);
            transform: scale(0.95);
        }
    `;

    const toastStyle = `
        .jlc-toast {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            z-index: 100000;
            font-size: 14px;
            text-align: center;
            max-width: 80%;
            word-break: break-all;
            animation: fadeIn 0.3s;
        }
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
    `;

    // 注入样式
    GM_addStyle(btnStyle + toastStyle);

    // ================= 功能函数 =================

    // 显示屏幕提示 (Toast)
    function showToast(msg, isError = false) {
        const toast = document.createElement('div');
        toast.className = 'jlc-toast';
        toast.style.border = isError ? '1px solid #ff4d4f' : '1px solid #52c41a';
        toast.innerHTML = msg;
        document.body.appendChild(toast);

        // 3秒后自动消失
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // 执行复制操作
    function doCopy(text, type) {
        try {
            // 优先尝试 GM_setClipboard
            GM_setClipboard(text);
            showToast(`✅ 成功提取 ${type}<br>已复制到剪贴板！`);
        } catch (e) {
            // 降级方案：使用 textarea
            try {
                const input = document.createElement('textarea');
                input.value = text;
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                document.body.removeChild(input);
                showToast(`✅ 成功提取 ${type}<br>已复制到剪贴板！`);
            } catch (err) {
                showToast(`❌ 提取成功但复制失败<br>请手动截图`, true);
                console.error(err);
            }
        }
    }

    // 主提取逻辑
    function extractToken() {
        const host = window.location.hostname;
        let resultValue = "";
        let resultType = "";

        // 1. 嘉立创 m.jlc.com
        if (host.includes("m.jlc.com")) {
            const possibleKeys = ['X-JLC-AccessToken', 'token', 'accessToken', 'Authorization'];
            let token = "";
            for (let key of possibleKeys) {
                token = localStorage.getItem(key);
                if (token) break;
            }

            if (token) {
                token = token.replace(/^Bearer\s+/i, "");
                resultValue = token;
                resultType = "JLC Token";
            } else {
                showToast("❌ 未找到 Token，请确认已登录嘉立创账号", true);
                return;
            }
        }
        // 2. 开源平台 oshwhub.com
        else if (host.includes("oshwhub.com")) {
            const cookie = document.cookie;
            if (cookie && cookie.length > 0) {
                resultValue = cookie;
                resultType = "开源平台 Cookie";
            } else {
                showToast("❌ 未找到 Cookie，请确认已登录", true);
                return;
            }
        } else {
            showToast("⚠️ 当前网站不支持抓取", true);
            return;
        }

        // 如果获取到了值，执行复制
        if (resultValue) {
            doCopy(resultValue, resultType);
        }
    }

    // ================= 创建界面 =================

    function createFloatingButton() {
        const btn = document.createElement('div');
        btn.id = 'jlc-grab-btn';
        btn.innerText = '抓取Token';
        btn.onclick = extractToken; // 绑定点击事件
        document.body.appendChild(btn);
    }

    // 初始化
    createFloatingButton();

    // 为了防止 SPA 页面加载延迟，延迟1秒自动尝试一次（可选，不喜欢自动弹窗可注释掉下面这行）
    // setTimeout(extractToken, 1000);

})();