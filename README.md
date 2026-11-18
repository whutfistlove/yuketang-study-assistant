# 雨课堂学习助手

雨课堂的个人玩具项目。支持顺序播放视频、阅读课件，以及按设置处理讨论和普通练习。

## Windows 本机版

1. 安装 Microsoft Edge 和 [Node.js 24](https://nodejs.org/)，下载或克隆本仓库。
2. 双击 `start.cmd`，在独立的 Edge 窗口中登录雨课堂并打开课程。通过右下角面板可以开始或停止。
3. 如需 AI 功能，先在面板「设置」中保存模型接口和模型名。双击 `set-ai-key.cmd` 输入该接口的 API Key，再刷新学习页并打开需要的 AI 选项。Windows 会在本机加密保存密钥。

DeepSeek 官方接口可填写 `https://api.deepseek.com/chat/completions`，模型填 `deepseek-flash`，接口格式选 OpenAI。开启 AI 功能后，相关题干、题区截图或讨论题目会发送到所配置的服务。

## 用户脚本

也可将 `study-core.js` 的内容复制到 Tampermonkey。需要模型读取题区截图时，使用 Windows 本机版。

## 免责声明

本项目是独立开发的玩具，供学习和本地实验。请遵守平台、学校和课程的规定，核对模型答案与提交结果。软件按许可证原样提供，使用者自行承担使用风险。

原用户脚本作者为风之子。本项目按 [GPL-3.0](LICENSE) 发布。
