import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../index.mjs', import.meta.url));
const PROTOCOLO = '2026-07-28';

const ERRO_SALA = 'Sala inexistente: sala-delorean';
const ERRO_JANELA = 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00';
const ERRO_DURACAO = 'Duracao acima do limite: a politica permite no maximo 2 horas';
const ERRO_INTERVALO = 'Intervalo invalido: fim deve ser posterior a inicio';

let filho;
let porta;

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
  filho = spawn(process.execPath, [INDEX], {
    env: { ...process.env, MCP_PORT: String(porta), REQUEST_STATE_SECRET: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await esperaPorta(porta);
});

after(() => {
  filho?.kill();
});

let proximoId = 0;

async function mcp(metodo, params, nome) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOLO,
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  };
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
    body: JSON.stringify({ jsonrpc: '2.0', id: `r-${++proximoId}`, method: metodo, params: { ...params, _meta: meta } }),
  });
  return resp.json();
}

const chamar = async (nome, args) => (await mcp('tools/call', { name: nome, arguments: args }, nome)).result;
const reservar = (sala, inicio, fim, responsavel = 'Doc') => chamar('reservar_sala', { sala, inicio, fim, responsavel });
const consultar = (sala, inicio, fim) => chamar('consultar_disponibilidade', { sala, inicio, fim });
const h = (hora) => `2026-11-03T${hora}:00-03:00`;

test('check 1 e 2: tools/list traz as tres tools, todas com inputSchema de objeto', async () => {
  const { result } = await mcp('tools/list', {});
  const porNome = Object.fromEntries(result.tools.map((t) => [t.name, t]));
  for (const nome of ['listar_salas', 'consultar_disponibilidade', 'reservar_sala']) {
    assert.equal(porNome[nome]?.inputSchema.type, 'object', nome);
  }
});

test('wire 02: reserva em intervalo livre devolve res-0003 com o structuredContent completo', async () => {
  const r = await reservar('sala-aquario', h('09:00'), h('10:00'));
  const esperado = {
    reserva: 'res-0003',
    reservado: true,
    sala: 'sala-aquario',
    inicio: h('09:00'),
    fim: h('10:00'),
    responsavel: 'Doc',
    politica: '2026-11-01',
    motivo: null,
  };
  assert.notEqual(r.isError, true);
  assert.deepEqual(r.structuredContent, esperado);
  assert.deepEqual(JSON.parse(r.content[0].text), esperado);
});

test('ids de reserva seguem sequenciais', async () => {
  const r = await reservar('sala-porao', h('09:00'), h('10:00'));
  assert.equal(r.structuredContent.reserva, 'res-0004');
});

test('consultar_disponibilidade: intervalo livre e intervalo com conflito listando a reserva', async () => {
  const livre = await consultar('sala-mirante', h('09:00'), h('10:00'));
  assert.deepEqual(livre.structuredContent, { sala: 'sala-mirante', livre: true, conflitos: [] });

  const ocupada = await consultar('sala-garagem', h('14:30'), h('15:30'));
  assert.equal(ocupada.structuredContent.livre, false);
  assert.deepEqual(ocupada.structuredContent.conflitos, [
    { id: 'res-0001', inicio: h('14:00'), fim: h('15:00'), responsavel: 'Marty' },
  ]);
});

test('intervalos adjacentes nao conflitam', async () => {
  const r = await consultar('sala-garagem', h('15:00'), h('16:00'));
  assert.equal(r.structuredContent.livre, true);
});

test('check 9: sala inexistente devolve isError com a mensagem exata', async () => {
  for (const tool of [reservar, (s, i, f) => consultar(s, i, f)]) {
    const r = await tool('sala-delorean', h('09:00'), h('10:00'));
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, ERRO_SALA);
  }
});

test('check 10: fora da janela devolve isError com a mensagem exata, no inicio e no fim', async () => {
  for (const [i, f] of [['07:00', '08:00'], ['19:00', '21:00']]) {
    const r = await consultar('sala-aquario', h(i), h(f));
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, ERRO_JANELA);
  }
});

test('check 11: duracao acima de 2h devolve isError com a mensagem exata', async () => {
  const r = await consultar('sala-aquario', h('09:00'), h('12:00'));
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, ERRO_DURACAO);
});

test('duracao de exatamente 2h e aceita', async () => {
  const r = await consultar('sala-aquario', h('11:00'), h('13:00'));
  assert.notEqual(r.isError, true);
});

test('check 12: intervalo invertido ou vazio devolve isError com a mensagem exata', async () => {
  for (const [i, f] of [['10:00', '09:00'], ['10:00', '10:00']]) {
    const r = await reservar('sala-aquario', h(i), h(f));
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, ERRO_INTERVALO);
  }
});

test('erro de validacao nao consome id de reserva', async () => {
  await reservar('sala-delorean', h('09:00'), h('10:00'));
  const r = await reservar('sala-fusca', h('09:00'), h('10:00'));
  assert.equal(r.structuredContent.reserva, 'res-0005');
});
