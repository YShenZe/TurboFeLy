# 从 Pjax 迁移到 TurboFeLy

## 核心架构技术对比

### 1. DOM 更新引擎原理
```mermaid
flowchart TB
    subgraph Pjax
        A[获取HTML] --> B[全量替换容器]
        B --> C[重新执行所有脚本]
    end
    
    subgraph TurboFeLy
        D[获取HTML] --> E[构建虚拟DOM树]
        E --> F{缓存对比}
        F -->|匹配| G[应用差异补丁]
        F -->|不匹配| H[全量更新]
        G --> I[局部脚本执行]
        H --> J[智能脚本恢复]
    end
    
    style F fill:#4CAF50,stroke:#2E7D32
    style G fill:#2196F3,stroke:#1565C0
```

### 2. 缓存机制实现差异
```mermaid
classDiagram
    class PjaxCache {
        + store: Object
        + get(key): String
        + set(key, value): void
    }
    
    class TurboCache {
        + maxSize: Number
        + ttl: Number
        + lruKeys: Array
        + storage: Map
        + get(key): <html: String, expireAt: Number>
        + set(key, value): void
        + prune(): void
    }
    
    interface LRUAlgorithm {
        + updateLRU(key): void
    }
    
    interface TTLExpiration {
        + checkExpiration(key): Boolean
    }
    
    interface DimensionIsolation {
        + isolate(key): void
    }
    
    TurboCache <|-- LRUAlgorithm
    TurboCache <|-- TTLExpiration
    TurboCache <|-- DimensionIsolation
```

## 分模块技术迁移方案

### 1. 配置项映射表
| Pjax 配置项 | TurboFeLy 等效配置 | 技术差异说明 |
|------------|--------------------|-------------|
| `elements` | `linkSelector` | 支持 CSS4 选择器语法 |
| `selectors` | `container` | 支持多个容器级联 |
| `cacheBust` | `fetchHeaders` | 使用现代缓存控制头 |
| `timeout` | `prefetchDelay` | 分场景延迟配置 |

```javascript
// 迁移示例
// Pjax
new Pjax({
  elements: "a:not([data-no-pjax])",
  selectors: ["#main"],
  cacheBust: true
})

// TurboFeLy
new TurboFeLy({
  linkSelector: 'a:not([data-turbo-disable])',
  container: '#main',
  fetchHeaders: { 
    'Cache-Control': 'no-cache',
    'X-TurboFeLy': 'true'
  }
})
```

### 2. DOM 处理技术升级
```mermaid
sequenceDiagram
    participant P as Pjax
    participant T as TurboFeLy
    
    Note over P: 全量替换流程
    P->>P: 1. 移除旧容器
    P->>P: 2. 插入新HTML
    P->>P: 3. 执行所有脚本
    
    Note over T: 智能更新流程
    T->>T: 1. 解析新DOM树
    T->>T: 2. 生成变更记录
    alt 文本节点
        T->>T: 3a. 直接更新textContent
    else 元素节点
        T->>T: 3b. 递归比对子节点
    end
    T->>T: 4. 按需执行脚本
```

#### 迁移时需要修改的代码模式：
```javascript
// Pjax 典型模式（需改造）
document.querySelector('#main').innerHTML = newContent
initComponents() // 需要手动重新初始化

// TurboFeLy 优化模式
// 自动完成DOM差异更新
// 通过 data-turbo-id 保留状态
<div data-turbo-id="user-panel">
  <!-- 动态内容 -->
</div>
```

### 3. 事件系统技术迁移
```mermaid
stateDiagram-v2
    [*] --> PjaxEvent
    PjaxEvent --> TurboEvent: 转换
    TurboEvent --> Advanced: 增强特性
    
    state TurboEvent {
        [*] --> BeforeNavigate
        BeforeNavigate --> CacheCheck
        CacheCheck --> DOMUpdate
        DOMUpdate --> AfterUpdate
        
        state DOMUpdate {
            [*] --> DiffStart
            DiffStart --> AttributeSync
            AttributeSync --> ChildProcessing
        }
    }
    
    state Advanced {
        [*] --> ScriptHydration
        ScriptHydration --> StateRestoration
    }
```

#### 事件监听器改造示例：
```javascript
// Pjax 事件
document.addEventListener('pjax:send', () => {
  NProgress.start()
})

// TurboFeLy 等效实现
document.addEventListener('turbo:before-navigate', ({ detail }) => {
  if (!detail.canceled) {
    NProgress.start()
    
    // 新增访问控制能力
    if (detail.url.includes('/admin')) {
      detail.preventDefault()
      redirectToLogin()
    }
  }
})
```

## 关键技术点深度解析

