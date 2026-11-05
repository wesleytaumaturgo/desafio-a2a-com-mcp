import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../index.mjs', import.meta.url));
const PROTOCOLO = '2026-07-28';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let filho;
let porta;
let stderr = '';

function portaLivre() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sobe(env) {
  return spawn(process.execPath, [INDEX], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function terminou(proc) {
  return new Promise((resolve) => {
    let err = '';
    proc.stderr.on('data', (c) => (err += c));
    proc.once('exit', (codigo) => resolve({ codigo, err }));
  });
}

async function esperaPorta(p) {
  for (let i = 0; i < 100; i++) {
    const aberta = await new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(true));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(false)));
    });
    if (aberta) return;
    await new Promise((r) => setTimeout(r, 50)); // sleep-ok: intervalo de polling até a porta do filho abrir, sem espera fixa
  }
  throw new Error('servidor MCP nao abriu a porta');
}

before(async () => {
  porta = await portaLivre();
  filho = sobe({ MCP_PORT: String(porta), REQUEST_STATE_SECRET: randomBytes(32).toString('hex') });
  filho.stderr.on('data', (c) => (stderr += c));
  await esperaPorta(porta);
});

after(() => {
  filho?.kill();
});

let proximoId = 0;

async function mcp(metodo, params, { nome, omitir, traceparent, id } = {}) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOLO,
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  };
  if (traceparent) meta.traceparent = traceparent;
  if (omitir) delete meta[`io.modelcontextprotocol/${omitir}`];
  const cabecalhos = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOLO,
    'Mcp-Method': metodo,
  };
  if (nome) cabecalhos['Mcp-Name'] = nome;
  const resp = await fetch(`http://127.0.0.1:${porta}/mcp`, {
    method: 'POST',
    headers: cabecalhos,
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? `t-${++proximoId}`, method: metodo, params: { ...params, _meta: meta } }),
  });
  return { status: resp.status, corpo: await resp.json() };
}

const listar = (opts) => mcp('tools/call', { name: 'listar_salas', arguments: {} }, { nome: 'listar_salas', ...opts });

test('check 3: listar_salas devolve structuredContent e o mesmo JSON em texto', async () => {
  const { corpo } = await listar();
  const r = corpo.result;
  assert.equal(r.structuredContent.salas.length, 5);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test('tools/list expoe listar_salas com outputSchema', async () => {
  const { corpo } = await mcp('tools/list', {});
  const tool = corpo.result.tools.find((t) => t.name === 'listar_salas');
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(tool.outputSchema.required, ['salas']);
});

test('check 4: _meta sem protocolVersion devolve -32602 e HTTP 400', async () => {
  const { status, corpo } = await listar({ omitir: 'protocolVersion' });
  assert.equal(status, 400);
  assert.equal(corpo.error.code, -32602);
});

test('check 5: _meta sem clientCapabilities devolve -32602 e HTTP 400', async () => {
  const { status, corpo } = await listar({ omitir: 'clientCapabilities' });
  assert.equal(status, 400);
  assert.equal(corpo.error.code, -32602);
});

test('check 6: tool inexistente devolve -32602', async () => {
  const { corpo } = await mcp('tools/call', { name: 'voar_delorean', arguments: {} }, { nome: 'voar_delorean' });
  assert.equal(corpo.error.code, -32602);
});

test('check 7: resources/read de politica://uso devolve a politica em markdown', async () => {
  const { corpo } = await mcp('resources/read', { uri: 'politica://uso' }, { nome: 'politica://uso' });
  const conteudo = corpo.result.contents[0];
  assert.equal(conteudo.mimeType, 'text/markdown');
  assert.match(conteudo.text, /versao: 2026-11-01/);
});

test('check 8: resources/read de URI inexistente devolve -32602', async () => {
  const { corpo } = await mcp('resources/read', { uri: 'politica://inexistente' }, { nome: 'politica://inexistente' });
  assert.equal(corpo.error.code, -32602);
});

test('G2: stderr registra metodo, id e traceparent de cada request', async () => {
  await listar({ id: 'log-com-trace', traceparent: TRACEPARENT });
  await listar({ id: 'log-sem-trace' });
  await mcp('tools/list', {}, { id: 'log-lista' });
  const linhas = stderr.split('\n');
  assert.ok(linhas.includes(`mcp tools/call id=log-com-trace traceparent=${TRACEPARENT}`), stderr);
  assert.ok(linhas.includes('mcp tools/call id=log-sem-trace traceparent=-'), stderr);
  assert.ok(linhas.includes('mcp tools/list id=log-lista traceparent=-'), stderr);
});

test('D-04: sem REQUEST_STATE_SECRET o processo sai com codigo 1', async () => {
  const proc = sobe({ MCP_PORT: String(await portaLivre()), REQUEST_STATE_SECRET: '' });
  const { codigo, err } = await terminou(proc);
  assert.equal(codigo, 1);
  assert.match(err, /REQUEST_STATE_SECRET/);
});

test('D-04: segredo hex com menos de 32 bytes ou caractere invalido sai com codigo 1', async () => {
  for (const segredo of [randomBytes(16).toString('hex'), 'zz'.repeat(32)]) {
    const proc = sobe({ MCP_PORT: String(await portaLivre()), REQUEST_STATE_SECRET: segredo });
    const { codigo, err } = await terminou(proc);
    assert.equal(codigo, 1);
    assert.match(err, /REQUEST_STATE_SECRET/);
  }
});
