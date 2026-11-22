// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA (ISA.md in the kit).
// Runs every /input/<id> program and writes /output/<id>/stdout.bin + exit.txt.
// Node 22, stdlib only. Deterministic: no clock, no randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Stack effect [pops, pushes] of opcodes 0x00-0x07, hoisted out of the hot
// loop: building this table per instruction would allocate on every step.
const EFF07: [number, number][] = [[0, 0], [0, 1], [0, 1], [1, 0], [1, 2], [2, 2], [2, 3], [3, 3]];

// Stack effect [pops, pushes] of an opcode, or null for an unknown opcode.
function eff(o: number): [number, number] | null {
  if (o < 8) return EFF07[o];
  if (o >= 0x10 && o <= 0x22) return o === 0x17 || o === 0x1b ? [1, 1] : [2, 1];
  if (o === 0x30 || o === 0x33 || o === 0x34) return [0, 0];
  if (o === 0x31 || o === 0x32) return [1, 0];
  if (o === 0x40) return [1, 1];
  if (o === 0x41) return [2, 0];
  if (o >= 0x50 && o <= 0x53) return o === 0x52 ? [0, 1] : [1, 0];
  return null;
}

function run(p: Uint8Array, q: Uint8Array): { o: Uint8Array; c: number } {
  const S = new Int32Array(256); let n = 0;
  const K = new Int32Array(64); let m = 0;
  const W = new Int32Array(256);
  const B = new Uint8Array(65536); let bl = 0;
  let j = 0, pc = 0, st = 0;
  const end = (c: number) => ({ o: B.slice(0, bl), c });
  for (;;) {
    if (st === 1000000) return end(10);
    if (pc < 0 || pc >= p.length) return end(9);
    const o = p[pc];
    const e = eff(o);
    if (!e) return end(5);
    const im = o === 1 ? 1 : o === 2 ? 4 : o >= 0x30 && o <= 0x33 ? 2 : 0;
    if (pc + im >= p.length) return end(9);
    st++;
    const nx = pc + 1 + im;
    if (n < e[0]) return end(2);
    if (n - e[0] + e[1] > 256) return end(3);
    pc = nx;
    switch (o) {
      case 0x00: return end(0);
      case 0x01: S[n++] = (p[nx - 1] << 24) >> 24; break;
      case 0x02: S[n++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break;
      case 0x03: n--; break;
      case 0x04: S[n] = S[n - 1]; n++; break;
      case 0x05: { const t = S[n - 1]; S[n - 1] = S[n - 2]; S[n - 2] = t; break; }
      case 0x06: S[n] = S[n - 2]; n++; break;
      case 0x07: { const a = S[n - 3]; S[n - 3] = S[n - 2]; S[n - 2] = S[n - 1]; S[n - 1] = a; break; }
      case 0x17: S[n - 1] = -S[n - 1] | 0; break;
      case 0x1b: S[n - 1] = ~S[n - 1]; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = S[n - 1], a = S[n - 2];
        let r: number;
        if (o === 0x10) r = (a + b) | 0;
        else if (o === 0x11) r = (a - b) | 0;
        else if (o === 0x12) r = Math.imul(a, b);
        else if (o === 0x13) { if (b === 0) return end(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; }
        else if (o === 0x14) { if (b === 0) return end(4); r = b === -1 ? 0 : (a % b) | 0; }
        else if (o === 0x15) { if (b === 0) return end(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; }
        else if (o === 0x16) { if (b === 0) return end(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (o === 0x18) r = a & b;
        else if (o === 0x19) r = a | b;
        else if (o === 0x1a) r = a ^ b;
        else if (o === 0x1c) r = a << (b & 31);
        else if (o === 0x1d) r = a >> (b & 31);
        else if (o === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (o === 0x20) r = a === b ? 1 : 0;
        else if (o === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        n -= 2; S[n++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        if (o === 0x30 || (o === 0x31) === (S[--n] === 0)) pc = nx + rel;
        break;
      }
      case 0x33:
        if (m === 64) return end(7);
        K[m++] = nx; pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34:
        if (m === 0) return end(8);
        pc = K[--m];
        break;
      case 0x40: {
        const ad = S[n - 1];
        if (ad < 0 || ad >= 256) return end(6);
        S[n - 1] = W[ad];
        break;
      }
      case 0x41: {
        const ad = S[n - 1], v = S[n - 2];
        if (ad < 0 || ad >= 256) return end(6);
        n -= 2; W[ad] = v;
        break;
      }
      case 0x50: {
        const s = String(S[n - 1]);
        if (bl + s.length > 65536) return end(11);
        n--;
        for (let i = 0; i < s.length; i++) B[bl++] = s.charCodeAt(i);
        break;
      }
      case 0x51:
        if (bl + 1 > 65536) return end(11);
        B[bl++] = S[--n] & 255;
        break;
      case 0x52: S[n++] = j < q.length ? q[j++] : -1; break;
      case 0x53: return end(S[--n] & 255);
    }
  }
}

for (const id of readdirSync(IN).sort()) {
  const r = run(readFileSync(join(IN, id, 'program.bin')), readFileSync(join(IN, id, 'input.bin')));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'stdout.bin'), r.o);
  writeFileSync(join(OUT, id, 'exit.txt'), `${r.c}\n`);
}
