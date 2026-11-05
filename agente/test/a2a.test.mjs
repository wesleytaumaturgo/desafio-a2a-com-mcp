import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { criarAgente } from '../index.mjs';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const ERRO_SALA = 'Sala inexistente: sala-delorean';

const chamadasTool = [];
const leiturasPolitica = [];
let versaoServida = '2026-11-01';

function resultadoDe(argumentos) {
  if (argumentos.sala === 'sala-delorean') {
    return { content: [{ type: 'text', text: ERRO_SALA }], isError: true, resultType: 'complete' };
  }
  const estruturado = {
    reserva: 'res-0003',
    reservado: true,
    sala: argumentos.sala,
    inicio: argumentos.inicio,
    fim: argumentos.fim,
    responsavel: argumentos.responsavel,
    politica: '2026-11-01',
    motivo: null,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(estruturado) }],
    isError: false,
    resultType: 'complete',
    structuredContent: estruturado,
  };
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
        leiturasPolitica.push(pedido.params);
        result = { contents: [{ uri: pedido.params.uri, text: `versao: ${versaoServida}\n\n# Politica\n` }] };
      } else {
        chamadasTool.push(pedido.params);
        result = resultadoDe(pedido.params.arguments);
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

before(async () => {
  mcpFalso = await subirMcpFalso();
  agente = criarAgente({ mcpUrl: `http://127.0.0.1:${mcpFalso.address().port}/mcp` });
  const porta = await agente.iniciar();
  base = `http://127.0.0.1:${porta}`;
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
  return resposta.json();
}

function enviar(texto, { taskId, traceparent } = {}) {
  const message = { messageId: 'msg-teste', role: 'ROLE_USER', parts: [{ text: texto }] };
  if (taskId) message.taskId = taskId;
  return rpc('SendMessage', { message }, traceparent);
}

const pedido = (sala) =>
  `reservar sala=${sala} inicio=2026-11-04T09:00:00-03:00 fim=2026-11-04T10:00:00-03:00 responsavel=Doc`;

test('check 21 a 23: card no well-known com interface JSONRPC 1.0 e skill reservar-sala', async () => {
  const resposta = await fetch(`${base}/.well-known/agent-card.json`);
  assert.equal(resposta.status, 200);
  const card = await resposta.json();
  const interfaces = card.supportedInterfaces;
  assert.equal(interfaces.length, 1);
  assert.equal(interfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(interfaces[0].protocolVersion, '1.0');
  assert.equal(interfaces[0].url, `${base}/a2a`);
  assert.ok(card.skills.some((s) => s.id === 'reservar-sala'));
});

test('check 24: SendMessage com sala livre conclui a Task', async () => {
  const resposta = await enviar(pedido('sala-porao'), { traceparent: TRACEPARENT });
  const task = resposta.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.match(task.id, /^task-/);
  assert.match(task.contextId, /^ctx-/);
  assert.equal(task.status.message.role, 'ROLE_AGENT');
  assert.equal(task.status.message.taskId, task.id);
  assert.equal(task.history.length, 2);
  assert.equal(task.history[0].role, 'ROLE_USER');
});

test('check 25: artifact reserva traz a politica e a sala', async () => {
  const resposta = await enviar(pedido('sala-porao'));
  const [artifact] = resposta.result.task.artifacts;
  assert.equal(artifact.name, 'reserva');
  const conteudo = JSON.parse(artifact.parts[0].text);
  assert.equal(conteudo.sala, 'sala-porao');
  assert.equal(conteudo.politica, '2026-11-01');
  assert.equal(conteudo.reserva, 'res-0003');
  assert.equal(conteudo.responsavel, 'Doc');
});

test('a politica do artifact vem do resource politica://uso, com o trace-id da Task', async () => {
  versaoServida = '2099-01-01';
  try {
    const antes = leiturasPolitica.length;
    const task = (await enviar(pedido('sala-porao'), { traceparent: TRACEPARENT })).result.task;
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    const conteudo = JSON.parse(task.artifacts[0].parts[0].text);
    assert.equal(conteudo.politica, '2099-01-01');
    assert.equal(conteudo.reserva, 'res-0003');
    const leituras = leiturasPolitica.slice(antes);
    assert.equal(leituras.length, 1);
    assert.equal(leituras[0].uri, 'politica://uso');
    assert.match(leituras[0]._meta.traceparent, new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
  } finally {
    versaoServida = '2026-11-01';
  }
});

test('check 26: GetTask devolve id, contextId e estado corrente', async () => {
  const criada = (await enviar(pedido('sala-porao'))).result.task;
  const lida = (await rpc('GetTask', { id: criada.id })).result.task;
  assert.equal(lida.id, criada.id);
  assert.equal(lida.contextId, criada.contextId);
  assert.equal(lida.status.state, 'TASK_STATE_COMPLETED');
});

test('GetTask de id desconhecido devolve erro JSON-RPC', async () => {
  const resposta = await rpc('GetTask', { id: 'task-inexistente' });
  assert.equal(resposta.error.code, -32001);
});

test('check 31: SendMessage em Task terminal e recusado', async () => {
  const criada = (await enviar(pedido('sala-porao'))).result.task;
  const antes = chamadasTool.length;
  const resposta = await enviar('escolha=sala-mirante', { taskId: criada.id });
  assert.ok(resposta.error);
  assert.equal(resposta.result, undefined);
  assert.equal(chamadasTool.length, antes);
});

test('check 35: isError da tool termina a Task em FAILED com a mensagem exata', async () => {
  const resposta = await enviar(pedido('sala-delorean'));
  const task = resposta.result.task;
  assert.equal(task.status.state, 'TASK_STATE_FAILED');
  assert.equal(task.status.message.parts[0].text, ERRO_SALA);
  assert.deepEqual(task.artifacts, []);
});

test('pedido fora do formato fixo e recusado sem chamar a tool', async () => {
  const antes = chamadasTool.length;
  const resposta = await enviar('quero uma sala bonita');
  assert.equal(resposta.error.code, -32602);
  assert.equal(chamadasTool.length, antes);
});

test('o trace-id do header chega ao MCP e fica gravado na Task', async () => {
  await enviar(pedido('sala-porao'), { traceparent: TRACEPARENT });
  const ultima = chamadasTool.at(-1);
  assert.match(ultima._meta.traceparent, new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
});

test('a resposta A2A nao expoe campos internos da Task', async () => {
  const task = (await enviar(pedido('sala-porao'), { traceparent: TRACEPARENT })).result.task;
  assert.deepEqual(Object.keys(task).sort(), ['artifacts', 'contextId', 'history', 'id', 'status']);
});
