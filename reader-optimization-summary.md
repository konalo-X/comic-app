# Reader.vue 图片加载优化总结

## 修改日期
2026-07-02

## 优化内容

### 1. IntersectionObserver 懒加载
**问题**：单页和双页模式下，所有图片同时请求，导致带宽浪费和加载缓慢

**解决方案**：
- 添加了 `setupIntersectionObserver()` 函数初始化 IntersectionObserver
- 使用 `data-src` 属性存储真实图片 URL，初始不设置 `src`
- 当图片进入视口（提前 200px）时才设置 `src` 触发加载
- 添加了 `observeImage()` 和 `unobserveImage()` 函数管理观察者
- 添加了 `rebindLazyLoad()` 函数在 DOM 更新后重新绑定观察者

**实现细节**：
- Single 模式：图片使用 `:data-src` 替代 `:src`，通过 `ref` 绑定观察者
- Double 模式：左右两页同样使用懒加载
- Scroll 模式：保持原有的 `loading="lazy"`，无需修改

### 2. 章节预加载
**问题**：切换章节时需要等待新章节的图片加载

**解决方案**：
- 在 `loadChapter()` 末尾添加 `preloadNextChapter()` 调用
- `preloadNextChapter()` 函数会异步获取下一章的图片列表
- 使用 `new Image()` 预加载下一章的前 3 张图片
- 预加载的图片存储在 `preloadImages` 数组中，组件卸载时清理

### 3. 图片加载失败占位符
**问题**：图片加载失败时显示白屏，用户体验差

**解决方案**：
- 修改 `onImageError()` 函数，标记加载失败状态 `loadedImages[idx] = 'error'`
- 在模板中检查加载状态，如果失败则显示 SVG 占位符
- 占位符显示灰色背景和"图片加载失败"文字
- 添加了 `.placeholder` CSS 类确保占位符正确显示

### 4. 其他改进
- 在 `onMounted` 中初始化 IntersectionObserver
- 在 `setMode()` 中切换模式时重新绑定懒加载
- 在 `onBeforeUnmount` 中清理观察者和预加载图片
- 使用 `onBeforeUnmount` 替代 `onUnmounted`（Vue 3 推荐）

## 文件修改位置

### Template 部分
- Single 模式图片标签：使用 `:data-src` 和 `ref="el => el && observeImage(el)"`
- Double 模式图片标签：同样使用懒加载
- 添加占位符显示逻辑

### Script 部分
- 添加新的导入：`onBeforeUnmount`
- 添加 IntersectionObserver 相关函数
- 添加 `preloadNextChapter()` 函数
- 修改 `onImageError()` 函数
- 在生命周期钩子中初始化和清理

### Style 部分
- 添加 `.comic-image.placeholder` 样式

## 验证结果
- Vite 构建无错误
- 三种模式（single/double/scroll）均正常工作
- 懒加载只在图片进入视口时触发
- 预加载功能在章节加载完成后自动执行
- 图片加载失败时显示占位符

## 性能提升
- 减少初始加载时间：只加载可见图片
- 节省带宽：不会加载用户未查看的图片
- 提升用户体验：章节切换更快，有错误反馈

## 注意事项
- IntersectionObserver 需要浏览器支持（现代浏览器都支持）
- 预加载功能依赖于 `window.readerApi.getChapterImages` 方法
- 占位符使用 data URI，不会触发额外请求
