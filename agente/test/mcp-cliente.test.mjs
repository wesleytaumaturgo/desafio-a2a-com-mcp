import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { criarClienteMcp } from '../mcp-cliente.mjs';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const CHAVE = '__main__:escolha_de_sala';

let servidor;
let url;
let recebidos;

function respostaPara(corpo) {
  if (corpo.method === 'tools/list') {
    return { tools: [{ name: 'reservar_sala' }] };
  }
  if (corpo.method === 'resources/read') {
    return { contents: [{ uri: 'politica://uso', text: '# politica' }] };
  }
  if (corpo.params.inputResponses) {
    return { resultType: 'complete', isError: false, content: [], structuredContent: { reservado: true } };
  }
  return {
    resultType: 'input_required',
    inputRequests: { [CHAVE]: { method: 'elicitation/create', params: { mode: 'form' } } },
    requestState: 'opaco',
  };
}

before(async () => {
  servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      const corpo = JSON.parse(Buffer.concat(partes).toString());
      recebidos.push({ headers: req.headers, corpo });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: corpo.id, result: respostaPara(corpo) }));
    });
  });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${servidor.address().port}/mcp`;
});

after(() => new Promise((ok) => servidor.close(ok)));

const args = { sala: 'sala-garagem', inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00', responsavel: 'Marty' };

test('G3: tools/list vai antes do primeiro tools/call e so uma vez', async () => {
  recebidos = [];
  const cliente = criarClienteMcp({ url });
  await cliente.chamarTool('reservar_sala', args, { traceId: TRACE_ID });
  await cliente.chamarTool('reservar_sala', args, { traceId: TRACE_ID });
  assert.deepEqual(recebidos.map((r) => r.corpo.method), ['tools/list', 'tools/call', 'tools/call']);
});

test('G3: lerPolitica faz resources/read de politica://uso', async () => {
  recebidos = [];
  const cliente = criarClienteMcp({ url });
  const politica = await cliente.lerPolitica({ traceId: TRACE_ID });
  assert.equal(recebidos[0].corpo.method, 'resources/read');
  assert.equal(recebidos[0].corpo.params.uri, 'politica://uso');
  assert.equal(recebidos[0].headers['mcp-name'], 'politica://uso');
  assert.equal(politica.contents[0].text, '# politica');
});

test('G4: o retry usa id diferente do pedido inicial e devolve input_required cru', async () => {
  recebidos = [];
  const cliente = criarClienteMcp({ url });
  const pausa = await cliente.chamarTool('reservar_sala', args, { traceId: TRACE_ID });
  assert.equal(pausa.resultType, 'input_required');
  assert.equal(pausa.requestState, 'opaco');
  assert.ok(pausa.inputRequests[CHAVE]);

  const final = await cliente.chamarTool('reservar_sala', args, {
    traceId: TRACE_ID,
    requestState: pausa.requestState,
    inputResponses: { [CHAVE]: { action: 'accept', content: { sala: 'sala-fusca' } } },
  });
  assert.equal(final.structuredContent.reservado, true);

  const chamadas = recebidos.filter((r) => r.corpo.method === 'tools/call');
  assert.equal(chamadas.length, 2);
  assert.notEqual(chamadas[0].corpo.id, chamadas[1].corpo.id);
  assert.equal(new Set(recebidos.map((r) => r.corpo.id)).size, recebidos.length);
  assert.equal(chamadas[1].corpo.params.requestState, 'opaco');
  assert.deepEqual(chamadas[1].corpo.params.inputResponses[CHAVE].content, { sala: 'sala-fusca' });
});

test('G5: headers MCP-Protocol-Version, Mcp-Method, Mcp-Name e Accept duplo', async () => {
  recebidos = [];
  const cliente = criarClienteMcp({ url });
  await cliente.chamarTool('reservar_sala', args, { traceId: TRACE_ID });
  const [lista, chamada] = recebidos;
  for (const { headers } of recebidos) {
    assert.equal(headers['mcp-protocol-version'], '2026-07-28');
    assert.equal(headers.accept, 'application/json, text/event-stream');
    assert.match(headers['content-type'], /^application\/json/);
  }
  assert.equal(lista.headers['mcp-method'], 'tools/list');
  assert.equal(lista.headers['mcp-name'], undefined);
  assert.equal(chamada.headers['mcp-method'], 'tools/call');
  assert.equal(chamada.headers['mcp-name'], 'reservar_sala');
});

test('G6: elicitation.form, protocolVersion e clientInfo no _meta de todo request', async () => {
  recebidos = [];
  const cliente = criarClienteMcp({ url });
  await cliente.lerPolitica({ traceId: TRACE_ID });
  await cliente.chamarTool('reservar_sala', args, { traceId: TRACE_ID });
  assert.equal(recebidos.length, 3);
  for (const { corpo } of recebidos) {
    const meta = corpo.params._meta;
    assert.equal(meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    assert.deepEqual(meta['io.modelcontextprotocol/clientCapabilities'], { elicitation: { form: {} } });
    assert.equal(meta['io.modelcontextprotocol/clientInfo'].name, 'agente-central-de-salas');
  }
});

async function comServidorFalso({ tools, politica }, fn) {
  const vistos = [];
  const falso = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      const corpo = JSON.parse(Buffer.concat(partes).toString());
      vistos.push(corpo);
      const result = corpo.method === 'tools/list'
        ? { tools: tools.map((name) => ({ name })) }
        : corpo.method === 'resources/read'
          ? { contents: [{ uri: 'politica://uso', text: politica }] }
          : { resultType: 'complete', isError: false, content: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: corpo.id, result }));
    });
  });
  await new Promise((ok) => falso.listen(0, '127.0.0.1', ok));
  try {
    await fn(`http://127.0.0.1:${falso.address().port}/mcp`, vistos);
  } finally {
    await new Promise((ok) => falso.close(ok));
  }
}

test('versaoPolitica devolve a versao da primeira linha da politica', async () => {
  await comServidorFalso({ tools: [], politica: 'versao: 2026-11-01\n\n# Politica de uso das salas' }, async (u) => {
    const cliente = criarClienteMcp({ url: u });
    assert.equal(await cliente.versaoPolitica({ traceId: TRACE_ID }), '2026-11-01');
  });
});

test('versaoPolitica lanca erro quando a politica nao tem a linha de versao', async () => {
  await comServidorFalso({ tools: [], politica: '# Politica sem versao' }, async (u) => {
    const cliente = criarClienteMcp({ url: u });
    await assert.rejects(() => cliente.versaoPolitica({ traceId: TRACE_ID }));
  });
});

test('chamarTool recusa tool que nao apareceu no tools/list e nao faz tools/call', async () => {
  await comServidorFalso({ tools: ['listar_salas'], politica: '' }, async (u, vistos) => {
    const cliente = criarClienteMcp({ url: u });
    await assert.rejects(
      () => cliente.chamarTool('reservar_sala', args, { traceId: TRACE_ID }),
      { message: 'tool nao anunciada: reservar_sala' },
    );
    assert.equal(vistos.some((v) => v.method === 'tools/call'), false);
  });
});

test('traceparent leva o trace-id da Task e span-id novo a cada request', async () => {
  recebidos = [];
  const cliente = criarClienteMcp({ url });
  await cliente.chamarTool('reservar_sala', args, { traceId: TRACE_ID });
  const spans = recebidos.map(({ corpo }) => {
    const tp = corpo.params._meta.traceparent;
    assert.match(tp, new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
    return tp.split('-')[2];
  });
  assert.notEqual(spans[0], spans[1]);
});