### 1. 差异更新算法实现
```mermaid
flowchart TD
    Start[开始比对] --> CheckType{节点类型一致?}
    CheckType -->|否| Replace[替换节点]
    CheckType -->|是| CheckTag{标签名相同?}
    
    CheckTag -->|否| Replace
    CheckTag -->|是| CheckAttrs{属性匹配度}
    
    CheckAttrs -->|差异>阈值| Replace
    CheckAttrs -->|差异≤阈值| SyncAttrs[同步属性]
    
    SyncAttrs --> CheckChildren{子节点比对}
    
    CheckChildren --> KeyedCheck{是否存在 key?}
    KeyedCheck -->|是| KeyedDiff[基于 key 的移动]
    KeyedCheck -->|否| OrderDiff[顺序比对]
    
    OrderDiff --> TextNode{是否文本节点?}
    TextNode -->|是| UpdateText[更新文本内容]
    TextNode -->|否| Recurse[递归比对子节点]
```

### 2. 缓存存储结构设计
```javascript
// TurboFeLy 缓存条目结构
{
  html: "<div>...</div>",    // 原始HTML
  timestamp: 1696147200000,  // 缓存时间戳
  expireAt: 1696150800000,   // 过期时间
  scroll: { x: 0, y: 300 },  // 滚动位置
  metadata: {
    viewport: "1920x1080",   // 视口维度
    userAgent: "Chrome/117", // UA信息
    checksum: "a1b2c3d4"     // 内容校验和
  }
}
```

## 高级技术迁移方案

### 1. 脚本执行管理
```mermaid
flowchart LR
    A[发现新脚本] --> B{类型检查}
    B -->|外部脚本| C[检查缓存]
    C -->|已缓存| D[跳过加载]
    C -->|未缓存| E[插入DOM]
    B -->|内联脚本| F[沙箱执行]
    
    subgraph 沙箱执行流程
        F --> G[创建虚拟环境]
        G --> H[重写全局访问]
        H --> I[安全执行]
        I --> J[清理泄漏]
    end
```

#### 迁移时需注意：
```html
<!-- Pjax 需要全量执行的脚本 -->
<script src="analytics.js"></script>

<!-- TurboFeLy 优化写法 -->
<script src="analytics.js" data-turbo-permanent></script>
```

### 2. 表单处理技术升级
```mermaid
sequenceDiagram
    participant F as Form
    participant T as TurboFeLy
    
    F->>T: 提交事件
    T->>T: 拦截默认行为
    T->>T: 序列化表单数据
    alt GET 请求
        T->>T: 构建URL参数
        T->>T: processNavigation()
    else POST 请求
        T->>T: 创建FormData
        T->>T: fetch() 提交
        T->>T: 处理响应
    end
```

#### 迁移示例：
```javascript
// Pjax 表单处理
$(document).on('submit', 'form', function(e) {
  e.preventDefault()
  $.pjax.submit(e, '#main')
})

// TurboFeLy 实现
document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault()
  
  const form = e.target
  const url = new URL(form.action)
  const formData = new FormData(form)

  if (form.method === 'get') {
    url.search = new URLSearchParams(formData)
    turbo.processNavigation(url.href)
  } else {
    const response = await fetch(url, {
      method: form.method,
      body: formData
    })
    turbo.handleResponse(response)
  }
})
```

## 性能优化迁移策略

### 1. 预加载机制对比
```mermaid
gantt
    title 预加载策略对比
    dateFormat  ss
    axisFormat %S秒
    
    section Pjax
    手动预加载 :a1, 0, 2s
    
    section TurboFeLy
    视口预测 :crit, a2, 0, 1s
    链路预取 :a3, after a2, 2s
    行为分析 :a4, after a3, 3s
```

### 2. 内存优化配置
```javascript
new TurboFeLy({
  cacheSize: 15, // 根据内存容量调整
  diffThreshold: 0.7, // 降低比对强度
  maxDiffDepth: 25, // 限制递归深度
  animationMemory: {
    maxFrames: 5, // 最大缓存动画帧
    poolSize: 10   // 对象池大小
  }
})
```

## 调试与验证方案

### 1. 差异更新调试器
```javascript
// 启用调试模式
new TurboFeLy({
  debug: {
    domChanges: true,  // 打印DOM变更
    cacheStatus: true, // 显示缓存状态
    diffVisual: true   // 可视化差异节点
  }
})

// 控制台输出示例
[TurboFeLy Debug] DOM changes detected:
- UPDATE #header (textContent)
- REPLACE .old-widget (depth 3)
- ADD 2 new .product-card items
```

### 2. 性能验证指标
```mermaid
pie
    title 性能指标权重
    "DOM解析时间" : 25
    "差异化率" : 30
    "缓存命中率" : 20
    "动画帧率" : 15
    "内存占用" : 10
```

本技术迁移方案聚焦核心实现细节，涵盖 DOM 处理、缓存机制、脚本执行等关键技术点。建议通过以下步骤实施：
1. 逐步替换选择器配置
2. 重构事件监听系统
3. 添加 Turbo 专用数据属性
4. 实施渐进式缓存策略
5. 验证性能关键指标
6. 部署监控和回滚方案

遇到具体技术问题时，可参考 TurboFeLy 的调试模式输出和变更记录进行针对性优化。
