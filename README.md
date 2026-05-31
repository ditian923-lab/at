# 注册与号池控制台

这是一个本地运行的自动注册、Developer Key 提取和聚合号池控制台。

## 功能

- 批量导入账号，格式为：

```text
邮箱----密码----client_id----refresh_token
```

- 自动发送邮箱验证码。
- 通过邮箱 API 读取验证码邮件。
- 自动提交 OTP 完成注册 / 登录。
- 开启 Developer Mode。
- 提取 Developer connection string。
- 提供本地可视化前端。
- 提供 OpenAI 兼容的本地聚合号池代理。
- 记录聚合请求状态、使用账号、模型、耗时和 token usage。

## 启动方式

在项目目录运行：

```powershell
npm start
```

然后浏览器打开：

```text
http://localhost:3131
```

## 聚合号池调用方式

默认本地聚合接口：

```text
Base URL: http://localhost:3131/pool/v1
API Key: 123456
```

也就是说，如果你的客户端支持 OpenAI 兼容接口，就这样填写：

```text
接口地址 / Base URL: http://localhost:3131/pool/v1
密钥 / API Key: 123456
```

本地服务会自动从 `sessions/` 目录里的可用 Key 中轮询选择一个，然后转发到脚本里配置的上游接口。

## 修改聚合 Key

本地默认聚合 Key 是：

```text
123456
```

如果要部署到云端或者分享给别人用，可以设置自己的随机 Key：

```powershell
$env:POOL_API_KEY="换成一段很长的随机字符串"
npm start
```

## 账号输入格式

每行一个账号：

```text
example@outlook.com----X----client_id----refresh_token
```

说明：

- 第 1 段：邮箱
- 第 2 段：密码，占位用，当前脚本不使用
- 第 3 段：Microsoft OAuth client_id
- 第 4 段：Microsoft OAuth refresh_token

## 目录说明

```text
server.js        本地 Web 服务和聚合号池代理
public/          前端页面
sessions/        本地运行结果
```

## 注意

本项目适合在你有权限的测试环境、CTF 环境或自用环境中使用。

如果把聚合号池部署到云端给别人调用，实际消耗的是你号池里的账号额度。
