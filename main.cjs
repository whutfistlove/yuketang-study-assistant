'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { DevToolsPipe } = require('./devtools.cjs');
const { Settings, dataFolder } = require('./settings.cjs');
const { WORLD, BINDING, REPLY, StudyRequestError, isCourseUrl, buildScript, askModel, canUseVision } = require('./bridge.cjs');

const HOME_URL = 'https://www.yuketang.cn/v2/web/index';
const POPUP_WAIT = 7_000;
const isBlank = url => !url || url === 'about:blank';

function popupDestination(from, to, userGesture, allowedUrl) {
  try {
    if (!allowedUrl(from) || !allowedUrl(to)) return false;
    const source = new URL(from);
    const target = new URL(to);
    if (source.origin !== target.origin || target.href === source.href) return false;
    if (/^\/v2\/web\/index\/?$/.test(source.pathname)) {
      return userGesture && /^\/v2\/web\/studentLog\/[^/]+\/?$/.test(target.pathname);
    }
    const cardCourse = target.pathname.match(/^\/v2\/web\/studentCards\/(\d+)\/\d+\/\d+(?:\/ppt)?\/?$/)?.[1];
    const workspace = source.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/[^/]+\/[^/]+\/?$/)?.[1];
    if (workspace) return cardCourse === workspace && (!target.searchParams.has('classroom_id')
      || target.searchParams.get('classroom_id') === workspace);
    const classroom = source.pathname.match(/^\/v2\/web\/studentLog\/([^/]+)\/?$/)?.[1];
    if (!classroom) return false;
    const activity = target.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/(?:graph|video|audio|ppt|courseware|forum|discussion|exercise|homework|quiz|practice|test|share)\/[^/]+\/?$/i);
    if (activity) return activity[1] === classroom;
    if (cardCourse && !target.searchParams.has('classroom_id')) return cardCourse === classroom;
    return /^\/v2\/web\/(?:studentCards|studentVideo|studentHomework|exercise|homework|video|audio|share)\//i.test(target.pathname)
      && target.searchParams.get('classroom_id') === classroom;
  } catch {
    return false;
  }
}

