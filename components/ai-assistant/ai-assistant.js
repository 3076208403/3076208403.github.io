/**
 * 简工坊Pro · AI 智能助手核心逻辑
 * 2026 混元大模型 · 流式对话 · 云数据库持久化
 * 技术栈：wx.cloud.extend.AI + streamText()
 */

const {
  MODE_SYSTEM_PROMPTS,
  MODEL_CONFIG,
  buildMessages,
  getWelcomeMessage,
  generateTitle
} = require('../../utils/ai-prompts');

Component({
  /**
   * 组件属性 — 由父页面控制显隐
   */
  properties: {
    visible: {
      type: Boolean,
      value: false,
      observer: '_onVisibleChange'
    }
  },

  /**
   * 组件内部数据
   */
  data: {
    // ====== 对话状态 ======
    messages: [],               // { role, content, timestamp, streaming?, error? }
    inputValue: '',             // 输入框文本
    isStreaming: false,         // 是否正在流式输出
    streamingText: '',          // 流式累积文本

    // ====== 模式选项 ======
    mode: 'formal',             // 'formal' | 'concise' | 'friendly'
    modeOptions: [
      { key: 'formal',   label: '更正式', icon: '💼' },
      { key: 'concise',  label: '更精简', icon: '⚡' },
      { key: 'friendly', label: '更友善', icon: '😊' }
    ],

    // ====== 快捷提示 ======
    quickPrompts: [
      '帮我润色这段文字，让它更专业',
      '请用三句话总结今天的新闻要点',
      '给我推荐一个提高效率的方法'
    ],

    // ====== 历史记录 ======
    conversations: [],          // 从云数据库加载的历史对话列表
    showHistory: false,

    // ====== UI 辅助 ======
    scrollToView: '',           // 滚动锚点
    inputFocused: false,
    statusBarHeight: 44,        // 默认值，从 app.globalData 获取

    // ====== 内部状态（不触发渲染） ======
    _streamConnection: null,    // 活跃流连接（用于取消）
    _modelInstance: null,       // AI 模型实例（懒初始化）
    _currentConvId: null,       // 当前对话的云数据库 _id
    _db: null,                  // 云数据库引用
    _isFirstChunk: false,       // 是否等待首个流式块
    _pendingSetData: null       // setData 防抖定时器
  },

  /**
   * 组件生命周期
   */
  lifetimes: {
    attached() {
      // 获取状态栏高度
      const app = getApp();
      if (app && app.globalData) {
        this.setData({
          statusBarHeight: app.globalData.statusBarHeight || 44
        });
      }

      // 初始化云数据库
      if (wx.cloud) {
        this.data._db = wx.cloud.database();
      }
    },

    detached() {
      // 清理流连接，防止内存泄漏
      this._cancelStream();
      // 清理防抖定时器
      if (this.data._pendingSetData) {
        clearTimeout(this.data._pendingSetData);
      }
    }
  },

  /**
   * 组件方法
   */
  methods: {

    /* ================================================================
       公开接口 — 由父页面通过 selectComponent 调用
       ================================================================ */

    /**
     * 打开 AI 助手
     * 初始化模型实例 + 加载历史对话
     */
    open() {
      this.setData({
        inputValue: '',
        showHistory: false
      });

      // 懒初始化 AI 模型
      if (!this.data._modelInstance && wx.cloud && wx.cloud.extend && wx.cloud.extend.AI) {
        try {
          this.data._modelInstance = wx.cloud.extend.AI.createModel(MODEL_CONFIG.model);
          console.log('[AI助手] 混元模型实例已创建:', MODEL_CONFIG.model);
        } catch (err) {
          console.error('[AI助手] 模型初始化失败:', err);
        }
      }

      // 加载云数据库历史
      this._loadConversationHistory();
    },

    /**
     * 关闭 AI 助手（内部清理，由父页面 closeAIAssistant 调用）
     * 取消活跃流 + 清理状态
     */
    close() {
      this._cancelStream();
      this.setData({
        isStreaming: false,
        streamingText: '',
        showHistory: false,
        inputFocused: false
      });
    },

    /**
     * 请求关闭 — 通过事件冒泡通知父页面隐藏浮层
     * 由 WXML 中的 ✕ 按钮 bindtap 触发
     */
    _onRequestClose() {
      wx.vibrateShort({ type: 'light' });
      this.triggerEvent('close');
    },


    /* ================================================================
       可见性变化观察者
       ================================================================ */
    _onVisibleChange(newVal) {
      if (newVal) {
        this.open();
        wx.vibrateShort({ type: 'light' });
      } else {
        this.close();
      }
    },


    /* ================================================================
       模式切换
       ================================================================ */

    /**
     * 切换润色模式（正式 / 精简 / 友善）
     * 不会清空当前对话，仅影响后续消息的系统提示词
     */
    _onModeChange(e) {
      const mode = e.currentTarget.dataset.mode;
      if (mode === this.data.mode) return;

      this.setData({ mode });
      wx.vibrateShort({ type: 'light' });

      // 模式切换提示（不记入历史）
      const modeLabel = this.data.modeOptions.find(m => m.key === mode);
      wx.showToast({
        title: `已切换至「${modeLabel ? modeLabel.label : mode}」模式`,
        icon: 'none',
        duration: 1500
      });
    },


    /* ================================================================
       输入处理
       ================================================================ */

    _onInputChange(e) {
      this.setData({ inputValue: e.detail.value });
    },

    _onInputFocus() {
      this.setData({ inputFocused: true });
    },

    _onInputBlur() {
      this.setData({ inputFocused: false });
    },


    /* ================================================================
       发送消息 — 核心流程
       ================================================================ */

    /**
     * 发送用户消息
     * 流程：验证 → 触觉反馈 → 追加用户消息 → 创建助手占位 → 流式调用
     */
    _onSend() {
      const inputValue = this.data.inputValue.trim();
      if (!inputValue || this.data.isStreaming) return;

      // 🔔 触觉反馈：开始发送
      wx.vibrateShort({ type: 'medium' });

      const userMessage = {
        role: 'user',
        content: inputValue,
        timestamp: Date.now()
      };

      // 助手占位消息（流式填充）
      const assistantPlaceholder = {
        role: 'assistant',
        content: '',
        timestamp: Date.now() + 1,
        streaming: true
      };

      const messages = [...this.data.messages, userMessage, assistantPlaceholder];

      this.setData({
        messages,
        inputValue: '',
        isStreaming: true,
        streamingText: '',
        scrollToView: 'msg-bottom'
      });

      // 开始流式调用
      this._streamResponse(userMessage.content);
    },

    /**
     * 快捷提示词点击
     */
    _onQuickPrompt(e) {
      const prompt = e.currentTarget.dataset.prompt;
      this.setData({ inputValue: prompt });
      // 自动发送
      this._onSend();
    },


    /* ================================================================
       流式调用 — wx.cloud.extend.AI + streamText()
       ================================================================ */

    /**
     * 使用混元大模型进行流式对话
     * 核心 API：wx.cloud.extend.AI.createModel().streamText()
     */
    async _streamResponse(userMessage) {
      // 确保模型已初始化
      if (!this.data._modelInstance) {
        if (wx.cloud && wx.cloud.extend && wx.cloud.extend.AI) {
          try {
            this.data._modelInstance = wx.cloud.extend.AI.createModel(MODEL_CONFIG.model);
          } catch (err) {
            this._handleStreamError(new Error('模型初始化失败：' + err.message));
            return;
          }
        } else {
          this._handleStreamError(new Error('当前环境不支持 wx.cloud.extend.AI，请升级基础库至 3.7.1+'));
          return;
        }
      }

      // 组装消息（含系统提示词 + 历史上下文）
      const historyMessages = this.data.messages
        .filter(m => m.role !== 'assistant' || !m.streaming)
        .slice(0, -1); // 排除刚添加的占位消息

      const apiMessages = buildMessages(userMessage, this.data.mode, historyMessages);

      this.data._isFirstChunk = true;

      try {
        // 开发环境检测：若 API 不可用，自动降级为本地 mock 流式
        if (!this.data._modelInstance || !this.data._modelInstance.streamText) {
          console.warn('[AI助手] streamText 不可用，使用开发环境 mock 模式');
          this._mockStreamResponse(apiMessages);
          return;
        }

        // 🔥 核心调用：streamText() 流式输出
        // 注意：参数直接传递，不需要包裹 data:{}（那是 wx.cloud.callFunction 的模式）
        const stream = await this.data._modelInstance.streamText({
          model: MODEL_CONFIG.model,
          messages: apiMessages,
          temperature: MODEL_CONFIG.temperature,
          maxTokens: MODEL_CONFIG.maxTokens
        });

        this.data._streamConnection = stream;
        let fullText = '';

        // 监听流式文本块
        stream.on('text', (chunk) => {
          fullText += chunk;
          this.data.streamingText = fullText;
          this._handleStreamChunk(chunk, fullText);
        });

        // 监听流结束
        stream.on('end', () => {
          this.data._streamConnection = null;
          this._handleStreamEnd(fullText);
        });

        // 监听错误
        stream.on('error', (err) => {
          this.data._streamConnection = null;
          this._handleStreamError(err);
        });

      } catch (err) {
        console.error('[AI助手] streamText 调用异常:', err);
        // 异常时尝试 mock 降级
        this._mockStreamResponse(apiMessages);
      }
    },

    /**
     * 处理流式文本块 — 防抖更新 UI 实现打字机效果
     */
    _handleStreamChunk(chunk, fullText) {
      // 🔔 首个 chunk 触觉反馈
      if (this.data._isFirstChunk) {
        this.data._isFirstChunk = false;
        wx.vibrateShort({ type: 'light' });
      }

      // 防抖 setData（80ms），避免高频更新导致 UI 卡顿
      if (this.data._pendingSetData) {
        clearTimeout(this.data._pendingSetData);
      }

      this.data._pendingSetData = setTimeout(() => {
        // 更新最后一条助手消息的内容
        const messages = this.data.messages;
        const lastIdx = messages.length - 1;
        if (lastIdx >= 0 && messages[lastIdx].streaming) {
          messages[lastIdx].content = fullText;
          this.setData({
            messages,
            scrollToView: 'msg-bottom'
          });
        }
        this.data._pendingSetData = null;
      }, 80);
    },

    /**
     * 处理流结束 — 定稿消息 + 持久化
     */
    _handleStreamEnd(fullText) {
      // 🔔 触觉反馈：流式输出结束
      wx.vibrateShort({ type: 'light' });

      // 清除防抖，立即更新最终文本
      if (this.data._pendingSetData) {
        clearTimeout(this.data._pendingSetData);
        this.data._pendingSetData = null;
      }

      const messages = this.data.messages;
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].streaming) {
        messages[lastIdx].content = fullText;
        messages[lastIdx].streaming = false;  // 移除流式标记 → 打字机光标消失
      }

      this.setData({
        messages,
        isStreaming: false,
        streamingText: '',
        scrollToView: 'msg-bottom'
      });

      // 异步持久化至云数据库（fire-and-forget）
      this._saveToCloudDB();
    },

    /**
     * 处理流错误
     */
    _handleStreamError(err) {
      console.error('[AI助手] 流式调用失败:', err);

      // 清除防抖
      if (this.data._pendingSetData) {
        clearTimeout(this.data._pendingSetData);
        this.data._pendingSetData = null;
      }

      // 给最后一条助手消息标记错误
      const messages = this.data.messages;
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].streaming) {
        messages[lastIdx].streaming = false;
        messages[lastIdx].error = true;
        // 保留已有内容
        if (!messages[lastIdx].content) {
          messages[lastIdx].content = '抱歉，请求失败，请重试。';
        }
      }

      this.setData({
        messages,
        isStreaming: false,
        streamingText: ''
      });

      // 错误提示
      wx.showToast({
        title: '请求失败，请重试',
        icon: 'none',
        duration: 2000
      });
    },

    /**
     * 重试失败的消息
     */
    _onRetry(e) {
      const index = e.currentTarget.dataset.index;
      const messages = this.data.messages;
      if (index >= 0 && index < messages.length && messages[index].error) {
        // 移除失败的消息 + 它之前的用户消息
        const userMsgIdx = index - 1;
        if (userMsgIdx >= 0 && messages[userMsgIdx].role === 'user') {
          messages.splice(userMsgIdx, 2);
          this.setData({ messages });
          // 重新发送该用户消息
          this._streamResponse(messages[userMsgIdx].content);
        }
      }
    },

    /**
     * 停止流式输出
     */
    _onStopStream() {
      this._cancelStream();
      // 保留已输出的部分文本
      const messages = this.data.messages;
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].streaming) {
        messages[lastIdx].streaming = false;
        if (!messages[lastIdx].content) {
          messages[lastIdx].content = '（已停止生成）';
        }
      }
      this.setData({
        messages,
        isStreaming: false,
        streamingText: ''
      });
      wx.vibrateShort({ type: 'light' });
    },

    /**
     * 取消活跃的流连接
     */
    _cancelStream() {
      if (this.data._streamConnection) {
        try {
          this.data._streamConnection.off('text');
          this.data._streamConnection.off('end');
          this.data._streamConnection.off('error');
        } catch (e) {
          // 静默处理
        }
        this.data._streamConnection = null;
      }
    },

    /**
     * 开发环境 Mock 流式响应
     * 当 wx.cloud.extend.AI 不可用时，模拟打字机效果供 UI 调试
     */
    _mockStreamResponse(apiMessages) {
      const userMsg = apiMessages[apiMessages.length - 1].content;
      const modeLabel = this.data.modeOptions.find(m => m.key === this.data.mode);

      // 根据模式生成不同的 mock 回复
      const mockReplies = {
        formal: `感谢您的提问。针对"${userMsg.substring(0, 15)}${userMsg.length > 15 ? '…' : ''}"这一问题，我提供以下专业分析：\n\n1. 首先，这是一个值得深入探讨的话题。从专业角度来看，需要考虑多个维度的因素。\n\n2. 其次，建议您结合实际场景进行验证，以确保方案的有效性和可行性。\n\n3. 最后，如果您需要更详细的解答，请提供更多背景信息，我将为您进一步分析。\n\n📌 提示：以上为开发环境 Mock 回复，部署到真机后将使用混元大模型实时生成。`,
        concise: `关于"${userMsg.substring(0, 12)}${userMsg.length > 12 ? '…' : ''}"：\n\n• 核心要点：这是一个常见问题\n• 解决方案：分三步处理\n• 注意事项：关注实际场景\n\n⚡ Mock 模式 · 真机将实时生成`,
        friendly: `嗨～好问题！关于这个我很乐意帮你看看～ 😊\n\n其实这个问题可以从几个角度来想，不过最重要的还是要看你的具体情况啦～\n\n有什么更多细节可以随时告诉我，我们一起把这个搞定！💪\n\n（当前是开发环境 Mock 回复，上线后会由混元大模型实时生成哦～）`
      };

      const fullMock = mockReplies[this.data.mode] || mockReplies.formal;
      this.data._isFirstChunk = true;

      // 逐字输出模拟流式效果（每 40ms 输出 1-3 个字符）
      let pos = 0;
      const timer = setInterval(() => {
        const step = Math.floor(Math.random() * 3) + 1;
        pos = Math.min(pos + step, fullMock.length);
        const partial = fullMock.substring(0, pos);

        this._handleStreamChunk(fullMock.substring(pos - step, pos), partial);

        if (pos >= fullMock.length) {
          clearInterval(timer);
          this._handleStreamEnd(fullMock);
        }
      }, 40);

      // 保存 timer 引用以便取消
      this.data._streamConnection = {
        off: () => clearInterval(timer)
      };
    },


    /* ================================================================
       云数据库 — 对话历史持久化
       ================================================================ */

    /**
     * 将当前对话保存至云数据库
     * 使用 fire-and-forget 模式，不阻塞 UI
     */
    async _saveToCloudDB() {
      if (!this.data._db) return;

      const messages = this.data.messages.filter(m => !m.streaming && !m.error);
      if (messages.length === 0) return;

      const firstUserMsg = messages.find(m => m.role === 'user');
      const title = generateTitle(firstUserMsg ? firstUserMsg.content : '');

      const docData = {
        title,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp
        })),
        mode: this.data.mode,
        messageCount: messages.length,
        createTime: this.data._db.serverDate(),
        updateTime: this.data._db.serverDate()
      };

      try {
        if (this.data._currentConvId) {
          // 更新已有对话
          await this.data._db
            .collection('ai_conversations')
            .doc(this.data._currentConvId)
            .update({
              data: {
                messages: docData.messages,
                mode: docData.mode,
                messageCount: docData.messageCount,
                updateTime: this.data._db.serverDate()
              }
            });
        } else {
          // 新建对话
          const res = await this.data._db
            .collection('ai_conversations')
            .add({ data: docData });
          this.data._currentConvId = res._id;
        }

        // 强制限制历史数量 ≤ 10
        this._enforceHistoryLimit();

        // 重新加载历史列表
        this._loadConversationHistory();

      } catch (err) {
        console.error('[AI助手] 云数据库保存失败:', err);
        // 静默失败，不影响用户体验
      }
    },

    /**
     * 加载历史对话列表（最近 10 条）
     */
    async _loadConversationHistory() {
      if (!this.data._db) return;

      try {
        const res = await this.data._db
          .collection('ai_conversations')
          .orderBy('updateTime', 'desc')
          .limit(10)
          .get();

        const conversations = (res.data || []).map(item => ({
          ...item,
          modeLabel: this._getModeLabel(item.mode)
        }));

        this.setData({ conversations });
      } catch (err) {
        console.error('[AI助手] 加载历史失败:', err);
      }
    },

    /**
     * 强制限制历史对话数量 ≤ 10
     * 超出时删除最早的记录
     */
    async _enforceHistoryLimit() {
      if (!this.data._db) return;

      const MAX = 10;
      try {
        const res = await this.data._db
          .collection('ai_conversations')
          .orderBy('createTime', 'asc')
          .limit(100)
          .get();

        const excess = (res.data || []).length - MAX;
        for (let i = 0; i < excess; i++) {
          await this.data._db
            .collection('ai_conversations')
            .doc(res.data[i]._id)
            .remove();
        }
      } catch (err) {
        console.error('[AI助手] 历史限制清理失败:', err);
      }
    },


    /* ================================================================
       历史面板交互
       ================================================================ */

    /**
     * 切换历史面板显示
     */
    _onToggleHistory() {
      this.setData({ showHistory: !this.data.showHistory });
      wx.vibrateShort({ type: 'light' });
    },

    /**
     * 点击历史对话项 → 加载该对话
     */
    _onHistoryItemTap(e) {
      const id = e.currentTarget.dataset.id;
      const conv = this.data.conversations.find(c => c._id === id);
      if (!conv || !conv.messages) return;

      this.data._currentConvId = id;
      this.setData({
        messages: conv.messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp || Date.now(),
          streaming: false
        })),
        mode: conv.mode || 'formal',
        showHistory: false,
        scrollToView: 'msg-bottom'
      });

      wx.vibrateShort({ type: 'medium' });
    },

    /**
     * 长按历史对话项 → 删除
     */
    _onHistoryLongPress(e) {
      const id = e.currentTarget.dataset.id;
      const conv = this.data.conversations.find(c => c._id === id);
      if (!conv) return;

      wx.showModal({
        title: '删除对话',
        content: `确定要删除"${conv.title || '新对话'}"吗？`,
        confirmColor: '#FF3B30',
        success: (res) => {
          if (res.confirm) {
            this._deleteConversation(id);
          }
        }
      });
    },

    /**
     * 删除指定对话
     */
    async _deleteConversation(id) {
      if (!this.data._db) return;

      try {
        await this.data._db.collection('ai_conversations').doc(id).remove();

        // 如果删除的是当前对话，重置
        if (this.data._currentConvId === id) {
          this.data._currentConvId = null;
          this.setData({ messages: [] });
        }

        this._loadConversationHistory();
        wx.showToast({ title: '已删除', icon: 'success', duration: 1200 });
      } catch (err) {
        console.error('[AI助手] 删除对话失败:', err);
        wx.showToast({ title: '删除失败', icon: 'none' });
      }
    },

    /**
     * 新建对话
     */
    _onNewChat() {
      if (this.data.messages.length === 0) return;

      this.data._currentConvId = null;
      this.setData({
        messages: [],
        inputValue: '',
        isStreaming: false,
        streamingText: '',
        scrollToView: ''
      });
      wx.vibrateShort({ type: 'light' });
    },


    /* ================================================================
       辅助方法
       ================================================================ */

    /**
     * 获取模式的中文标签
     */
    _getModeLabel(mode) {
      const option = this.data.modeOptions.find(m => m.key === mode);
      return option ? option.label : '正式';
    }
  }
});
