# comic-app 重新优化建议（2026-07-02）

> 基于代码审查和今天已完成工作的重新审视

---

## 🔴 P0 — 必须修复（Bug/缺失功能）

### 1. **CSS 变量不统一** ⚠️ 高风险
**问题**：各页面使用了两套不同的 CSS 变量命名！
- `Bookshelf.vue` / `ChapterMgr.vue` / `ComicList.vue` 使用：`--bg`, `--text`, `--border`, `--brand`
- `DataManager.vue` / `ReadingHistory.vue` / `Shortcuts.vue` 使用：`--bg-primary`, `--text-primary`, `--border-color`

**后果**：切换主题时，一半页面样式会崩！

**方案**：
- 统一到一套变量（建议用 `--bg-primary` / `--text-primary` 这套，更符合现代规范）
- 在 `App.vue` 中统一定义所有变量
- 全局查找替换所有页面

**工作量**：2 小时

---

### 2. **缺失 API：window.windowApi.openPath** 🐛 Bug
**位置**：`DataManager.vue:412`
```js
await window.windowApi.openPath(dbPath.value || '.')
```
**问题**：`window.windowApi` 未在 `preload.js` 中定义！

**修复**：
在 `preload.js` 中添加：
```js
contextBridge.exposeInMainWorld('windowApi', {
  openPath: (path) => ipcRenderer.invoke('window:openPath', path)
})
```
在 `main.js` 中添加：
```js
ipcMain.handle('window:openPath', (_, path) => {
  shell.openPath(path)
})
```

**工作量**：15 分钟

---

### 3. **设置页主题切换无效** 🐛 Bug
**问题**：`Settings.vue` 有主题切换 UI，但：
- `App.vue` 中有 `isDark` ref 和 `data-theme` 属性切换
- 但 CSS 变量没有定义 `dark` 和 `light` 两套！
- 切换后只有 `data-theme` 属性变化，视觉上无任何变化

**方案**：
- 在 `App.vue` 中定义完整的深色主题 CSS 变量（覆盖所有 `--bg-*` / `--text-*` 变量）
- 使用 `[data-theme="dark"]` 选择器
- 测试浅色/深色切换效果

**工作量**：1 小时

---

## 🟡 P1 — 体验优化（高价值）

### 4. **批量操作 UI 未实现** ⚡ 功能缺失
**后端**：已就绪（`batch:delete` / `batch:exportEPUB`）
**前端**：`ComicList.vue` 无多选模式！

**方案**：
- 在 `ComicList.vue` 添加「选择」按钮
- 进入多选模式后，每个漫画卡片显示 checkbox
- 底部显示操作栏：「删除 (3)」/「导出 EPUB (3)」/「取消」
- 调用 `window.batchApi.delete(ids)` 和 `window.batchApi.exportEPUB(ids)`

**工作量**：1 小时

---

### 5. **通知系统未实现** 📢 功能缺失
**后端**：已发送 `download:jobDone` / `crawl:done` 事件
**前端**：未监听，用户不知道任务完成！

**方案**：
在 `App.vue` 中添加：
```js
import { ipcRenderer } from 'electron'
ipcRenderer.on('download:jobDone', (_, data) => {
  new Notification('下载完成', { body: data.title })
})
ipcRenderer.on('crawl:done', (_, data) => {
  new Notification('爬虫完成', { body: `新增 ${data.added} 部漫画` })
})
```

**工作量**：30 分钟

---

### 6. **性能：长列表无虚拟滚动** 🐌 性能瓶颈
**问题**：
- `ComicList.vue` 一次性渲染所有漫画卡片（3065 部 = 3065 个 DOM 节点）
- `Bookshelf.vue` 渲染书架 + 历史记录
- 滚动时会卡顿

**方案**：
- 使用 `vue-virtual-scroller` 或 `vue-virtual-scroll-grid`
- 只渲染可见区域的卡片（比如视口内 20 个，前后各缓冲 10 个）
- 3065 部 → 只渲染 ~40 个 DOM 节点

**工作量**：2 小时（加依赖 + 改造 ComicList）

---

### 7. **Reader.vue 图片加载无优化** 🐌 性能瓶颈
**问题**：
- `v-for="(img, idx) in images"` 一次性加载所有图片
- 100 页的章节 = 100 个 `<img>` 同时加载
- 内存占用高，滑动卡顿

**方案**：
- 使用 IntersectionObserver 懒加载
- 只加载当前页 + 前后各 2 页
- 离开视口的图片设置 `display: none` 或移除 `src`

**工作量**：1 小时

---

## 🟢 P2 — 锦上添花（体验提升）

### 8. **代码重复：fetchData 模式** 🧹 技术债
**问题**：几乎所有页面都有类似的 `fetchData()` 模式：
```js
async function fetchData() {
  loading.value = true
  try {
    const result = await window.xxxApi.yyy()
    data.value = result
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}
onMounted(fetchData)
```

**方案**：
- 创建 `useFetch` composable：
```js
// src/composables/useFetch.js
import { ref } from 'vue'
export function useFetch(fn) {
  const data = ref(null)
  const loading = ref(false)
  const error = ref(null)
  async function execute(...args) {
    loading.value = true
    try {
      data.value = await fn(...args)
    } catch (e) {
      error.value = e
    } finally {
      loading.value = false
    }
  }
  return { data, loading, error, execute }
}
```
- 在各页面中使用

