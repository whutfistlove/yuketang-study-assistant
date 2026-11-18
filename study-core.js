// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.2.10
// @description  按页面状态辅助播放、阅读课件和完成非考试学习任务。
// @author       风之子
// @license      GPL3
// @match        *://*.yuketang.cn/v2/web/*
// @match        *://*.yuketang.cn/ai-workspace/lms-graph/*
// @match        *://*.yuketang.cn/pro/lms/*
// @match        *://*.gdufemooc.cn/v2/web/*
// @match        *://*.gdufemooc.cn/ai-workspace/lms-graph/*
// @match        *://*.gdufemooc.cn/pro/lms/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const SETTINGS_KEY = 'ykt.study.settings.v3.1';
  const HANDOFF_KEY = 'ykt.study.navigation.v3.1';
  const HANDOFF_ACK_KEY = 'ykt.study.navigation.ack.v3.1';
  const HANDOFF_RESULT_KEY = 'ykt.study.navigation.result.v3.1';
  const NATIVE = typeof YKT_NATIVE !== 'undefined' && YKT_NATIVE;
  const DEFAULTS = {
    pptSeconds: 10,
    autoPractice: false,
    autoHomework: false,
    autoDiscussion: false,
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    format: 'openai',
    auth: 'bearer',
    key: '',
  };
  const OPEN_WAIT = 25_000;
  const STATUS_WAIT = 40_000;
  const MANUAL_WAIT = 60 * 60 * 1000;
  const PLAYBACK_IDLE = 120_000;
  const STATUS_SELECTOR = '.progress-wrap .text, .study-progress .text, .study-status, .learn-status';
  const ROW_STATUS = '.statistics-box .aside, .unfinished-study__item-status';
  const UNFINISHED_ROW = '.unfinished-study__item';
  const WORKSPACE_DONE_ICON = '\uE7AB';
  const GLM_CHAT_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const DEEPSEEK_CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
  const EXERCISE_ROOT = '.container-problem, .homework-container, .exercise-container, .quiz-container';
  const QUESTION_BODY = '.item-body, .question-body, .problem-body, .question-content, .problem-content';
  const BUTTON = 'button, [role="button"], .el-button';
  const EXAM_PATH = /(?:^|\/)(?:(?:student)?exam(?:ination)?|kaoshi|timed-exam)(?:\/|$)/i;

  class Pause extends Error {}

  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const label = element => normalize(element?.innerText ?? element?.textContent);

  function isVisible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  }

  const visible = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
  const firstVisible = (root, selector) => visible(root, selector)[0];

  function isEnabled(element) {
    return isVisible(element) && !element.matches(':disabled, [aria-disabled="true"], [disabled], .is-disabled')
      && !element.closest('.swiper-button-disabled, [aria-disabled="true"], [inert]');
  }

  function action(root, text) {
    return visible(root, BUTTON).find(element => isEnabled(element) && text.test(label(element)));
  }

  function isDone(value, allowRatio = false) {
    const text = normalize(value).replace(/^(?:视频|学习|观看|阅读|课件)进度\s*[:：]?\s*/, '')
      .replace(/\s*(?:学习|阅读|观看)进度$/, '');
    if (/^(?:100(?:\.0+)?\s*%|已完成|已读|已提交|已交卷|已分享|已参与|已讨论|已回复|已发表|已发帖|已发言|(?:课程|课件|视频|音频|作业|练习|测验|测试|讨论)已完成|(?:作业|练习|测验|测试)已提交)$/.test(text)) return true;
    const ratio = allowRatio && text.match(/^(\d+)\s*\/\s*(\d+)(?:\s*页)?$/);
    return Boolean(ratio && Number(ratio[2]) > 0 && Number(ratio[1]) === Number(ratio[2]));
  }

  const hasDone = (root, selector = STATUS_SELECTOR) => visible(root, selector).some(node => isDone(label(node)));

  function kindOf(text) {
    if (/kaoshi|\b(?:exam|examination)\b|考试|监考/i.test(text)) return 'exam';
    if (/zuoye|homework|作业/i.test(text)) return 'homework';
    if (/exercise|\b(?:quiz|test|practice)\b|练习|测验|测试/i.test(text)) return 'exercise';
    if (/fenxiang|\bshare\b|分享/i.test(text)) return 'share';
    if (/yinpin|audio|音频/i.test(text)) return 'audio';
    if (/shipin|video|视频/i.test(text)) return 'video';
    if (/kejian|courseware|ppt|课件/i.test(text)) return 'courseware';
    if (/piliang|batch|批量/i.test(text)) return 'batch';
    if (/tuwen|article|图文/i.test(text)) return 'reading';
    if (/taolun|forum|discussion|讨论/i.test(text)) return 'discussion';
    if (/ketang|classroom|课堂/i.test(text)) return 'classroom';
    return '';
  }

  function getRoute() {
    const path = location.pathname;
    if (/^\/v2\/web\/index\/?$/.test(path)) return { view: 'home' };
    const ai = path.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (ai) {
      const kind = ai[2] === 'graph' ? 'reading' : EXAM_PATH.test(path) ? 'exam' : kindOf(ai[2]);
      return { view: 'ai', classroomId: ai[1], kind, leaf: ai[3] };
    }
    const directory = path.match(/^\/v2\/web\/studentLog\/([^/]+)/);
    if (directory) return { view: 'directory', classroomId: directory[1] };
    const standalonePpt = path.match(/^\/v2\/web\/studentCards\/(\d+)\/\d+\/\d+(?:\/ppt)?\/?$/);
    if (standalonePpt) return { view: 'v2', classroomId: standalonePpt[1], kind: 'courseware' };
    if (path.startsWith('/pro/lms/')) return { view: 'pro' };
    if (path.startsWith('/v2/web/')) return { view: 'v2' };
    return null;
  }

  function blockingDialog() {
    return courseDocuments().some(doc => visible(doc, '.el-dialog__wrapper, .el-message-box__wrapper, [role="alertdialog"], [role="dialog"]')
      .some(element => /继续观看|好好学习|报告老师|挂机|切屏|人机验证|请完成验证|请作答后|答题后继续/.test(label(element))));
  }

  function sleep(ms, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  class StudyRun {
    constructor(settings, log) {
      this.settings = settings;
      this.log = log;
      this.controller = new AbortController();
      this.signal = this.controller.signal;
      this.retryFromDirectory = null;
    }

    check() {
      this.signal.throwIfAborted();
      const handedOff = this.retryFromDirectory?.state;
      if (handedOff?.ownedPopup && !handoffParent(handedOff)) throw new Pause('目录中的自动流程已停止。');
      if (blockingDialog()) throw new Pause('页面需要本人确认。处理提示后，点「开始」继续。');
    }

    async wait(read, message, timeout = OPEN_WAIT) {
      const until = performance.now() + timeout;
      do {
        this.check();
        const value = read();
        if (value) return value;
        await sleep(250, this.signal);
      } while (performance.now() < until);
      throw new Pause(message);
    }

    async click(target, message) {
      await this.wait(() => document.visibilityState === 'visible', '请回到课程页后继续。', MANUAL_WAIT);
      this.check();
      const element = typeof target === 'function' ? target() : target;
      if (!isEnabled(element)) throw new Pause(message);
      element.click();
    }
  }

  // 只接力当前队列刚发起的导航。失败、停止和不匹配的跳转均清除命令。
  function saveHandoff(data) {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...data, expires: Date.now() + OPEN_WAIT * 2 }));
  }

  function clearHandoff() {
    sessionStorage.removeItem(HANDOFF_KEY);
    sessionStorage.removeItem(HANDOFF_ACK_KEY);
    sessionStorage.removeItem(HANDOFF_RESULT_KEY);
  }

  if (NATIVE) globalThis.__yuketangIsOpening = from => {
    try {
      const pending = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null');
      return ['open', 'workspace-ppt'].includes(pending?.phase) && pending.from === from
        && location.href === from && pending.expires >= Date.now();
    } catch {
      return false;
    }
  };

  function takeHandoff() {
    try {
      const data = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null');
      clearHandoff();
      const route = getRoute();
      if (route?.view === 'v2' && route.kind === 'courseware') {
        const parent = sameOriginOpenerStorage();
        const opening = JSON.parse(parent?.getItem(HANDOFF_KEY) || 'null');
        const popup = opening?.phase === 'workspace-ppt' && opening.from === window.opener.location.href;
        const pending = popup ? opening : data;
        const linkedClassroom = new URLSearchParams(location.search).get('classroom_id');
        if (pending?.phase === 'workspace-ppt' && pending.id && pending.expires >= Date.now()
          && pending.classroomId === route.classroomId && (!linkedClassroom || linkedClassroom === route.classroomId)
          && pending.returnUrl === pending.from && pending.from !== location.href) {
          const source = new URL(pending.from);
          if (source.origin !== location.origin || !source.pathname.startsWith(`/ai-workspace/lms-graph/${route.classroomId}/`)) return null;
          if (!popup) return pending;
          if (parent.getItem(HANDOFF_ACK_KEY)) return null;
          parent.setItem(HANDOFF_ACK_KEY, pending.id);
          return { ...pending, ownedPopup: true };
        }
      }
      if (!data || data.expires < Date.now() || !Array.isArray(data.verified)) return null;
      const target = new URL(data.returnUrl);
      const expectedId = target.pathname.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1];
      if (target.origin !== location.origin || !expectedId) return null;
      if (data.phase === 'return' && route?.view === 'directory' && location.href === target.href) return data;
      if (data.phase === 'open' && data.item?.key && data.from !== location.href && ['ai', 'v2', 'pro'].includes(route?.view)) {
        const classroomId = new URLSearchParams(location.search).get('classroom_id') || route.classroomId;
        if (classroomId && classroomId !== expectedId) return null;
        const parent = sameOriginOpenerStorage();
        if (parent) {
          const opening = JSON.parse(parent.getItem(HANDOFF_KEY) || 'null');
          if (data.id && opening?.id === data.id) {
            if (classroomId !== expectedId || document.referrer !== data.from) return null;
            parent.setItem(HANDOFF_ACK_KEY, data.id);
            return { ...data, ownedPopup: true };
          }
        }
        return data;
      }
    } catch {
      return null;
    }
    return null;
  }

  function sameOriginOpenerStorage() {
    try {
      if (window.opener && !window.opener.closed && window.opener.location.origin === location.origin) {
        return window.opener.sessionStorage;
      }
    } catch {
      // 其他站点打开的页面由当前标签页处理。
    }
    return null;
  }

  function handoffParent(state) {
    if (!state?.ownedPopup) return null;
    const storage = sameOriginOpenerStorage();
    if (storage && storage.getItem(HANDOFF_ACK_KEY) === state.id && window.opener.location.href === state.returnUrl) return storage;
    return null;
  }

  function signalParent(state, outcome) {
    const parent = handoffParent(state);
    if (!parent) return false;
    parent.setItem(HANDOFF_RESULT_KEY, `${state.id}:${outcome}`);
    return true;
  }

  function waitForPopupResult(run, id) {
    return run.wait(() => {
      const result = sessionStorage.getItem(HANDOFF_RESULT_KEY);
      return result === `${id}:done` ? 'done' : result === `${id}:paused` ? 'paused' : null;
    }, '新标签页还未确认完成，请在该页继续。', MANUAL_WAIT);
  }

  function courseDocuments() {
    const docs = [document];
    for (const frame of visible(document, 'iframe')) {
      if (frame.id === 'ykt-study-panel') continue;
      try {
        if (frame.contentDocument?.body) docs.push(frame.contentDocument);
      } catch {
        // 跨域课件由网页自身显示。
      }
    }
    return docs;
  }

  function courseMedia(kind, root = document) {
    const selector = kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'video, audio';
    const candidates = root === document ? courseDocuments().flatMap(doc => mediaNodes(doc, selector)) : mediaNodes(root, selector);
    return candidates.find(media => !media.paused && !media.ended) || candidates[0];
  }

  function mediaVisible(media) {
    return isVisible(media) || (media.isConnected && media.matches('audio')
      && isVisible(media.closest('.audio-box, .audio-player, #audio-box')));
  }

  function mediaNodes(root, selector = 'video, audio') {
    return Array.from(root.querySelectorAll(selector)).filter(mediaVisible);
  }

  function playerQuestionVisible(doc) {
    return Boolean(firstVisible(doc, '.video-question, .player-question, .xt-video-question, .pop-question'));
  }

  function sameResourcePage(address) {
    const before = new URL(address);
    const current = new URL(location.href);
    if (before.origin !== current.origin || before.pathname !== current.pathname) return false;
    return ['classroom_id', 'activity_id', 'video_id', 'leaf_id', 'node_id', 'content_url'].every(key => {
      const previous = before.searchParams.get(key);
      const latest = current.searchParams.get(key);
      return !previous || !latest || previous === latest;
    });
  }

  async function watchMedia(run, readMedia, name, alreadyDone = () => false) {
    const page = location.href;
    await run.wait(() => document.visibilityState === 'visible', '请回到播放器页面后继续。', MANUAL_WAIT);
    let previousMedia;
    let previousSource;
    const state = await run.wait(() => {
      if (!sameResourcePage(page)) throw new Pause('已离开当前视频，播放器尚未就绪。');
      if (alreadyDone()) return { done: true };
      const next = readMedia();
      const nextSource = next?.currentSrc;
      if (next && next === previousMedia && nextSource === previousSource && document.visibilityState === 'visible') return { media: next };
      previousMedia = next;
      previousSource = nextSource;
      return null;
    }, `${name} 的播放器未就绪，已停在当前项。`);
    if (state.done) return null;
    const { media } = state;
    let source = media.currentSrc;
    run.log(`播放 ${name}`);
    const readyToPlay = !media.ended && !playerQuestionVisible(media.ownerDocument);
    const video = media.localName === 'video';
    let selectedPlayerRate = false;
    const useVideoRate = () => {
      if (!video) return;
      if (!selectedPlayerRate) {
        const options = media.closest('xt-wrap')?.querySelectorAll('xt-speedlist xt-button[data-speed]') || [];
        const option = Array.from(options).find(button => Number(button.getAttribute('data-speed')) === 2
          && !button.closest('[disabled], [aria-disabled="true"], .is-disabled, [inert], [hidden]'));
        if (option) {
          selectedPlayerRate = true;
          option.click();
        }
      }
      if (media.defaultPlaybackRate !== 2) media.defaultPlaybackRate = 2;
      if (media.playbackRate !== 2) media.playbackRate = 2;
    };
    if (readyToPlay) useVideoRate();
    if (readyToPlay && media.paused) {
      // 只尝试启动一次。播放器主动暂停或要求确认时，由用户继续。
      try {
        Promise.resolve(media.play()).catch(() => {
          if (!run.signal.aborted && media.isConnected && media.paused) run.log('请点击网页播放器的播放键。');
        });
      } catch {
        run.log('请点击网页播放器的播放键。');
      }
    }
    let lastTime = media.currentTime;
    let lastMovement = performance.now();
    const playbackStartedAt = lastMovement;
    let pausedNotice = false;
    let playbackReported = false;
    while (true) {
      run.check();
      if (!sameResourcePage(page) || !mediaVisible(media) || (source && source !== media.currentSrc)) {
        throw new Pause(`${name} 的播放器已关闭或切换。`);
      }
      source ||= media.currentSrc;
      if (playerQuestionVisible(media.ownerDocument)) throw new Pause('视频出现待答题目，处理后点「开始」。');
      if (media.error) throw new Pause(`${name} 播放出错，请检查网页播放器。`);
      if (media.ended && !media.seeking && Number.isFinite(media.duration) && media.duration > 0) return media;
      const now = performance.now();
      const advancing = media.currentTime > lastTime && !media.seeking;
      if (!media.paused && !media.seeking && (advancing || playbackReported)) useVideoRate();
      if (advancing) {
        lastMovement = now;
        if (!playbackReported) {
          run.log(`正在播放 ${name}${video ? ` · ${media.playbackRate}×` : ''}`);
          playbackReported = true;
        }
      }
      lastTime = media.currentTime;
      if (media.paused && !pausedNotice) {
        run.log(`${name} 暂停，请使用网页播放器继续。`);
        pausedNotice = true;
      } else if (!media.paused) {
        pausedNotice = false;
      }
      const limit = Number.isFinite(media.duration) ? Math.max(MANUAL_WAIT, media.duration * 3_000) : MANUAL_WAIT;
      if (now - lastMovement > PLAYBACK_IDLE || now - playbackStartedAt > limit) {
        throw new Pause(`${name} 未播完，已停在当前项。`);
      }
      await sleep(250, run.signal);
    }
  }

  async function confirmStatus(run, page, readDone, name) {
    run.log(`等待雨课堂确认 ${name} 的完成状态`);
    await run.wait(() => {
      if (!sameResourcePage(page)) throw new Pause('页面已切换，当前项的完成状态未确认。');
      return readDone();
    }, `${name} 尚未显示完成，已停在当前项。`, STATUS_WAIT);
  }

  async function studyMedia(run, kind, name, readDone, readMedia = () => courseMedia(kind)) {
    const url = location.href;
    const headerDone = () => workspaceAssetDone(kind, name);
    if (await watchMedia(run, readMedia, name, headerDone)) {
      await confirmStatus(run, url, () => headerDone() || readDone(), name);
    }
  }

  function readSlides(wrapper) {
    const slides = Array.from(wrapper.children).filter(slide => slide.matches('.swiper-slide:not(.swiper-slide-duplicate)'));
    const selected = slides.findIndex(slide => slide.matches('.swiper-slide-thumb-active, [aria-current="page"], [aria-selected="true"]') && isVisible(slide));
    const active = selected >= 0 ? selected : slides.findIndex(slide => slide.classList.contains('swiper-slide-active') && isVisible(slide));
    return { wrapper, slides, active };
  }

  function slideGroup() {
    const groups = visible(document, '.swiper-wrapper').map(readSlides);
    const isThumbs = group => group.wrapper.closest('.swiper-thumbs, .swiper-container-thumbs');
    const outline = groups.find(group => group.slides.length > 1 && group.slides.every((slide, index) =>
      new RegExp(`^(?:第\\s*)?${index + 1}(?:\\s*页)?(?:\\s*(?:未读|已读))?$`).test(label(slide))))
      || groups.find(group => group.slides.length > 1 && isThumbs(group));
    const active = groups.filter(group => group.active >= 0);
    const area = group => {
      const rect = group.slides[group.active].getBoundingClientRect();
      return rect.width * rect.height;
    };
    const main = outline && active.filter(group => group !== outline && !isThumbs(group) && group.slides.length === outline.slides.length)
      .sort((a, b) => area(b) - area(a))[0];
    const group = main || active.find(item => item.slides.length > 1 && item !== outline && !isThumbs(item))
      || active.find(item => item.slides.length > 1) || active[0];
    return group ? { ...group, outline: outline?.slides.length === group.slides.length ? outline.wrapper : null } : null;
  }

  function pptProgress(total) {
    const progress = label(document.body).match(/学习进度\s*[:：]\s*(\d+)\s*[/／]\s*(\d+)/);
    if (!progress || (total && Number(progress[2]) !== total)) return null;
    const read = Number(progress[1]);
    const count = Number(progress[2]);
    return count > 0 && read <= count ? { read, total: count } : null;
  }

  function slideReady(slide) {
    if (!isVisible(slide) || firstVisible(slide, '.el-loading-mask, [aria-busy="true"]')) return false;
    const rect = slide.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    return visible(slide, 'img').every(image => image.complete && image.naturalWidth > 0);
  }

  async function dwellSlide(run, readDeck, index, total, seconds = run.settings.pptSeconds) {
    const pageLabel = `PPT 第 ${index + 1}/${total} 页`;
    const dwellMs = seconds * 1_000;
    let elapsed = 0;
    let visibilityChange = 0;
    let lastNotice = '';
    const show = notice => {
      if (lastNotice === notice) return;
      lastNotice = notice;
      run.log(`${pageLabel} · ${notice}`);
    };
    const onVisibility = () => { visibilityChange++; };
    document.addEventListener('visibilitychange', onVisibility);
    try {
      while (elapsed < dwellMs) {
        const getCurrent = () => {
          if (document.visibilityState !== 'visible') {
            show('学习窗口在后台，回到此页后继续计时');
            return null;
          }
          const group = readDeck();
          if (group?.active >= 0 && group.active !== index) throw new Pause('PPT 已被切换，请从当前页重新开始。');
          const slide = group?.active === index && group.slides[index];
          if (!slide || !slideReady(slide)) {
            show('等待本页图片加载并显示');
            return null;
          }
          return slide;
        };
        const slide = await run.wait(getCurrent, 'PPT 未加载完成或页面已切到后台。', MANUAL_WAIT);
        show(`本页还需停留 ${Math.ceil((dwellMs - elapsed) / 1_000)} 秒`);
        const startedAt = performance.now();
        const visibilityBefore = visibilityChange;
        await sleep(250, run.signal);
        run.check();
        if (getCurrent() === slide && visibilityBefore === visibilityChange) {
          elapsed += Math.min(performance.now() - startedAt, 500);
        }
      }
    } finally {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  function nextSlideControl({ wrapper, slides, active, outline }) {
    const carousel = wrapper.closest('.swiper, .swiper-container') || wrapper.parentElement;
    const viewer = carousel.closest('.el-card, .el-dialog, [role="dialog"], .ppt-container, .ppt-viewer') || carousel;
    const textNext = /^(?:下一页|下一张|下一张幻灯片|Next|Next slide)$/i;
    const actions = visible(viewer, '.swiper-button-next, .swiper-btn-next, .ppt-next, .next-page, button, a, [role="button"], [aria-label], [title]')
      .filter(node => {
        const owner = node.closest('.swiper, .swiper-container');
        return (!owner || owner === carousel) && (node.matches('.swiper-button-next, .swiper-btn-next, .ppt-next, .next-page')
          || [label(node), node.getAttribute('aria-label'), node.getAttribute('title')].some(value => textNext.test(normalize(value))));
      });
    if (actions.length || (outline && outline !== wrapper)) return actions.find(isEnabled);

    // V2 课件也使用普通 div 作为可点击的缩略图。
    const thumbnail = slides[active + 1];
    return isEnabled(thumbnail) ? thumbnail : null;
  }

  function videoCardDone(card) {
    return isDone(label(card)) || hasDone(card, '.status, .progress, .finish, .text');
  }

  async function playEmbedded(run, root, name) {
    // 当前可见页上的视频逐个播放，避免把未显示的幻灯片当成当前页。
    const cards = visible(root, '.video-box').filter(card => (root !== document || !card.closest('.swiper-slide'))
      && !card.querySelector('video, audio'));
    for (const [index, card] of cards.entries()) {
      if (videoCardDone(card)) continue;
      const before = new Map(courseDocuments().flatMap(doc => mediaNodes(doc)).map(media => [media, media.currentSrc]));
      const activeVideo = () => courseDocuments().flatMap(doc => mediaNodes(doc))
        .find(media => !before.has(media) || (media.currentSrc && media.currentSrc !== before.get(media)));
      await run.click(card, '无法打开当前页内嵌视频。');
      const media = await watchMedia(run, activeVideo, `${name}内嵌视频 ${index + 1}`);
      const dialog = media.closest('.el-dialog__wrapper, [role="dialog"]');
      const trackedStatus = () => videoCardDone(card) || (dialog && hasDone(dialog));
      const hasTracking = dialog && firstVisible(dialog, STATUS_SELECTOR);
      if (hasTracking) await confirmStatus(run, location.href, trackedStatus, '内嵌视频');
      if (dialog && isVisible(dialog)) {
        const close = firstVisible(dialog, '.el-dialog__headerbtn, button[aria-label="Close"], button[aria-label="关闭"]');
        if (!close) throw new Pause('内嵌视频已播完。请关闭播放器后继续。');
        await run.click(close, '请关闭已播完的内嵌播放器。');
        await run.wait(() => !isVisible(dialog), '请关闭已播完的内嵌播放器。');
      }
    }
  }

  function hasCoursewareStatus() {
    const progress = pptProgress();
    if (progress) return progress.read === progress.total;
    return visible(document, '.courseware-status, .ppt-status, .dialog-header .status, .el-card__header .status')
      .some(node => !node.closest('.logs-list') && isDone(label(node)));
  }

  async function selectSlide(run, readDeck, index) {
    const control = () => {
      if (document.visibilityState !== 'visible') return null;
      const current = readDeck();
      if (!current || current.active < 0) return null;
      if (current.active === index) return 'selected';
      const { wrapper, outline } = current;
      if (index === current.active + 1) {
        const next = nextSlideControl(current);
        if (next) return next;
      }
      if (outline && outline !== wrapper) {
        const thumbnail = readSlides(outline).slides[index];
        if (isEnabled(thumbnail)) return thumbnail;
      }
      return null;
    };
    await run.wait(() => {
      const next = control();
      if (!next) return null;
      if (next !== 'selected') next.click();
      return true;
    }, '未找到可用的下一页控件，请从当前页手动翻页。');
    return run.wait(() => {
      const current = readDeck();
      const slide = current?.active === index && current.slides[index];
      return slide && slideReady(slide) && slide;
    }, `下一张 PPT 没有切换成功或还未加载（目标第 ${index + 1} 页）。`);
  }

  async function readSlideDeck(run, deck, name) {
    const total = deck.slides.length;
    const { wrapper, outline } = deck;
    const page = location.href;
    const separateOutline = outline && outline !== wrapper;
    const readDeck = () => {
      if (!sameResourcePage(page)) throw new Pause('课件页面已切换。');
      let current = readSlides(deck.wrapper);
      if (!isVisible(deck.wrapper) || current.slides.length !== total || (deck.outline && !deck.outline.isConnected)) {
        const updated = slideGroup();
        if (updated?.slides.length !== total || (separateOutline && updated.wrapper === updated.outline)) return null;
        deck = updated;
        current = updated;
      }
      return { ...current, outline: deck.outline };
    };
    const tracked = pptProgress(total);
    if (tracked) run.log(`PPT 已识别 ${total} 页，雨课堂已确认 ${tracked.read}/${total} 页`);
    const thumbnails = () => {
      const current = readDeck();
      return current?.outline ? readSlides(current.outline).slides : [];
    };
    const unread = () => thumbnails().flatMap((slide, index) => /未读/.test(label(slide)) ? [index] : []);
    const canJump = tracked && separateOutline;
    const current = deck.active;
    const inOrder = Array.from({ length: total - Math.max(0, current) }, (_, offset) => Math.max(0, current) + offset);
    const pending = canJump ? unread() : [];
    const first = pending.length ? pending : inOrder;
    // Rain Classroom documents a 3-second default for pre-reading. The page's progress remains authoritative.
    const seconds = tracked ? Math.max(3.25, run.settings.pptSeconds) : run.settings.pptSeconds;
    const show = async (index, duration) => {
      const slide = await selectSlide(run, readDeck, index);
      await playEmbedded(run, slide, name);
      if (courseMedia('', slide)) await watchMedia(run, () => courseMedia('', slide), 'PPT 页内媒体');
      await dwellSlide(run, readDeck, index, total, duration);
    };
    for (const index of first) {
      if (canJump && !/未读/.test(label(thumbnails()[index])) && pptProgress(total)?.read === total) break;
      await show(index, seconds);
    }
    if (canJump && pptProgress(total)?.read < total) {
      const retryAt = performance.now() + 3_000;
      await run.wait(() => pptProgress(total)?.read === total || performance.now() >= retryAt,
        '正在等待雨课堂同步课件进度。');
      if (pptProgress(total)?.read === total) return;
      // A delayed update never counts as completion. Revisit only pages the outline still marks unread.
      const remaining = unread();
      if (remaining.length) run.log(`PPT 已浏览，补读雨课堂尚未确认的 ${remaining.length} 页`);
      for (const index of remaining) {
        if (pptProgress(total)?.read === total) break;
        if (/未读/.test(label(thumbnails()[index]))) await show(index, Math.max(seconds, 5));
      }
    }
  }

  async function studyCourseware(run, name, readDone) {
    const openPreview = visible(document, '.ppt_img_box .check, p.check, button').find(node => label(node) === '查看课件');
    if (openPreview) await run.click(openPreview, '请点击网页的「查看课件」。');
    const initial = await run.wait(() => slideGroup() || firstVisible(document, '.video-box') || courseMedia('video'),
      '未找到可识别的 PPT 或课件视频。');
    const page = location.href;
    if (initial.slides) {
      await readSlideDeck(run, initial, name);
      await playEmbedded(run, document, name);
    } else if (courseMedia('video')) {
      await watchMedia(run, () => courseMedia('video'), name);
    } else {
      await playEmbedded(run, document, name);
      if (isVisible(initial) && initial.matches('.video-box')) {
        await confirmStatus(run, page, () => readDone() || videoCardDone(initial), name);
        return;
      }
    }
    await confirmStatus(run, page, readDone, name);
  }

  const EXERCISE_STATUS = '.exercise-status, .homework-status, .submission-status, .submit-result, .exercise-header .status, .homework-header .status';
  const GRADING_STATUS = '.grading-mode, .assessment-type, .score-mode, .exercise-type, .exercise-header .tag, .homework-header .tag';
  const QUESTION_STATUS = '.answer-status, .question-result, .result-status, .feedback, .result';
  const CHOICE_CONTROL = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
  const TEXT_CONTROL = 'textarea, input[type="text"], [contenteditable="true"][role="textbox"]';
  const SUBJECT_EDITOR = 'iframe[src*="/fe/ueditor/iframe.html"]';
  const QUESTION_TAB = '.subject-item, .problem-index-item, .question-index-item, [role="tab"][data-question-id]';
  const EMBEDDED_EXERCISE = /^\/v2\/web\/iframe-exercise\//;
  const SUBMIT_QUESTION = /^(?:提交答案|提交本题|确认答案|保存答案)$/;
  const PREVIOUS_QUESTION = /^(?:上一题|上一道题?|上题)$/;
  const NEXT_QUESTION = /^(?:下一题|下一道题?|下题)$/;

  function exerciseRoot() {
    for (const doc of courseDocuments()) {
      const root = firstVisible(doc, EXERCISE_ROOT);
      if (root) return root;
      const question = firstVisible(doc, '.item-type, .subject-item.J_order');
      if (question) return question.closest('main, #app') || question.parentElement;
    }
    return null;
  }

  function exerciseDone(readDone) {
    if (readDone()) return true;
    return courseDocuments().some(doc => visible(doc, EXERCISE_STATUS).some(node =>
      /^(?:已交卷|已提交|提交成功|交卷成功|已完成|(?:作业|练习|测验|测试)已(?:提交|完成))$/.test(label(node))));
  }

  function isUngraded(root) {
    if (!root) return false;
    const markers = visible(root.ownerDocument, GRADING_STATUS)
      .filter(node => (root.contains(node) || node.closest('.exercise-header, .homework-header')) && !node.closest(QUESTION_BODY))
      .map(label);
    if (markers.some(text => /^(?:考试|计分|计入成绩|计分作业|计分练习|计分测验|正式作业)$/.test(text))) return false;
    return markers.some(text => /^(?:不计分|不计入成绩|非计分练习|仅供练习|练习\s*[（(]不计分[)）])$/.test(text));
  }

  function isExamPage(doc) {
    if (EXAM_PATH.test(doc.location.pathname)
      || visible(doc, '.exam-header, .exam-countdown, .proctoring-panel, [data-activity-type="exam"]')
        .some(node => !node.closest('.nav-item-leaf-box, .logs-list'))) return true;
    const tags = visible(doc, `${GRADING_STATUS}, .exercise-header h1, .homework-header h1`).map(label);
    return tags.some(text => /^(?:(?:正式|限时|在线|期中|期末)?考试|监考)(?:$|\s|[:：])/.test(text)
      || /(?:期中|期末|正式|限时)考试$/.test(text));
  }

  function canAnswer(run, root, kind) {
    return root && isExerciseKind(kind) && !isExamPage(root.ownerDocument)
      && (run.settings.autoHomework || (run.settings.autoPractice && isUngraded(root)));
  }

  function readTextField(field) {
    if (field.matches('input, textarea')) return field.value;
    if (field === field.ownerDocument.body) return (field.innerText ?? field.textContent).replace(/\u00a0/g, ' ').trim();
    return field.textContent;
  }

  function writeTextField(field, text) {
    const view = field.ownerDocument.defaultView;
    const prototype = field.matches('textarea') ? view.HTMLTextAreaElement.prototype : field.matches('input') ? view.HTMLInputElement.prototype : null;
    if (prototype) Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, text);
    else field.textContent = text;
    field.dispatchEvent(new view.Event('input', { bubbles: true }));
    field.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  function judgmentValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    const text = normalize(value).toLowerCase();
    if (/^(?:true|正确|对|真|是|√|✓|✔)$/.test(text)) return true;
    if (/^(?:false|错误|错|假|否|×|✗|✘)$/.test(text)) return false;
    return undefined;
  }

  function judgmentOption(option) {
    const text = judgmentValue(option.text);
    if (text !== undefined) return text;
    const icons = Array.from(option.target.querySelectorAll('svg use'), use =>
      use.getAttribute('href') || use.getAttribute('xlink:href'));
    const correct = icons.includes('#icon--tiankongtizhengque');
    const incorrect = icons.includes('#icon--tiankongticuowu');
    return correct === incorrect ? undefined : correct;
  }

  function getQuestion(root) {
    if (!root) return null;
    const type = label(firstVisible(root, '.item-type'));
    const subjective = /主观题|简答题|问答题|论述题/.test(type);
    const doc = root.ownerDocument;
    const embedded = EMBEDDED_EXERCISE.test(doc.location.pathname);
    const tab = questionTabs(embedded ? doc : root).find(isCurrentQuestionTab);
    // 嵌入作业提交后会给题号着色，并可能移除文字输入框。
    const recordedText = embedded && (subjective || /填空题/.test(type)) && tab?.matches('.J_order.primary')
      && exerciseProgress(doc)?.answered > 0;
    const controlSelector = `${CHOICE_CONTROL}, ${TEXT_CONTROL}${subjective ? `, ${SUBJECT_EDITOR}` : ''}`;
    const bodies = visible(root, QUESTION_BODY).filter(node => (recordedText && node.matches('.item-body')) || node.querySelector(controlSelector));
    const body = bodies[0];
    if (!body) return null;
    // 忽略一个题块内部嵌套的题干容器。有多个同时展示的题块时交由人工处理。
    if (bodies.some(node => !body.contains(node) && !node.contains(body))) return null;
    const stem = firstVisible(body, '.subject-answer-container > .problem-body')
      || firstVisible(body, '.question-stem, .problem-stem, .item-title, .question-title, .stem, h3')
      || firstVisible(root, '.question-stem, .problem-stem, .item-title, .question-title');
    const number = Number(type.match(/^(\d+)\s*[.．、]/)?.[1] || label(tab).match(/^\d+$/)?.[0]);
    const question = { body, stem, text: label(stem), embedded, number };
    const identity = [body.getAttribute('data-question-id'), number || label(tab), question.text];
    if (recordedText) {
      const submit = questionSubmit(root, question);
      if (submit && !isEnabled(submit)) return { ...question, recorded: true, key: JSON.stringify([...identity, 'recorded']) };
    }
    const hasImage = firstVisible(body, 'img, canvas') || (stem && firstVisible(stem, 'img, canvas'));
    const visual = NATIVE && Boolean(embedded || hasImage);
    const frames = visible(body, 'iframe');
    let editor = null;
    if (frames.length) {
      if (!subjective || frames.length !== 1 || !stem || !frames[0].matches(SUBJECT_EDITOR)) return null;
      const editorDoc = frames[0].contentDocument;
      if (editorDoc?.location?.origin !== doc.location.origin || editorDoc.location.pathname !== '/fe/ueditor/iframe.html'
        || !editorDoc.body?.matches('[contenteditable="true"]')) return null;
      editor = editorDoc.body;
    }
    if (firstVisible(body, 'input[type="file"]') || (!visual && (hasImage || !label(stem)))) return null;
    const nativeInputs = Array.from(body.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    const controls = nativeInputs.length ? nativeInputs : visible(body, '[role="radio"], [role="checkbox"]');
    const fields = editor ? [editor] : visible(body, TEXT_CONTROL).filter(field => !field.matches('[readonly], [aria-readonly="true"]'));
    if (!controls.length && fields.length && fields.length <= 12) {
      const limits = fields.map(field => field.maxLength >= 0 ? Math.min(field.maxLength, 2000) : 2000);
      const key = JSON.stringify([...identity, 'text', limits]);
      return { ...question, fields, limits, key, visual, type, subjective, editor };
    }
    if (fields.length) return null;
    const options = controls.map(control => {
      const target = control.labels?.[0] || control.closest('label') || control;
      return { control, target, text: label(target), multiple: control.matches('[type="checkbox"], [role="checkbox"]') };
    }).filter(option => isVisible(option.target));
    if (options.length < 2 || options.length > 26 || options.some(option => option.multiple !== options[0].multiple)) return null;
    const meanings = /判断题|是非题/.test(type) && options.length === 2 && !options[0].multiple
      ? options.map(judgmentOption) : null;
    const judgment = meanings?.includes(true) && meanings.includes(false) ? meanings : null;
    if (judgment) {
      for (const [index, option] of options.entries()) {
        if (!option.text) option.text = judgment[index] ? '正确' : '错误';
      }
    }
    if (options.some(option => !option.text)) return null;
    const key = JSON.stringify([...identity, options.map(option => option.text)]);
    return { ...question, options, key, multiple: options[0].multiple, judgment, visual };
  }

  function answered(question) {
    return question.recorded || visible(question.body, QUESTION_STATUS).some(node =>
      /^(?:已作答|已保存|已提交|提交成功|回答正确|回答错误|回答不正确|作答正确|作答错误)$/.test(label(node)));
  }

  function parseModelJson(response) {
    if (typeof response !== 'string') return null;
    const clean = response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    try {
      return JSON.parse(clean);
    } catch {
      return null;
    }
  }

  function parseChoices(response, question) {
    const payload = parseModelJson(response);
    const choices = payload?.choices;
    if (question.judgment && (choices === undefined || (Array.isArray(choices) && choices.length === 1))) {
      const value = choices?.[0] ?? (payload && typeof payload === 'object' ? payload.judgment : payload ?? response);
      const verdict = judgmentValue(value);
      if (verdict !== undefined) return [question.judgment.indexOf(verdict)];
    }
    if (!Array.isArray(choices) || !choices.length || (!question.multiple && choices.length !== 1)) return null;
    if (choices.some(choice => typeof choice !== 'string' || !/^[A-Z]$/.test(choice))) return null;
    const indices = choices.map(choice => choice.charCodeAt(0) - 65);
    if (new Set(indices).size !== indices.length || indices.some(index => index >= question.options.length)) return null;
    return indices;
  }

  function requestModel(run, system, user, maxTokens = 1024, clip) {
    const { endpoint, key, model, format, auth } = run.settings;
    let url;
    try { url = new URL(endpoint); } catch { /* 统一给出配置提示 */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || !key || !model) {
      throw new Pause('请在设置里填写 HTTPS 模型接口、模型名和 API Key。');
    }
    const deepseekFlash = url.href === DEEPSEEK_CHAT_ENDPOINT && model === 'deepseek-flash';
    if (clip && (format !== 'openai' || (url.href !== GLM_CHAT_ENDPOINT && !deepseekFlash))) {
      throw new Pause('当前模型配置无法读取截图题，请使用 DeepSeek Flash 或智谱接口的 OpenAI 格式。');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'x-api-key') headers['x-api-key'] = key;
    else headers.Authorization = `Bearer ${key}`;
    const messages = [{ role: 'user', content: user }];
    let data = { model, messages: [{ role: 'system', content: system }, ...messages] };
    if (url.hostname === 'open.bigmodel.cn' && model === 'glm-5.3') {
      data.reasoning_effort = 'low';
      data.max_tokens = maxTokens;
    }
    if (deepseekFlash) {
      data.thinking = { type: 'disabled' };
      data.max_tokens = maxTokens;
    }
    if (format === 'anthropic') {
      if (url.hostname === 'api.anthropic.com') headers['anthropic-version'] = '2023-06-01';
      data = { model, system, max_tokens: maxTokens, messages };
    }
    run.check();
    return new Promise((resolve, reject) => {
      let request;
      const fail = message => reject(new Pause(message));
      const abort = () => {
        request?.abort();
        reject(run.signal.reason);
      };
      const complete = result => {
        run.signal.removeEventListener('abort', abort);
        if (result.status !== 200) return fail(`模型接口返回 HTTP ${result.status}，已停在当前项。`);
        let response;
        try {
          const json = JSON.parse(result.responseText);
          response = format === 'anthropic' ? json.content?.find(part => part.type === 'text')?.text : json.choices?.[0]?.message?.content;
        } catch {
          return fail('无法读取模型响应，已停在当前项。');
        }
        if (typeof response === 'string' && response.trim()) resolve(response);
        else fail('模型没有返回可用内容，已停在当前项。');
      };
      const networkError = error => {
        run.signal.removeEventListener('abort', abort);
        fail((NATIVE && error?.message) || (clip ? '题区截图或视觉模型请求失败，已停在当前题。' : '模型接口超时或连接失败，已停在当前项。'));
      };
      run.signal.addEventListener('abort', abort, { once: true });
      try {
        request = GM_xmlhttpRequest({
          method: 'POST', url: url.href, headers, data: JSON.stringify(data), anonymous: true, timeout: 45_000,
          clip,
          onload: complete, onerror: networkError, ontimeout: networkError,
        });
      } catch {
        networkError();
      }
    });
  }

  async function questionClip(run, liveQuestion, fitNext) {
    const scrollToQuestion = () => {
      const { body, stem, editor } = liveQuestion();
      (editor ? stem : body).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    };
    const adjusted = new Set();
    scrollToQuestion();
    return run.wait(() => {
      const question = liveQuestion();
      const capture = question.editor ? question.stem : question.body;
      const images = visible(capture, 'img');
      if (images.some(image => !image.complete || !image.naturalWidth)) return null;
      const controls = question.editor ? [] : question.fields || question.options.map(option => option.target);
      const range = question.body.ownerDocument.createRange();
      const boxes = [question.stem || question.body, ...controls].map(node => {
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        return text.width && text.height ? text : node.getBoundingClientRect();
      });
      for (const node of visible(capture, 'img, canvas')) boxes.push(node.getBoundingClientRect());
      let left = Math.min(...boxes.map(box => box.left));
      let top = Math.min(...boxes.map(box => box.top));
      let right = Math.max(...boxes.map(box => box.right));
      let bottom = Math.max(...boxes.map(box => box.bottom));
      let view = question.body.ownerDocument.defaultView;
      while (true) {
        if (left < -1 || top < -1 || right > view.innerWidth + 1 || bottom > view.innerHeight + 1) {
          if (!adjusted.has(view) && right - left <= view.innerWidth && bottom - top <= view.innerHeight) {
            adjusted.add(view);
            view.scrollBy({ left: left < 0 ? left : Math.max(0, right - view.innerWidth),
              top: top < 0 ? top : Math.max(0, bottom - view.innerHeight), behavior: 'instant' });
          } else if (fitNext()) {
            adjusted.clear();
            scrollToQuestion();
          }
          return null;
        }
        const frame = view.frameElement;
        if (!frame) break;
        const bounds = frame.getBoundingClientRect();
        left += bounds.left + frame.clientLeft;
        right += bounds.left + frame.clientLeft;
        top += bounds.top + frame.clientTop;
        bottom += bounds.top + frame.clientTop;
        view = frame.ownerDocument.defaultView;
      }
      const x = Math.max(0, Math.floor(left));
      const y = Math.max(0, Math.floor(top));
      return { x, y, width: Math.min(view.innerWidth, Math.ceil(right)) - x, height: Math.min(view.innerHeight, Math.ceil(bottom)) - y };
    }, '当前题目尚未完整显示，已停在此题。');
  }

  function parseTextAnswers(response, question) {
    const payload = parseModelJson(response);
    const value = payload?.answers ?? payload?.answer ?? payload;
    const answers = Array.isArray(value) ? value : [value];
    if (answers.length !== question.fields.length) return null;
    const text = answers.map(answer => {
      if (!question.subjective && typeof answer === 'number' && Number.isFinite(answer)) return String(answer);
      return typeof answer === 'string' ? answer.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim() : '';
    });
    return text.every((answer, index) => answer && answer.length <= question.limits[index]
      && (!question.fields[index].matches('input') || !answer.includes('\n'))) ? text : null;
  }

  async function requestAnswer(run, liveQuestion, clip) {
    const question = liveQuestion();
    if (question.fields) {
      const type = question.subjective ? '主观题' : /填空题/.test(question.type) ? '填空题' : '文字题';
      const guide = question.subjective ? '按题干要求用纯文本作答，必要时分段。' : '按输入框从左到右、从上到下的顺序填入答案。每个空格只返回对应内容。';
      const system = `解答当前${type}。${guide}只返回 JSON 对象，格式为 {"answers":["答案"]}。`;
      const count = question.fields.length;
      const stem = clip ? '请根据图中的题干和配图作答。' : question.text;
      const user = `${type}。${stem}\n共有 ${count} 个输入框。答案数量必须为 ${count}。各答案的字符上限依次为 ${question.limits.join('、')}。`;
      for (const correction of ['', '\n上次返回的答案格式无效。请在 answers 数组中为每个输入框提供一个非空字符串，并核对数量与字符上限。']) {
        liveQuestion();
        const response = await requestModel(run, system, user + correction, 2048, clip);
        const answers = parseTextAnswers(response, question);
        if (answers) return answers;
      }
      throw new Pause(`模型未返回 ${count} 个可填写的文字答案，已停在当前题。`);
    }
    const system = question.judgment
      ? '解答当前判断题。陈述正确返回 {"judgment":true}，陈述错误返回 {"judgment":false}。只返回 JSON。'
      : '解答当前选择题。只返回 JSON，格式为 {"choices":["A"]}。多选可返回多个字母。';
    const type = question.judgment ? '判断题' : question.multiple ? '多选' : '单选';
    const prompt = clip ? `${type}。请根据图中的题干、配图和选项作答。` : `${type}\n${question.text}`;
    const options = question.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option.text}`);
    const user = !clip || question.judgment ? [prompt, ...options].join('\n') : prompt;
    const indices = parseChoices(await requestModel(run, system, user, 1024, clip), question);
    if (!indices) throw new Pause(question.judgment ? '模型没有返回可识别的判断结果，请在当前题检查。'
      : '模型没有返回适用的选项，请在当前题检查。');
    return new Set(indices);
  }

  async function solveQuestion(run, liveQuestion) {
    const question = liveQuestion();
    if (!question.visual) return requestAnswer(run, liveQuestion);
    const layout = question.body.ownerDocument.documentElement;
    const zoom = layout.style.getPropertyValue('zoom');
    const priority = layout.style.getPropertyPriority('zoom');
    const base = Number(layout.ownerDocument.defaultView.getComputedStyle(layout).zoom) || 1;
    const factors = [0.85, 0.7, 0.55].values();
    let scaled = false;
    const fitNext = () => {
      const { value } = factors.next();
      if (!value) return false;
      layout.style.setProperty('zoom', String(base * value), 'important');
      scaled = true;
      return true;
    };
    try {
      const clip = await questionClip(run, liveQuestion, fitNext);
      return await requestAnswer(run, liveQuestion, clip);
    } finally {
      if (scaled) {
        if (zoom) layout.style.setProperty('zoom', zoom, priority);
        else layout.style.removeProperty('zoom');
      }
    }
  }

  function checked(option) {
    const { control, target } = option;
    if (control.matches('input') && control.checked) return true;
    const marker = '[aria-checked="true"], [aria-selected="true"], [data-state="checked"], .is-checked, .checked, .is-selected, .selected, .option-checked, .option-selected, .option-active, .is-active, .active';
    const row = target.closest('li') || control.closest('li') || target;
    return [control, target, row].some(node => node.matches(marker)) || Boolean(row.querySelector(marker));
  }

  const controlLocked = control => control.matches(':disabled, [disabled], [aria-disabled="true"], [readonly], [aria-readonly="true"]');

  function writeSubjectEditor(field, text) {
    const doc = field.ownerDocument;
    const view = doc.defaultView;
    const selection = doc.getSelection();
    if (!selection || !isEnabled(view.frameElement) || controlLocked(field)) throw new Pause('主观题编辑器暂时不可用。');
    field.focus({ preventScroll: true });
    const range = doc.createRange();
    range.selectNodeContents(field);
    selection.removeAllRanges();
    selection.addRange(range);
    // 富文本编辑器的保存和撤销会监听键盘编辑事件。
    field.dispatchEvent(new view.KeyboardEvent('keydown', { bubbles: true }));
    if (!doc.execCommand?.('insertText', false, text)) throw new Pause('主观题编辑器未接受文字输入。');
    field.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true }));
    field.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  async function fillAnswer(run, question, liveQuestion, answer) {
    if (question.fields) {
      for (const [index, text] of answer.entries()) {
        const current = liveQuestion();
        const field = current.fields[index];
        if (field === current.editor) writeSubjectEditor(field, text);
        else {
          if (!isEnabled(field) || controlLocked(field)) throw new Pause('文字答案输入框暂时不可用。');
          writeTextField(field, text);
        }
      }
      const current = liveQuestion();
      const textMatches = current.fields.every((field, index) => {
        const rendered = readTextField(field);
        const expected = answer[index];
        // 浏览器读取相邻段落时会在段间增加空行。
        if (field === current.editor) return rendered.replace(/\n{2,}/g, '\n') === expected.replace(/\n{2,}/g, '\n');
        return rendered === expected;
      });
      if (!textMatches) {
        throw new Pause('页面中的文字答案未能确认。');
      }
      return;
    }
    const selected = (option, index) => checked(option) === answer.has(index);
    for (const [index, option] of liveQuestion().options.entries()) {
      if ((!question.multiple && !answer.has(index)) || selected(option, index)) continue;
      await run.click(() => {
        const current = liveQuestion().options[index];
        return controlLocked(current.control) ? null : current.target;
      }, '选项暂时不可用。');
    }
    await run.wait(() => liveQuestion().options.every(selected), '页面中的选中状态无法确认。', 3000);
  }

  function questionTabs(root) {
    return visible(root, QUESTION_TAB).filter(element => label(element) && label(element).length <= 20);
  }

  const isCurrentQuestionTab = tab => tab.matches('.is-active, .active, .current, .is-current, [aria-current="true"], [aria-selected="true"]');
  const questionTabNumber = tab => Number(label(tab).match(/^(?:第\s*)?(\d+)(?:\s*题|\s|$)/)?.[1]);
  const questionTabKey = tab => tab.dataset.questionId || (questionTabNumber(tab) || label(tab));
  const buttonText = button => label(button).replace(/\s+/g, '');

  function exerciseProgress(doc) {
    for (const node of visible(doc, 'span, div, p, header, strong')) {
      if (node.closest(QUESTION_BODY)) continue;
      const match = label(node).match(/^(?:(?:展开|收起)\s*[»›>]*\s*)?(\d+)\s*[/／]\s*(\d+)\s*题$/);
      if (!match) continue;
      const [answered, total] = match.slice(1).map(Number);
      if (total > 0 && answered <= total) return { answered, total };
    }
    return null;
  }

  function embeddedExerciseButton(doc, text) {
    const buttons = visible(doc, 'button').filter(button => text.test(buttonText(button)));
    // 嵌入测验的提交按钮与上一题、下一题放在同一组。
    const navigation = buttons.find(button => {
      const group = button.closest('ul, ol, footer, .exercise-footer, .quiz-footer');
      if (!group) return false;
      const labels = visible(group, 'button').map(buttonText);
      return labels.some(title => PREVIOUS_QUESTION.test(title)) && labels.some(title => NEXT_QUESTION.test(title));
    });
    return navigation || (buttons.length === 1 ? buttons[0] : null);
  }

  function questionSubmit(root, question) {
    if (question.embedded) {
      const submit = embeddedExerciseButton(root.ownerDocument, /^(?:提交|提交答案|提交本题|确认答案|保存答案)$/);
      if (submit) return submit;
    }
    const local = visible(question.body, BUTTON).find(button => SUBMIT_QUESTION.test(buttonText(button)) || buttonText(button) === '提交');
    return local || visible(root, BUTTON).find(button => SUBMIT_QUESTION.test(buttonText(button)));
  }

  function savedEmbeddedQuestion(question, progress, submit) {
    if (!progress?.answered) return false;
    const submitLocked = submit && !isEnabled(submit);
    if (question.options) {
      const locked = question.options.every(({ control, target }) => controlLocked(control) || !isEnabled(target));
      const selected = question.options.some(checked);
      return submitLocked ? locked || selected : locked && selected;
    }
    return (submitLocked || question.fields.every(controlLocked)) && question.fields.some(field => normalize(readTextField(field)));
  }

  function wholeExerciseButton(root) {
    const generic = !EMBEDDED_EXERCISE.test(root.ownerDocument.location.pathname);
    const submit = button => /^(?:交卷|提交作业|提交测验|提交测试|提交练习|提交试卷|提交全部答案|完成并提交)$/.test(label(button))
      || (generic && label(button) === '提交');
    const buttons = visible(root, BUTTON).filter(button => !button.closest(QUESTION_BODY) && submit(button));
    if (buttons.length === 1) return buttons[0];
    if (buttons.length) return null;
    const footer = firstVisible(root.ownerDocument, '.exercise-footer, .homework-footer, .quiz-footer');
    return footer && visible(footer, BUTTON).find(submit);
  }

  function exerciseConfirmations(doc) {
    return visible(doc, '.el-message-box, .el-dialog, [role="alertdialog"], [role="dialog"]').filter(dialog => {
      const text = label(dialog);
      return /(?:确认|确定|是否|将要).{0,30}(?:提交|交卷)|(?:提交|交卷).{0,30}(?:确认|确定|是否)/.test(text)
        && !/未作答|未答题|漏答|考试|监考|验证/.test(text);
    });
  }

  async function finishExercise(run, name, kind, checkPage, readDone) {
    const confirmCurrent = () => {
      checkPage();
      const root = exerciseRoot();
      if (!canAnswer(run, root, kind)) throw new Pause('当前作答页面已变化，整份提交已停止。');
      return root;
    };
    const ready = await run.wait(() => {
      checkPage();
      if (exerciseDone(readDone)) return 'done';
      const button = wholeExerciseButton(confirmCurrent());
      return isEnabled(button) && button;
    }, '未找到可用的整份提交按钮，已停在当前作答页。');
    if (ready === 'done') return;
    const doc = ready.ownerDocument;
    const existing = new Set(exerciseConfirmations(doc));
    run.log(`提交 ${name}，等待雨课堂确认`);
    await run.click(() => wholeExerciseButton(confirmCurrent()), '整份提交按钮暂时不可用。');
    const confirmation = await run.wait(() => {
      checkPage();
      if (exerciseDone(readDone)) return 'done';
      confirmCurrent();
      return exerciseConfirmations(doc).find(dialog => !existing.has(dialog)
        && action(dialog, /^(?:确定|确认|提交|交卷|确认提交|确定提交|确认交卷|确定交卷)$/));
    }, `${name} 尚未显示提交成功，已停在当前项。`, STATUS_WAIT);
    if (confirmation === 'done') return;
    await run.click(() => {
      confirmCurrent();
      if (!exerciseConfirmations(doc).includes(confirmation)) return null;
      return action(confirmation, /^(?:确定|确认|提交|交卷|确认提交|确定提交|确认交卷|确定交卷)$/);
    }, '整份提交确认窗口已变化。');
    await run.wait(() => {
      checkPage();
      return exerciseDone(readDone);
    }, `${name} 尚未显示提交成功，已停在当前项。`, STATUS_WAIT);
  }

  async function studyExercise(run, name, readDone, kind = 'exercise') {
    if (exerciseDone(readDone)) return;
    const page = location.href;
    const checkPage = () => {
      if (!sameResourcePage(page)) throw new Pause('作答页面已切换，当前作答状态未确认。');
    };
    const root = await run.wait(() => {
      checkPage();
      return exerciseRoot();
    }, '未识别到题目区域，已停在当前项。');
    const waitManually = async () => {
      run.log(`请完成并提交 ${name}。页面确认提交后将继续。`);
      await run.wait(() => {
        checkPage();
        return exerciseDone(readDone);
      }, '本项尚未显示已提交，请完成后再继续。', MANUAL_WAIT);
    };
    if (!canAnswer(run, root, kind)) return waitManually();

    const seen = new Set();
    const visitedTabs = new Set();
    while (!exerciseDone(readDone)) {
      checkPage();
      const question = await run.wait(() => {
        checkPage();
        const current = getQuestion(exerciseRoot());
        if (current?.embedded && !exerciseProgress(current.body.ownerDocument)
          && current.options?.every(({ control }) => controlLocked(control)) && !answered(current)) return null;
        return current;
      }, '没有识别到当前题干或可作答选项，已停在当前题。');
      if (!canAnswer(run, exerciseRoot(), kind)) return waitManually();
      if (seen.has(question.key)) throw new Pause('题目没有切换成功，请检查当前题。');
      seen.add(question.key);
      const questionId = question.body.dataset.questionId;
      const frame = question.body.ownerDocument;
      const frameUrl = new URL(frame.location.href);
      let saved = false;
      const matchesQuestion = current => {
        if (current.key === question.key) return true;
        if (!saved) return false;
        const currentId = current.body.dataset.questionId;
        if (questionId && currentId) return currentId === questionId;
        if (question.number > 0 && current.number > 0) return current.number === question.number;
        return Boolean(question.text && current.text === question.text);
      };
      const sameFrame = doc => doc === frame || (question.embedded && doc.location?.origin === frameUrl.origin
        && doc.location.pathname === frameUrl.pathname);
      const liveQuestion = () => {
        run.check();
        checkPage();
        const currentRoot = exerciseRoot();
        const current = getQuestion(currentRoot);
        if (!canAnswer(run, currentRoot, kind) || !current || current.body.ownerDocument !== frame
          || !matchesQuestion(current)) throw new Pause('当前题目已变化，请重新开始。');
        return current;
      };
      const currentRoot = exerciseRoot();
      const questionTabsBefore = questionTabs(question.embedded ? frame : currentRoot);
      const tabBefore = questionTabsBefore.find(isCurrentQuestionTab);
      if (tabBefore) visitedTabs.add(questionTabKey(tabBefore));
      const progressBefore = question.embedded && exerciseProgress(frame);
      const submitButton = () => questionSubmit(exerciseRoot(), liveQuestion());
      saved = answered(question) || savedEmbeddedQuestion(question, progressBefore, questionSubmit(currentRoot, question));
      if (progressBefore) {
        const current = question.number ? `，第 ${question.number} 题` : '';
        run.log(`测验进度 ${progressBefore.answered}/${progressBefore.total} 题${current}${saved ? '已提交，继续下一题' : ''}`);
      }
      if (!saved) {
        await run.wait(() => document.visibilityState === 'visible', '请回到练习页后继续。', MANUAL_WAIT);
        run.log(question.visual ? '正在读取当前图片题' : '正在解答当前题目');
        const answer = await solveQuestion(run, liveQuestion);
        await run.wait(() => document.visibilityState === 'visible', '请回到练习页后继续。', MANUAL_WAIT);
        if (exerciseDone(readDone)) return;
        await fillAnswer(run, question, liveQuestion, answer);
        if (submitButton()) {
          await run.wait(() => answered(liveQuestion()) || isEnabled(submitButton()), '当前题的提交按钮不可用。');
          if (!answered(liveQuestion())) {
            run.log(question.number ? `提交第 ${question.number} 题` : '提交当前题');
            await run.click(submitButton, '当前题的提交按钮不可用。');
          }
          await run.wait(() => {
            checkPage();
            if (exerciseDone(readDone)) return true;
            const root = exerciseRoot();
            if (!root) return null;
            if (!sameFrame(root.ownerDocument)) throw new Pause('作答页面已切换，当前作答状态未确认。');
            const progress = progressBefore && exerciseProgress(root.ownerDocument);
            if (progress && progress.total === progressBefore.total && progress.answered === progressBefore.answered + 1) return true;
            const verified = getQuestion(root);
            return verified?.key === question.key && answered(verified);
          }, '没有收到本题提交成功的反馈，已停在当前题。', STATUS_WAIT);
          saved = true;
          const currentDoc = exerciseRoot()?.ownerDocument;
          const confirmed = question.embedded && currentDoc && sameFrame(currentDoc) && exerciseProgress(currentDoc);
          if (confirmed) {
            run.log(`测验进度 ${confirmed.answered}/${confirmed.total} 题`);
          }
        }
      }
      const readTransition = () => {
        checkPage();
        if (exerciseDone(readDone)) return 'done';
        const root = exerciseRoot();
        if (!root) return null;
        if (!sameFrame(root.ownerDocument)) throw new Pause('作答页面已切换，当前作答状态未确认。');
        const current = getQuestion(root);
        return current && { root, current };
      };
      const afterAnswer = await run.wait(readTransition, '没有识别到当前题干或可作答选项，已停在当前题。');
      if (afterAnswer === 'done') return;
      const loadedRoot = afterAnswer.root;
      if (!canAnswer(run, loadedRoot, kind)) return waitManually();
      const navigation = question.embedded ? loadedRoot.ownerDocument : loadedRoot;
      const tabs = questionTabs(navigation);
      let currentIndex = tabs.findIndex(tab => questionId && tab.dataset.questionId === questionId);
      if (currentIndex < 0 && question.number) currentIndex = tabs.findIndex(tab => questionTabNumber(tab) === question.number);
      if (currentIndex < 0 && matchesQuestion(afterAnswer.current)) currentIndex = tabs.findIndex(isCurrentQuestionTab);
      if (currentIndex >= 0) visitedTabs.add(questionTabKey(tabs[currentIndex]));
      if (!matchesQuestion(afterAnswer.current)) {
        if (saved) continue;
        throw new Pause('当前题目已变化，请重新开始。');
      }
      const nextButton = root => question.embedded ? embeddedExerciseButton(root.ownerDocument, NEXT_QUESTION)
        : visible(root, BUTTON).find(button => NEXT_QUESTION.test(buttonText(button)));
      const useTabs = tabs.length > 1 && currentIndex >= 0;
      const inOrder = tabs.slice(currentIndex + 1).concat(tabs.slice(0, currentIndex));
      const nextTab = useTabs && inOrder.find(tab => !visitedTabs.has(questionTabKey(tab)));
      const next = useTabs ? nextTab : nextButton(loadedRoot);
      const progress = question.embedded && exerciseProgress(navigation);
      if (progress?.total > 0 && progress.answered === progress.total && !wholeExerciseButton(loadedRoot)) {
        return confirmStatus(run, page, () => exerciseDone(readDone), name);
      }
      if (!next) {
        if (tabs.length > 1 && tabs.some(tab => !visitedTabs.has(questionTabKey(tab)))) throw new Pause('题号未能全部核对，已停在当前作答页。');
        return finishExercise(run, name, kind, checkPage, readDone);
      }
      const nextKey = nextTab && questionTabKey(nextTab);
      const mayUseNextButton = useTabs && nextTab === tabs[currentIndex + 1];
      let clickedAt = null;
      let usedFallback = false;
      await run.wait(() => {
        const state = readTransition();
        if (state === 'done') return true;
        if (!state) return null;
        if (!canAnswer(run, state.root, kind)) throw new Pause('当前作答页面已变化。');
        if (!matchesQuestion(state.current)) {
          if (saved || clickedAt !== null) return true;
          throw new Pause('当前题目已变化，请重新开始。');
        }
        if (document.visibilityState !== 'visible' || (!saved && !answered(state.current))) return null;
        const scope = question.embedded ? state.root.ownerDocument : state.root;
        const preferred = useTabs ? questionTabs(scope).find(tab => questionTabKey(tab) === nextKey) : nextButton(state.root);
        if (clickedAt === null && isEnabled(preferred)) {
          clickedAt = performance.now();
          preferred.click();
        } else if (mayUseNextButton && !usedFallback
          && (!isEnabled(preferred) || (clickedAt !== null && performance.now() - clickedAt >= 2000))) {
          const fallback = nextButton(state.root);
          if (isEnabled(fallback)) {
            clickedAt = performance.now();
            usedFallback = true;
            fallback.click();
          }
        }
        return null;
      }, '下一题没有加载成功。');
    }
  }

  function hasDetailDone() {
    return courseDocuments().some(doc => visible(doc, STATUS_SELECTOR)
      .filter(node => !node.closest('.logs-list, .nav-item-leaf-box')).some(node => isDone(label(node))));
  }

  function workspaceAssetDone(kind, name) {
    const route = getRoute();
    if (route?.view !== 'ai' || route.kind !== kind) return false;
    const statuses = { reading: ['已读'], video: ['已完成'], audio: ['已完成'], discussion: ['已参与', '已讨论', '已回复', '已发表', '已发帖', '已发言', '已完成'] }[kind];
    if (!statuses) return false;
    const title = normalize(name).replace(/^(?:图文|视频|音频|讨论)\s+/, '');
    if (!title) return false;
    const metadata = visible(document, 'span, p, div').filter(node => /^考核截止时间\s*[:：]/.test(label(node))
      && !Array.from(node.children).some(child => /^考核截止时间/.test(label(child))));
    for (const deadline of metadata) {
      let header = deadline.parentElement;
      for (let depth = 0; header && depth < 3 && header !== document.body; depth++, header = header.parentElement) {
        if (header.closest('.nav-item-leaf-box')) break;
        const text = label(header);
        if (text.length >= 450 || !text.includes(title)) continue;
        const labels = visible(header, 'span, p, div, h1, h2, h3').map(label);
        // Some title nodes also contain the resource type label.
        const textNodes = Array.from(header.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => normalize(node.textContent));
        if (statuses.some(status => labels.includes(status))
          && [...labels, ...textNodes].some(value => value.replace(/^(?:图文|视频|音频|讨论)\s+/, '') === title)) return true;
      }
    }
    return false;
  }

  const DISCUSSION_COMPOSER = '.publish_discuss, .forum-composer, .discussion-composer, form[data-discussion-form]';
  const DISCUSSION_POSTS = '.new_discuss_list .cont_detail, .forum-posts .post-content, .discussion-list .post-content';
  const DISCUSSION_REPLIES = '.new_discuss_list, .forum-posts, .discussion-list, .comment-item, .reply-editor';
  const DISCUSSION_INPUT = 'textarea[placeholder^="发表你的观点"], input[placeholder^="发表你的观点"], [contenteditable][data-placeholder^="发表你的观点"], [contenteditable][aria-label^="发表你的观点"]';
  const DISCUSSION_ENTER = /Enter\s*发送\s*[/／]\s*Shift\s*\+\s*Enter\s*换行/i;

  function discussionEditor() {
    const composer = visible(document, DISCUSSION_COMPOSER).find(node => !node.closest(DISCUSSION_REPLIES));
    const root = composer || firstVisible(document, '#new_discuss');
    const editor = root && visible(root, 'textarea, [contenteditable="true"]').filter(field => !field.closest(DISCUSSION_REPLIES));
    const modern = visible(document, DISCUSSION_INPUT).filter(field => !field.closest(DISCUSSION_REPLIES));
    if (modern.length === 1 && DISCUSSION_ENTER.test(label(document.body))) {
      const field = modern[0];
      return { root: root?.contains(field) ? root : field.parentElement, field, sendWithEnter: true };
    }
    return editor?.length === 1 ? { root, field: editor[0], sendWithEnter: false } : null;
  }

  function discussionTopic(name) {
    const heading = firstVisible(document, '.forum-title, .discussion-title, .topic-title, section.title h1, section.title h2');
    const title = (label(heading) || normalize(name)).replace(/^讨论(?:\s*[：:]\s*|\s+|$)/, '').trim();
    const details = visible(document, '.forum-description, .forum-prompt, .discussion-prompt, .topic-description, .topic-content')
      .find(node => !node.closest(`${DISCUSSION_REPLIES}, ${DISCUSSION_COMPOSER}`) && label(node));
    if (!title || /^(?:当前内容|当前知识点|学习空间)$/.test(title)) return '';
    // 学习空间的讨论正文位于两个带数量的「讨论区」标签之间。
    const rendered = document.body.innerText ?? document.body.textContent;
    const betweenTabs = rendered.match(/(?:^|\s)正文\s+讨论区\s*[（(]\s*\d+\s*[）)]\s+([\s\S]+?)\s+讨论区\s*[（(]\s*\d+\s*[）)]/);
    const prompt = label(details) || normalize(betweenTabs?.[1]);
    return [title, prompt.slice(0, 6000)].filter(Boolean).join('\n');
  }

  function discussionPublish(root) {
    const controls = visible(root, BUTTON).filter(node => !node.closest(DISCUSSION_REPLIES));
    return controls.find(node => node.matches('.submitComment, .postBtn button'))
      || controls.find(node => /^(?:发布|发表|发送|发布讨论|发表讨论|发表回复|发布评论|发表评论|提交讨论)$/.test(label(node)));
  }

  function discussionPostCount(text) {
    const expected = normalize(text);
    if (!expected) return 0;
    const posts = visible(document, DISCUSSION_POSTS).filter(node => label(node) === expected);
    const field = discussionEditor()?.field;
    if (field?.matches(DISCUSSION_INPUT)) {
      // 新版的帖子不沿用旧评论区类名。只匹配编辑框之后显示的完整正文。
      const candidates = document.querySelectorAll('article, section, div, p, span, blockquote, li');
      for (const node of candidates) {
        const position = field.compareDocumentPosition(node);
        if (!(position & Node.DOCUMENT_POSITION_FOLLOWING) || (position & Node.DOCUMENT_POSITION_CONTAINED_BY)) continue;
        if (!node.closest('[contenteditable], textarea, .nav-item-leaf-box') && label(node) === expected && isVisible(node)) posts.push(node);
      }
    }
    const unique = [...new Set(posts)];
    return unique.filter(node => !unique.some(other => other !== node && node.contains(other))).length;
  }

  async function requestDiscussion(run, topic, limit) {
    const system = '请回答课程讨论题，回应题目中每一问，用自己的话给出切题解释。仅输出可发布的中文纯文本正文。';
    for (const length of [Math.min(limit, 360), Math.min(limit, 220)]) {
      const response = await requestModel(run, system, `${topic}\n正文最多 ${length} 字。`, 2048);
      const payload = parseModelJson(response);
      const rawText = typeof payload?.reply === 'string' ? payload.reply : typeof payload === 'string' ? payload : response;
      const text = rawText.trim();
      if (text && text.length <= limit && !/^(?:[\[\]{}`]|<think\b)/i.test(text)) return text;
    }
    throw new Pause('模型没有返回适用的讨论正文。');
  }

  async function studyDiscussion(run, name, readDone) {
    const page = location.href;
    const done = () => readDone() || workspaceAssetDone('discussion', name)
      || hasDone(document, '.discussion-status, .forum-status, .discussion-header .status, .forum-header .status');
    const checkPage = () => {
      if (!sameResourcePage(page) || isExamPage(document)) throw new Pause('讨论页面已切换，发布已停止。');
    };
    const pendingKey = `ykt.study.discussion.pending:${location.pathname}`;
    if (done()) {
      sessionStorage.removeItem(pendingKey);
      return;
    }
    const pending = sessionStorage.getItem(pendingKey);
    if (pending) {
      const { reply, previousCount } = JSON.parse(pending);
      await confirmStatus(run, page, () => done() || discussionPostCount(reply) > previousCount, name);
      sessionStorage.removeItem(pendingKey);
      return;
    }
    if (!run.settings.autoDiscussion) {
      run.log(`请使用网页完成 ${name}。可在助手设置中启用自动讨论。`);
      await run.wait(() => {
        checkPage();
        return done();
      }, `${name} 尚未显示已参与。`, MANUAL_WAIT);
      return;
    }

    const ready = await run.wait(() => {
      checkPage();
      if (done()) return 'done';
      const editor = discussionEditor();
      const topic = discussionTopic(name);
      return editor && topic && isEnabled(editor.field) && { ...editor, topic };
    }, '没有找到讨论题目或可用的发布编辑框。');
    if (ready === 'done') return;
    if (normalize(readTextField(ready.field))) throw new Pause('讨论编辑框已有草稿，已保留当前内容。');
    const limit = ready.field.maxLength >= 0 ? Math.min(800, ready.field.maxLength) : 800;
    await run.wait(() => document.visibilityState === 'visible', '请回到讨论页后继续。', MANUAL_WAIT);
    const sameEditor = () => {
      checkPage();
      const editor = discussionEditor();
      if (editor?.field !== ready.field || discussionTopic(name) !== ready.topic || !isEnabled(editor.field)) {
        throw new Pause('当前讨论题目或编辑框已变化，发布已停止。');
      }
      return editor;
    };
    sameEditor();
    run.log(`正在生成讨论回复 ${name}`);
    const text = await requestDiscussion(run, ready.topic, limit);
    await run.wait(() => document.visibilityState === 'visible', '请回到讨论页后继续。', MANUAL_WAIT);
    checkPage();
    if (done()) return;
    const editor = sameEditor();
    if (normalize(readTextField(editor.field))) throw new Pause('讨论编辑框出现了新草稿，已保留当前内容。');
    writeTextField(editor.field, text);
    const target = await run.wait(() => {
      const current = sameEditor();
      if (normalize(readTextField(current.field)) !== normalize(text)) return null;
      const button = discussionPublish(current.root);
      return isEnabled(button) ? button : current.sendWithEnter && current.field;
    }, '讨论内容或发布控件未就绪。');
    const previousCount = discussionPostCount(text);
    run.log(`发布讨论 ${name}，等待雨课堂确认`);
    await run.wait(() => document.visibilityState === 'visible', '请回到讨论页后继续。', MANUAL_WAIT);
    checkPage();
    if (done()) return;
    const current = sameEditor();
    const sendWithEnter = current.sendWithEnter && target === current.field;
    if ((!sendWithEnter && discussionPublish(current.root) !== target) || !isEnabled(target)
      || normalize(readTextField(current.field)) !== normalize(text)) throw new Pause('讨论编辑框或发布控件已变化。');
    sessionStorage.setItem(pendingKey, JSON.stringify({ reply: text, previousCount }));
    if (sendWithEnter) {
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } else target.click();
    await confirmStatus(run, page, () => done() || discussionPostCount(text) > previousCount, name);
    sessionStorage.removeItem(pendingKey);
  }

  const isExerciseKind = kind => kind === 'exercise' || kind === 'homework';

  async function studyAsset(run, kind, name, readDone, canSkip = readDone) {
    run.check();
    if (kind === 'exam' || (isExerciseKind(kind) && isExamPage(document))) throw new Pause(`${name} 是考试任务。`);
    if (kind === 'discussion') return studyDiscussion(run, name, canSkip);
    if (canSkip() || workspaceAssetDone(kind, name)) return;
    if (kind === 'classroom') {
      const iframeSelector = 'iframe.lesson-report-mobile';
      const page = location.href;
      const tracks = await run.wait(() => {
        const frame = firstVisible(document, iframeSelector);
        const media = frame?.contentDocument ? mediaNodes(frame.contentDocument) : [];
        return media.length && media;
      }, `${name} 的回放未加载，已停在当前项。`);
      for (const track of tracks) await watchMedia(run, () => mediaVisible(track) ? track : null, name);
      await confirmStatus(run, page, readDone, name);
    } else if (kind === 'video' || kind === 'audio') {
      await studyMedia(run, kind, name, readDone);
    } else if (kind === 'courseware') {
      await studyCourseware(run, name, readDone);
    } else if (isExerciseKind(kind)) {
      await studyExercise(run, name, canSkip, kind);
    } else if (kind === 'reading' || kind === 'share') {
      const page = new URL(location.href);
      run.log(kind === 'share' ? `请使用网页完成 ${name}。雨课堂确认后将继续。` : `请阅读 ${name}，等待网页显示完成。`);
      await run.wait(() => {
        const current = new URL(location.href);
        if (page.origin !== current.origin || page.pathname !== current.pathname) throw new Pause('页面已切换，本项状态未确认。');
        return readDone() || workspaceAssetDone(kind, name)
          || (kind === 'share' && hasDone(document, '.share-status, .share-task .status, .sharing-status'));
      }, `${name} 尚未显示完成。`, MANUAL_WAIT);
    } else {
      throw new Pause(`无法识别 ${name} 的类型，已停在当前项。`);
    }
  }

  function directoryContents() {
    const unfinished = firstVisible(document, '.unfinished-study');
    if (unfinished) {
      const rows = visible(unfinished, `.unfinished-study__list > ${UNFINISHED_ROW}`).map(row => ({ row, entry: row }));
      const empty = firstVisible(unfinished, '.unfinished-study__state-empty');
      return rows.length || empty ? rows : null;
    }
    const list = firstVisible(document, '.logs-list');
    if (!list) return null;
    const rows = Array.from(list.children).map(row => ({ row, entry: row.querySelector('.content-box section') }))
      .filter(({ entry }) => isVisible(entry));
    const empty = /^(?:暂无数据|暂无内容|暂无任务|暂无未完成(?:任务|项目|活动)|没有未完成(?:任务|项目|活动))$/.test(label(list));
    return rows.length || empty ? rows : null;
  }

  const anonymousRows = new WeakMap();
  const directoryDocumentId = Math.random().toString(36).slice(2);
  let anonymousRowNumber = 0;

  function directoryRowId(entry, link, index) {
    const id = entry.getAttribute('data-id') || (link?.origin === location.origin && link.pathname !== location.pathname && link.href);
    if (id) return id;
    if (!entry.matches(UNFINISHED_ROW) && new URLSearchParams(location.search).get('tab') !== 'unfinished') return index;
    // 未完成列表移除已完成项后，序号会变。仅在当前页面缓存无编号条目。
    if (!anonymousRows.has(entry)) anonymousRows.set(entry, `${directoryDocumentId}-${++anonymousRowNumber}`);
    return anonymousRows.get(entry);
  }

  function describeRow(entry, group, index) {
    const tag = entry.querySelector('.tag, .unfinished-study__type-text');
    const icon = tag?.querySelector('use');
    const expand = entry.querySelector('.sub-info .gray span');
    const name = label(entry.querySelector('h2, .unfinished-study__item-title')) || `第 ${index + 1} 项`;
    const internalLink = entry.closest('a[href]') || entry.querySelector('a[href]');
    const type = kindOf(`${icon?.getAttribute('href') || icon?.getAttribute('xlink:href') || ''} ${label(tag)}`);
    const path = internalLink?.pathname || '';
    const resource = path.match(/^\/ai-workspace\/lms-graph\/[^/]+\/([^/]+)\//)?.[1];
    const linkedType = EXAM_PATH.test(path) ? 'exam' : resource === 'graph' ? 'reading' : kindOf(resource || '');
    const titleType = kindOf(name.match(/^(讨论|测验|测试|作业|考试)(?=\s|[:：]|$)/)?.[1] || '');
    let kind = linkedType || type || (expand ? 'batch' : titleType);
    if (type === 'exam' || linkedType === 'exam') kind = 'exam';
    else if (type === 'homework' && linkedType === 'exercise') kind = type;
    const key = JSON.stringify([group, directoryRowId(entry, internalLink, index), kind, name]);
    const target = entry.matches(UNFINISHED_ROW) ? entry.querySelector('button.unfinished-study__arrow') : entry;
    return { element: entry, target, expand, key, kind, name };
  }

  const rowDone = item => visible(item.element, ROW_STATUS).some(node => isDone(label(node), ['batch', 'courseware'].includes(item.kind)));

  function batchRows(row) {
    return visible(row, '.leaf_list__wrap .activity__wrap');
  }

  async function nextDirectoryItem(run, verified, exams = new Set()) {
    const pending = item => {
      if (rowDone(item) || verified.has(item.key)) return false;
      if (item.kind !== 'exam') return true;
      exams.add(item.key);
      return false;
    };
    let rows = await run.wait(directoryContents, '目录未加载，找不到课程条目。');
    while (true) {
      for (const [index, { row, entry }] of rows.entries()) {
        const item = describeRow(entry, '', index);
        if (!pending(item)) continue;
        if (item.kind !== 'batch') return item;
        if (!batchRows(row).length) {
          await run.click(item.expand, `${item.name} 的展开按钮不可用。`);
          await run.wait(() => batchRows(row).length, `${item.name} 的子条目未加载。`);
        }
        const child = batchRows(row).map((element, childIndex) => describeRow(element, item.key, childIndex))
          .find(pending);
        if (child) return child;
      }

      const scroller = firstVisible(document, '.viewContainer') || document.scrollingElement;
      if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) return null;
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(900, run.signal);
      const loaded = directoryContents();
      if (!loaded || loaded.length <= rows.length) return null;
      rows = loaded;
    }
  }

  function assetElement(kind) {
    if (isExerciseKind(kind)) return exerciseRoot();
    if (kind === 'courseware') return slideGroup()?.wrapper || firstVisible(document, '.ppt_img_box .check, .video-box') || courseMedia('video');
    if (kind === 'reading') return firstVisible(document, '.article-content, .new_discuss_list, .reading-content');
    if (kind === 'discussion') return discussionEditor()?.root || firstVisible(document, '#new_discuss, .discussion-status, .forum-status');
    if (kind === 'share') return firstVisible(document, '.share-task, .share-status, .sharing-status');
    return courseMedia(kind);
  }

  function assetStamp(kind) {
    const node = assetElement(kind);
    let identity = label(node);
    if (node?.matches('video, audio')) identity = node.currentSrc || node.getAttribute('src');
    else if (isExerciseKind(kind) && node) identity = getQuestion(node)?.key || label(firstVisible(node, '.item-type, .question-title, .exercise-header'));
    else if (kind === 'discussion') identity = discussionTopic('') || identity;
    return { node, identity };
  }

  function assetChanged(before, kind) {
    const current = assetStamp(kind);
    return current.node && (before.node !== current.node || before.identity !== current.identity);
  }

  function assetDone(kind) {
    return hasDetailDone() || (kind === 'courseware' && hasCoursewareStatus());
  }

  async function returnToDirectory(run, state) {
    await run.wait(() => document.visibilityState === 'visible', '请回到当前课程页后继续。', MANUAL_WAIT);
    const returnUrl = new URL(state.returnUrl);
    if (returnUrl.origin !== location.origin || !/^\/v2\/web\/studentLog\//.test(returnUrl.pathname)) {
      throw new Pause('课程已确认完成，请返回目录继续。');
    }
    if (signalParent(state, 'done')) {
      run.log(`${state.item.name} 已确认完成，返回目录`);
      window.opener.focus();
      window.close();
      return true;
    }
    const verified = [...new Set([...state.verified, state.item.key])];
    saveHandoff({ phase: 'return', from: location.href, returnUrl: returnUrl.href, verified });
    run.log(`${state.item.name} 已确认完成，返回目录`);
    location.assign(returnUrl.href);
    return true;
  }

  async function studyWorkspacePpt(run, state) {
    if (state.ownedPopup && !handoffParent(state)) state = { ...state, ownedPopup: false };
    run.retryFromDirectory = { page: location.href, state };
    await studyAsset(run, 'courseware', state.item.name, hasCoursewareStatus);
    if (!state.ownedPopup) return continueFromCourseware(run);
    if (!signalParent(state, 'done')) throw new Pause('课件已完成，原课程队列已停止。');
    run.log(`${state.item.name} 已确认完成，返回学习空间`);
    window.opener.focus();
    window.close();
    return true;
  }

  async function studyFromDirectory(run, state) {
    if (state?.phase === 'open') {
      if (state.ownedPopup && !handoffParent(state)) state = { ...state, ownedPopup: false };
      run.retryFromDirectory = { page: location.href, state };
      const route = getRoute();
      // AI 学习空间的 exercise 路由比目录中的批量分类更精确。
      const kind = route?.view === 'ai' && route.kind && !(route.kind === 'exercise' && state.item.kind === 'homework') ? route.kind : state.item.kind;
      const leafDone = () => route?.view === 'ai' && aiLeafDone();
      await studyAsset(run, kind, state.item.name, () => leafDone() || assetDone(kind), leafDone);
      return returnToDirectory(run, state);
    }
    const returnUrl = location.href;
    const verified = new Set(state?.verified || []);
    const exams = new Set();
    const item = await nextDirectoryItem(run, verified, exams);
    if (!item) {
      run.log(exams.size ? `当前目录其余已加载任务均已确认完成。${exams.size} 场考试待处理。` : '当前目录已加载的项目均已确认完成。');
      return false;
    }
    if (!item.kind) throw new Pause(`无法识别 ${item.name} 的任务类型，已停在目录。`);
    const before = assetElement(item.kind);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handoff = { id, phase: 'open', from: returnUrl, returnUrl, verified: [...verified], item: { key: item.key, kind: item.kind, name: item.name } };
    await run.wait(() => document.visibilityState === 'visible', '请回到课程目录后继续。', MANUAL_WAIT);
    if (location.href !== returnUrl) throw new Pause('课程目录已切换，请从当前目录开始。');
    saveHandoff(handoff);
    run.log(`打开 ${item.name}`);
    await run.click(item.target, `${item.name} 的目录入口不可用。`);
    const opened = await run.wait(() => {
      if (sessionStorage.getItem(HANDOFF_ACK_KEY) === id) return 'new-tab';
      if (location.href !== returnUrl && getRoute()?.view !== 'directory') return 'same-tab';
      const after = assetElement(item.kind);
      return after && after !== before && 'same-tab';
    }, '当前标签页未打开课程详情。若课程在新标签页打开，请在那一页点「开始」。');
    if (opened === 'new-tab') {
      run.log('课程已在新标签页打开，等待当前项的完成状态。');
      const completed = await waitForPopupResult(run, id);
      clearHandoff();
      if (completed === 'paused') throw new Pause('新标签页已暂停，请查看该页提示。');
      run.log(`${item.name} 已确认完成，返回目录`);
      verified.add(item.key);
      return studyFromDirectory(run, { phase: 'return', verified: [...verified] });
    }
    clearHandoff();
    return studyFromDirectory(run, handoff);
  }

  function aiLeaf() {
    return firstVisible(document, '.leaf-item.is-active');
  }

  function aiLeafDone() {
    const leaf = aiLeaf();
    if (!leaf) return false;
    if (hasDone(leaf, `${STATUS_SELECTOR}, .leaf-status, .progress, .status`)) return true;
    return visible(leaf, 'i, span, [class*="icon"]').some(icon => {
      if (label(icon) === WORKSPACE_DONE_ICON) return true;
      const view = icon.ownerDocument.defaultView;
      return view.CSS?.supports('content', '""')
        && ['::before', '::after'].some(pseudo => view.getComputedStyle(icon, pseudo).content === `"${WORKSPACE_DONE_ICON}"`);
    });
  }

  async function studyAiWorkspace(run) {
    if (document.visibilityState !== 'visible') {
      run.log('学习空间窗口在后台，回到课程页后继续。');
      await run.wait(() => document.visibilityState === 'visible', '请回到学习空间后继续。', MANUAL_WAIT);
    }
    let fromEarlierItem = false;
    let skippedExams = 0;
    let completedPopup = null;
    while (true) {
      const route = getRoute();
      if (route?.view !== 'ai') throw new Pause('已离开学习空间。');
      const active = await run.wait(aiLeaf, '未识别到当前知识点。');
      if (!completedPopup) {
        const name = normalize(label(active).replaceAll(WORKSPACE_DONE_ICON, '')) || '当前知识点';
        const readDone = () => aiLeafDone() || assetDone(route.kind);
        const verifyLeaf = fromEarlierItem || isExerciseKind(route.kind) || route.kind === 'discussion';
        await studyAsset(run, route.kind, name, readDone, verifyLeaf ? aiLeafDone : readDone);
        run.log(`${name} 已确认完成。`);
      }
      const leaves = visible(document, '.nav-item-leaf-box');
      let index = leaves.findIndex(node => node.contains(completedPopup?.node || active));
      if (index < 0 && completedPopup && normalize(label(leaves[completedPopup.index]).replaceAll(WORKSPACE_DONE_ICON, '')) === completedPopup.name) {
        index = completedPopup.index;
      }
      if (index < 0) throw new Pause('当前内容已完成。无法确认目录中的下一项。');
      const next = leaves.slice(index + 1).map(row => row.querySelector('.leaf-item') || row.firstElementChild).find(node => {
        if (!node) return false;
        const link = node.closest('a[href]') || node.querySelector('a[href]');
        const type = kindOf(`${node.className} ${node.dataset.activityType || ''} ${label(node.querySelector('.tag'))} ${node.querySelector('i')?.className || ''}`);
        if (type !== 'exam' && !EXAM_PATH.test(link?.pathname || '')) return true;
        skippedExams++;
        return false;
      });
      if (!next) {
        run.log(skippedExams ? `学习空间已处理到最后一项。${skippedExams} 场考试待处理。` : '学习空间里当前已加载的项目已处理到最后一项。');
        return;
      }
      const url = location.href;
      const oldContent = assetStamp(route.kind);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const name = normalize(label(next).replaceAll(WORKSPACE_DONE_ICON, '')) || '课件';
      const nextIndex = leaves.findIndex(row => row.contains(next));
      await run.click(() => {
        if (location.href !== url) throw new Pause('学习空间已切换，请从当前内容重新开始。');
        saveHandoff({ id, phase: 'workspace-ppt', from: url, returnUrl: url, classroomId: route.classroomId, item: { name } });
        return next;
      }, '下一项不可用。');
      const opened = await run.wait(() => {
        if (sessionStorage.getItem(HANDOFF_ACK_KEY) === id) return 'new-tab';
        const fresh = getRoute();
        if (location.href === url || fresh?.view !== 'ai' || fresh.classroomId !== route.classroomId || aiLeaf() === active) return false;
        return aiLeaf() && (fresh.kind !== route.kind || aiLeafDone() || assetChanged(oldContent, fresh.kind)) && 'same-tab';
      }, '下一项未加载完成，已停止切换。');
      completedPopup = null;
      if (opened === 'new-tab') {
        const result = await waitForPopupResult(run, id);
        if (result === 'paused') throw new Pause('课件标签页已暂停，请查看该页提示。');
        completedPopup = { node: next, index: nextIndex, name };
        run.log(`${name} 已确认完成。`);
      }
      clearHandoff();
      fromEarlierItem = true;
    }
  }

  function proHeader() {
    return firstVisible(document, '.header-bar');
  }

  function proDone() {
    return hasDetailDone() || visible(document, 'section.title > :last-child').some(node => isDone(label(node)));
  }

  async function studyPro(run) {
    let fromEarlierItem = false;
    while (true) {
      const header = await run.wait(proHeader, '此旧版课程页需要先在目录里打开内容。');
      const title = header.firstElementChild;
      const kind = kindOf(`${title?.firstElementChild?.className || ''} ${label(title?.querySelector('.tag'))}`);
      const page = location.href;
      const name = label(title) || '当前课程';
      const readDone = () => proDone() || (kind === 'courseware' && hasCoursewareStatus());
      await studyAsset(run, kind, name, readDone, fromEarlierItem || isExerciseKind(kind) ? () => false : readDone);
      const next = firstVisible(document, '.btn-next');
      if (!next || !isEnabled(next)) {
        run.log(`${name} 已确认完成。`);
        return;
      }
      const oldContent = assetStamp(kind);
      await run.click(next, '课程的下一项不可用。');
      await run.wait(() => {
        const currentTitle = proHeader()?.firstElementChild;
        if (!currentTitle || location.href === page || label(currentTitle) === name) return false;
        const currentKind = kindOf(`${currentTitle.firstElementChild?.className || ''} ${label(currentTitle.querySelector('.tag'))}`);
        return currentKind !== kind || assetChanged(oldContent, currentKind);
      }, '下一项没有切换成功。');
      fromEarlierItem = true;
    }
  }

  async function studyV2Detail(run) {
    const kind = await run.wait(() => {
      if (isExamPage(document)) return 'exam';
      if (exerciseRoot()) return /homework|zuoye/i.test(location.pathname) ? 'homework' : 'exercise';
      if (kindOf(location.pathname) === 'discussion' && discussionEditor()) return 'discussion';
      if (slideGroup() || firstVisible(document, '.ppt_img_box .check, .video-box')) return 'courseware';
      if (courseMedia('video')) return 'video';
      if (courseMedia('audio')) return 'audio';
      return '';
    }, '没有识别到当前学习内容。可以返回目录再点「开始」。');
    const name = label(firstVisible(document, '.dialog-header h2, .title h2, h1')) || '当前内容';
    await studyAsset(run, kind, name, () => assetDone(kind), isExerciseKind(kind) ? () => false : undefined);
    run.log(`${name} 已确认完成。`);
    return kind === 'courseware' && await continueFromCourseware(run);
  }

  async function continueFromCourseware(run) {
    const page = location.href;
    const params = new URLSearchParams(location.search);
    const route = getRoute();
    const course = location.pathname.match(/^\/v2\/web\/studentCards\/(\d+)\//)?.[1];
    const linkedClassroom = params.get('classroom_id');
    if (!course || (linkedClassroom && linkedClassroom !== course) || (!linkedClassroom && route.kind !== 'courseware')) return false;
    await run.wait(() => document.visibilityState === 'visible', '请回到课程页后继续。', MANUAL_WAIT);
    const recorded = pptProgress();
    if (recorded) {
      await sleep(1_500, run.signal);
      run.check();
      const confirmed = pptProgress(recorded.total);
      if (!confirmed || confirmed.read !== confirmed.total) throw new Pause('雨课堂正在同步课件进度，请稍后再继续。');
    }
    if (!sameResourcePage(page)) throw new Pause('课件页面已切换。');
    const directory = new URL(`/v2/web/studentLog/${course}`, location.origin);
    if (document.referrer) {
      const referrer = new URL(document.referrer);
      if (referrer.origin === location.origin && (referrer.pathname === directory.pathname
        || referrer.pathname.startsWith(`/ai-workspace/lms-graph/${course}/`))) {
        for (const key of ['university_id', 'platform_id']) {
          if (!params.has(key) && referrer.searchParams.has(key)) params.set(key, referrer.searchParams.get(key));
        }
      }
    }
    for (const key of ['university_id', 'platform_id']) {
      if (params.get(key)) directory.searchParams.set(key, params.get(key));
    }
    directory.searchParams.set('classroom_id', course);
    directory.searchParams.set('content_url', '');
    directory.searchParams.set('tab', 'unfinished');
    saveHandoff({ phase: 'return', from: location.href, returnUrl: directory.href, verified: [] });
    run.log('PPT 已确认完成，返回目录继续。');
    location.assign(directory.href);
    return true;
  }

  function getSettings() {
    const saved = GM_getValue(SETTINGS_KEY, {});
    return { ...DEFAULTS, ...saved };
  }

  function createPanel() {
    const root = document.createElement('aside');
    root.id = 'ykt-study-panel';
    const shadow = root.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { position:fixed; z-index:2147480000; right:16px; bottom:16px; color:#182334;
          font:14px/1.5 system-ui,sans-serif; width:min(305px,calc(100vw - 32px)); }
        .panel { background:#fff; border:1px solid #cbd4df; border-radius:12px; box-shadow:0 4px 20px #16273721; padding:12px; }
        header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        header button { padding:2px 8px; }
        p { margin:8px 0; overflow-wrap:anywhere; }
        .buttons { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
        button { color:#23446c; border:1px solid #cbd4df; background:#f3f6fa; border-radius:6px;
          padding:5px 10px; font:inherit; cursor:pointer; }
        button:disabled { opacity:.52; cursor:default; }
        .primary { color:#fff; background:#235c9f; border-color:#235c9f; }
        form { margin-top:12px; border-top:1px solid #e3e9f0; padding-top:8px; max-height:55vh; overflow:auto; }
        label { display:block; margin:6px 0; }
        label > input:not([type=checkbox]), select { font:inherit; padding:4px; width:100%; box-sizing:border-box; }
        .help { color:#4c596b; font-size:12px; }
        [hidden] { display:none !important; }
      </style>
      <div class="panel">
        <header><strong>雨课堂学习助手</strong><button id="toggle" type="button" aria-expanded="true">收起</button></header>
        <section id="body">
          <p id="status" role="status" aria-live="polite">就绪。点击「开始」处理当前学习内容。</p>
          <div class="buttons">
            <button class="primary" id="start" type="button">开始</button>
            <button id="stop" type="button" disabled>停止</button>
            <button id="settings" type="button">设置</button>
          </div>
          <form hidden>
            <label>PPT 每页最短停留（秒）<input name="pptSeconds" type="number" min="1" max="600" required></label>
            <label><input name="autoPractice" type="checkbox"> 自动完成非计分练习</label>
            <label><input name="autoHomework" type="checkbox"> 自动提交普通作业和测验（含计分）</label>
            <label><input name="autoDiscussion" type="checkbox"> 自动回复课程讨论</label>
            <div id="aiSettings" hidden>
              <p class="help">助手使用配置的模型处理当前文字题目，并通过雨课堂页面提交。考试由本人完成。</p>
              <label>模型接口<input name="endpoint" type="url" placeholder="https://..." required></label>
              <label>模型名<input name="model" type="text" required></label>
              <label id="keyField">API Key<input name="key" type="password" autocomplete="off"></label>
              <p id="keyStatus" class="help" hidden></p>
              <label>请求格式<select name="format"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label>
              <label>认证方式<select name="auth"><option value="bearer">Bearer</option><option value="x-api-key">X-API-Key</option></select></label>
            </div>
            <div class="buttons"><button class="primary" type="submit">保存</button><button id="cancel" type="button">取消</button></div>
          </form>
        </section>
      </div>`;
    document.body.append(root);
    const byId = id => shadow.getElementById(id);
    const form = shadow.querySelector('form');
    const settingsFields = form.elements;
    const saveButton = form.querySelector('button[type="submit"]');
    const log = message => {
      byId('status').textContent = message;
      if (NATIVE) YKT_STUDY_STATUS(message);
    };
    const taskSettings = ['autoPractice', 'autoHomework', 'autoDiscussion'];
    const toggleAiSettings = () => {
      const enabled = taskSettings.some(name => settingsFields[name].checked);
      byId('aiSettings').hidden = !enabled;
      for (const name of ['endpoint', 'model', 'key', 'format', 'auth']) settingsFields[name].disabled = !enabled;
      if (NATIVE) settingsFields.key.disabled = true;
    };
    if (NATIVE) {
      byId('keyField').hidden = true;
      byId('keyStatus').hidden = false;
    }
    byId('toggle').onclick = () => {
      const body = byId('body');
      body.hidden = !body.hidden;
      byId('toggle').textContent = body.hidden ? '展开' : '收起';
      byId('toggle').setAttribute('aria-expanded', String(!body.hidden));
    };
    byId('settings').onclick = () => {
      const settings = getSettings();
      for (const name of ['pptSeconds', 'endpoint', 'model', 'format', 'auth']) settingsFields[name].value = settings[name];
      settingsFields.key.value = '';
      settingsFields.key.placeholder = settings.key ? '留空保留已保存的 Key' : '请输入 API Key';
      if (NATIVE) byId('keyStatus').textContent = settings.key ? '本机已配置 API Key。' : '先运行「设置 AI Key.cmd」，再刷新课程页。';
      for (const name of taskSettings) settingsFields[name].checked = settings[name];
      toggleAiSettings();
      form.hidden = !form.hidden;
    };
    for (const name of taskSettings) settingsFields[name].onchange = toggleAiSettings;
    byId('cancel').onclick = () => { form.hidden = true; };
    form.onsubmit = async event => {
      event.preventDefault();
      const settings = getSettings();
      settings.pptSeconds = settingsFields.pptSeconds.valueAsNumber;
      for (const name of taskSettings) settings[name] = settingsFields[name].checked;
      if (taskSettings.some(name => settings[name])) {
        if (NATIVE && !settings.key) {
          log('请先运行「设置 AI Key.cmd」，刷新课程页后再启用自动提交。');
          return;
        }
        for (const name of ['endpoint', 'model', 'format', 'auth']) settings[name] = settingsFields[name].value.trim();
        settings.key = settingsFields.key.value.trim() || settings.key;
        try {
          const url = new URL(settings.endpoint);
          if (url.protocol !== 'https:' || url.username || url.password || !settings.model || !settings.key) throw new Error();
        } catch {
          log('启用自动提交需要 HTTPS 模型接口、模型名和 API Key。');
          return;
        }
      }
      saveButton.disabled = true;
      try {
        await GM_setValue(SETTINGS_KEY, settings);
        settingsFields.key.value = '';
        form.hidden = true;
        log('设置已保存，下次开始时生效。');
      } catch (error) {
        log(String(error.message || '保存本机设置失败。'));
      } finally {
        saveButton.disabled = false;
      }
    };
    return { start: byId('start'), stop: byId('stop'), log };
  }

  function boot() {
    if (!getRoute() || document.getElementById('ykt-study-panel')) return;
    const panel = createPanel();
    let active = null;
    let retry = null;
    let selectedClassroom = '';
    const start = async handoff => {
      if (active) return;
      const route = getRoute();
      if (route?.view === 'home') {
        panel.log('请选择要学习的课程。');
        return;
      }
      if (route?.view === 'directory') selectedClassroom = route.classroomId;
      const run = new StudyRun(getSettings(), panel.log);
      active = run;
      panel.start.disabled = true;
      panel.stop.disabled = false;
      let navigating = false;
      try {
        if (handoff?.phase === 'workspace-ppt') navigating = await studyWorkspacePpt(run, handoff);
        else if (handoff || route?.view === 'directory') navigating = await studyFromDirectory(run, handoff);
        else if (route?.view === 'ai') await studyAiWorkspace(run);
        else if (route?.view === 'pro') await studyPro(run);
        else if (route?.view === 'v2') navigating = await studyV2Detail(run);
        else panel.log('当前页面未识别为课程页。');
      } catch (error) {
        if (run.signal.aborted) panel.log('已停止。再次开始时读取当前页面的完成状态。');
        else if (error instanceof Pause) {
          panel.log(error.message);
          if (NATIVE) YKT_STUDY_STATUS(`流程已暂停。${error.message}`);
        }
        else {
          console.warn('[雨课堂学习助手]', error?.message || '运行失败');
          panel.log('运行出错，已停在当前项。');
          if (NATIVE) YKT_STUDY_STATUS('流程已暂停。程序运行出错。');
        }
      } finally {
        if (!navigating) {
          signalParent(run.retryFromDirectory?.state, 'paused');
          clearHandoff();
          retry = run.retryFromDirectory;
          panel.start.disabled = false;
          panel.stop.disabled = true;
          active = null;
        }
      }
    };
    panel.start.onclick = () => start(retry?.page === location.href ? retry.state : null);
    panel.stop.onclick = () => {
      clearHandoff();
      active?.controller.abort();
    };
    const handoff = takeHandoff();
    if (handoff) start(handoff);
    else if (NATIVE && YKT_RESUME_PPT && (getRoute()?.kind === 'courseware' || /\/ppt\/?$/.test(location.pathname))) start(null);
    else if (NATIVE && YKT_RESUME_DIRECTORY && getRoute()?.view === 'directory') start(null);
    else if (NATIVE && YKT_RESUME_WORKSPACE && getRoute()?.view === 'ai') {
      panel.log('学习空间已开始续跑。');
      start(null);
    }
    if (NATIVE && YKT_START_ON_COURSE) {
      let showingHome = false;
      const followSelection = () => {
        if (active) return;
        const route = getRoute();
        if (route?.view === 'home') {
          selectedClassroom = '';
          if (!showingHome) panel.log('请选择要学习的课程。');
          showingHome = true;
          return;
        }
        showingHome = false;
        if (route?.view !== 'directory' || route.classroomId === selectedClassroom || document.visibilityState !== 'visible') return;
        panel.log('开始处理课程目录。');
        start(null);
      };
      followSelection();
      window.setInterval(followSelection, 500);
    }
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
