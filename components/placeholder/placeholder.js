Component({
  /**
   * 占位组件 — 在目标组件加载完成前短暂显示
   * 用于 "用时注入" (componentPlaceholder) 场景
   */
  properties: {
    /** 自定义提示文字 */
    text: {
      type: String,
      value: '加载中...'
    }
  }
});
