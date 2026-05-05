# 英文语境笔记 — 开发文档 & 交接手册

## 项目概览

一款 Chrome 浏览器扩展（MV3）。用户在英文网页上划词 → 自动提取完整句子 → AI 翻译（单词上下文释义 + 整句翻译）→ 浮窗展示 → 自动存入本地语料库。同一个词在不同文章中反复遇到时，自动追踪遇见次数并标记频率等级。

**核心理念**：不主动背单词，靠自然重复遇见来记住。

---

## 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 运行时 | Chrome Extension MV3 | Manifest V3，Service Worker |
| 语言 | 纯 JavaScript (ES2020+) | 零依赖，零构建，零打包 |
| 样式 | 纯 CSS | Catppuccin Mocha 深色主题 |
| 存储 | IndexedDB | 语料库持久化 |
| 缓存 | chrome.storage.session | 翻译缓存，Service Worker 重启后存活 |
| 设置 | chrome.storage.local | API Key / Base URL / Model |
| 语音 | chrome.tts | 系统原生 TTS（macOS Samantha） |
| AI | OpenAI 兼容 API | DeepSeek / OpenAI / 自定义 |
| 保活 | chrome.alarms | 15 秒心跳防 Worker 休眠 |

---

## 文件结构

```
en-context-notes/
├── manifest.json         # 扩展清单（权限、入口、图标）
├── background.js         # Service Worker — API 调用、IndexedDB、TTS、消息路由
├── content.js            # 内容脚本 — 划词监听、取整句、浮窗 UI
├── content.css           # 浮窗样式
├── popup.html/js/css     # 工具栏弹窗 — 最近单词列表
├── history.html/js/css   # 全屏语料库 — 记录浏览 + 成长概览
├── options.html/js/css   # 设置页 — API 配置
├── icons/                # 扩展图标 (16/48/128px PNG)
├── README.md             # 项目介绍
├── LICENSE               # MIT
└── DEVELOPMENT.md        # 本文档
```

---

## 架构 & 数据流

### 核心流程：划词 → 翻译 → 存储

```
用户在页面划词
    │
    ▼
content.js: onMouseUp()
    │ 防抖 250ms，检查非中文、含英文字母
    ▼
content.js: getFullSentence()
    │ DOM TreeWalker 向前后扩展至句子边界 (.!?)
    ▼
content.js: showPopup()
    │ 动态注入浮窗 DOM，显示原文 + 加载动画
    ▼
content.js: translateAndUpdate()
    ├──► background.js: 'checkWord'  → 异步查询该词是否已存在
    ├──► background.js: 'translate'  → AI API 翻译（词+句合并为一次调用）
    │
    ▼ 翻译结果返回
    │
content.js: 更新浮窗 DOM
    │ 显示单词释义 + 整句翻译 + 遇见次数（如是重复词）
    │
content.js: → background.js: 'saveRecord'
    │ 已存在 → upsert（encounterCount++，contexts 追加）
    │ 新词   → insert（encounterCount=1，创建 contexts）
    ▼
浮窗显示 "✓ 已保存" 或 "第 N 次遇见"
```

### 消息协议

| Action | 方向 | 请求 | 响应 |
|--------|------|------|------|
| `translate` | content → bg | `{ word, sentence }` | `{ wordTranslation, sentenceTranslation }` 或 `{ error }` |
| `checkWord` | content → bg | `{ word }` | `{ found: bool, record }` |
| `saveRecord` | content → bg | `{ record: { word, wordTranslation, sentence, sentenceTranslation, url, title } }` | `{ success, id, isRepeat, encounterCount }` |
| `getAllRecords` | history → bg | — | `{ records: [...] }` |
| `getRecordsByUrl` | popup → bg | — | `{ groups: [...] }` |
| `deleteRecord` | * → bg | `{ id }` | `{ success }` |
| `deduplicate` | history → bg | — | `{ success, merged }` |
| `speak` | * → bg | `{ text }` | `{ success }` |
| `getSettings` | options → bg | — | `{ apiKey, apiBase, apiModel }` |
| `openOptions` | content → bg | — | 打开设置页 |

### IndexedDB 数据模型

数据库：`enLearnDB` (v3)
对象存储：`records`，keyPath: `id`
索引：`url`、`timestamp`、`word`

```js
{
  id: "uuid",                    // 首次遇见时生成，后续 upsert 复用
  word: "deepen",                // 用户选中的词
  wordTranslation: "加深",        // AI 翻译（上下文）
  sentence: "A place to ...",    // 完整句子
  sentenceTranslation: "一个...的地方",
  url: "https://...",            // 页面 URL
  title: "Article Title",        // 页面标题
  timestamp: 1746412800000,      // 首次遇见时间
  encounterCount: 3,             // 遇见总次数
  firstEncounteredAt: 1746412800000,
  contexts: [                    // 每次遇见的上下文
    { url, title, sentence, timestamp },
    ...
  ]
}
```

### 翻译缓存

- 存储位置：`chrome.storage.session`
- 键格式：`h_<hash(word + '|||' + sentence)>`
- 容量限制：最多 500 条
- 生命周期：浏览器重启后清空（合理：新会话重新构建缓存）

