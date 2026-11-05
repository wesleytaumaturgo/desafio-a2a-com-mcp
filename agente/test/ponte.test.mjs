import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { criarAgente } from '../index.mjs';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const OUTRO_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const CHAVE = 'escolha_de_sala';
const ALTERNATIVAS = ['sala-fusca', 'sala-mirante'];

const chamadas = [];
let sequenciaEstado = 0;
const estadosEmitidos = [];

function pausa() {
  const requestState = `estado-opaco-${++sequenciaEstado}.assinatura`;
  estadosEmitidos.push(requestState);
  return {
    resultType: 'input_required',
    inputRequests: {
      [CHAVE]: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Sala ocupada. Escolha outra.',
          requestedSchema: { type: 'object', properties: { sala: { type: 'string', enum: ALTERNATIVAS } } },
        },
      },
    },
    requestState,
  };
}

function completo(estruturado) {
  return {
    content: [{ type: 'text', text: JSON.stringify(estruturado) }],
    isError: false,
    resultType: 'complete',
    structuredContent: estruturado,
  };
}

function resultadoDe(params) {
  const argumentos = params.arguments;
  const resposta = params.inputResponses?.[CHAVE];
  if (resposta) {
    if (resposta.action === 'decline') {
      return completo({ reserva: null, reservado: false, sala: null, inicio: null, fim: null, responsavel: null, politica: '2026-11-01', motivo: 'recusado' });
    }
    return completo({ reserva: `res-${sequenciaEstado}${argumentos.responsavel.length}`, reservado: true, sala: resposta.content.sala, inicio: argumentos.inicio, fim: argumentos.fim, responsavel: argumentos.responsavel, politica: '2026-11-01', motivo: null });
  }
  if (argumentos.sala === 'sala-garagem') return pausa();
  return completo({ reserva: 'res-livre', reservado: true, sala: argumentos.sala, inicio: argumentos.inicio, fim: argumentos.fim, responsavel: argumentos.responsavel, politica: '2026-11-01', motivo: null });
}

function subirMcpFalso() {
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (pedaco) => (corpo += pedaco));
    req.on('end', () => {
      const pedido = JSON.parse(corpo);
      let result;
      if (pedido.method === 'tools/list') {
        result = { tools: [{ name: 'reservar_sala' }] };
      } else if (pedido.method === 'resources/read') {
        result = { contents: [{ uri: pedido.params.uri, text: 'versao: 2026-11-01\n' }] };
      } else {
        chamadas.push({ id: pedido.id, params: pedido.params });
        result = resultadoDe(pedido.params);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: pedido.id, result }));
    });
  });
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve(servidor)));
}

let mcpFalso;
let agente;
let base;
const corposA2a = [];

before(async () => {
  mcpFalso = await subirMcpFalso();
  agente = criarAgente({ mcpUrl: `http://127.0.0.1:${mcpFalso.address().port}/mcp` });
  base = `http://127.0.0.1:${await agente.iniciar()}`;
});

after(async () => {
  await agente.parar();
  await new Promise((resolve) => mcpFalso.close(resolve));
});

async function rpc(metodo, params, traceparent) {
  const headers = { 'Content-Type': 'application/json' };
  if (traceparent) headers.traceparent = traceparent;
  const resposta = await fetch(`${base}/a2a`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'x1', method: metodo, params }),
  });
  const texto = await resposta.text();
  corposA2a.push(texto);
  return JSON.parse(texto);
}

function enviar(texto, { taskId, traceparent } = {}) {
  const message = { messageId: 'msg-teste', role: 'ROLE_USER', parts: [{ text: texto }] };
  if (taskId) message.taskId = taskId;
  return rpc('SendMessage', { message }, traceparent);
}

const pedido = (sala, inicio = '14:00', fim = '15:00', responsavel = 'Marty') =>
  `reservar sala=${sala} inicio=2026-11-03T${inicio}:00-03:00 fim=2026-11-03T${fim}:00-03:00 responsavel=${responsavel}`;

const estadoDe = (resposta) => resposta.result.task.status.state;
const textoDe = (resposta) => resposta.result.task.status.message.parts[0].text;
const reservaDe = (resposta) => JSON.parse(resposta.result.task.artifacts[0].parts[0].text);

