import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { criarCodec } from '../mrtr.mjs';

const INDEX = fileURLToPath(new URL('../index.mjs', import.meta.url));
const PROTOCOLO = '2026-07-28';
const CHAVE = 'escolha_de_sala';
const ERRO_SEM_ALTERNATIVA = 'Sem alternativas disponiveis no intervalo';
const COM_ELICITATION = { elicitation: { form: {} } };

const segredo = randomBytes(32).toString('hex');
let principal;
const filhos = [];

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

async function iniciar(chave, porta) {
  porta ??= await portaLivre();
  const filho = spawn(process.execPath, [INDEX], {
    env: { ...process.env, MCP_PORT: String(porta), REQUEST_STATE_SECRET: chave },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  filhos.push(filho);
  await esperaPorta(porta);
  return { porta, filho };
}

before(async () => {
  principal = await iniciar(segredo);
});

after(() => {
  for (const f of filhos) f.kill();
});

let proximoId = 0;

async function mcp(servidor, params, { capacidades = COM_ELICITATION } = {}) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOLO,
    'io.modelcontextprotocol/clientCapabilities': capacidades,
  };
  const resp = await fetch(`http://127.0.0.1:${servidor.porta}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOLO,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': params.name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `m-${++proximoId}`, method: 'tools/call', params: { ...params, _meta: meta } }),
  });
  return { status: resp.status, corpo: await resp.json() };
}

const h = (hora) => `2026-11-03T${hora}:00-03:00`;

const reservar = (sala, inicio, fim, responsavel = 'Doc', opcoes = {}, servidor = principal) =>
  mcp(servidor, { name: 'reservar_sala', arguments: { sala, inicio, fim, responsavel } }, opcoes);

const retomar = (sala, inicio, fim, resposta, requestState, responsavel = 'Doc', servidor = principal) =>
  mcp(servidor, {
    name: 'reservar_sala',
    arguments: { sala, inicio, fim, responsavel },
    inputResponses: { [CHAVE]: resposta },
    requestState,
  });

const enumDe = (resultado) => resultado.inputRequests[CHAVE].params.requestedSchema.properties.sala.enum;

async function pedirEscolha(sala, inicio, fim, responsavel = 'Doc', servidor = principal) {
  const { corpo } = await reservar(sala, inicio, fim, responsavel, {}, servidor);
  assert.equal(corpo.result.resultType, 'input_required', JSON.stringify(corpo));
  return corpo.result;
}

test('check 13 e 14: conflito devolve input_required, form mode, chave escolha_de_sala e enum ordenado', async () => {
  const { status, corpo } = await reservar('sala-garagem', h('14:00'), h('15:00'));
  const r = corpo.result;
  assert.equal(status, 200);
  assert.equal(r.resultType, 'input_required');
  assert.deepEqual(Object.keys(r.inputRequests), [CHAVE]);
  assert.ok(r.requestState);
  const pedido = r.inputRequests[CHAVE];
  assert.equal(pedido.method, 'elicitation/create');
  assert.equal(pedido.params.mode, 'form');
  assert.equal(pedido.params.message, 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.');
  assert.deepEqual(pedido.params.requestedSchema.required, ['sala']);
  assert.deepEqual(enumDe(r), ['sala-fusca', 'sala-mirante']);
});

test('enum tem no maximo 3 salas, por capacidade crescente e id em empate', async () => {
  await reservar('sala-aquario', h('09:00'), h('10:00'), 'Ocupante');
  const r = await pedirEscolha('sala-aquario', h('09:00'), h('10:00'));
  assert.deepEqual(enumDe(r), ['sala-porao', 'sala-fusca', 'sala-garagem']);
});

test('uma unica alternativa continua em enum', async () => {
  await reservar('sala-garagem', h('18:00'), h('19:00'), 'Ocupante');
  await reservar('sala-fusca', h('18:00'), h('19:00'), 'Ocupante');
  const r = await pedirEscolha('sala-garagem', h('18:00'), h('19:00'));
  const campo = r.inputRequests[CHAVE].params.requestedSchema.properties.sala;
  assert.deepEqual(campo.enum, ['sala-mirante']);
  assert.equal('const' in campo, false);
});

test('check 15: conflito sem a capability elicitation devolve -32021 e HTTP 400', async () => {
  const { status, corpo } = await reservar('sala-garagem', h('14:00'), h('15:00'), 'Doc', { capacidades: {} });
  assert.equal(status, 400);
  assert.equal(corpo.error.code, -32021);
  assert.ok(corpo.error.data.requiredCapabilities);
});

test('check 16: retry com escolha valida e requestState conclui a reserva', async () => {
  const r = await pedirEscolha('sala-fusca', h('16:00'), h('17:00'));
  assert.deepEqual(enumDe(r), ['sala-garagem', 'sala-mirante']);
  const { corpo } = await retomar('sala-fusca', h('16:00'), h('17:00'), { action: 'accept', content: { sala: 'sala-garagem' } }, r.requestState);
  const res = corpo.result;
  assert.equal(res.resultType, 'complete');
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.sala, 'sala-garagem');
  assert.equal(res.structuredContent.reservado, true);
  assert.equal(res.structuredContent.politica, '2026-11-01');
});

test('check 17: requestState adulterado devolve -32602', async () => {
  const r = await pedirEscolha('sala-garagem', h('14:00'), h('15:00'));
  const adulterado = r.requestState.slice(0, -6) + (r.requestState.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
  const { corpo } = await retomar('sala-garagem', h('14:00'), h('15:00'), { action: 'accept', content: { sala: 'sala-fusca' } }, adulterado);
  assert.equal(corpo.error.code, -32602);
});

test('check 17b: requestState selado com outro segredo devolve -32602', async () => {
  const estranho = criarCodec(randomBytes(32).toString('hex'));
  const estado = await estranho.mint({
    sala: 'sala-garagem', inicio: h('14:00'), fim: h('15:00'), responsavel: 'Doc', alternativas: ['sala-fusca'],
  });
  const { corpo } = await retomar('sala-garagem', h('14:00'), h('15:00'), { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
  assert.equal(corpo.error.code, -32602);
});

test('check 18: argumentos adulterados no retry nao tomam efeito, vale o selado', async () => {
  await reservar('sala-garagem', h('12:00'), h('13:00'), 'Ocupante');
  const r = await pedirEscolha('sala-garagem', h('12:00'), h('13:00'), 'Doc');
  const { corpo } = await retomar('sala-mirante', h('13:00'), h('14:00'), { action: 'accept', content: { sala: 'sala-fusca' } }, r.requestState, 'Biff');
  const dados = corpo.result.structuredContent;
  assert.equal(dados.sala, 'sala-fusca');
  assert.equal(dados.inicio, h('12:00'));
  assert.equal(dados.fim, h('13:00'));
  assert.equal(dados.responsavel, 'Doc');
});

test('escolha fora das alternativas seladas pede de novo com o mesmo enum', async () => {
  const r = await pedirEscolha('sala-garagem', h('14:00'), h('15:00'));
  const { corpo } = await retomar('sala-garagem', h('14:00'), h('15:00'), { action: 'accept', content: { sala: 'sala-aquario' } }, r.requestState);
  assert.equal(corpo.result.resultType, 'input_required');
  assert.deepEqual(enumDe(corpo.result), enumDe(r));
  assert.ok(corpo.result.requestState);
});

test('sala escolhida ocupada na hora do retry devolve isError sem alternativas', async () => {
  await reservar('sala-garagem', h('19:00'), h('20:00'), 'Ocupante');
  const r = await pedirEscolha('sala-garagem', h('19:00'), h('20:00'));
  assert.deepEqual(enumDe(r), ['sala-fusca', 'sala-mirante']);
  await reservar('sala-mirante', h('19:00'), h('20:00'), 'Furao');
  const { corpo } = await retomar('sala-garagem', h('19:00'), h('20:00'), { action: 'accept', content: { sala: 'sala-mirante' } }, r.requestState);
  assert.equal(corpo.result.isError, true);
  assert.equal(corpo.result.content[0].text, ERRO_SEM_ALTERNATIVA);
});

test('check 19: decline conclui com reservado false, motivo e sem isError', async () => {
  const r = await pedirEscolha('sala-garagem', h('14:00'), h('15:00'));
  const { corpo } = await retomar('sala-garagem', h('14:00'), h('15:00'), { action: 'decline' }, r.requestState);
  const res = corpo.result;
  assert.equal(res.resultType, 'complete');
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.reservado, false);
  assert.equal(res.structuredContent.reserva, null);
  assert.equal(res.structuredContent.motivo, 'recusado');
});

test('cancel conclui com reservado false e motivo', async () => {
  const r = await pedirEscolha('sala-garagem', h('14:00'), h('15:00'));
  const { corpo } = await retomar('sala-garagem', h('14:00'), h('15:00'), { action: 'cancel' }, r.requestState);
  assert.notEqual(corpo.result.isError, true);
  assert.equal(corpo.result.structuredContent.reservado, false);
  assert.equal(corpo.result.structuredContent.motivo, 'cancelado');
});

test('check 20: conflito sem alternativa devolve isError com a mensagem exata', async () => {
  await reservar('sala-mirante', h('11:00'), h('12:00'));
  const { corpo } = await reservar('sala-mirante', h('11:00'), h('12:00'));
  assert.equal(corpo.result.isError, true);
  assert.equal(corpo.result.content[0].text, ERRO_SEM_ALTERNATIVA);
  assert.equal(corpo.result.inputRequests, undefined);
});

test('G1: requestState sobrevive ao restart do processo com o mesmo segredo', async () => {
  const chave = randomBytes(32).toString('hex');
  const antes = await iniciar(chave);
  const r = await pedirEscolha('sala-garagem', h('14:00'), h('15:00'), 'Doc', antes);
  antes.filho.kill();
  await new Promise((resolve) => antes.filho.once('exit', resolve));
  const depois = await iniciar(chave, antes.porta);
  const { corpo } = await retomar('sala-garagem', h('14:00'), h('15:00'), { action: 'accept', content: { sala: 'sala-fusca' } }, r.requestState, 'Doc', depois);
  assert.equal(corpo.result.resultType, 'complete');
  assert.equal(corpo.result.structuredContent.sala, 'sala-fusca');
});

test('G9: requestState expirado devolve -32602', async () => {
  const expirado = await criarCodec(segredo, -1).mint({
    sala: 'sala-garagem', inicio: h('14:00'), fim: h('15:00'), responsavel: 'Doc', alternativas: ['sala-fusca'],
  });
  const { corpo } = await retomar('sala-garagem', h('14:00'), h('15:00'), { action: 'accept', content: { sala: 'sala-fusca' } }, expirado);
  assert.equal(corpo.error.code, -32602);
});
