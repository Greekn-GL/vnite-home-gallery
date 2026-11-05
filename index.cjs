const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { id: pluginId, configuration } = require('./manifest.json');

const snapshotChannel = 'local-vnite-home-gallery:snapshot';
const launchChannel = 'local-vnite-home-gallery:launch';
const instanceKey = '__localVniteHomeGallery';
let dispose;

function stringList(value, limit) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, limit)
    : [];
}

function dateValue(value) {
  return Date.parse(value) || 0;
}

function projectGames(documents, settings, sortFields) {
  const mode = settings.nsfwFilterMode ?? 0;
  const blur = settings.nsfwBlurLevel ?? 0;
  if ((settings.localGameFilterMode ?? 0) !== 0 || settings.customVisibilityFilter?.enabled) return [];

  return Object.values(documents).flatMap(game => {
    if (!game?._id || game._id.startsWith('_') || game._deleted || !game.metadata?.name) return [];
    const nsfw = Boolean(game.apperance?.nsfw);
    if ((mode === 1 && nsfw) || (mode === 2 && !nsfw)) return [];
    const conceal = nsfw && blur >= 2;
    const { metadata, record } = game;
    const score = Number.isFinite(record?.score) && record.score >= 0 ? record.score : null;
    return [{
      card: {
        id: game._id,
        name: conceal ? '已隐藏的游戏' : metadata.name,
        blurImage: nsfw && blur >= 1,
        developers: conceal ? [] : stringList(metadata.developers, 3),
        year: conceal ? '' : String(metadata.releaseDate ?? '').match(/^\d{4}/)?.[0] ?? '',
        tags: conceal ? [] : stringList(metadata.tags, 5),
        score: conceal ? null : score
      },
      recent: record?.hideFromRecentGames ? 0 : dateValue(record?.lastRunDate),
      score: score ?? -1,
      playTime: Number.isFinite(record?.playTime) ? Math.max(0, record.playTime) : 0
    }];
  }).sort((left, right) => {
    for (const field of sortFields) {
      const difference = right[field] - left[field];
      if (difference) return difference;
    }
    return left.card.name.localeCompare(right.card.name, 'zh-CN');
  }).map(game => game.card);
}

async function activate(api) {
  if (dispose) return;
  // Vnite creates missing defaults on read. Initialize the document once, then read it as a unit.
  await api.PluginDB.getValue('#all', {});
  const rendererFile = path.join(app.getAppPath(), 'out', 'renderer', 'index.html');
  const mount = readFileSync(path.join(__dirname, 'renderer.js'), 'utf8').trim();
  const styles = readFileSync(path.join(__dirname, 'gallery.css'), 'utf8');
  const payload = `(${mount})(${JSON.stringify({ styles, snapshotChannel, launchChannel, instanceKey, pluginId })})`;
  const windows = new Map();

  function isRenderer(rawUrl, requireHome = false) {
    try {
      const url = new URL(rawUrl);
      return !path.relative(rendererFile, fileURLToPath(url)) &&
        (!requireHome || /^#\/library\/home\/?(?:\?|$)/.test(url.hash));
    } catch {
      return false;
    }
  }

  function checkSender(event) {
    const state = windows.get(event.sender);
    if (!state || event.senderFrame !== event.sender.mainFrame || !isRenderer(event.senderFrame.url, true)) {
      throw new Error('The showcase is available only on the Vnite library homepage.');
    }
    return state;
  }

  function watchWindow(window) {
    const contents = window.webContents;
    if (windows.has(contents) || contents.isDestroyed()) return;
    const state = { ids: new Set(), pending: null };
    const install = () => {
      if (!isRenderer(contents.getURL())) return;
      state.pending = contents.executeJavaScript(payload).catch(error => {
        if (!contents.isDestroyed()) console.warn('[首页展厅] 加载页面组件失败', error);
      });
    };
    state.detach = () => {
      contents.removeListener('did-finish-load', install);
      contents.removeListener('destroyed', forget);
    };
    const forget = () => windows.delete(contents);
    windows.set(contents, state);
    contents.on('did-finish-load', install);
    contents.once('destroyed', forget);
    if (!contents.isLoadingMainFrame()) install();
  }

  ipcMain.handle(snapshotChannel, async event => {
    const state = checkSender(event);
    const [settings, docs, preferences] = await Promise.all([
      api.ConfigDB.getConfigValue('appearances'),
      api.GameDB.getAllGames(),
      api.PluginDB.getValue('#all', {})
    ]);
    const sortFields = configuration.filter(option => (preferences[option.id] ?? option.default) === true).map(option => option.id);
    const games = projectGames(docs, settings ?? {}, sortFields);
    state.ids = new Set(games.map(game => game.id));
    return games;
  });
  ipcMain.handle(launchChannel, (event, id) => {
    const state = checkSender(event);
    if (typeof id !== 'string' || !state.ids.has(id)) throw new Error('This game is unavailable in the showcase.');
    api.ipc.sendTo(event.sender, 'game:start-from-url', id);
  });

  const onCreated = (_event, window) => watchWindow(window);
  app.on('browser-window-created', onCreated);
  BrowserWindow.getAllWindows().forEach(watchWindow);
  dispose = async () => {
    app.removeListener('browser-window-created', onCreated);
    ipcMain.removeHandler(snapshotChannel);
    ipcMain.removeHandler(launchChannel);
    const entries = Array.from(windows);
    entries.forEach(([, state]) => state.detach());
    windows.clear();
    await Promise.allSettled(entries.map(async ([contents, state]) => {
      await state.pending;
      if (!contents.isDestroyed() && isRenderer(contents.getURL())) {
        await contents.executeJavaScript(`window[${JSON.stringify(instanceKey)}]?.()`);
      }
    }));
  };
}

async function deactivate() {
  if (!dispose) return;
  const cleanup = dispose;
  await cleanup();
  dispose = undefined;
}

module.exports = { activate, deactivate };
