'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULTS = {
  pptSeconds: 10,
  autoPractice: false,
  autoHomework: false,
  autoDiscussion: false,
  endpoint: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-chat',
  format: 'openai',
  auth: 'bearer',
};
const KEY_MARKER = 'configured-on-this-pc';
const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';

function cleanSettings(value) {
  const pptSeconds = Number(value.pptSeconds);
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { /* Show validation below. */ }
  if (!Number.isInteger(pptSeconds) || pptSeconds < 1 || pptSeconds > 600 || !model || model.length > 200
    || !endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('请检查 PPT 停留时间、HTTPS 模型接口和模型名。');
  }
  return {
    pptSeconds,
    autoPractice: value.autoPractice === true,
    autoHomework: value.autoHomework === true,
    autoDiscussion: value.autoDiscussion === true,
    endpoint: endpoint.href,
    model,
    format: value.format === 'anthropic' ? 'anthropic' : 'openai',
    auth: value.auth === 'x-api-key' ? 'x-api-key' : 'bearer',
  };
}

function dataFolder() {
  if (!process.env.LOCALAPPDATA) throw new Error('找不到 Windows 本地应用数据目录。');
  return path.join(process.env.LOCALAPPDATA, 'YuketangStudy');
}

function windowsPowerShell() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powerShellEnv(values = {}) {
  const env = { ...process.env, ...values };
  // PowerShell 7's module paths can point Windows PowerShell at incompatible assemblies.
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  return env;
}

class Settings {
  constructor(folder) {
    this.folder = folder;
    this.file = path.join(folder, 'settings.json');
    this.legacyKeyFile = path.join(folder, 'ai-key.dpapi');
    this.deepseekKeyFile = path.join(folder, 'ai-key-deepseek.dpapi');
    fs.mkdirSync(folder, { recursive: true });
    this.values = { ...DEFAULTS };
    try { this.values = cleanSettings({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }); }
    catch (error) {
      if (error.code !== 'ENOENT') this.loadWarning = '本机设置文件无法读取，已使用默认设置。';
    }
    this.legacyDeepseekKey = new URL(this.values.endpoint).origin === DEEPSEEK_ORIGIN;
  }

  keyFileFor(endpoint) {
    if (new URL(endpoint).origin === DEEPSEEK_ORIGIN
      && (fs.existsSync(this.deepseekKeyFile) || !this.legacyDeepseekKey)) return this.deepseekKeyFile;
    return this.legacyKeyFile;
  }

  get keyFile() {
    return this.keyFileFor(this.values.endpoint);
  }

  forPanel() {
    return { ...this.values, key: fs.existsSync(this.keyFile) ? KEY_MARKER : '' };
  }

  save(value) {
    const settings = cleanSettings(value);
    if ((settings.autoPractice || settings.autoHomework || settings.autoDiscussion) && !fs.existsSync(this.keyFileFor(settings.endpoint))) {
      throw new Error('请先运行「设置 AI Key.cmd」。');
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.values = settings;
    return this.forPanel();
  }

  setKey() {
    const script = `
      $ErrorActionPreference = 'Stop'
      $courseKey = Read-Host 'Enter the AI API key (blank to cancel)' -AsSecureString
      if ($courseKey.Length -eq 0) { exit 0 }
      $courseCipher = ConvertFrom-SecureString -SecureString $courseKey
      $courseKeyPath = $env:YUKETANG_STUDY_KEY_PATH
      [IO.File]::WriteAllText($courseKeyPath, $courseCipher)
      Write-Host 'API key saved for the current Windows user.'
    `;
    const result = spawnSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-Command', script], {
      env: powerShellEnv({ YUKETANG_STUDY_KEY_PATH: new URL(this.values.endpoint).origin === DEEPSEEK_ORIGIN ? this.deepseekKeyFile : this.keyFile }),
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) throw new Error('无法保存 API Key。');
  }

  readKey() {
    if (!fs.existsSync(this.keyFile)) throw new Error('请先运行「设置 AI Key.cmd」。');
    const script = `
      $ErrorActionPreference = 'Stop'
      $courseCipher = [Console]::In.ReadToEnd().Trim()
      $courseSecret = ConvertTo-SecureString -String $courseCipher
      [Console]::Out.Write([System.Net.NetworkCredential]::new('', $courseSecret).Password)
    `;
    const result = spawnSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: powerShellEnv(), input: fs.readFileSync(this.keyFile), encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    const key = result.stdout?.trim();
    if (result.status !== 0 || !key || /[\r\n]/.test(key)) throw new Error('当前 Windows 用户无法读取本机 API Key。');
    return key;
  }
}

module.exports = { Settings, dataFolder, windowsPowerShell, powerShellEnv };
