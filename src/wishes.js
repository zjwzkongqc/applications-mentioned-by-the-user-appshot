/* Fresh-app enhancement. Personal wishes stay in the signed-in account, never
 * in localStorage or a group board. The API owns lifetime duration totals. */
(() => {
  'use strict';
  if (!config.freshStart) return;

  const RATE_CENTS_PER_MINUTE = 250;
  const MAX_TARGET_CENTS = 100000000;
  const model = { owner: null, session: null, epoch: -1, data: null, error: '', loadedAt: 0, pending: null, generation: 0, images: new Map(), imagePending: new Map() };
  const base = { render, resetView, request, openRecord };
  const currency = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

  function money(cents) { return '¥' + currency.format(cents / 100); }
  function duration(minutes) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return [h ? h + ' 小时' : '', m ? m + ' 分钟' : ''].filter(Boolean).join(' ') || '0 分钟';
  }
  function parsePrice(value) {
    const text = String(value).trim();
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text)) throw new Error('请输入大于 0 的金额，最多保留两位小数。');
    const [whole, fraction = ''] = text.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_TARGET_CENTS) throw new Error('心愿金额请填写 ¥0.01 至 ¥1,000,000。');
    return cents;
  }
  function progress(total, target) {
    const remainingCents = Math.max(0, target - total);
    return { percent: Math.min(100, Math.max(0, total / target * 100)), remainingCents, remainingMinutes: Math.ceil(remainingCents / RATE_CENTS_PER_MINUTE) };
  }
  function activeIdentity() { return state.authReady && state.account?.id && !state.publicToken && !state.invalidInvite ? state.account.id : null; }
  function reset() {
    model.generation++;
    for (const value of model.images.values()) URL.revokeObjectURL(value.url);
    model.images.clear(); model.imagePending.clear();
    Object.assign(model, { owner: activeIdentity(), session: state.accountSession, epoch: state.epoch, data: null, error: '', loadedAt: 0, pending: null });
  }
  function syncIdentity() {
    if (model.owner !== activeIdentity() || model.session !== state.accountSession || model.epoch !== state.epoch) reset();
    return !!model.owner;
  }
  function guard() {
    const id = activeIdentity(), session = state.accountSession, epoch = state.epoch, generation = model.generation;
    return () => !!id && id === activeIdentity() && session === state.accountSession && epoch === state.epoch && generation === model.generation;
  }
  function button(action, label, id = '', className = 'text-button') {
    return `<button type="button" class="${className}" data-wish-action="${action}"${id ? ` data-wish-id="${esc(id)}"` : ''}>${label}</button>`;
  }
  function placeholder() {
    return '<svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="M40 12 64 26v28L40 68 16 54V26z" stroke="currentColor" stroke-width="1.3"/><path d="m16 26 24 14 24-14M40 40v28M28 19l24 14" stroke="currentColor" stroke-width="1.3"/><path d="m54 11 2-6m8 13 6-2M18 63l-4 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  function imageMarkup(wish, form = false) {
    const image = model.images.get(wish.id);
    return wish.imageUrl ? `<img data-wish-image="${esc(wish.id)}"${image?.version === wish.updatedAt ? ` src="${esc(image.url)}"` : ''} alt="${esc(wish.name)}的心愿图片" ${form ? '' : 'loading="lazy"'}>` : placeholder();
  }
  function wishCard(wish) {
    const p = progress(model.data.totalValueCents, wish.targetCents), complete = !!wish.fulfilledAt;
    const percentage = p.percent >= 100 ? '100' : String(Math.floor(p.percent * 10) / 10);
    return `<article class="wish-card${complete ? ' is-fulfilled' : ''}" data-wish-card="${esc(wish.id)}">
      <div class="wish-card-top"><div class="wish-visual">${imageMarkup(wish)}</div><div class="wish-card-title"><span class="wish-status">${complete ? '✓ 心愿已实现' : p.percent >= 100 ? '等值目标已达到' : '正在靠近喜欢的东西'}</span><h3>${esc(wish.name)}</h3><p class="wish-price">${money(wish.targetCents)}</p></div></div>
      <div class="wish-progress-label"><span>训练等值进度</span><strong>${percentage}<small>%</small></strong></div><progress class="wish-progress" value="${p.percent}" max="100" aria-label="${esc(wish.name)}的训练等值进度">${percentage}%</progress>
      <p class="wish-remaining">${p.remainingCents ? `还差 <strong>${money(p.remainingCents)}</strong> · 约 ${duration(p.remainingMinutes)}` : '这份坚持，已经攒到心愿的等值目标。'}</p>
      ${complete ? `<p class="wish-fulfilled-date">${esc(wish.fulfilledAt.slice(0, 10))} · 由你标记实现</p>` : ''}
      <div class="wish-card-actions">${button(complete ? 'reopen' : 'fulfill', complete ? '重新设为进行中' : '标记心愿已实现', wish.id, 'secondary')}${button('edit', '编辑', wish.id)}${button('delete', '删除', wish.id, 'text-button danger')}</div>
    </article>`;
  }
  function errorMarkup() {
    return model.error ? `<div class="wish-error" role="alert"><span>${esc(model.error)}${model.data ? ' 下方是上次保存的进度。' : ''}</span>${button('retry', '重试')}</div>` : '';
  }
  function panelContent() {
    const data = model.data;
    return `<div class="wish-section-heading"><div><p class="eyebrow">A LITTLE CLOSER, EVERY SESSION</p><h2>训练心愿</h2><p>把球场上的坚持，换算成离心愿更近的一步。</p></div>${button('create', '+ 添加心愿', '', 'primary')}</div>
      <div class="wish-value-card"><div class="wish-value-copy"><span class="wish-value-label">我的累计训练等值</span><strong class="wish-total">${data ? money(data.totalValueCents) : '—'}</strong><p>${data ? `已记录 ${duration(data.totalMinutes)}` : '正在读取你的长期训练记录…'}</p></div><div class="wish-rate"><span class="wish-tennis-ball" aria-hidden="true"></span><strong>1 小时 = ¥150</strong><small>每 1 分钟，都算数</small></div></div>
      <p class="wish-explainer">按 ¥150/小时折算，用来记录坚持与心愿进度，不代表实际到账。累计包含这个账号在各群记录的打球与训练时长；签到本身不计时长。</p>${errorMarkup()}
      ${data ? data.wishes.length ? `<div class="wish-grid">${data.wishes.map(wishCard).join('')}</div><p class="wish-footnote">心愿仅自己可见。每个心愿都参考同一份累计训练等值，标记实现不会扣减，也不会清空训练记录。</p>` : `<div class="wish-empty"><div class="wish-empty-art">${placeholder()}</div><div><h3>下一份喜欢，交给每一次挥拍。</h3><p>一支新球拍、一双球鞋，或一场旅行。<br>写下想要的东西和价格，看看坚持带你走了多远。</p>${button('create', '写下第一个心愿', '', 'secondary')}</div></div>` : !model.error ? '<p class="loading-line wish-loading" role="status">正在打开我的心愿…</p>' : ''}`;
  }
  function teaserContent() {
    const d = model.data;
    return `<div><span class="wish-teaser-label">我的训练心愿</span><strong>${d ? money(d.totalValueCents) : '每小时，攒下 ¥150 训练等值'}</strong><small>${d ? `${duration(d.totalMinutes)}的坚持 · 看看离心愿还有多远` : '让每一次挥拍，都离喜欢的东西更近一步'}</small></div>${button('open', '查看心愿 <span aria-hidden="true">↗</span>', '', 'secondary')}`;
  }
  function repaint() {
    if (!syncIdentity()) return;
    document.querySelectorAll('[data-wishes-panel]').forEach(el => { el.innerHTML = panelContent(); });
    document.querySelectorAll('[data-wishes-teaser]').forEach(el => { el.innerHTML = teaserContent(); });
    loadImages();
  }
  async function refresh({ force = false } = {}) {
    if (!syncIdentity()) return;
    if (model.pending) {
      if (!force) return model.pending;
      // A write may finish after an already-running read took its snapshot.
      // Queue a fresh read after it, without crossing an identity change.
      const stillCurrent = guard();
      await model.pending;
      if (stillCurrent()) return refresh({ force: true });
      return;
    }
    if (!force && Date.now() - model.loadedAt < 30000) { loadImages(); return; }
    const current = guard();
    const task = (async () => {
      try {
        const result = await base.request('/api/wishes');
        if (!current()) return;
        if (!Number.isSafeInteger(result.totalMinutes) || result.totalMinutes < 0 || !Number.isSafeInteger(result.totalValueCents) || result.totalValueCents < 0 || !Array.isArray(result.wishes)) throw new Error('心愿数据暂时不完整，请重试。');
        model.data = result; model.error = '';
        const valid = new Map(result.wishes.map(w => [w.id, w]));
        for (const [id, value] of model.images) if (!valid.get(id)?.imageUrl || valid.get(id)?.updatedAt !== value.version) { URL.revokeObjectURL(value.url); model.images.delete(id); }
      } catch (error) {
        if (!current()) return;
        model.error = error.message || '暂时未能读取心愿，请重试。';
      } finally {
        if (current()) { model.loadedAt = Date.now(); model.pending = null; repaint(); }
      }
    })();
    model.pending = task;
    return task;
  }
  async function loadImages() {
    if (!syncIdentity() || !model.data) return;
    const current = guard();
    for (const wish of model.data.wishes) {
      const targets = [...document.querySelectorAll('[data-wish-image]')].filter(img => img.dataset.wishImage === wish.id);
      if (!targets.length || !wish.imageUrl) continue;
      const existing = model.images.get(wish.id);
      if (existing?.version === wish.updatedAt) { targets.forEach(img => { if (img.src !== existing.url) img.src = existing.url; }); continue; }
      if (model.imagePending.has(wish.id)) continue;
      // Accept only this account-scoped resource path, never arbitrary URLs.
      if (wish.imageUrl !== '/api/wishes/' + wish.id + '/image') continue;
      const marker = {}; model.imagePending.set(wish.id, marker);
      (async () => {
        try {
          const response = await apiFetch(wish.imageUrl);
          if (!response.ok) return;
          const blob = await response.blob();
          if (!current() || model.data?.wishes.find(w => w.id === wish.id)?.updatedAt !== wish.updatedAt) return;
          const url = URL.createObjectURL(blob), old = model.images.get(wish.id);
          if (old) URL.revokeObjectURL(old.url);
          model.images.set(wish.id, { url, version: wish.updatedAt });
          for (const img of document.querySelectorAll('[data-wish-image]')) if (img.dataset.wishImage === wish.id) img.src = url;
        } catch { /* The wish remains useful when its optional photo is offline. */ }
        finally { if (model.imagePending.get(wish.id) === marker) model.imagePending.delete(wish.id); }
      })();
    }
  }
  function afterRender() {
    if (!syncIdentity()) return;
    if (!hasClub()) {
      const anchor = document.querySelector('.welcome-grid');
      if (anchor && !document.querySelector('[data-wishes-panel]')) anchor.insertAdjacentHTML('beforebegin', '<section class="wishes-panel" data-wishes-panel aria-label="我的训练心愿"></section>');
    } else if (state.board?.me && state.tab === 'my') {
      const anchor = document.querySelector('.account-panel');
      if (anchor && !document.querySelector('[data-wishes-panel]')) anchor.insertAdjacentHTML('afterend', '<section class="wishes-panel" data-wishes-panel aria-label="我的训练心愿"></section>');
    } else if (state.board?.me && state.tab === 'feed') {
      const anchor = document.querySelector('.main > .stats');
      if (anchor && !document.querySelector('[data-wishes-teaser]')) anchor.insertAdjacentHTML('beforebegin', '<section class="wish-teaser" data-wishes-teaser aria-label="我的训练心愿"></section>');
    }
    if (document.querySelector('[data-wishes-panel], [data-wishes-teaser]')) { repaint(); void refresh(); }
  }
  function openEditor(id) {
    if (!syncIdentity()) return;
    const wish = id ? model.data?.wishes.find(w => w.id === id) : null;
    if (id && !wish) { toast('心愿还没有加载出来，请刷新后再试。'); return; }
    const current = guard(), wishId = wish?.id || crypto.randomUUID();
    let saved = !!wish, imagePreview = null, selectedImage = null, imageTask = Promise.resolve(), fileGeneration = 0, busy = false;
    modal(wish ? '编辑我的心愿' : '写下一个心愿', `<form id="wish-form" class="form"><p class="form-helper">只给自己看的小目标。训练记录会自动换算进度。</p><div><label for="wish-name">想要的东西</label><input id="wish-name" name="name" maxlength="60" value="${esc(wish?.name || '')}" placeholder="比如：一支喜欢的新球拍" required></div><div><label for="wish-price">心愿金额 <span class="optional">元</span></label><input id="wish-price" name="price" type="text" inputmode="decimal" maxlength="12" value="${wish ? (wish.targetCents / 100).toFixed(2) : ''}" placeholder="例如 3000" required><p class="form-helper" id="wish-price-preview">按 ¥150/小时，看看离喜欢的东西还有多远。</p></div><div><label for="wish-image">心愿图片 <span class="optional">选填</span></label><div class="wish-upload-preview" id="wish-image-preview">${wish ? imageMarkup(wish, true) : placeholder()}</div><input type="file" id="wish-image" accept="image/jpeg,image/png,image/webp"><p class="form-helper">选一张代表心愿的图片，会自动压缩后保存。图片仅自己可见。</p></div>${actionButtons('保存心愿')}</form>`, 'SOMETHING TO LOOK FORWARD TO');
    const form = document.querySelector('#wish-form'), price = form.elements.price, error = form.querySelector('.form-error');
    const dispose = () => { fileGeneration++; if (imagePreview) URL.revokeObjectURL(imagePreview); dialog.removeEventListener('close', dispose); };
    dialog.addEventListener('close', dispose, { once: true });
    function pricePreview() {
      try { const amount = parsePrice(price.value), p = progress(model.data?.totalValueCents || 0, amount); document.querySelector('#wish-price-preview').textContent = p.remainingCents ? `目标等值 ${duration(Math.ceil(amount / RATE_CENTS_PER_MINUTE))} · 还需约 ${duration(p.remainingMinutes)}` : '你的累计训练等值已经达到这个目标。'; }
      catch { document.querySelector('#wish-price-preview').textContent = '按 ¥150/小时折算；修改或删除训练记录，进度也会同步更新。'; }
    }
    price.addEventListener('input', pricePreview); if (wish) pricePreview();
    form.querySelector('#wish-image').addEventListener('change', event => {
      const file = event.target.files[0], version = ++fileGeneration;
      selectedImage = null; error.textContent = '';
      if (!file) return;
      imageTask = (async () => {
        try {
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
          const blob = await photoBlob(file);
          if (!current() || version !== fileGeneration || !form.isConnected) return;
          selectedImage = blob;
          if (imagePreview) URL.revokeObjectURL(imagePreview);
          imagePreview = URL.createObjectURL(blob);
          form.querySelector('#wish-image-preview').innerHTML = `<img src="${imagePreview}" alt="心愿图片预览">`;
        } catch (e) { if (current() && version === fileGeneration && form.isConnected) { error.textContent = e.message; event.target.value = ''; } }
      })();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !current()) return;
      busy = true;
      await submit(form, async () => {
        const name = form.elements.name.value.trim(), targetCents = parsePrice(price.value);
        if (!name) throw new Error('给这份心愿取个名字吧。');
        await imageTask;
        if (!current() || !form.isConnected) return;
        await base.request(saved ? '/api/wishes/' + wishId : '/api/wishes', saved ? 'PATCH' : 'POST', saved ? { name, targetCents } : { id: wishId, name, targetCents });
        saved = true;
        if (!current()) return;
        if (!form.isConnected) { await refresh({ force: true }); return; }
        if (selectedImage) {
          try {
            const response = await apiFetch('/api/wishes/' + wishId + '/image', { method: 'POST', headers: { 'Content-Type': selectedImage.type }, body: selectedImage });
            if (!response.ok) { const result = await response.json(); throw new Error(result.error || '图片上传失败'); }
          } catch (e) { if (current()) { await refresh({ force: true }); throw new Error('心愿已保存，图片暂未保存：' + e.message + '。可以直接重试。'); } return; }
        }
        if (!current()) return;
        if (!form.isConnected) { await refresh({ force: true }); return; }
        closeDialog(); await refresh({ force: true }); if (!current()) return; toast(wish ? '心愿更新好了，继续慢慢靠近。' : '心愿记下了，每一次挥拍都算数。');
      });
      busy = false;
    });
    loadImages();
  }
  function changeWish(id, action) {
    if (!syncIdentity()) return;
    const wish = model.data?.wishes.find(w => w.id === id);
    if (!wish) return;
    const current = guard(), deleting = action === 'delete', fulfilling = action === 'fulfill';
    modal(deleting ? '删除这个心愿？' : fulfilling ? '为这份心愿留下纪念' : '继续向这个心愿前进', `<form id="wish-action-form" class="form"><p><strong>${esc(wish.name)}</strong></p><p>${deleting ? '只删除这个心愿和它的图片，累计训练等值与训练记录都会保留。' : fulfilling ? '按自己的实际情况标记“已实现”。累计训练等值会继续保留，之后也可以改回进行中。' : '心愿会恢复为进行中，继续参考你的累计训练等值。'}</p>${actionButtons(deleting ? '确认删除心愿' : fulfilling ? '标记心愿已实现' : '恢复为进行中')}</form>`, 'MY TRAINING WISH');
    const form = document.querySelector('#wish-action-form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      await submit(form, async () => {
        if (!current()) return;
        await base.request('/api/wishes/' + id, deleting ? 'DELETE' : 'PATCH', deleting ? undefined : { fulfilled: fulfilling });
        if (!current()) return;
        if (!form.isConnected) { await refresh({ force: true }); return; }
        closeDialog(); await refresh({ force: true }); if (!current()) return; toast(deleting ? '心愿已删除，训练的坚持还在。' : fulfilling ? '心愿已实现，为这份坚持留个纪念。' : '心愿已恢复，继续向喜欢的东西靠近。');
      });
    });
  }
  function trainingPreview() {
    const form = document.querySelector('#record-form'), input = form?.elements.minutes;
    if (!form || !input) return;
    const block = document.createElement('div'); block.className = 'wish-record-value'; block.setAttribute('aria-live', 'polite');
    input.closest('.row').insertAdjacentElement('afterend', block);
    function update() {
      const minutes = Number(input.value);
      block.innerHTML = Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 ? `<span>这次打球的训练等值</span><strong>${money(minutes * RATE_CENTS_PER_MINUTE)}</strong><small>保存后计入个人累计与心愿进度 · ¥150/小时</small>` : '<span>填好训练时长，就能看到这次的训练等值。</span>';
    }
    input.addEventListener('input', update); update();
  }

  render = function (...args) { const result = base.render.apply(this, args); afterRender(); return result; };
  resetView = function (...args) { const result = base.resetView.apply(this, args); reset(); return result; };
  request = async function (path, method = 'GET', ...args) {
    const identity = activeIdentity(), result = await base.request.call(this, path, method, ...args);
    if (identity && identity === activeIdentity() && ['POST', 'PATCH', 'DELETE'].includes(method) && /^\/api\/records(?:\/[a-f0-9-]+)?(?:\?|$)/i.test(path)) {
      model.loadedAt = 0;
      // Let the caller finish its own form/load flow; repaint only our section.
      Promise.resolve(model.pending).then(() => { if (identity === activeIdentity()) return refresh({ force: true }); }).catch(() => {});
    }
    return result;
  };
  openRecord = function (...args) { const result = base.openRecord.apply(this, args); trainingPreview(); return result; };
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-wish-action]');
    if (!target || target.disabled || !syncIdentity()) return;
    const action = target.dataset.wishAction, id = target.dataset.wishId;
    if (action === 'create' || action === 'edit') openEditor(id);
    else if (action === 'retry') void refresh({ force: true });
    else if (action === 'open') { state.tab = 'my'; render(); loadAvatars(); document.querySelector('[data-wishes-panel]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else if (['fulfill', 'reopen', 'delete'].includes(action)) changeWish(id, action);
  });
  window.addEventListener('pagehide', reset);
  window.TennisWishes = Object.freeze({ refresh, reset, parsePrice, progress, money, duration });
  afterRender();
})();