function edgePath() {
  const locations = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  const found = locations.filter(Boolean).map(folder => path.join(folder, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(filename => fs.existsSync(filename));
  if (!found) throw new Error('未找到 Microsoft Edge。');
  return found;
}

async function reserveProfile(profile, activate) {
  const id = createHash('sha256').update(path.resolve(profile).toLowerCase()).digest('hex').slice(0, 24);
  const address = '\\\\.\\pipe\\YuketangStudy-' + id;
  const server = net.createServer(client => {
    client.on('error', () => {});
    activate().then(
      shown => client.end(shown ? 'shown' : 'retry'),
      () => client.end('error'),
    );
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const listening = once(server, 'listening');
      server.listen(address);
      await listening;
      return server;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
    let reply = '';
    const client = net.createConnection(address);
    client.setEncoding('utf8');
    client.on('data', chunk => { reply += chunk; });
    client.setTimeout(8000, () => client.destroy(new Error('已打开的学习窗口未响应。')));
    try {
      await once(client, 'end');
      if (reply === 'shown') return null;
      if (reply !== 'retry') throw new Error('未能显示已打开的学习窗口。');
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error;
    }
    await delay(100);
  }
  throw new Error('原学习窗口正在退出，请稍后重试。');
}

async function launchBrowser({ settings, profile, browser = edgePath(), url = HOME_URL, headless = false,
  allowedUrl = isCourseUrl, fetchModel = fetch, info = console.log, resumePpt = false, resumeDirectory = false, resumeWorkspace = false }) {
  if (!allowedUrl(url)) throw new Error('请用雨课堂课程页的网址。');
  const startUrl = new URL(url);
  const selectingCourse = /^\/v2\/web\/index\/?$/.test(startUrl.pathname);
  const allowPptResume = resumePpt && /^\/v2\/web\/studentCards\/(?:\d+\/\d+\/\d+|[^?#]+\/ppt)\/?$/.test(startUrl.pathname);
  const allowDirectoryResume = resumeDirectory && /^\/v2\/web\/studentLog\/[^/]+\/?$/.test(startUrl.pathname);
  const allowWorkspaceResume = resumeWorkspace && /^\/ai-workspace\/lms-graph\/[^/]+\/[^/]+\/[^/]+\/?$/.test(startUrl.pathname);
  let resumePending = allowPptResume || allowDirectoryResume || allowWorkspaceResume;
  let initialSession;
  let initialTargetId;
  let activeSession;
  if (!path.isAbsolute(profile)) throw new Error('独立的 Edge 配置目录必须使用绝对路径。');
  const core = fs.readFileSync(path.join(__dirname, 'study-core.js'), 'utf8');
  const source = buildScript(core, allowedUrl);
  const sessions = new Map();
  let activate = async () => false;
  const reservation = await reserveProfile(profile, () => activate());
  if (!reservation) return { reused: true };
  const args = [
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--no-startup-window', ...(headless ? ['--headless=new'] : []),
  ];
  const edge = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: headless });
  edge.stderr.resume();
  const pipe = new DevToolsPipe(edge);
  const closed = once(pipe, 'closed');
  const exited = new Promise(resolve => edge.once('close', () => {
    reservation.close();
    resolve();
  }));
  let closing;
  const close = () => {
    if (!closing) closing = (async () => {
      if (!pipe.closed) await pipe.send('Browser.close').catch(() => {
        if (!pipe.closed && edge.exitCode === null) edge.kill();
      });
      await exited;
    })();
    return closing;
  };
  async function showWindow(page) {
    const { windowId, bounds } = await pipe.send('Browser.getWindowForTarget', { targetId: page.target.targetId });
    if (headless) return;
    if (bounds.windowState === 'minimized') {
      await pipe.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    }
    await pipe.send('Page.bringToFront', {}, page.id);
  }

  async function hasPageTargets() {
    try {
      const { targetInfos } = await pipe.send('Target.getTargets');
      return targetInfos.some(target => target.type === 'page');
    } catch (error) {
      if (!pipe.closed && !closing) throw error;
      return false;
    }
  }

  function forgetContext(page, id) {
    const context = page.contexts.get(id);
    if (!context) return;
    for (const request of context.requests.values()) request.abort();
    page.contexts.delete(id);
  }

  const evaluate = (page, context, expression) => pipe.send('Runtime.evaluate', {
    expression, uniqueContextId: context.uniqueId, returnByValue: true, silent: true,
  }, page.id);

  async function captureQuestion(page, context, address, rect, signal) {
    const pathname = new URL(address).pathname;
    const exercise = /^\/ai-workspace\/lms-graph\/[^/]+\/(?:exercise|homework|quiz|test|practice)\/[^/]+\/?$/.test(pathname)
      || /^\/v2\/web\/(?:iframe-exercise|exercise|studentHomework)\//i.test(pathname);
    const { x, y, width, height } = rect;
    if (!exercise || !canUseVision(settings) || ![x, y, width, height].every(Number.isSafeInteger)
      || x < 0 || y < 0 || width < 1 || height < 1 || width > 2500 || height > 1800) {
      throw new StudyRequestError('当前题区无法截图，请检查播放器位置和模型设置。');
    }
    const { cssVisualViewport: viewport } = await pipe.send('Page.getLayoutMetrics', {}, page.id);
    const visibleWidth = Math.min(width, Math.floor(viewport.clientWidth - x));
    const visibleHeight = Math.min(height, Math.floor(viewport.clientHeight - y));
    if (visibleWidth < 1 || visibleHeight < 1 || width - visibleWidth > 20 || height - visibleHeight > 20) {
      throw new StudyRequestError('题区未完整显示，请把答题页留在前台后重试。');
    }
    // 放大窄题区，保持截取范围只包含题干和相关控件。
    const scale = Math.min(2, 2500 / visibleWidth, 1800 / visibleHeight,
      Math.max(1, 32 / Math.min(visibleWidth, visibleHeight)));
    const { data } = await pipe.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 88, captureBeyondViewport: false,
      clip: { x: viewport.pageX + x, y: viewport.pageY + y, width: visibleWidth, height: visibleHeight, scale },
    }, page.id);
    signal.throwIfAborted();
    const current = await evaluate(page, context, 'document.visibilityState === "visible" ? location.href : ""');
    if (current.result?.value !== address) throw new StudyRequestError('截图时题页已切换或进入后台。');
    if (!data) throw new StudyRequestError('Edge 未返回题区截图。');
    return data;
  }

  async function handleCall(page, event) {
    const context = page.contexts.get(event.executionContextId);
    if (!context || event.name !== BINDING || typeof event.payload !== 'string' || event.payload.length > 70_000) return;
    const message = JSON.parse(event.payload);
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;
    const current = await evaluate(page, context, 'window.top === window.self ? location.href : ""');
    const address = current.result?.value;
    if (!address || !allowedUrl(address) || page.contexts.get(event.executionContextId) !== context) return;
    let error;
    let result;
    try {
      if (message.method === 'settings') {
        const currentUrl = new URL(address);
        const resume = resumePending && page.target.targetId === initialTargetId && currentUrl.origin === startUrl.origin && currentUrl.pathname === startUrl.pathname
          && [...startUrl.searchParams].every(([key, value]) => currentUrl.searchParams.get(key) === value);
        const startOnCourse = selectingCourse && currentUrl.origin === startUrl.origin
          && (page.target.targetId === initialTargetId || page.target.openerId === initialTargetId);
        result = { ...settings.forPanel(), resumePpt: resume && allowPptResume,
          resumeDirectory: resume && allowDirectoryResume, resumeWorkspace: resume && allowWorkspaceResume, startOnCourse };
        if (resume) resumePending = false;
      } else if (message.method === 'studyStatus') {
        if (typeof message.value === 'string' && message.value.length <= 160
          && /^(?:请选择要学习的课程|开始处理课程目录|PPT |打开 |播放 |正在播放 |正在生成讨论回复 |发布讨论 |正在解答当前题目|正在读取当前图片题|测验进度 |提交 |提交第 |提交当前题|等待雨课堂|请点击网页播放器|请完成并提交|请使用网页|请阅读 |流程已暂停|当前目录|学习空间)|已确认完成/.test(message.value)) {
          activeSession = page.id;
          info(message.value.replace(/[\r\n]/g, ' '));
        }
      } else if (message.method === 'save') {
        result = settings.save(message.value);
      } else if (message.method === 'cancel') {
        context.requests.get(message.value)?.abort();
      } else if (message.method === 'ask') {
        if (context.requests.size) throw new Error('当前任务的模型请求仍在进行中。');
        const controller = new AbortController();
        context.requests.set(message.id, controller);
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
          const image = message.value?.clip ? await captureQuestion(page, context, address, message.value.clip, signal).catch(failure => {
            signal.throwIfAborted();
            if (failure instanceof StudyRequestError) throw failure;
            throw new StudyRequestError('Edge 截取题区失败。');
          }) : undefined;
          result = await askModel(settings, message.value, signal, fetchModel, image);
        } finally {
          context.requests.delete(message.id);
        }
      } else {
        return;
      }
    } catch (failure) {
      if (message.method === 'save' || failure instanceof StudyRequestError) error = failure.message;
      else if (failure.name === 'TimeoutError') error = '模型请求超时，已停在当前题。';
      else error = '本机模型请求失败或已取消。';
    }
    if (page.contexts.get(event.executionContextId) !== context) return;
    await evaluate(page, context, `globalThis.${REPLY}(${message.id}, ${JSON.stringify(result ?? null)}, ${JSON.stringify(error ?? null)})`);
  }

  async function install(page) {
    if (page.target.openerId && isBlank(page.target.url)) pipe.send('Runtime.runIfWaitingForDebugger', {}, page.id).catch(() => {});
    await pipe.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, page.id);
    await pipe.send('Runtime.enable', {}, page.id);
    await pipe.send('Page.enable', {}, page.id);
    inject(page).catch(() => {});
  }

  async function inject(page) {
    const { frameTree } = await pipe.send('Page.getFrameTree', {}, page.id);
    const frame = frameTree.frame;
    page.frameId = frame.id;
    page.address = frame.url;
    if (!allowedUrl(frame.url)) return;
    if (page.recoveredUrl) {
      const arrived = new URL(frame.url);
      const intended = new URL(page.recoveredUrl);
      page.recoveredUrl = null;
      if (arrived.origin === intended.origin && arrived.pathname === intended.pathname) {
        await pipe.send('Page.bringToFront', {}, page.id).catch(() => {});
        info('已恢复课程标签页的跳转。');
      }
    }
    const { executionContextId } = await pipe.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD }, page.id);
    await pipe.send('Runtime.evaluate', { expression: source, contextId: executionContextId, silent: true }, page.id);
  }

  async function recoverPopup(page) {
    const opener = Array.from(sessions.values()).find(item => item.target.targetId === page.target.openerId);
    const opening = opener?.opening;
    if (!opening || opening.used || Math.abs(opening.at - page.attachedAt) > 1000
      || opener.dialogOpen || page.dialogOpen || !sessions.has(page.id)) return;
    if (Array.from(sessions.values()).some(item => item !== page && item.target.openerId === page.target.openerId
      && Math.abs(opening.at - item.attachedAt) <= 1000)) return;
    const { targetInfo } = await pipe.send('Target.getTargetInfo', { targetId: page.target.targetId });
    if (!isBlank(targetInfo.url) || opener.address !== opening.from) return;
    if (/^\/(?:v2\/web\/studentLog|ai-workspace\/lms-graph)\//.test(new URL(opening.from).pathname)) {
      const context = opener.contexts.values().next().value;
      if (!context) return;
      const pending = await evaluate(opener, context, `globalThis.__yuketangIsOpening?.(${JSON.stringify(opening.from)}) === true`);
      if (!pending.result?.value || opener.opening !== opening) return;
    }
    if (!isBlank(page.address) || !sessions.has(opener.id) || opener.address !== opening.from
      || opener.opening !== opening || opener.dialogOpen || page.dialogOpen) return;
    opening.used = true;
    page.recoveredUrl = opening.url;
    const navigation = await pipe.send('Page.navigate', { url: opening.url, referrer: opening.from }, page.id);
    if (navigation.errorText) page.recoveredUrl = null;
  }

  pipe.on('message', ({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget' && !sessionId) {
      const page = { id: params.sessionId, target: params.targetInfo, contexts: new Map(),
        address: params.targetInfo.url, attachedAt: Date.now() };
      sessions.set(page.id, page);
      page.ready = install(page);
      page.ready.catch(() => { if (!pipe.closed && sessions.has(page.id)) info('此标签页的助手未能启动，请关闭该标签页后重开。'); });
      if (page.target.openerId && isBlank(page.address)) {
        setTimeout(() => recoverPopup(page).catch(() => {}), POPUP_WAIT).unref();
      }
      return;
    }
    if (method === 'Target.detachedFromTarget' && !sessionId) {
      const page = sessions.get(params.sessionId);
      if (page) for (const id of page.contexts.keys()) forgetContext(page, id);
      sessions.delete(params.sessionId);
      if (initialSession && !sessions.size && !closing) {
        // Edge launched without a startup window can stay alive after the last tab closes.
        hasPageTargets().then(hasPages => {
          if (!sessions.size && !hasPages) return close();
        }).catch(() => {});
      }
      return;
    }
    const page = sessions.get(sessionId);
    if (!page) return;
    if (method === 'Runtime.executionContextCreated' && params.context.name === WORLD) {
      page.contexts.set(params.context.id, { uniqueId: params.context.uniqueId, requests: new Map() });
    } else if (method === 'Runtime.executionContextDestroyed') {
      forgetContext(page, params.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const id of page.contexts.keys()) forgetContext(page, id);
    } else if (method === 'Runtime.bindingCalled') {
      // Navigation or tab closure can invalidate the isolated world while replying.
      handleCall(page, params).catch(() => {});
    } else if (method === 'Page.windowOpen') {
      page.opening = popupDestination(page.address, params.url, params.userGesture, allowedUrl)
        ? { from: page.address, url: params.url, at: Date.now() }
        : null;
    } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      page.frameId = params.frame.id;
      page.address = params.frame.url;
    } else if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed') {
      page.dialogOpen = method === 'Page.javascriptDialogOpening';
    } else if (method === 'Page.domContentEventFired' || method === 'Page.navigatedWithinDocument') {
      if (method === 'Page.navigatedWithinDocument' && params.frameId === page.frameId) page.address = params.url;
      inject(page).catch(() => {});
    }
  });
  pipe.once('closed', () => {
    for (const page of sessions.values()) for (const id of page.contexts.keys()) forgetContext(page, id);
    sessions.clear();
  });

  const ready = (async () => {
    ({ targetId: initialTargetId } = await pipe.send('Target.createTarget', { url, newWindow: true }));
    await pipe.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      filter: [{ type: 'page', exclude: false }, { exclude: true }],
    });
    const page = Array.from(sessions.values()).find(session => session.target.targetId === initialTargetId);
    if (!page) throw new Error('未能打开独立的 Edge 学习标签页。');
    initialSession = page.id;
    await page.ready;
    await showWindow(page);
  })();
  activate = async () => {
    await ready.catch(() => {});
    if (!closing && !pipe.closed && sessions.size) {
      const page = sessions.get(activeSession) || sessions.get(initialSession) || sessions.values().next().value;
      try {
        await showWindow(page);
        // Chromium can acknowledge activation while the last tab is still closing.
        await delay(100);
        if (!closing && !pipe.closed && sessions.has(page.id)) return true;
        throw new Error('学习标签页在恢复过程中关闭。');
      } catch (error) {
        if (!closing && await hasPageTargets()) throw error;
      }
    }
    await close();
    return false;
  };
  try {
    await ready;
    return { pipe, edge, sessions, initialSession, closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('本机版需要 Windows。');
  const settings = new Settings(dataFolder());
  if (settings.loadWarning) console.log(settings.loadWarning);
  if (process.argv[2] === '--set-ai-key') {
    settings.setKey();
    return;
  }
  const url = process.argv[2] || HOME_URL;
  const resumeWorkspace = process.argv[3] === '--resume-workspace';
  console.log('正在打开独立的 Edge 学习窗口。首次使用请在该窗口登录雨课堂。');
  const browser = await launchBrowser({ settings, profile: path.join(settings.folder, 'EdgeProfile'), url,
    resumePpt: process.argv[3] === '--resume-ppt', resumeDirectory: process.argv[3] === '--resume-directory',
    resumeWorkspace });
  if (browser.reused) {
    console.log('已切回正在运行的雨课堂学习窗口。');
    return;
  }
  const stop = () => { browser.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (/^\/v2\/web\/index\/?$/.test(new URL(url).pathname)) console.log('正在打开雨课堂主页，选择课程后自动开始。');
  else if (resumeWorkspace) console.log('正在从指定学习页继续。使用页面右下角的「雨课堂学习助手」可停止。');
  else console.log('进入课程目录后，使用页面右下角的「雨课堂学习助手」。关闭学习窗口即可退出。');
  await browser.closed;
}

if (require.main === module) main().catch(error => {
  console.error(`启动失败。${error.message}`);
  console.error('如果已有本机版学习窗口，请关闭该窗口后再试。');
  process.exitCode = 1;
});

module.exports = { launchBrowser, edgePath, HOME_URL };