---

## 关键函数索引

### background.js

| 函数 | 行号（大约） | 职责 |
|------|-------------|------|
| `openDB()` | 42 | 打开/创建 IndexedDB，处理版本迁移 |
| `checkWord(word)` | 95 | 大小写不敏感全扫描查词 |
| `deduplicateAll()` | 108 | 合并重复记录（历史数据清理） |
| `saveRecord(record)` | 165 | IndexedDB put 写入 |
| `getRecordsByUrl()` | 175 | 按 URL 分组返回记录 |
| `getAllRecords()` | 200 | 返回全部记录 |
| `deleteRecord(id)` | 210 | 按 ID 删除 |
| `callAI(...)` | 240 | 调用 OpenAI 兼容 API |
| `handleMessage(...)` | 288 | 消息路由中心 |

### content.js

| 函数 | 职责 |
|------|------|
| `isChinesePage()` | 页面前 5000 字汉字占比 > 30% 则跳过 |
| `onMouseDown/Up()` | 鼠标事件处理，弹窗内点击不触发关闭 |
| `handleSelection()` | 校验选中文本，触发取句和翻译 |
| `getFullSentence()` | TreeWalker 向前后扩展至句子边界 |
| `findTextOffset()` | 在 DOM 块内定位选中文本的字符偏移 |
| `createPopup()` | 创建浮窗 DOM 结构 |
| `showPopup()` | 定位并显示浮窗 |
| `translateAndUpdate()` | 翻译流程编排：checkWord → translate → saveRecord |
| `showOnboarding()` | 首次使用引导（未配置 API Key 时） |
| `showError()` | 错误信息展示 |
| `toggleSpeak()` | TTS 播放/停止（发给 background） |

---

## 开发 & 调试

### 本地加载

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择项目根目录
4. 修改代码后点击刷新图标 🔄

### 查看日志

- **Service Worker 日志**：`chrome://extensions/` → 点击扩展卡片的「service worker」链接 → 打开 DevTools
- **Content Script 日志**：在任意网页上右键 → 检查 → Console（日志带 `[content]` 前缀）
- **弹窗日志**：右键扩展图标 → 检查弹出内容

### 调试消息通信

在 Service Worker Console 和网页 Console 之间对比日志。关键日志标记：
- `[checkWord]` — 查词结果
- `[saveRecord]` — 保存状态（NEW / UPSERT）

### 修改后测试清单

- [ ] 英文网页划词 → 弹窗出现
- [ ] 翻译正确显示（单词释义 + 整句翻译）
- [ ] 第一次遇见图标「已保存」
- [ ] 重复遇见图标「第 N 次遇见」
- [ ] 朗读按钮正常播放/停止
- [ ] 弹窗内点击不消失
- [ ] 中文网页划词不触发
- [ ] 扩展弹窗显示最近单词
- [ ] 全屏语料库页面正常加载
- [ ] 成长概览统计数据正确
- [ ] 设置页保存 API Key 生效
- [ ] 30 秒不操作后再次划词仍正常工作

---

## 已知限制

1. **`host_permissions: ["<all_urls>"]`** — Chrome Web Store 审核会较慢，需逐权限解释用途
2. **取整句算法** — 依赖 DOM TreeWalker，在复杂页面（如 Twitter 时间线、代码编辑器）可能取不到理想范围
3. **高频词去重** — 使用全扫描 + 大小写不敏感比较，记录数 < 10k 时性能无问题，超出后建议加 `wordLower` 索引
4. **TTS** — 依赖操作系统 TTS 引擎。Windows 上中文语音质量可能不如 macOS。可通过 `chrome.tts.getVoices()` 查看可用语音
5. **Service Worker** — MV3 会在闲置 30 秒后终止 Worker。本扩展用 `chrome.alarms` 15 秒心跳保持活跃

---

## 发布到 Chrome Web Store

### 打包

```bash
cd en-context-notes
zip -r en-context-notes.zip . -x "*.DS_Store" ".git/*"
```

确保 `manifest.json` 在 zip 根目录。

### 提审清单

- [ ] 开启 Google 账号两步验证
- [ ] 支付 $5 开发者注册费（需 Visa/Mastercard）
- [ ] 128×128 商店图标
- [ ] 至少 1 张 1280×800 截图
- [ ] 单一用途说明
- [ ] 每个权限的用途解释
- [ ] 隐私政策 URL（可放在 GitHub Pages）
- [ ] 数据合规三项声明（不出售、不广告、不信用评估）
- [ ] 远程代码选择「否」

---

## 未来扩展方向

- **云同步**：Firebase Firestore，按用户 ID 存储记录。需登录系统
- **手机 App**：从 Firebase 读取语料库，纯展示 + 搜索
- **AI 语音朗读**：OpenAI TTS，缓存音频 blob 到 IndexedDB
- **导入/导出 Anki**：导出为 Anki 兼容格式
- **词汇量估算**：基于遇见频率和间隔时间，估算已掌握的词汇量
- **Firefox / Edge 移植**：代码基本兼容，manifest 稍作调整即可
