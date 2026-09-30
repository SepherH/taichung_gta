// 載入畫面：標題、進度條、隨機臺中小知識、完成後「點擊開始」

export class LoadingScreen {
  constructor(trivia) {
    this.root = document.getElementById('loading');
    this.bar = document.getElementById('bar-fill');
    this.label = document.getElementById('loading-label');
    this.triviaEl = document.getElementById('trivia-text');
    this.startBtn = document.getElementById('start-btn');
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
    if (!this.trivia.length) return;
    this.triviaEl.textContent = this.trivia[this.index % this.trivia.length];
    this.index++;
  }

  setProgress(p, text) {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    if (text) this.label.textContent = text;
  }

  // 載入完成：顯示「點擊開始」，點擊後呼叫 onStart
  ready(onStart) {
    this.setProgress(1, '載入完成');
    this.root.classList.add('ready');
    this.startBtn.classList.remove('hidden');
    const go = () => {
      this.startBtn.removeEventListener('click', go);
      clearInterval(this.timer);
      this.root.classList.add('hidden');
      onStart();
    };
    this.startBtn.addEventListener('click', go);
  }

  error(message) {
    clearInterval(this.timer);
    this.label.textContent = message;
    this.label.classList.add('error');
  }
}
