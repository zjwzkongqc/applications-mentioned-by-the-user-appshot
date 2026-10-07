const themes = Object.freeze({
  forest: { name: '奶油森林', description: '清爽、有活力', paper: '#F5F6F1' },
  gold: { name: '曜石香槟', description: '沉稳、有纪念感', paper: '#141613' },
  clay: { name: '暖白红土', description: '温暖、复古', paper: '#FAF4EE' },
  navy: { name: '雾白海军蓝', description: '清晰、克制', paper: '#F2F5F8' },
  sage: { name: '象牙鼠尾草', description: '柔和、耐看', paper: '#F5F3EA' },
});
const choices = [...document.querySelectorAll('[data-theme-choice]')];
const panel = document.querySelector('#theme-preview');
let toastTimer;
function notify(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
}
function applyTheme(name, moveFocus = false) {
  const key = Object.hasOwn(themes, name) ? name : 'forest';
  const theme = themes[key];
  document.documentElement.dataset.theme = key;
  document.querySelector('meta[name="theme-color"]').content = theme.paper;
  document.title = `${theme.name} · 网球记录本配色预览`;
  document.querySelector('#theme-description').textContent = `${theme.name} · ${theme.description}`;
  panel.setAttribute('aria-labelledby', `tab-${key}`);
  choices.forEach(button => {
    const selected = button.dataset.themeChoice === key;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) {
      if (moveFocus) button.focus({ preventScroll: true });
      // Only move the horizontal theme strip; preserve the notebook scroll position.
      const strip = button.parentElement;
      const target = button.offsetLeft - strip.offsetLeft - (strip.clientWidth - button.offsetWidth) / 2;
      strip.scrollLeft = target;
    }
  });
}
function themeFromHash() { return location.hash.slice(1).toLowerCase(); }
function choose(name, moveFocus = false) {
  if (!Object.hasOwn(themes, name)) return;
  history.replaceState(null, '', `#${name}`);
  applyTheme(name, moveFocus);
}
choices.forEach((button, index) => {
  button.addEventListener('click', () => choose(button.dataset.themeChoice));
  button.addEventListener('keydown', event => {
    let target;
    if (event.key === 'ArrowRight') target = (index + 1) % choices.length;
    else if (event.key === 'ArrowLeft') target = (index - 1 + choices.length) % choices.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = choices.length - 1;
    else return;
    event.preventDefault();
    choose(choices[target].dataset.themeChoice, true);
  });
});
window.addEventListener('hashchange', () => applyTheme(themeFromHash()));
applyTheme(themeFromHash());

document.querySelector('#copy-link').addEventListener('click', async () => {
  const url = new URL(location.href);
  url.hash = document.documentElement.dataset.theme;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url.href);
    notify('已复制这款配色的预览链接');
  } catch {
    // WeChat sometimes blocks Clipboard API. A selected field keeps sharing usable.
    const field = document.createElement('textarea');
    field.value = url.href;
    field.readOnly = true;
    field.setAttribute('aria-label', '配色预览链接');
    Object.assign(field.style, { position: 'fixed', bottom: '92px', left: '5%', width: '90%', height: '76px', zIndex: '12', fontSize: '14px', padding: '10px', color: 'var(--ink)', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '8px' });
    document.querySelector('[data-copy-fallback]')?.remove();
    field.dataset.copyFallback = '';
    document.body.append(field);
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Leave selection visible. */ }
    if (copied) { field.remove(); notify('已复制这款配色的预览链接'); }
    else { notify('请长按已选中的链接，选择复制'); field.addEventListener('blur', () => field.remove(), { once: true }); }
  }
});

const pageCopy = {
  records: ['OUR TENNIS JOURNAL', '教练，我想打网球', '一起打过的球，都值得记下来。'],
  growth: ['MY GROWTH JOURNAL', '进步，有自己的形状。', '不着急变厉害，先享受每一次上场。'],
};
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  const name = button.dataset.view;
  document.querySelectorAll('[data-page]').forEach(section => { section.hidden = section.dataset.page !== name; });
  document.querySelectorAll('[data-view]').forEach(nav => {
    const active = nav.dataset.view === name;
    nav.classList.toggle('active', active);
    nav.setAttribute('aria-pressed', String(active));
  });
  const [eyebrow, title, subtitle] = pageCopy[name];
  document.querySelector('#view-eyebrow').textContent = eyebrow;
  document.querySelector('#view-title').textContent = title;
  document.querySelector('#view-subtitle').textContent = subtitle;
  panel.scrollIntoView({ behavior: 'instant', block: 'start' });
}));
document.querySelectorAll('[data-view]').forEach(nav => nav.setAttribute('aria-pressed', String(nav.dataset.view === 'records')));

const scores = [7, 6, 5, 5, 6, 7];
const skills = ['正手稳定性', '反手稳定性', '发球控制', '接发球能力', '网前截击', '移动与回位'];
const point = (index, radius) => [160 + Math.sin(index * Math.PI / 3) * radius, 140 - Math.cos(index * Math.PI / 3) * radius];
const points = values => values.map((radius, index) => point(index, radius).join(',')).join(' ');
const labels = [[160, 26], [269, 82], [269, 201], [160, 259], [51, 201], [51, 82]];
const radar = `<svg class="radar" viewBox="0 0 320 282" role="img" aria-label="示例能力自评：正手稳定性 7 分、反手稳定性 6 分、发球控制 5 分、接发球能力 5 分、网前截击 6 分、移动与回位 7 分，满分 10 分"><title>六边形能力雷达图 · 示例数据</title>${[.2,.4,.6,.8,1].map(scale => `<polygon class="radar-grid" points="${points(scores.map(() => 88 * scale))}"/>`).join('')}${scores.map((_, index) => `<line class="radar-axis" x1="160" y1="140" x2="${point(index,88)[0]}" y2="${point(index,88)[1]}"/>`).join('')}<polygon class="radar-shape" points="${points(scores.map(score => 88 * score / 10))}"/>${scores.map((score, index) => `<circle class="radar-dot" cx="${point(index,88 * score / 10)[0]}" cy="${point(index,88 * score / 10)[1]}" r="3"/>`).join('')}${labels.map(([x,y], index) => `<text text-anchor="middle" x="${x}" y="${y}">${skills[index]}</text><text text-anchor="middle" class="score" x="${x}" y="${y+16}">${scores[index]} / 10</text>`).join('')}</svg>`;
document.querySelectorAll('.radar-container').forEach(container => { container.innerHTML = radar; });

const dialog = document.querySelector('#demo-dialog');
document.querySelector('#open-record').addEventListener('click', () => dialog.showModal());
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
document.querySelector('#demo-form').addEventListener('submit', event => {
  event.preventDefault();
  dialog.close();
  notify('预览结束，正式记录本没有变化');
});
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
