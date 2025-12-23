#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
青龙脚本：嘉立创自动签到
环境变量：jlcToken
格式：token1&token2 或 token1\ntoken2
cron: 0 8 * * *
const $ = new Env("嘉立创签到");
"""

import requests
import json
import time
import random
import os
import sys
import re

# ======== 修复通知导入开始 ========
# 获取当前脚本所在目录
current_dir = os.path.dirname(os.path.abspath(__file__))
# 获取上一级目录（即 diy 的上一级，通常是青龙的脚本根目录）
parent_dir = os.path.dirname(current_dir)

# 将上一级目录加入到系统路径，这样才能找到 notify.py
if parent_dir not in sys.path:
    sys.path.append(parent_dir)

# 尝试导入青龙通知模块
try:
    # 注意：你说文件名为 notify.py，所以这里必须导入 notify，而不是 sendNotify
    from notify import send
except ImportError:
    try:
        #以此防万一，如果文件名是 sendNotify.py 则尝试这个
        from sendNotify import send
    except ImportError:
        def send(title, content):
            print("未找到 notify 或 sendNotify 模块，仅打印日志到控制台。")
            print(f"【标题】{title}")
            print(f"【内容】{content}")
# ======== 修复通知导入结束 ========

# 环境变量名称
ENV_NAME = 'jlcToken'

# 接口配置
URL_SIGN = 'https://m.jlc.com/api/activity/sign/signIn?source=3'
URL_ASSETS = "https://m.jlc.com/api/appPlatform/center/assets/selectPersonalAssetsInfo"
URL_VOUCHER = "https://m.jlc.com/api/activity/sign/receiveVoucher"

# 全局日志容器
msg_all = []

# ======== 工具函数 ========

def log(content):
    """记录日志并打印"""
    print(content)
    msg_all.append(content)

def get_env():
    """获取环境变量中的 Token"""
    tokens = os.getenv(ENV_NAME)
    if not tokens:
        return []
    
    # 支持 & 或换行符分隔
    if '&' in tokens:
        return tokens.split('&')
    elif '\n' in tokens:
        return tokens.split('\n')
    else:
        return [tokens]

def mask_account(account):
    """账号脱敏"""
    if not account:
        return '未知'
    if len(account) >= 4:
        return account[:2] + '****' + account[-2:]
    return '****'

# ======== 业务逻辑 ========

def sign_in(access_token, index, total):
    """单个账号签到逻辑"""
    headers = {
        'X-JLC-AccessToken': access_token.strip(),
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) '
                      'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/20) JlcMobileApp',
    }

    log(f"\n────── 正在处理第 {index}/{total} 个账号 ──────")

    try:
        # 1. 获取用户信息（用于获取 customerCode 和 当前金豆）
        bean_response = requests.get(URL_ASSETS, headers=headers)
        if bean_response.status_code == 401:
            log(f"❌ [账号{index}] Token 已失效，请重新抓包")
            return
        
        bean_response.raise_for_status()
        bean_result = bean_response.json()

        if not bean_result.get('data'):
             log(f"❌ [账号{index}] 获取用户信息失败: {bean_result.get('message')}")
             return

        customer_code = bean_result['data'].get('customerCode', '')
        integral_voucher = bean_result['data'].get('integralVoucher', 0)
        account_mask = mask_account(customer_code)

        # 2. 执行签到
        sign_response = requests.get(URL_SIGN, headers=headers)
        sign_response.raise_for_status()
        sign_result = sign_response.json()

        success = sign_result.get('success')
        message = sign_result.get('message', '')
        data = sign_result.get('data', {})

        # 判断结果
        if not success:
            if '已经签到' in message:
                log(f"ℹ️ [账号: {account_mask}] 今日已签到")
                log(f"💰 当前金豆: {integral_voucher}")
            else:
                log(f"❌ [账号: {account_mask}] 签到失败: {message}")
            return

        # 签到成功处理
        gain_num = data.get('gainNum', 0)
        status = data.get('status', 0)

        if status > 0:
            if gain_num and gain_num > 0:
                log(f"✅ [账号: {account_mask}] 签到成功")
                log(f"🎁 获得金豆: {gain_num} 个")
                log(f"💰 当前总数: {integral_voucher + gain_num}")
            else:
                # 尝试领取第七天奖励
                log(f"ℹ️ [账号: {account_mask}] 尝试领取连签奖励...")
                seventh_response = requests.get(URL_VOUCHER, headers=headers)
                seventh_result = seventh_response.json()

                if seventh_result.get("success"):
                    log(f"🎉 [账号: {account_mask}] 七天连签奖励领取成功！")
                    log(f"💰 当前总数: {integral_voucher + 8} (预估)")
                else:
                    log(f"ℹ️ [账号: {account_mask}] 无奖励可领取 或 {seventh_result.get('message')}")
        else:
            log(f"ℹ️ [账号: {account_mask}] 状态码异常，可能已签到")

    except requests.exceptions.RequestException as e:
        log(f"❌ [账号{index}] 网络请求失败: {e}")
    except Exception as e:
        log(f"❌ [账号{index}] 脚本执行出错: {e}")

# ======== 主程序 ========

def main():
    print("🏁 嘉立创自动签到任务开始")
    
    token_list = [t for t in get_env() if t.strip()]
    
    if not token_list:
        print(f"❌ 未找到环境变量 {ENV_NAME}，请在青龙面板中设置。")
        return

    print(f"🔧 共发现 {len(token_list)} 个账号")

    for i, token in enumerate(token_list):
        sign_in(token, i + 1, len(token_list))
        
        # 随机延迟，防止黑号 (最后一个账号不需要等待)
        if i < len(token_list) - 1:
            wait_time = random.randint(5, 15)
            print(f"⏳ 等待 {wait_time} 秒...")
            time.sleep(wait_time)

    # 推送通知
    print("\n📬 正在发送通知...")
    send_content = '\n'.join(msg_all)
    send("嘉立创签到汇总", send_content)
    print("🏁 任务执行完毕")

if __name__ == '__main__':
    main()
