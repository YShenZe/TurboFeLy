(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.TurboFeLy = factory());
})(this, function () {
'use strict';

const DOM_CHANGE_TYPES = {
  REPLACE: 'replace',
  UPDATE: 'update',
  REMOVE: 'remove',
  ADD: 'add'
};

class TurboFeLy {
  constructor(options = {}) {
    const defaults = {
      container: '#main-container',
      cacheSize: 10,
      prefetchDelay: 150,
      linkIds: [],
      linkSelector: 'a[href]:not([data-turbo-disable])',
      animate: true,
      animationDuration: 300,
      loadingClass: 'turbo-loading',
      loadingDelay: 200,
      debug: false,
      preventClickDelay: 0,
      updateMode: 'replace',
      fallbackToReplace: true,
      diffThreshold: 0.8,
      maxDiffDepth: 30,
      ignoreAttributes: ['data-turbo-id', 'data-temp'],
      cacheByViewport: false,
      cacheByUserAgent: false,
      cacheTTL: 15 * 60 * 1000
    };

    this.options = { ...defaults, ...options };
    this.cache = new Map();
    this.pendingRequests = new Map();
    this.lruKeys = [];
    this.currentController = null;
    this.animationFrame = null;
    this.isLoading = false;
    this.loadingTimeout = null;
    this.lastTouchTime = 0;
    this.scrollPositions = new Map();
    this.changeTracker = new Map();
    this.currentDiffDepth = 0;

    this.handleClick = this.handleClick.bind(this);
    this.handleHoverDelegate = this.handleHoverDelegate.bind(this);
    this.handleTouchDelegate = this.handleTouchDelegate.bind(this);
    this.handlePopState = this.handlePopState.bind(this);

    this.initCore()
      .initEventListeners()
      .initMutationObserver()
      .initAnimations();
  }

  initCore() {
    this.validateElements();
    this.enableDebug();
    this.initScrollRestoration();
    this.applyTouchPatch();
    return this;
  }

  initEventListeners() {
    const events = [
      ['click', this.handleClick],
      ['mouseover', this.handleHoverDelegate],
      ['touchstart', this.handleTouchDelegate, { passive: true }],
      ['touchend', this.handleTouchDelegate, { passive: true }],
      ['popstate', this.handlePopState]
    ];

    events.forEach(([type, handler, options]) => {
      document.body.addEventListener(type, handler, options);
    });
    return this;
  }

  validateElements() {
    this.options.linkIds.forEach(id => {
      const el = document.getElementById(id);
      if (el && el.tagName !== 'A') {
        console.warn(`TurboFeLy: Element #${id} is not an anchor tag`);
      }
    });
  }

  initScrollRestoration() {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
  }

  initMutationObserver() {
    this.observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this.revalidateElements(node);
          }
        });
      });
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    return this;
  }

  initAnimations() {
    if (!this.options.animate) return this;
    
    const style = document.createElement('style');
    style.textContent = `
      .turbo-animate-out {
        opacity: 1;
        transform: translateY(0);
        transition: all ${this.options.animationDuration}ms ease-out;
      }
      
      .turbo-animate-in {
        opacity: 0;
        transform: translateY(20px);
        transition: all ${this.options.animationDuration}ms ease-in;
      }
      
      .turbo-animate-in-active {
        opacity: 1;
        transform: translateY(0);
      }

      .${this.options.loadingClass}::after {
        content: '';
        position: fixed;
        top: 20px;
        right: 20px;
        width: 30px;
        height: 30px;
        border: 3px solid rgba(0,0,0,0.2);
        border-radius: 50%;
        border-top-color: #000;
        animation: turboSpin 1s ease-in-out infinite;
      }

      @keyframes turboSpin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
    return this;
  }

  revalidateElements(root = document) {
    const links = root.querySelectorAll(this.options.linkSelector);
    links.forEach(link => {
      if (!link.hasAttribute('data-turbo-bound')) {
        link.setAttribute('data-turbo-bound', 'true');
        this.bindLinkHover(link);
      }
    });
  }

  bindLinkHover(link) {
    const handler = () => {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = setTimeout(() => {
        this.prefetch(link.href);
      }, this.options.prefetchDelay);
    };

    link.addEventListener('mouseenter', handler);
    link.addEventListener('touchstart', handler);
  }

  handleClick(event) {
    if (this.isSimulatedClick(event)) return;

    const link = this.findTargetLink(event.target);
    if (!link) return;

    if (!this.triggerEvent('beforeNavigate', { url: link.href })) return;

    event.preventDefault();
    this.processNavigation(link.href);
  }

  isSimulatedClick(event) {
    return Date.now() - this.lastTouchTime < this.options.preventClickDelay ||
           (event.clientX === 0 && event.clientY === 0);
  }

  handleTouchDelegate(event) {
    this.lastTouchTime = Date.now();
    const link = this.findTargetLink(event.target);
    if (link) this.handleHover(event);
  }

  handleHoverDelegate(event) {
    const link = this.findTargetLink(event.target);
    if (link) this.handleHover(event);
  }

  handleHover(event) {
    const link = this.findTargetLink(event.target);
    if (!link) return;

    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      this.prefetch(link.href);
    }, this.options.prefetchDelay);
  }

  handlePopState() {
    this.navigate(location.href, true);
  }

  async navigate(url, isBack = false) {
    try {
      if (this.isLoading) return;

      this.abortPendingRequest();
      const cacheKey = this.generateCacheKey(url);

      if (this.cache.has(cacheKey)) {
        const entry = this.cache.get(cacheKey);
        if (entry.expireAt > Date.now()) {
          this.applyCachedUpdate(cacheKey, isBack);
          return;
        } else {
          this.cache.delete(cacheKey);
        }
      }

      await this.fetchNewContent(url, isBack);
    } catch (error) {
      this.handleError(error);
    } finally {
      this.cleanupAfterNavigation();
    }
  }

  abortPendingRequest() {
    if (this.currentController) {
      this.currentController.abort();
      this.log('Aborted previous request');
    }
  }

  applyCachedUpdate(cacheKey, isBack) {
    this.log(`Cache hit: ${cacheKey}`);
    const entry = this.cache.get(cacheKey);
    this.lruKeys = this.lruKeys.filter(k => k !== cacheKey);
    this.lruKeys.push(cacheKey);
    this.applyUpdate(entry.html, isBack);
    this.restoreScrollPosition(cacheKey);
  }

  async fetchNewContent(url, isBack) {
    this.showLoading();
    this.currentController = new AbortController();

    const response = await fetch(url, {
      signal: this.currentController.signal,
      headers: { 'X-TurboFeLy': 'true' }
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const html = await response.text();
    this.updateCache(this.generateCacheKey(url), html);
    this.applyUpdate(html, isBack);
    this.recordScrollPosition(url);
  }

  applyUpdate(html, isBack = false) {
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(html, 'text/html');
    const newContent = this.validateNewContent(newDoc);

    if (!newContent) return;

    const oldContent = document.querySelector(this.options.container);
    this.currentDiffDepth = 0;

    if (this.options.updateMode === 'diff') {
      this.executeDiffUpdate(oldContent, newContent);
    } else {
      this.executeReplaceUpdate(oldContent, newContent);
    }

    this.postUpdateActions(newDoc, isBack);
  }

  validateNewContent(newDoc) {
    const newContent = newDoc.querySelector(this.options.container);
    if (!newContent) {
      console.error('Target container missing in response');
      window.location.reload();
      return null;
    }
    return newContent;
  }

  executeDiffUpdate(oldContent, newContent) {
    try {
      this.log('Starting differential update');
      this.changeTracker.clear();
      
      const tempWrapper = document.createElement('div');
      tempWrapper.appendChild(newContent.cloneNode(true));
      
      this.diffUpdate(oldContent, tempWrapper.firstElementChild, oldContent.parentNode);
      
      this.log('DOM changes:', Array.from(this.changeTracker.entries()));
    } catch (error) {
      this.handleDiffError(error, oldContent, newContent);
    }
  }

  diffUpdate(oldNode, newNode, parentNode) {
    if (this.currentDiffDepth++ > this.options.maxDiffDepth) {
      throw new Error('Maximum diff depth exceeded');
    }

    if (this.shouldReplaceNodes(oldNode, newNode)) {
      this.applyChange(DOM_CHANGE_TYPES.REPLACE, parentNode, oldNode, newNode);
      return;
    }

    if (this.handleTextNodes(oldNode, newNode)) return;

    this.syncAttributes(oldNode, newNode);
    this.processChildNodes(oldNode, newNode);

    this.currentDiffDepth--;
  }

  shouldReplaceNodes(oldNode, newNode) {
    if (!oldNode || !newNode) return true;
    if (oldNode.nodeType !== newNode.nodeType) return true;
    if (oldNode.tagName !== newNode.tagName) return true;

    if (oldNode instanceof HTMLInputElement) {
      if (oldNode.type !== newNode.type || oldNode.checked !== newNode.checked) return true;
    }

    const oldAttrs = this.getSignificantAttributes(oldNode);
    const newAttrs = this.getSignificantAttributes(newNode);
    
    if (!this.areAttributesEqual(oldAttrs, newAttrs)) return true;

    const childDiff = Math.abs(oldNode.childNodes.length - newNode.childNodes.length);
    const maxChildren = Math.max(oldNode.childNodes.length, 1);
    return (childDiff / maxChildren) > this.options.diffThreshold;
  }

  getSignificantAttributes(node) {
    return Array.from(node.attributes)
      .filter(attr => !this.options.ignoreAttributes.includes(attr.name))
      .reduce((acc, attr) => {
        acc[attr.name] = this.normalizeAttributeValue(attr.value, attr.name);
        return acc;
      }, {});
  }

  normalizeAttributeValue(value, name) {
    if (value === '' && ['checked', 'disabled', 'selected'].includes(name)) {
      return 'true';
    }
    if (!isNaN(value) && !isNaN(parseFloat(value))) {
      return parseFloat(value).toString();
    }
    return value.trim().toLowerCase();
  }

  areAttributesEqual(oldAttrs, newAttrs) {
    const oldKeys = Object.keys(oldAttrs);
    const newKeys = Object.keys(newAttrs);
    
    if (oldKeys.length !== newKeys.length) return false;
    
    return oldKeys.every(key => {
      return newAttrs.hasOwnProperty(key) && oldAttrs[key] === newAttrs[key];
    });
  }

  processChildNodes(oldNode, newNode) {
    const oldChildren = Array.from(oldNode.childNodes);
    const newChildren = Array.from(newNode.childNodes);
    
    if (this.keyedDiff(oldNode, oldChildren, newChildren)) return;

    const maxLength = Math.max(oldChildren.length, newChildren.length);
    for (let i = 0; i < maxLength; i++) {
      const oldChild = oldChildren[i];
      const newChild = newChildren[i];

      if (!oldChild && newChild) {
        this.applyChange(DOM_CHANGE_TYPES.ADD, oldNode, null, newChild);
      } else if (oldChild && !newChild) {
        this.applyChange(DOM_CHANGE_TYPES.REMOVE, oldNode, oldChild);
      } else {
        this.diffUpdate(oldChild, newChild, oldNode);
      }
    }
  }

  keyedDiff(parent, oldChildren, newChildren) {
    const oldMap = new Map();
    const newMap = new Map();
    
    oldChildren.forEach(child => {
      const key = child.dataset?.turboId;
      if (key) oldMap.set(key, child);
    });
    
    newChildren.forEach(child => {
      const key = child.dataset?.turboId;
      if (key) newMap.set(key, child);
    });
    
    if (oldMap.size === 0 && newMap.size === 0) return false;
    
    const allKeys = new Set([...oldMap.keys(), ...newMap.keys()]);
    
    allKeys.forEach(key => {
      const oldChild = oldMap.get(key);
      const newChild = newMap.get(key);
      
      if (oldChild && newChild) {
        this.diffUpdate(oldChild, newChild, parent);
      } else if (newChild) {
        this.applyChange(DOM_CHANGE_TYPES.ADD, parent, null, newChild);
      } else if (oldChild) {
        this.applyChange(DOM_CHANGE_TYPES.REMOVE, parent, oldChild);
      }
    });
    
    return true;
  }

  handleTextNodes(oldNode, newNode) {
    if (oldNode.nodeType === Node.TEXT_NODE) {
      const oldText = oldNode.textContent.trim();
      const newText = newNode.textContent.trim();
      
      if (oldText !== newText) {
        this.applyChange(DOM_CHANGE_TYPES.UPDATE, oldNode.parentNode, oldNode, newNode);
      }
      return true;
    }
    return false;
  }

  syncAttributes(oldNode, newNode) {
    Array.from(oldNode.attributes).forEach(attr => {
      if (!newNode.hasAttribute(attr.name) && !this.options.ignoreAttributes.includes(attr.name)) {
        oldNode.removeAttribute(attr.name);
      }
    });

    Array.from(newNode.attributes).forEach(attr => {
      if (!this.options.ignoreAttributes.includes(attr.name)) {
        const normalizedOld = this.normalizeAttributeValue(oldNode.getAttribute(attr.name) || '', attr.name);
        const normalizedNew = this.normalizeAttributeValue(attr.value, attr.name);
        if (normalizedOld !== normalizedNew) {
          oldNode.setAttribute(attr.name, attr.value);
        }
      }
    });
  }

executeReplaceUpdate(oldContent, newContent) {
  this.log('Performing full replace update');
  const parent = oldContent.parentNode;
  
  const clone = document.importNode(newContent, true);
  
  parent.replaceChild(clone, oldContent);
  
  if (this.options.animate) {
    this.prepareAnimation(oldContent, 'out');
    this.prepareAnimation(clone, 'in');
  }
  
  if (this.options.animate) {
    void clone.offsetHeight;
  }
}

handleDiffError(error, oldContent, newContent) {
  const errorMsg = `Diff update failed: ${error.message}`;
  this.options.debug ? console.warn(errorMsg) : this.log(errorMsg);
  
  this.triggerEvent('diffError', {
    error: {
      message: error.message,
      stack: error.stack,
      oldHTML: oldContent?.outerHTML,
      newHTML: newContent?.outerHTML
    }
  });
  
  if (this.options.debug) {
    console.log('[TurboFeLy Debug] Old node structure:', oldContent?.cloneNode(true));
    console.log('[TurboFeLy Debug] New node structure:', newContent?.cloneNode(true));
  }
  
  if (this.options.fallbackToReplace) {
    this.log('Fallback to replace mode');
    this.executeReplaceUpdate(oldContent, newContent);
  } else {
    setTimeout(() => {
      try {
        this.diffUpdate(oldContent, newContent, oldContent.parentNode);
      } catch (retryError) {
        console.error('Retry failed:', retryError);
        window.location.reload();
      }
    }, 50);
  }
}

  applyChange(type, parent, oldNode, newNode) {
    const animate = this.options.animate && this.animationFrame === null;
    const clone = newNode ? this.cloneNodeWithNamespace(newNode) : null;

    if (animate && oldNode) {
      this.prepareAnimation(oldNode, 'out');
    }

    const performChange = () => {
      switch (type) {
        case DOM_CHANGE_TYPES.REPLACE:
          parent.replaceChild(clone, oldNode);
          break;
        case DOM_CHANGE_TYPES.UPDATE:
          oldNode.textContent = newNode.textContent;
          break;
        case DOM_CHANGE_TYPES.REMOVE:
          parent.removeChild(oldNode);
          break;
        case DOM_CHANGE_TYPES.ADD:
          parent.appendChild(clone);
          break;
      }

      if (animate && clone) {
        this.prepareAnimation(clone, 'in');
      }
    };

    if (animate) {
      this.animationFrame = requestAnimationFrame(() => {
        performChange();
        this.animationFrame = null;
      });
    } else {
      performChange();
    }

    this.logDOMChange(type, oldNode, newNode);
  }

  prepareAnimation(node, direction) {
  if (!node || !node.parentNode) return;

  node.classList.add(`turbo-animate-${direction}`);
  
  const _ = window.getComputedStyle(node).opacity;
  
  requestAnimationFrame(() => {
    node.classList.add(`turbo-animate-${direction}-active`);
  });

  setTimeout(() => {
    node.classList.remove(
      `turbo-animate-${direction}`,
      `turbo-animate-${direction}-active`
    );
    
    if (!document.body.contains(node)) {
      node.className = node.className
        .split(' ')
        .filter(cls => !cls.startsWith('turbo-animate'))
        .join(' ');
    }
  }, this.options.animationDuration);
}

  updateCache(key, html) {
    this.lruKeys = this.lruKeys.filter(k => k !== key);
    this.lruKeys.push(key);

    if (this.cache.size >= this.options.cacheSize) {
      const oldestKey = this.lruKeys.shift();
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, { 
      html,
      timestamp: Date.now(),
      expireAt: Date.now() + this.options.cacheTTL
    });
  }

  generateCacheKey(url) {
    const parts = [url];
    if (this.options.cacheByViewport) {
      parts.push(window.innerWidth, window.innerHeight);
    }
    if (this.options.cacheByUserAgent) {
      parts.push(navigator.userAgent);
    }
    return parts.join('|');
  }

  recordScrollPosition(url = location.href) {
    const key = this.generateCacheKey(url);
    this.scrollPositions.set(key, {
      x: window.scrollX,
      y: window.scrollY,
      timestamp: Date.now()
    });
  }

  restoreScrollPosition(key) {
    const pos = this.scrollPositions.get(key);
    if (pos) {
      requestAnimationFrame(() => {
        window.scrollTo(pos.x, pos.y);
      });
    }
  }

  executeScripts(newDoc) {
    const newScripts = Array.from(newDoc.querySelectorAll('script'));
    
    newScripts.forEach(newScript => {
      if (newScript.src) {
        const existing = document.querySelector(`script[src="${newScript.src}"]`);
        if (!existing) {
          const script = document.createElement('script');
          script.src = newScript.src;
          script.async = false;
          script.setAttribute('data-turbo-exec', '');
          document.head.appendChild(script);
        }
      } else {
        try {
          const scriptContent = newScript.textContent;
          if (scriptContent.trim()) {
            const execute = new Function(scriptContent);
            execute();
          }
        } catch (error) {
          console.error('Inline script execution error:', error);
        }
      }
    });
  }

  cloneNodeWithNamespace(node) {
  // 确保跨文档节点正确导入
  if (node.ownerDocument !== document) {
    return document.importNode(node, true);
  }
  return node.cloneNode(true);
}


  logDOMChange(type, oldNode, newNode) {
    const changeRecord = {
      type,
      oldNode: this.nodeToString(oldNode),
      newNode: this.nodeToString(newNode),
      timestamp: Date.now()
    };
    this.changeTracker.set(changeRecord.timestamp, changeRecord);
  }

  nodeToString(node) {
    if (!node) return null;
    return node.nodeType === Node.TEXT_NODE 
      ? `#text "${node.textContent.substring(0, 50)}${node.textContent.length > 50 ? '...' : ''}"` 
      : node.outerHTML.substring(0, 100) + (node.outerHTML.length > 100 ? '...' : '');
  }

  postUpdateActions(newDoc, isBack) {
    this.updateDocumentMetadata(newDoc);
    this.executeScripts(newDoc);
    if (!isBack) this.recordScrollPosition();
    this.triggerEvent('afterUpdate', { isBack });
    this.hideLoading();
  }

  updateDocumentMetadata(newDoc) {
    document.title = newDoc.title;
    this.updateMetaTags(newDoc);
  }

  updateMetaTags(newDoc) {
    const oldMetas = document.querySelectorAll('meta');
    const newMetas = newDoc.querySelectorAll('meta');

    oldMetas.forEach(meta => meta.remove());
    newMetas.forEach(meta => {
      document.head.appendChild(meta.cloneNode(true));
    });
  }

  triggerEvent(eventName, detail = {}) {
    const eventMap = {
      beforeNavigate: {
        type: 'turbo:before-navigate',
        cancelable: true,
        data: { url: detail.url }
      },
      afterUpdate: {
        type: 'turbo:after-update',
        data: { 
          changes: Array.from(this.changeTracker.values()),
          isBack: detail.isBack
        }
      },
      error: {
        type: 'turbo:error',
        data: { error: detail.error }
      },
      diffError: {
        type: 'turbo:diff-error',
        data: { error: detail.error }
      }
    };

    const eventConfig = eventMap[eventName];
    if (!eventConfig) return true;

    const event = new CustomEvent(eventConfig.type, {
      bubbles: true,
      cancelable: !!eventConfig.cancelable,
      detail: eventConfig.data
    });

    return document.dispatchEvent(event);
  }

  prefetch(url) {
    if (this.pendingRequests.has(url)) {
      this.pendingRequests.get(url).abort();
      this.pendingRequests.delete(url);
    }
    
    const cacheKey = this.generateCacheKey(url);
    if (this.cache.has(cacheKey)) return;

    this.log(`Prefetching ${url}`);
    const controller = new AbortController();
    this.pendingRequests.set(url, controller);

    fetch(url, {
      signal: controller.signal,
      headers: { 'X-TurboFeLy': 'true' },
      priority: 'low'
    })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(html => this.updateCache(cacheKey, html))
      .catch(error => {
        if (error.name !== 'AbortError') {
          this.log(`Prefetch failed: ${error.message}`);
          this.triggerEvent('error', { error });
        }
      })
      .finally(() => this.pendingRequests.delete(url));
  }

  processNavigation(url) {
    history.pushState({ turbo: true }, '', url);
    this.navigate(url);
  }

  clearCache() {
    this.cache.clear();
    this.lruKeys = [];
  }

  destroy() {
    this.observer.disconnect();
    document.body.removeEventListener('click', this.handleClick);
    document.body.removeEventListener('mouseover', this.handleHoverDelegate);
    document.body.removeEventListener('touchstart', this.handleTouchDelegate);
    document.body.removeEventListener('touchend', this.handleTouchDelegate);
    document.body.removeEventListener('popstate', this.handlePopState);
    this.cache.clear();
    this.pendingRequests.forEach(ctrl => ctrl.abort());
    this.pendingRequests.clear();
  }

  enableDebug() {
    if (this.options.debug) {
      window.turboDebug = this;
      console.log('TurboFeLy debug mode activated');
    }
  }

  log(message, data) {
    if (this.options.debug) {
      console.log(`[TurboFeLy] ${message}`, data || '');
    }
  }

  applyTouchPatch() {
    if ('ontouchstart' in window) {
      const style = document.createElement('style');
      style.textContent = `
        [data-turbo-touch] a {
          min-height: 44px;
          min-width: 44px;
          touch-action: manipulation;
        }
        .${this.options.loadingClass} {
          -webkit-touch-callout: none;
          -webkit-user-select: none;
        }
      `;
      document.head.appendChild(style);
      document.documentElement.setAttribute('data-turbo-touch', '');
    }
  }

  showLoading() {
    if (this.isLoading) return;
    
    this.loadingTimeout = setTimeout(() => {
      document.documentElement.classList.add(this.options.loadingClass);
      this.isLoading = true;
      this.log('Showing loading indicator');
    }, this.options.loadingDelay);
  }

  hideLoading() {
    clearTimeout(this.loadingTimeout);
    document.documentElement.classList.remove(this.options.loadingClass);
    this.isLoading = false;
    this.log('Hiding loading indicator');
  }

  findTargetLink(target) {
    if (!target) return null;
    const link = target.closest(this.options.linkSelector);
    return link && this.shouldIntercept(link) ? link : null;
  }

  shouldIntercept(link) {
    return link.hostname === location.hostname &&
           link.protocol === location.protocol &&
           link.target !== '_blank' &&
           !link.hasAttribute('download') &&
           (this.options.linkIds.length === 0 || 
            this.options.linkIds.includes(link.id));
  }

  handleError(error) {
    console.error('TurboFeLy Error:', error);
    this.triggerEvent('error', { error });
    this.hideLoading();
  }

  cleanupAfterNavigation() {
    this.hideLoading();
    this.currentController = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.TurboFeLy) {
      window.TurboFeLy = new TurboFeLy();
    }
  });
}

return TurboFeLy;

});