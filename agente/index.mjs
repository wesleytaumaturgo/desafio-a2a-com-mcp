import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { criarClienteMcp } from './mcp-cliente.mjs';
import { criarPonte, ESTADO_PAUSADO } from './ponte.mjs';
import { criarTasks } from './tasks.mjs';

const PADRAO_PEDIDO = /^reservar\s+sala=(\S+)\s+inicio=(\S+)\s+fim=(\S+)\s+responsavel=(.+)$/;
const PADRAO_TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

const ERRO = {
  JSON_INVALIDO: -32700,
  REQUISICAO_INVALIDA: -32600,
  METODO_INEXISTENTE: -32601,
  PARAMETROS_INVALIDOS: -32602,
  TASK_INEXISTENTE: -32001,
  OPERACAO_NAO_SUPORTADA: -32004,
};

class ErroRpc extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

function lerPedido(texto) {
  const achado = PADRAO_PEDIDO.exec(texto.trim());
  if (!achado) {
    throw new ErroRpc(
      ERRO.PARAMETROS_INVALIDOS,
      'Pedido fora do formato: reservar sala=<id> inicio=<iso> fim=<iso> responsavel=<nome>',
    );
  }
  const [, sala, inicio, fim, responsavel] = achado;
  return { sala, inicio, fim, responsavel: responsavel.trim() };
}

function textoDaMensagem(mensagem) {
  if (!mensagem || mensagem.role !== 'ROLE_USER' || !Array.isArray(mensagem.parts)) {
    throw new ErroRpc(ERRO.PARAMETROS_INVALIDOS, 'message invalida: esperado role ROLE_USER e parts');
  }
  return mensagem.parts.map((p) => p.text ?? '').join(' ');
}

function cartao(porta) {
  return {
    name: 'Central de Salas',
    description: 'Reserva salas de reuniao da Hill Valley Tech.',
    provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
    version: '1.0.0',
    supportedInterfaces: [
      { url: `http://127.0.0.1:${porta}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'reservar-sala',
        name: 'Reservar sala',
        description: 'Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.',
        tags: ['salas', 'agenda'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        examples: [
          'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty',
        ],
      },
    ],
  };
}

export function criarAgente({ mcpUrl, porta = 0 }) {
  const mcp = criarClienteMcp({ url: mcpUrl });
  const tasks = criarTasks();
  let servidor;

  const ponte = criarPonte({ mcp, tasks });

  async function enviarMensagem(params, traceparent) {
    const mensagem = params?.message;
    const texto = textoDaMensagem(mensagem);
    const achado = PADRAO_TRACEPARENT.exec(traceparent ?? '');

    if (mensagem.taskId) {
      const existente = tasks.obter(mensagem.taskId);
      if (!existente) throw new ErroRpc(ERRO.TASK_INEXISTENTE, `Task nao encontrada: ${mensagem.taskId}`);
      if (tasks.terminal(existente)) {
        throw new ErroRpc(ERRO.OPERACAO_NAO_SUPORTADA, `Task em estado terminal: ${existente.estado}`);
      }
      if (!ponte.pausada(existente) || existente.estado !== ESTADO_PAUSADO) {
        throw new ErroRpc(ERRO.OPERACAO_NAO_SUPORTADA, `Task nao aguarda resposta: ${existente.estado}`);
      }
      existente.historico.push(mensagem);
      if (achado) existente.traceId = achado[1];
      await ponte.continuar(existente, texto);
      return { task: tasks.visao(existente) };
    }

    const pedido = lerPedido(texto);
    const task = tasks.criar({ mensagem, traceId: achado?.[1] });
    await ponte.iniciar(task, pedido);
    return { task: tasks.visao(task) };
  }

  function lerTask(params) {
    const task = tasks.obter(params?.id);
    if (!task) throw new ErroRpc(ERRO.TASK_INEXISTENTE, `Task nao encontrada: ${params?.id}`);
    return { task: tasks.visao(task) };
  }

  async function despachar(corpo, traceparent) {
    if (corpo?.jsonrpc !== '2.0' || typeof corpo.method !== 'string') {
      throw new ErroRpc(ERRO.REQUISICAO_INVALIDA, 'Requisicao JSON-RPC invalida');
    }
    if (corpo.method === 'SendMessage') return enviarMensagem(corpo.params, traceparent);
    if (corpo.method === 'GetTask') return lerTask(corpo.params);
    throw new ErroRpc(ERRO.METODO_INEXISTENTE, `Metodo inexistente: ${corpo.method}`);
  }

  async function tratarRpc(req, res) {
    let corpo;
    let resposta;
    try {
      let bruto = '';
      for await (const pedaco of req) bruto += pedaco;
      try {
        corpo = JSON.parse(bruto);
      } catch {
        throw new ErroRpc(ERRO.JSON_INVALIDO, 'JSON invalido');
      }
      resposta = { jsonrpc: '2.0', id: corpo.id ?? null, result: await despachar(corpo, req.headers.traceparent) };
    } catch (erro) {
      const codigo = erro instanceof ErroRpc ? erro.codigo : -32603;
      resposta = { jsonrpc: '2.0', id: corpo?.id ?? null, error: { code: codigo, message: erro.message } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resposta));
  }

  function aoReceber(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cartao(servidor.address().port)));
    } else if (req.method === 'POST' && pathname === '/a2a') {
      tratarRpc(req, res);
    } else {
      res.writeHead(404).end();
    }
  }

  return {
    iniciar() {
      servidor = http.createServer(aoReceber);
      return new Promise((resolve) => servidor.listen(porta, '127.0.0.1', () => resolve(servidor.address().port)));
    },
    parar() {
      return new Promise((resolve) => servidor.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mcpUrl = `http://localhost:${process.env.MCP_PORT ?? 7301}/mcp`;
  const agente = criarAgente({ mcpUrl, porta: Number(process.env.AGENTE_PORT ?? 7300) });
  const porta = await agente.iniciar();
  process.stderr.write(`agente A2A em http://127.0.0.1:${porta}/a2a\n`);
}
