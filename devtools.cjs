'use strict';

const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

// Chromium's private child-process pipes carry UTF-8 JSON messages delimited by NUL.
class DevToolsPipe extends EventEmitter {
  constructor(child) {
    super();
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.nextId = 0;
    this.pending = new Map();
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.closed = false;

    this.output.on('data', chunk => this.read(chunk));
    this.output.on('end', () => this.close());
    for (const stream of [this.input, this.output]) stream.on('error', error => this.close(error));
    child.once('exit', () => this.close());
    child.once('error', error => this.close(error));
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Edge 连接已关闭。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待 Edge 响应超时 (${method})。`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  read(chunk) {
    this.buffer += this.decoder.write(chunk);
    let boundary;
    while ((boundary = this.buffer.indexOf('\0')) !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (!raw) continue;
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      if (message.method) {
        this.emit('message', message);
      } else {
        const result = this.pending.get(message.id);
        if (!result) continue;
        this.pending.delete(message.id);
        clearTimeout(result.timer);
        if (message.error) result.reject(new Error(message.error.message));
        else result.resolve(message.result);
      }
    }
  }

  close(reason = new Error('Edge 连接已关闭。')) {
    if (this.closed) return;
    this.closed = true;
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(reason);
    }
    this.pending.clear();
    this.emit('closed', reason);
  }
}

module.exports = { DevToolsPipe };
