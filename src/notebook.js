/* The fresh app has one shared notebook. Membership and private data remain
 * enforced by the API; this layer only simplifies navigation and onboarding. */
(() => {
  'use strict';
  const notebook = config.singleNotebook;
  if (!config.freshStart || !validClub(notebook?.id)) return;

  const base = { render, loadAccount, load, renderInviteGate, renderPublicCard, modal, openAccess };
  const membership = () => state.clubs.find(club => club.id === notebook.id);
  const notebookName = () => state.board?.club.id === notebook.id ? state.board.club.name : membership()?.name || notebook.name || '网球记录本';
  const brand = () => '<div class="brand"><span class="brand-icon" aria-hidden="true">🎾</span><div><strong>网球记录本</strong><small>COURT NOTES</small></div></div>';

  function accountActions() {
    return state.account
      ? `<span>已记住 <strong>${esc(state.account.displayName)}</strong></span><div><button class="text-button" data-action="identity">我的身份</button><button class="text-button" data-action="recovery-login">切换身份</button><button class="text-button" data-action="logout">退出本设备</button></div>`
      : '<button class="secondary" data-action="recovery-login">找回我的名片</button>';
  }

  function pendingIdentity() {
    const attempts = state.registrationAttempts.filter(item => item.clubId === notebook.id);
    const claims = state.claims.filter(item => item.id === notebook.id && !membership());
    return attempts.map(item => `<div class="home-login-note"><div><strong>继续保存 ${esc(item.nickname)} 的身份</strong><p>原来的名片与记录仍在，上次保存还没有收到完整回复。</p></div><button class="primary" data-action="register" data-club="${notebook.id}">继续保存我的身份</button></div>`).join('')
      + claims.map(item => `<div class="home-login-note"><div><strong>连接 ${esc(item.nickname)} 的原名片</strong><p>本设备保留着你的原名片，连接后继续使用原头像和训练记录。</p></div><button class="primary" data-action="bind-legacy" data-club="${notebook.id}">连接原名片</button></div>`).join('');
  }

  function notebookGate({ unavailable = false } = {}) {
    const joined = membership();
    document.title = `${notebookName()} · 网球记录本`;
    app.innerHTML = `<main class="welcome notebook-welcome"><div class="welcome-top">${brand()}<div class="welcome-account">${accountActions()}</div></div>
      ${readQuickStart() ? '<div class="home-login-note"><div><strong>继续保存刚刚建立的名片</strong><p>恢复码还没有完整收到，请继续保存。</p></div><button class="primary" data-action="quick-signup">继续保存名片</button></div>' : ''}
      ${pendingIdentity()}
      <div class="welcome-grid notebook-gate-grid"><section class="welcome-copy"><p class="eyebrow">一本记录本，记下每一次进步。</p><h1>${esc(notebookName())}</h1><p>一起签到、认真训练，<br>把球场上的坚持，慢慢记成自己的故事。</p><div class="welcome-notes"><div class="welcome-note"><span>01</span><strong>记录训练与下次计划</strong></div><div class="welcome-note"><span>02</span><strong>看见六边形能力的变化</strong></div><div class="welcome-note"><span>03</span><strong>用坚持，靠近自己的心愿</strong></div></div></section>
      <section class="notebook-access" aria-labelledby="notebook-access-heading"><p class="eyebrow">YOUR COURT NOTES</p><h2 id="notebook-access-heading">${unavailable ? '继续使用这本记录本' : joined ? '你的记录一直都在' : state.account ? '让群友带你入场' : '找回名片，继续记球'}</h2>
        ${unavailable ? '<p>这个旧入口已不再使用。请从记录本首页继续，原身份和已保存的内容仍会保留。</p>' : ''}
        ${joined ? `<p>以 <strong>${esc(joined.nickname)}</strong> 的名片，继续记录训练和成长。</p><button class="primary" data-action="${state.account ? 'open-club' : 'register'}" data-club="${notebook.id}">${state.account ? '打开记录本' : '保存我的原身份'}</button>`
          : state.account ? '<p>你已登录自己的账号。请从微信群里的完整邀请链接进入，加入后即可开始记录。</p><p class="profile-help">如果之前已经记过球，请用那张名片的恢复码登录，原头像和历史记录会跟着你。</p><button class="secondary" data-action="recovery-login">用原恢复码找回名片</button>'
            : '<p>在这个浏览器登录过，会自动记住你。换了设备，用自己保存的恢复码找回头像与训练记录。</p><button class="primary" data-action="recovery-login">用恢复码进入</button><details class="auth-links"><summary>以前用邮箱登录的账号</summary><button class="text-button" data-action="email-login">用原邮箱和密码登录</button></details><p class="notebook-new-member">第一次来？请点开微信群里的完整邀请链接，填写昵称即可加入。</p>'}
      </section></div><p class="welcome-footer">每个人使用自己的名片记录。恢复码只自己保存，球员资料和打球记录仅组内可见。</p></main>`;
  }

  function tidyNavigation() {
    for (const heading of app.querySelectorAll('.brand strong')) heading.textContent = '网球记录本';
    for (const button of document.querySelectorAll('[data-action="home"]')) button.textContent = '记录本首页';
    if (document.title.startsWith('网球搭子 · ')) document.title = document.title.replace('网球搭子 · ', '网球记录本 · ');
    if (state.preview?.club.id === notebook.id && !state.preview.joined) document.title = `加入 ${state.preview.club.name} · 网球记录本`;
  }

  function selectNotebook() {
    // Never replace an invitation, invalid link, public card or explicit route.
    // Joining still requires the actual group invitation and server permission.
    if (state.publicToken || state.invalidInvite || state.invite || state.club || !membership()) return false;
    state.club = notebook.id;
    history.replaceState(null, '', `${appBase}#c=${notebook.id}`);
    return true;
  }

  welcome = notebookGate;
  loadAccount = async function (...args) {
    const ready = await base.loadAccount.apply(this, args);
    if (ready) {
      state.clubs = state.clubs.filter(club => club.id === notebook.id);
      selectNotebook();
    }
    return ready;
  };
  load = async function (...args) {
    const hadRoute = hasClub();
    const result = await base.load.apply(this, args);
    // base.load() can start on the home route and load identity first. If that
    // revealed this notebook, finish opening it in the same navigation.
    if (!hadRoute && hasClub() && !state.board && state.club === notebook.id && membership()) return base.load.apply(this, args);
    return result;
  };
  render = function (...args) {
    // The initial app.js loadAccount may already be in flight when this addon
    // loads, so also select here before initialize() decides whether to load.
    if (state.authReady) selectNotebook();
    const normalRoute = !state.publicToken && !state.invalidInvite && !state.invite && state.authReady;
    if (normalRoute && state.club && state.club !== notebook.id) notebookGate({ unavailable: true });
    else if (normalRoute && state.club === notebook.id && !state.board && !membership()) notebookGate();
    else base.render.apply(this, args);
    tidyNavigation();
  };
  renderInviteGate = function (...args) { const result = base.renderInviteGate.apply(this, args); tidyNavigation(); return result; };
  renderPublicCard = function (...args) { const result = base.renderPublicCard.apply(this, args); tidyNavigation(); return result; };
  modal = function (...args) {
    if (args[0] === '登录网球搭子') args[0] = '登录网球记录本';
    if (args[0] === '注册网球搭子账号') args[0] = '保存我的记录本身份';
    const result = base.modal.apply(this, args); tidyNavigation(); return result;
  };
  openAccess = function (...args) {
    if (state.invite && !state.invalidInvite) return base.openAccess.apply(this, args);
    modal('进入网球记录本', `<p>用只由你保存的私密恢复码，找回自己的头像、训练记录与心愿。</p>${state.account ? `<p class="profile-help">当前记住：<strong>${esc(state.account.displayName)}</strong>。</p>` : ''}<div class="form-actions"><button class="primary" data-action="recovery-login">用恢复码找回名片</button></div><details class="auth-links"><summary>以前用邮箱登录的账号</summary><button class="text-button" data-action="email-login">用原邮箱和密码登录</button></details><p class="notebook-new-member">第一次使用，请从微信群里的完整邀请链接填写昵称加入。</p>`);
  };

  // app.js starts initialization before deferred addons execute; repaint the
  // loading/anonymous view now, while its pending identity request completes.
  if (state.authReady && selectNotebook()) { render(); void load(); }
  else render();
})();