**工作量**：1 小时（创建 composable）+ 2 小时（改造所有页面）

---

### 9. **ComicList.vue 爬虫功能耦合过高** 🧹 架构问题
**问题**：
- `ComicList.vue` 包含了爬虫启动/进度/完成的全部逻辑
- 这会导致：页面复杂、难以维护、爬虫状态和列表状态耦合

**方案**：
- 创建 `useCrawler.js` composable，封装所有爬虫逻辑
- `ComicList.vue` 只调用 `const { start, progress, done } = useCrawler()`
- 更清晰的责任分离

**工作量**：1.5 小时

---

### 10. **离线下载功能未整合** 📴 功能缺失
**问题**：
- `DownloadHistory.vue` 调用 `window.offlineApi.listLocal()`
- 但 `offlineApi` 未在 `preload.js` 中定义！
- 离线下载功能无法使用

**方案**：
- 在 `preload.js` 中添加 `offlineApi`（如果后端已实现）
- 或移除 `DownloadHistory.vue` 中的离线下载 UI（如果后端未实现）

**工作量**：30 分钟检查 + 1 小时修复

---

### 11. **EPubGen.vue 未整合到导航** 🔧 小问题
**问题**：
- `EPubGen.vue` 已创建，但不在侧栏导航中
- 用户无法访问这个功能

**方案**：
- 在 `App.vue` 的 `navItems` 中添加「EPub 生成」链接
- 或整合到「更多」下拉菜单中

**工作量**：10 分钟

---

### 12. **源码插件化未完全利用** 🔧 功能缺失
**问题**：
- `electron/sources/registry.js` 已创建（插件化架构）
- 但 `ComicList.vue` 中爬虫功能还是硬编码调用 `window.crawlerApi`
- 未利用插件系统动态切换数据源

**方案**：
- 在设置页添加「数据源」选择器（调用 `window.sourceApi.list()`）
- `ComicList.vue` 根据选择的数据源动态调用 `window.sourceApi.search(query, sourceId)`
- 支持未来扩展新的漫画网站

**工作量**：2 小时

---

## 🔵 P3 — 后续迭代（大功能）

### 13. **Kavita 集成** 🌐 大功能
**目标**：在 comic-app 中直接访问 Kavita 服务器（已 clone 到 `~/Projects/Kavita/`）

**方案**：
- 在设置页配置 Kavita 服务器地址
- 添加「在 Kavita 中打开」按钮（调用 Kavita API）
- 或嵌入 Kavita Web UI（iframe）

**工作量**：1 天

---

### 14. **云同步阅读进度** ☁️ 大功能
**目标**：在多设备间同步阅读进度（通过 gbrain 或自建 API）

**方案**：
- 在设置页配置同步服务（URL + Token）
- 定期上传阅读进度（防抖）
- 启动时下载并合并进度

**工作量**：1 天

---

### 15. **AI 推荐系统** 🤖 大功能
**目标**：基于阅读历史，推荐相似漫画

**方案**：
- 使用 gbrain 存储用户偏好
- 调用 LLM 分析标签/描述，计算相似度
- 在「我的书架」页面显示推荐

**工作量**：2 天

---

## 📊 优先级总结

| 优先级 | 项数 | 预计工作量 | 说明 |
|---|---|---|---|
| **P0 (Bug)** | 3 项 | 3.25 小时 | CSS 变量统一 + 缺失 API + 主题切换 |
| **P1 (体验)** | 4 项 | 4.5 小时 | 批量操作 + 通知 + 虚拟滚动 + 图片懒加载 |
| **P2 (优化)** | 5 项 | 5.5 小时 | 代码重复 + 爬虫解耦 + 离线下载 + EPub + 插件化 |
| **P3 (大功能)** | 3 项 | 4 天 | Kavita + 云同步 + AI 推荐 |

**总计**：
- **紧急修复**：3.25 小时（今天就能完成）
- **完整优化**：~13 小时 + 4 天大功能

---

## 🚀 建议执行顺序

### 今天（3.25 小时）
1. ✅ 修复 `window.windowApi.openPath` 缺失（15 分钟）
2. ✅ 统一 CSS 变量（2 小时）
3. ✅ 修复设置页主题切换（1 小时）
4. ✅ 检查并修复其他缺失 API（10 分钟）

### 明天（4.5 小时）
5. ✅ 实现批量操作 UI（1 小时）
6. ✅ 实现通知系统（30 分钟）
7. ✅ 添加虚拟滚动（2 小时）
8. ✅ 优化 Reader.vue 图片加载（1 小时）

### 后天（5.5 小时）
9. ✅ 创建 `useFetch` composable（1 小时）
10. ✅ 改造所有页面使用 composable（2 小时）
11. ✅ 创建 `useCrawler` composable（1.5 小时）
12. ✅ 修复离线下载功能（1 小时）
13. ✅ 整合 EPubGen 到导航（10 分钟）

---

## 📝 执行建议

**我可以立即开始修复 P0 的 3 个 Bug**，预计 3.25 小时完成。

**您希望我：**
- A. 立即开始修复 P0 Bug（今天完成）
- B. 先修复 P0 + P1（今天+明天，共 7.75 小时）
- C. 只修复最关键的问题（CSS 变量统一，2 小时）
- D. 其他安排

请指示！🚀
