# 从 Pjax 迁移到 TurboFeLy

## 核心能力对比

| 功能特性              | Pjax                        | TurboFeLy                               |
|----------------------|-----------------------------|----------------------------------------|
| **更新策略**          | 全量替换容器内容               | 支持 `replace`/`diff` 两种模式           |
| **缓存机制**          | 无内置缓存                   | LRU 缓存 + TTL + 多维度缓存键            |
| **动画支持**          | 需手动实现                   | 内置 CSS 动画系统                        |
| **预取策略**          | 不支持                      | 支持鼠标悬停/触摸延迟预取                  |
| **DOM 对比**          | 无                         | 智能节点对比 + 属性同步                   |
| **移动端优化**        | 基础支持                    | 触摸延迟优化 + 点击区域增强                |
| **脚本执行**          | 自动执行新脚本               | 智能去重 + 安全执行机制                   |
| **事件系统**          | 有限事件                    | 完善的生命周期事件                        |
| **性能监控**          | 无                         | 内置调试日志 + DOM 变更追踪               |

## 迁移步骤

### 1. 安装替换
```html
<!-- 移除 Pjax -->
<script src="pjax.js"></script>

<!-- 引入 TurboFeLy -->
<script src="turbo-fe-ly.js"></script>
```

### 2. 初始化配置迁移
```javascript
// Pjax 配置
new Pjax({
  elements: "a",
  selectors: ["#main"]
});

// TurboFeLy 等效配置
new TurboFeLy({
  linkSelector: 'a[href]',          // 匹配所有链接
  container: '#main',               // 目标容器
  updateMode: 'replace',            // 使用替换模式（兼容 Pjax 行为）
  cacheSize: 0                      // 禁用缓存
});
```

### 3. 事件监听器迁移
```javascript
// Pjax 事件
document.addEventListener('pjax:send', handleStart);
document.addEventListener('pjax:complete', handleEnd);

// TurboFeLy 等效事件
document.addEventListener('turbo:before-navigate', handleStart);
document.addEventListener('turbo:after-update', handleEnd);
```

### 4. 脚本处理适配
```javascript
// Pjax 需要手动重新初始化组件
$(document).on('pjax:end', function() {
  initComponents();
});

// TurboFeLy 自动处理以下情况：
// - 带 src 的脚本自动去重
// - 内联脚本自动执行
// 只需处理特殊情况的重新初始化：
document.addEventListener('turbo:after-update', ({ detail }) => {
  if (!detail.isBack) initComponents();
});
```

### 5. 动画过渡适配
```css
/* 移除 Pjax 自定义动画 */
#main { transition: opacity .3s; }

/* 启用 TurboFeLy 内置动画 */
new TurboFeLy({
  animate: true,
  animationDuration: 300
});

/* 自定义动画（可选） */
.turbo-animate-out { /* 离场动画 */ }
.turbo-animate-in { /* 入场动画 */ }
```

## 配置项对照表

| Pjax 配置项          | TurboFeLy 等效配置                | 说明                          |
|----------------------|----------------------------------|-----------------------------|
| `elements`           | `linkSelector`                  | 选择器需包含 `a[href]` 属性     |
| `selectors`          | `container`                     | 支持单个 CSS 选择器            |
| `switches`           | `updateMode: 'diff'`            | 需配合 DOM 结构化设计使用       |
| `cacheBust`          | `cacheByViewport: true`         | 更细粒度的缓存控制              |
| `timeout`            | `prefetchDelay` + `loadingDelay`| 拆分为不同阶段的超时控制          |

## 高级功能迁移

### 差异更新模式
```javascript
new TurboFeLy({
  updateMode: 'diff',
  diffThreshold: 0.6,       // 当子节点差异超过 60% 时执行替换
  maxDiffDepth: 20,         // 最大对比深度
  ignoreAttributes: ['data-no-diff'] // 忽略指定属性变化
});
```

### 缓存策略优化
```javascript
new TurboFeLy({
  cacheSize: 15,                     // 缓存 15 个页面
  cacheTTL: 30 * 60 * 1000,         // 30 分钟有效期
  cacheByViewport: true,             // 按视口尺寸缓存
  cacheByUserAgent: false            // 不区分 UA
});
```

### 脚本执行控制
```html
<!-- 避免重复加载 -->
<script src="analytics.js" data-turbo-exec="once"></script>

<!-- 强制每次更新执行 -->
<script data-turbo-exec="always">
  console.log('每次更新执行');
</script>
```

## 常见问题处理

### 保留滚动位置
```javascript
// 记录自定义滚动位置
document.addEventListener('turbo:before-navigate', () => {
  turbo.recordScrollPosition(customPositionKey);
});

// 恢复滚动位置
document.addEventListener('turbo:after-update', ({ detail }) => {
  if (detail.isBack) {
    window.scrollTo(savedPosition.x, savedPosition.y);
  }
});
```

### 自定义加载指示器
```javascript
new TurboFeLy({
  loadingClass: 'custom-loading',
  loadingDelay: 300
});

/* CSS 自定义样式 */
.custom-loading::after {
  /* 自定义加载动画 */
}
```

### 处理表单提交
```javascript
// 拦截表单提交
document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const response = await fetch(e.target.action, {
    method: 'POST',
    body: new FormData(e.target)
  });

  const html = await response.text();
  turbo.applyUpdate(html);
});
```

## 升级建议

1. **渐进式迁移**：
   ```javascript
   // 混合模式初始化
   const turbo = new TurboFeLy({
     linkSelector: '[data-turbo]',  // 仅对新链接生效
     fallbackToReplace: true
   });
   ```

2. **性能优化**：
   ```javascript
   // 启用生产模式
   new TurboFeLy({
     debug: false,
     animate: window.matchMedia('(prefers-reduced-motion: no-preference)').matches
   });
   ```

3. **错误监控**：
   ```javascript
   document.addEventListener('turbo:error', ({ detail }) => {
     logError(detail.error);
     if (detail.error.message.includes('Failed to fetch')) {
       showNetworkErrorToast();
     }
   });
   ```

4. **SEO 增强**：
   ```javascript
   // 服务端识别 TurboFeLy 请求
   turbo.options.headers = {
     'X-Requested-With': 'TurboFeLy'
   };
   ```

通过遵循本指南，您可以充分利用 TurboFeLy 的现代功能，同时保持与现有 Pjax 实现的兼容性。建议在开发环境启用 `debug: true` 以监控迁移过程中的 DOM 变更。