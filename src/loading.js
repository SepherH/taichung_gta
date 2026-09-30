// 載入畫面：標題、進度條、隨機臺中小知識；只負責顯示進度，載入完成後隱藏，開始遊戲改由選單的開始畫面（src/ui/menu.js）負責

export class LoadingScreen {
  constructor(trivia) {
    this.root = document.getElementById('loading');
    this.bar = document.getElementById('bar-fill');
    this.label = document.getElementById('loading-label');
    this.triviaEl = document.getElementById('trivia-text');
    this.trivia = trivia.slice();
    // 洗牌後輪播
    for (let i = this.trivia.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = this.trivia[i];
      this.trivia[i] = this.trivia[j];
      this.trivia[j] = t;
    }
    this.index = 0;
    this.showTrivia();
    this.timer = setInterval(() => this.showTrivia(), 5000);
  }

  showTrivia() {
    if (!this.trivia.length || !this.triviaEl) return;
    this.triviaEl.textContent = this.trivia[this.index % this.trivia.length];
    this.index++;
  }

  setProgress(p, text) {
    if (this.bar) this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    if (text && this.label) this.label.textContent = text;
  }

  // 載入完成：進度滿格後直接隱藏（不再有「點擊開始」按鈕；開始畫面由選單接手）
  ready() {
    this.setProgress(1, '載入完成');
    clearInterval(this.timer);
    if (this.root) this.root.classList.add('hidden');
  }

  error(message) {
    clearInterval(this.timer);
    if (!this.label) return;
    this.label.textContent = message;
    this.label.classList.add('error');
  }
}