test('check 27 e 28: sala ocupada pausa a Task com a linha exata de alternativas', async () => {
  const resposta = await enviar(pedido('sala-garagem'), { traceparent: TRACEPARENT });
  assert.equal(estadoDe(resposta), 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(textoDe(resposta), 'alternativas: sala-fusca, sala-mirante');
  assert.deepEqual(resposta.result.task.artifacts, []);
});

test('check 29 e 30: fora do enum repete a pausa sem chamar o MCP; no enum refaz o retry com id novo', async () => {
  const pausada = (await enviar(pedido('sala-garagem'), { traceparent: TRACEPARENT })).result.task;
  const chamadaInicial = chamadas.at(-1);
  const estadoSelado = estadosEmitidos.at(-1);

  const antes = chamadas.length;
  const fora = await enviar('escolha=sala-aquario', { taskId: pausada.id });
  assert.equal(estadoDe(fora), 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(textoDe(fora), 'alternativas: sala-fusca, sala-mirante');
  assert.equal(fora.result.task.id, pausada.id);
  assert.equal(chamadas.length, antes);

  const concluida = await enviar('escolha=sala-fusca', { taskId: pausada.id });
  assert.equal(estadoDe(concluida), 'TASK_STATE_COMPLETED');
  assert.equal(concluida.result.task.id, pausada.id);
  assert.equal(reservaDe(concluida).sala, 'sala-fusca');

  const retry = chamadas.at(-1);
  assert.equal(chamadas.length, antes + 1);
  assert.notEqual(retry.id, chamadaInicial.id);
  assert.equal(retry.params.requestState, estadoSelado);
  assert.deepEqual(retry.params.inputResponses, { [CHAVE]: { action: 'accept', content: { sala: 'sala-fusca' } } });
  assert.deepEqual(retry.params.arguments, chamadaInicial.params.arguments);
  assert.match(retry.params._meta.traceparent, new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
});

test('continuacao com traceparent novo usa o novo trace-id', async () => {
  const pausada = (await enviar(pedido('sala-garagem'), { traceparent: TRACEPARENT })).result.task;
  await enviar('escolha=sala-mirante', { taskId: pausada.id, traceparent: `00-${OUTRO_TRACE_ID}-00f067aa0ba902b7-01` });
  assert.match(chamadas.at(-1).params._meta.traceparent, new RegExp(`^00-${OUTRO_TRACE_ID}-[0-9a-f]{16}-01$`));
});

test('check 32: escolha=recusar vira decline e termina a Task em CANCELED', async () => {
  const pausada = (await enviar(pedido('sala-garagem', '14:30', '15:30', 'Biff'))).result.task;
  const resposta = await enviar('escolha=recusar', { taskId: pausada.id });
  assert.equal(estadoDe(resposta), 'TASK_STATE_CANCELED');
  assert.deepEqual(chamadas.at(-1).params.inputResponses, { [CHAVE]: { action: 'decline' } });
  assert.deepEqual(resposta.result.task.artifacts, []);
  const outra = await enviar('escolha=sala-fusca', { taskId: pausada.id });
  assert.ok(outra.error);
});

test('check 33: duas Tasks pausadas concluem cada uma com o seu estado', async () => {
  const a = (await enviar(pedido('sala-garagem', '16:00', '17:00', 'Lorraine'))).result.task;
  const b = (await enviar(pedido('sala-garagem', '18:00', '19:00', 'George'))).result.task;
  assert.notEqual(a.id, b.id);
  const estadoA = estadosEmitidos.at(-2);
  const estadoB = estadosEmitidos.at(-1);

  const respA = await enviar('escolha=sala-mirante', { taskId: a.id });
  assert.equal(chamadas.at(-1).params.requestState, estadoA);
  const respB = await enviar('escolha=sala-mirante', { taskId: b.id });
  assert.equal(chamadas.at(-1).params.requestState, estadoB);

  assert.equal(estadoDe(respA), 'TASK_STATE_COMPLETED');
  assert.equal(estadoDe(respB), 'TASK_STATE_COMPLETED');
  assert.equal(reservaDe(respA).responsavel, 'Lorraine');
  assert.equal(reservaDe(respB).responsavel, 'George');
  assert.notEqual(reservaDe(respA).inicio, reservaDe(respB).inicio);
});

test('check 34: nenhuma resposta A2A carrega o requestState, nem no GetTask', async () => {
  const pausada = (await enviar(pedido('sala-garagem', '20:00', '21:00'))).result.task;
  await rpc('GetTask', { id: pausada.id });
  assert.ok(estadosEmitidos.length > 0);
  for (const estado of estadosEmitidos) {
    for (const corpo of corposA2a) assert.ok(!corpo.includes(estado), 'requestState vazou em resposta A2A');
  }
  assert.ok(!corposA2a.some((corpo) => corpo.includes(CHAVE)), 'chave do inputRequests vazou em resposta A2A');
});

test('check 36: o mesmo pedido produz a mesma pausa', async () => {
  const m1 = textoDe(await enviar(pedido('sala-garagem')));
  const m2 = textoDe(await enviar(pedido('sala-garagem')));
  assert.equal(m1, m2);
  assert.ok(m1.startsWith('alternativas:'));
});

test('GetTask de Task pausada devolve INPUT_REQUIRED', async () => {
  const pausada = (await enviar(pedido('sala-garagem'))).result.task;
  const lida = (await rpc('GetTask', { id: pausada.id })).result.task;
  assert.equal(lida.status.state, 'TASK_STATE_INPUT_REQUIRED');
});
