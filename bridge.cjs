'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { windowsPowerShell, powerShellEnv } = require('./settings.cjs');

const WORLD = 'yuketang-study-local';
const BINDING = '__yuketangStudyCall';
const REPLY = '__yuketangStudyReply';
const GLM_CHAT_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEEPSEEK_CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions';

class StudyRequestError extends Error {}

function isCourseUrl(address) {
  const url = new URL(address);
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
    && /(?:^|\.)(?:yuketang\.cn|gdufemooc\.cn)$/.test(url.hostname)
    && /^\/(?:v2\/web\/|pro\/lms\/|ai-workspace\/lms-graph\/)/.test(url.pathname);
}

function buildScript(core, allowedUrl = isCourseUrl) {
  return `(async () => {
    if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    if (window.top !== window.self || !(${allowedUrl.toString()})(location.href)) return;
    for (let attempt = 0; attempt < 20 && typeof globalThis.${BINDING} !== 'function'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (globalThis.${REPLY} || typeof globalThis.${BINDING} !== 'function') return;
    const YKT_NATIVE = true;
    let nextId = 0;
    const pending = new Map();
    const connect = globalThis.${BINDING};
    const call = (method, value, timeout = 12_000) => {
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('本机助手没有响应。'));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        connect(JSON.stringify({ id, method, value }));
      });
      return { id, promise };
    };
    globalThis.${REPLY} = (id, result, error) => {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      if (error) item.reject(new Error(error));
      else item.resolve(result);
    };
    let settings = await call('settings').promise;
    const YKT_RESUME_PPT = settings.resumePpt === true;
    const YKT_RESUME_DIRECTORY = settings.resumeDirectory === true;
    const YKT_RESUME_WORKSPACE = settings.resumeWorkspace === true;
    const YKT_START_ON_COURSE = settings.startOnCourse === true;
    const YKT_STUDY_STATUS = status => call('studyStatus', status).promise.catch(() => {});
    const GM_getValue = () => settings;
    const GM_setValue = async (_key, value) => { settings = await call('save', value).promise; };
    const GM_xmlhttpRequest = options => {
      const { id, promise } = call('ask', { url: options.url, body: options.data, clip: options.clip }, 50_000);
      promise.then(options.onload, options.onerror);
      return { abort() { call('cancel', id).promise.catch(() => {}); } };
    };

${core}
  })().catch(error => console.warn('[雨课堂本机版]', error.message));`;
}

async function smallResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > 256_000) {
      await reader.cancel();
      throw new Error('模型响应过长。');
    }
    text += decoder.decode(value, { stream: true });
  }
}

function canUseVision(settings) {
  const { autoPractice, autoHomework, endpoint, format, model } = settings.values;
  return (autoPractice || autoHomework) && format === 'openai'
    && (endpoint === GLM_CHAT_ENDPOINT || (endpoint === DEEPSEEK_CHAT_ENDPOINT && model === 'deepseek-flash'));
}

function readQuestionText(image, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'ocr-question.ps1')], {
      env: powerShellEnv(), windowsHide: true, signal, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 && text.trim().length >= 15 && text.length <= 28_000) resolve(text.trim());
      else reject(new StudyRequestError('Windows OCR 未识别到可用的题干，已停在当前题。'));
    });
    child.stdin.on('error', reject);
    child.stdin.end(image);
  });
}

async function askModel(settings, value, signal, fetchModel = fetch, image) {
  const { autoPractice, autoHomework, autoDiscussion, endpoint, model, format, auth } = settings.values;
  if ((!autoPractice && !autoHomework && !autoDiscussion) || value?.url !== endpoint || typeof value.body !== 'string' || value.body.length > 60_000) {
    throw new Error('本机模型设置已变化，请刷新课程页面后再试。');
  }
  const data = JSON.parse(value.body);
  if (data.model !== model || !Array.isArray(data.messages)) throw new Error('本机模型请求的格式有误。');
  let body = value.body;
  if (image) {
    if (!canUseVision(settings) || typeof image !== 'string' || image.length > 2_000_000) throw new Error('当前模型配置不支持图片题。');
    if (endpoint === DEEPSEEK_CHAT_ENDPOINT) {
      const user = data.messages.at(-1);
      body = JSON.stringify({ ...data, messages: [...data.messages.slice(0, -1), {
        role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
          { type: 'text', text: user.content }],
      }] });
    } else {
      const text = data.messages.map(message => message.content).join('\n');
      body = JSON.stringify({
        model: 'glm-4.6v-flash', max_tokens: 2048, thinking: { type: 'enabled' },
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text }] }],
      });
    }
  }
  const key = settings.readKey();
  const headers = { 'Content-Type': 'application/json' };
  if (auth === 'x-api-key') headers['x-api-key'] = key;
  else headers.Authorization = `Bearer ${key}`;
  if (format === 'anthropic' && new URL(endpoint).hostname === 'api.anthropic.com') headers['anthropic-version'] = '2023-06-01';
  const request = { method: 'POST', headers, redirect: 'error', signal };
  let response = await fetchModel(endpoint, { ...request, body });
  if (image && response.status === 429) {
    await response.body?.cancel();
    const recognized = await readQuestionText(image, signal);
    const user = data.messages.at(-1);
    user.content += `\n以下是本机 Windows OCR 对题区的转写。每个文字块前的数字是 x、y 像素坐标，可结合位置恢复表格。若缺少必要图形关系，请返回空答案。\n${recognized}`;
    data.max_tokens = Math.max(data.max_tokens || 0, 2048);
    response = await fetchModel(endpoint, { ...request, body: JSON.stringify(data) });
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, responseText: '' };
  }
  return { status: response.status, responseText: await smallResponse(response) };
}

module.exports = { WORLD, BINDING, REPLY, StudyRequestError, isCourseUrl, buildScript, askModel, canUseVision };
