// Minecraft server-list ping: gets online players without spamming the console with /list.
import net from "node:net";
const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const str = (s) => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s)]);
const packet = (id, ...parts) => { const body = Buffer.concat([varint(id), ...parts]); return Buffer.concat([varint(body.length), body]); };
function readVarint(buf, off) { let n = 0, s = 0, b; do { if (off >= buf.length) return null; b = buf[off++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return [n, off]; }
export function ping(host, port, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let data = Buffer.alloc(0);
    const t = setTimeout(() => { sock.destroy(); reject(new Error("ping timeout")); }, timeout);
    sock.on("connect", () => {
      const p = Buffer.alloc(2); p.writeUInt16BE(port);
      sock.write(packet(0, varint(767), str(host), p, varint(1)));
      sock.write(packet(0));
    });
    sock.on("data", (d) => {
      data = Buffer.concat([data, d]);
      const a = readVarint(data, 0); if (!a) return;
      const [len, o1] = a; if (data.length < o1 + len) return;
      const b = readVarint(data, o1); const c = readVarint(data, b[1]);
      const json = data.subarray(c[1], c[1] + c[0]).toString("utf8");
      clearTimeout(t); sock.destroy();
      try { resolve(JSON.parse(json)); } catch (e) { reject(e); }
    });
    sock.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}
