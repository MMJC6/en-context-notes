# 英文语境笔记 · English Context Notes

> **Just read. The words will remember themselves.**

划词翻译，自动存句。你的私人语境语料库。

不主动学英语，只读你需要的。同一词划 3 次高频、5 次熟悉、7 次掌握——阅读即进步。

---

## 为什么做这个

市面上的翻译插件都在帮你「读懂页面」，但没有人在帮你「记住单词」。

**英文语境笔记**做的事情不一样：你在读技术文章、看新闻、刷 Reddit 时顺手划一个生词，它自动取整句、翻译、保存。下一次在另一篇文章里再遇到这个词时，弹窗告诉你「这是第 3 次遇见了」。你不刻意背，但一个词在不同语境里反复撞见，自然就记住了。

它不是翻译工具，是你的**语境语料库**。

---

## 特性

- **划词自动取整句** — 选中一个词，自动提取包含它的完整句子
- **AI 翻译（词+句）** — 单词在句子语境中的含义 + 整句翻译，一次返回
- **遇见追踪** — 同一个词在不同文章里再次选中时，自动标记「第 N 次遇见」，并显示之前在哪篇文章见过
- **频率分级** — 🔥 3 次高频 · 💚 5 次熟悉 · 🌟 7 次已掌握（自动淡出）
- **TTS 朗读** — 调用 macOS 系统原生语音，发音自然流畅
- **语料库** — 按日期 → 网址 → 单词 三级组织，可搜索、可导出
- **成长概览** — 累计单词数、重复遇见率、日活热力图、高频词排行榜
- **零配置启动** — 安装 → 填入你的 DeepSeek/OpenAI API Key → 开始用
- **数据完全本地** — 所有记录存在浏览器 IndexedDB，不上传任何服务器

---

## 安装

### Chrome Web Store（推荐）

> 即将上架

### 开发者模式（手动加载）

1. 克隆仓库
   ```bash
   git clone https://github.com/MMJC6/en-context-notes.git
   ```
2. 打开 `chrome://extensions/`，开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目目录
4. 右键扩展图标 → 选项，填入 API Key

---

## 配置

支持所有 OpenAI 兼容接口。推荐 [DeepSeek](https://platform.deepseek.com/)（新用户送 500 万 token，几乎免费）。

| 设置项 | 默认值 |
|--------|--------|
| API Base URL | `https://api.deepseek.com/v1` |
| Model | `deepseek-chat` |
| API Key | *需要你自己申请* |

---

## 技术栈

纯原生 JavaScript，零依赖，零构建步骤。

```
manifest.json     # Chrome MV3
background.js     # Service Worker · API 调用 · IndexedDB
content.js        # 划词监听 · 取整句 · 弹窗 UI · TTS
history.html/js   # 全屏语料库 + 成长概览
popup.html/js     # 工具栏弹窗
options.html/js   # API 设置页
```

---

## 路线图

- [x] 划词翻译 + 自动取整句
- [x] AI 翻译（词+句）
- [x] 遇见追踪 + 频率分级
- [x] 语料库（按日期/网址分组）
- [x] 成长概览
- [x] TTS 朗读
- [ ] Chrome Web Store 上架
- [ ] 云同步（Firebase）
- [ ] 手机 App（查看语料库）
- [ ] 导入/导出 Anki

---

## License

MIT
