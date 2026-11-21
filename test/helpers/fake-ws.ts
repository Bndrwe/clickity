// A tiny WebSocket server for tests (RFC 6455 handshake + unfragmented frames): enough to fake
// the openai realtime / deepgram live endpoints without a dependency.
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export interface FakeSocket {
  path: string;
  headers: http.IncomingHttpHeaders;
  sendText(s: string): void;
  sendJson(v: unknown): void;
  close(code?: number): void;
  onText(cb: (s: string) => void): void;
  onBinary(cb: (b: Buffer) => void): void;
}

function frame(op: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : (() => {
    const b = Buffer.alloc(10);
    b[0] = 0x80 | op;
    b[1] = 127;
    b.writeBigUInt64BE(BigInt(len), 2);
    return b;
  })();
  return Buffer.concat([head, payload]);
}

export async function fakeWsServer(
  onSocket: (s: FakeSocket) => void,
  onHttp?: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (onHttp) onHttp(req, res, Buffer.concat(chunks));
      else res.writeHead(404).end();
    });
  });
  const sockets = new Set<Duplex>();
  server.on('upgrade', (req, socket: Duplex) => {
    sockets.add(socket);
    const key = String(req.headers['sec-websocket-key']);
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (protos.length ? `Sec-WebSocket-Protocol: ${protos[0]}\r\n` : '') +
        '\r\n',
    );
    const texts: Array<(s: string) => void> = [];
    const bins: Array<(b: Buffer) => void> = [];
    let buf = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0]! & 15;
        let len = buf[1]! & 127;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (buf[1]! & 128) !== 0;
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) payload[i]! ^= buf[maskOff + (i % 4)]!;
        buf = buf.subarray(off + len);
        if (op === 1) texts.forEach((f) => f(payload.toString('utf8')));
        else if (op === 2) bins.forEach((f) => f(payload));
        else if (op === 8) {
          try {
            socket.end(frame(8, payload.subarray(0, 2)));
          } catch {
            /* gone */
          }
        } else if (op === 9) socket.write(frame(10, payload));
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    onSocket({
      path: req.url ?? '',
      headers: req.headers,
      sendText: (s) => socket.write(frame(1, Buffer.from(s))),
      sendJson: (v) => socket.write(frame(1, Buffer.from(JSON.stringify(v)))),
      close: (code = 1000) => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(code);
        socket.end(frame(8, b));
      },
      onText: (cb) => texts.push(cb),
      onBinary: (cb) => bins.push(cb),
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
