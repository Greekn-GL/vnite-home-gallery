function mountGallery({ styles, snapshotChannel, launchChannel, instanceKey, pluginId }) {
  window[instanceKey]?.();
  const ipc = window.electron?.ipcRenderer;
  if (!ipc) return;

  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(className, text) {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }

  const panel = element('section', 'vhg');
  panel.setAttribute('aria-label', '首页展厅');
  const hero = element('article', 'vhg-hero');
  const heroImage = element('img', 'vhg-backdrop');
  heroImage.alt = '';
  const info = element('div', 'vhg-info');
  const title = element('h2', 'vhg-game');
  const metadata = element('p', 'vhg-meta');
  const tags = element('ul', 'vhg-tags');
  const actions = element('div', 'vhg-actions');
  const launch = button('vhg-launch', '▷  开始游戏');
  const detail = element('a', 'vhg-detail', '游戏详情');
  const status = element('span', 'vhg-status');
  status.setAttribute('role', 'status');
  actions.append(launch, detail, status);
  info.append(title, metadata, tags, actions);
  hero.append(heroImage, info);

  const sectionHeader = element('div', 'vhg-deck-head');
  const deckActions = element('div', 'vhg-deck-actions');
  const previous = button('vhg-arrow', '‹');
  const next = button('vhg-arrow', '›');
  previous.setAttribute('aria-label', '向左滚动封面');
  next.setAttribute('aria-label', '向右滚动封面');
  deckActions.append(previous, next);
  sectionHeader.append(element('h2', '', '游戏库'), deckActions);
  const deck = element('div', 'vhg-deck');
  deck.setAttribute('aria-label', '游戏封面');
  const header = element('div', 'vhg-header');
  const layoutToggle = button('vhg-detail', '原版布局');
  header.append(element('h1', 'vhg-title', '今天玩点什么'), layoutToggle);
  panel.append(header, hero, sectionHeader, deck);

  let host;
  let selected;
  let revision = 0;
  let assetVersion = 0;
  let frame = 0;
  let refreshTimer = 0;
  let disposed = false;
  let compact = false;
  const posters = new Map();

  function updateLayout() {
    panel.classList.toggle('vhg-compact', compact);
    layoutToggle.textContent = compact ? '展厅布局' : '原版布局';
    layoutToggle.setAttribute('aria-expanded', String(!compact));
    panel.parentElement?.classList.toggle('vhg-showcase-active', !compact);
  }

  function detachPanel() {
    panel.parentElement?.classList.remove('vhg-showcase-active');
    panel.remove();
  }

  layoutToggle.addEventListener('click', () => {
    compact = !compact;
    updateLayout();
  });

  function imageUrl(game, kind) {
    return `attachment://game/${encodeURIComponent(game.id)}/images/${kind}.webp?v=${assetVersion}`;
  }

  function select(game) {
    if (selected) posters.get(selected.id)?.setAttribute('aria-pressed', 'false');
    selected = game;
    posters.get(game.id)?.setAttribute('aria-pressed', 'true');
    title.textContent = game.name;
    metadata.textContent = [...game.developers, game.year, game.score === null ? '' : `★ ${game.score}`].filter(Boolean).join('  ·  ');
    metadata.hidden = !metadata.textContent;
    tags.replaceChildren(...game.tags.map(tag => element('li', '', tag)));
    tags.hidden = game.tags.length === 0;
    detail.href = `#/library/games/${encodeURIComponent(game.id)}/all`;
    status.textContent = '';
    heroImage.classList.toggle('vhg-blurred', game.blurImage);
    heroImage.hidden = true;
    const candidates = ['background', 'cover'];
    function loadImage() {
      const kind = candidates.shift();
      if (kind) heroImage.src = imageUrl(game, kind);
      else heroImage.removeAttribute('src');
    }
    heroImage.onload = () => { heroImage.hidden = false; };
    heroImage.onerror = loadImage;
    loadImage();
  }

  function render(games) {
    if (!games.length) {
      detachPanel();
      return;
    }
    const currentFocus = deck.contains(document.activeElement);
    const scroll = deck.scrollLeft;
    posters.clear();
    const entries = games.map(game => {
      const poster = button('vhg-poster');
      poster.setAttribute('aria-label', game.name);
      poster.setAttribute('aria-pressed', 'false');
      poster.title = game.name;
      const image = element('img', game.blurImage ? 'vhg-blurred' : '');
      image.alt = '';
      image.loading = 'lazy';
      image.src = imageUrl(game, 'cover');
      image.addEventListener('error', () => image.remove(), { once: true });
      poster.append(element('span', '', game.name), image);
      poster.addEventListener('click', () => select(game));
      posters.set(game.id, poster);
      return poster;
    });
    deck.replaceChildren(...entries);
    select(games.find(game => game.id === selected?.id) ?? games[0]);
    if (panel.parentElement !== host) host.prepend(panel);
    updateLayout();
    deck.scrollLeft = scroll;
    if (currentFocus) posters.get(selected.id)?.focus({ preventScroll: true });
  }

  launch.addEventListener('click', async () => {
    if (!selected || launch.disabled) return;
    launch.disabled = true;
    try {
      await ipc.invoke(launchChannel, selected.id);
    } catch {
      status.textContent = '启动请求失败，请从游戏详情页重试。';
    } finally {
      launch.disabled = false;
    }
  });
  previous.addEventListener('click', () => deck.scrollBy({ left: -deck.clientWidth * 0.8, behavior: 'smooth' }));
  next.addEventListener('click', () => deck.scrollBy({ left: deck.clientWidth * 0.8, behavior: 'smooth' }));

  function findHost() {
    if (!/^#\/library\/home\/?(?:\?|$)/.test(location.hash)) return null;
    // The all-games grid is present on the ordinary homepage and absent on search/filter results.
    return document.querySelector(
      '#root [data-slot="scroll-area-viewport"] > div > [class~="pt-[18px]"].flex.flex-col.gap-3' +
      ':has(> .w-full.flex.flex-col.gap-1 > .w-full.pt-3.pl-5.pr-5.pb-6)'
    );
  }

  function refresh(delay = 0) {
    const request = ++revision;
    clearTimeout(refreshTimer);
    if (!host) return;
    refreshTimer = setTimeout(async () => {
      try {
        const games = await ipc.invoke(snapshotChannel);
        if (request === revision && host === findHost()) render(games);
      } catch (error) {
        if (request === revision) {
          detachPanel();
          console.warn('[首页展厅] 读取游戏库失败', error);
        }
      }
    }, delay);
  }

  function syncPage() {
    frame = 0;
    const container = findHost();
    if (container === host) return;
    detachPanel();
    host = container;
    refresh();
  }

  function scheduleSync() {
    if (!disposed && !frame) frame = requestAnimationFrame(syncPage);
  }

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', scheduleSync);
  window.addEventListener('popstate', scheduleSync);
  const stopDocs = ipc.on('db:doc-changed', (_event, change) => {
    if (change?.dbName === 'plugin' && change.docId === pluginId) {
      refresh(80);
      return;
    }
    if (!['config', 'game'].includes(change?.dbName)) return;
    if (change.dbName === 'config' && change.docId !== 'appearances') return;
    if (change.dbName === 'config' || change.data?._deleted) detachPanel();
    refresh(80);
  });
  const stopImages = ipc.on('db:attachment-changed', (_event, change) => {
    if (change?.dbName !== 'game') return;
    assetVersion = Date.now();
    refresh(80);
  });
  window[instanceKey] = () => {
    disposed = true;
    revision++;
    clearTimeout(refreshTimer);
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('hashchange', scheduleSync);
    window.removeEventListener('popstate', scheduleSync);
    stopDocs();
    stopImages();
    detachPanel();
    style.remove();
    delete window[instanceKey];
  };
  scheduleSync();
}
